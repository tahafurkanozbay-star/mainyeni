import {
  stableSortFindings,
  type AuditDomain,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type Severity,
} from './contracts.mts';
import {
  collectRepositoryChanges,
  type RepositoryChange,
} from './change-risk-audit.mts';
import {
  isDocumentationPath,
  isGeneratedPath,
  isTestPath,
} from './change-risk-policy.mts';

export type SafetySignalMode = 'protective' | 'dangerous';

export interface SafetyContractPolicy {
  readonly id: string;
  readonly domain: AuditDomain;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly remediation: string;
  readonly pathPatterns: readonly RegExp[];
  readonly mode: SafetySignalMode;
  readonly signals: readonly RegExp[];
  readonly minimumLoss?: number;
  readonly blocking?: boolean;
  readonly tags: readonly string[];
}

export interface SafetyContractObservation {
  readonly policyId: string;
  readonly file: string;
  readonly mode: SafetySignalMode;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly delta: number;
  readonly triggered: boolean;
}

export interface SafetyContractDeltaSummary {
  readonly evaluatedChanges: number;
  readonly observations: readonly SafetyContractObservation[];
  readonly protectivePolicies: number;
  readonly dangerousPolicies: number;
  readonly protectiveLosses: number;
  readonly dangerousIntroductions: number;
  readonly findingsByPolicy: Readonly<Record<string, number>>;
}

const WEB_RUNTIME = /^Webclient\.(?:app|admin)\/(?:src|tooling|scripts)\//u;
const BACKEND = /^(?:Api\.(?:Admin|User|Core)|Business|Operations)\//u;
const BACKEND_API = /^(?:Api\.(?:Admin|User|Core)|Business|Operations)\//u;
const GIS = /(?:^|\/)(?:gis|map|scene|spatial|arcgis|geometry|graphics|layer|feature|viewport|camera|cluster)(?:[._/-]|$)/iu;
const SEARCH = /(?:^|\/)(?:search|address|geocode|autocomplete|suggest)(?:[._/-]|$)/iu;
const DATA = /(?:^|\/)(?:data|repository|store|cache|dataset|registry|model|entity|dto|schema)(?:[._/-]|$)/iu;
const UI = /^Webclient\.(?:app|admin)\/src\/.*\.(?:tsx?|jsx?|css|scss|sass|less)$/u;
const WORKFLOW = /^\.github\/workflows\/.*\.ya?ml$/u;
const CONFIG = /(?:^|\/)(?:appsettings(?:\.[^/]+)?\.json|launchSettings\.json|vite\.config\.[cm]?[jt]s|\.env(?:\.[^/]+)?|web\.config)$/iu;
const SQL_OR_BACKEND = /(?:\.sql$|^(?:Api\.|Business|Operations|database\/))/iu;

const POLICIES: readonly SafetyContractPolicy[] = Object.freeze([
  {
    id: 'auth-guard-loss',
    domain: 'security',
    severity: 'high',
    title: 'Authorization guard evidence was reduced',
    message: 'A backend endpoint surface lost explicit authorization/require-authorization evidence relative to the exact base.',
    remediation: 'Restore [Authorize]/RequireAuthorization or prove equivalent server-side authorization with focused security tests.',
    pathPatterns: [BACKEND_API],
    mode: 'protective',
    signals: [/\[Authorize(?:Attribute)?(?:\([^\]]*\))?\]/gu, /\.RequireAuthorization\s*\(/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'security', 'authorization'],
  },
  {
    id: 'authentication-pipeline-loss',
    domain: 'security',
    severity: 'high',
    title: 'Authentication pipeline evidence was reduced',
    message: 'Backend startup/configuration lost authentication or authorization middleware/service registration evidence.',
    remediation: 'Restore the authentication/authorization pipeline and verify protected endpoints in backend release tests.',
    pathPatterns: [BACKEND, CONFIG],
    mode: 'protective',
    signals: [/AddAuthentication\s*\(/gu, /AddAuthorization\s*\(/gu, /UseAuthentication\s*\(/gu, /UseAuthorization\s*\(/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'security', 'middleware'],
  },
  {
    id: 'cookie-hardening-loss',
    domain: 'security',
    severity: 'high',
    title: 'Cookie hardening evidence was reduced',
    message: 'Cookie security evidence such as HttpOnly, Secure or SameSite was removed from a security-sensitive change.',
    remediation: 'Preserve HttpOnly/Secure/SameSite policy unless an equivalent server-owned session mechanism replaces it.',
    pathPatterns: [BACKEND, WEB_RUNTIME, CONFIG],
    mode: 'protective',
    signals: [/HttpOnly\s*=\s*true/giu, /Secure(?:Policy)?\s*=\s*(?:true|CookieSecurePolicy\.(?:Always|SameAsRequest))/giu, /SameSite\s*=/giu],
    minimumLoss: 1,
    tags: ['change-risk', 'security', 'cookie'],
  },
  {
    id: 'cancellation-contract-loss',
    domain: 'performance',
    severity: 'high',
    title: 'Cancellation contract evidence was reduced',
    message: 'Request/runtime code lost AbortSignal, AbortController or CancellationToken evidence.',
    remediation: 'Restore cooperative cancellation and verify superseded requests/work are terminated deterministically.',
    pathPatterns: [WEB_RUNTIME, BACKEND, GIS, SEARCH, DATA],
    mode: 'protective',
    signals: [/\bAbortSignal\b/gu, /\bAbortController\b/gu, /\bCancellationToken\b/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'performance', 'cancellation'],
  },
  {
    id: 'timeout-contract-loss',
    domain: 'performance',
    severity: 'high',
    title: 'Bounded timeout evidence was reduced',
    message: 'Network/runtime code lost explicit timeout evidence relative to the exact base.',
    remediation: 'Restore bounded timeout semantics and focused timeout/cancellation regression tests.',
    pathPatterns: [WEB_RUNTIME, BACKEND, GIS, SEARCH],
    mode: 'protective',
    signals: [/\btimeoutMs\b/gu, /\bTimeout\b/gu, /AbortSignal\.timeout\s*\(/gu, /withTimeout\s*\(/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'performance', 'timeout'],
  },
  {
    id: 'capacity-bound-loss',
    domain: 'performance',
    severity: 'high',
    title: 'Queue/cache capacity bound evidence was reduced',
    message: 'A scheduling/cache surface lost explicit capacity, queue, concurrency or entry bounds.',
    remediation: 'Restore bounded maxConcurrent/maxQueue/maxEntries/capacity semantics and pressure-path tests.',
    pathPatterns: [WEB_RUNTIME, GIS, SEARCH, DATA],
    mode: 'protective',
    signals: [/\bmaxConcurrent\w*\b/gu, /\bmaxQueue\w*\b/gu, /\bmaxEntries\b/gu, /\bcapacity\b/giu, /\bqueueLimit\b/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'performance', 'capacity'],
  },
  {
    id: 'dedupe-contract-loss',
    domain: 'performance',
    severity: 'medium',
    title: 'Request de-duplication evidence was reduced',
    message: 'A request-heavy runtime lost single-flight/de-duplication evidence.',
    remediation: 'Preserve identical-work de-duplication or document why duplicate concurrent work is now safe and bounded.',
    pathPatterns: [WEB_RUNTIME, GIS, SEARCH, DATA],
    mode: 'protective',
    signals: [/\bdedupe\w*\b/giu, /\bsingleFlight\b/giu, /\binFlight\b/gu, /\bpendingByKey\b/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'performance', 'dedupe'],
  },
  {
    id: 'gis-feature-budget-loss',
    domain: 'gis',
    severity: 'high',
    title: 'GIS feature/page budget evidence was reduced',
    message: 'GIS query/runtime code lost explicit maxFeatures, maxPages, featureBudget or result-limit evidence.',
    remediation: 'Restore bounded feature/page budgets and verify large-dataset pressure behavior.',
    pathPatterns: [GIS],
    mode: 'protective',
    signals: [/\bmaxFeatures\b/gu, /\bmaxPages\b/gu, /\bfeatureBudget\b/gu, /\bresultRecordCount\b/gu, /\bpageSize\b/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'gis', 'budget'],
  },
  {
    id: 'gis-ownership-cleanup-loss',
    domain: 'gis',
    severity: 'high',
    title: 'GIS resource cleanup evidence was reduced',
    message: 'GIS lifecycle code lost destroy/dispose/remove/abort cleanup evidence.',
    remediation: 'Restore deterministic ownership teardown for layers, views, handles, timers and in-flight work.',
    pathPatterns: [GIS],
    mode: 'protective',
    signals: [/\.destroy\s*\(/gu, /\.dispose\s*\(/gu, /removeHandle\s*\(/gu, /\.remove\s*\(/gu, /\.abort\s*\(/gu, /clear(?:Timeout|Interval)\s*\(/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'gis', 'lifecycle'],
  },
  {
    id: 'keyboard-accessibility-loss',
    domain: 'accessibility',
    severity: 'high',
    title: 'Keyboard accessibility evidence was reduced',
    message: 'Interactive UI code lost keyboard/semantic focus evidence relative to the base.',
    remediation: 'Restore keyboard handlers/semantic control behavior and focused accessibility regressions.',
    pathPatterns: [UI],
    mode: 'protective',
    signals: [/\bonKeyDown\b/gu, /\bonKeyUp\b/gu, /\btabIndex\b/gu, /\brole\s*=/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'accessibility', 'keyboard'],
  },
  {
    id: 'reduced-motion-loss',
    domain: 'accessibility',
    severity: 'medium',
    title: 'Reduced-motion evidence was reduced',
    message: 'Animated UI/GIS code lost reduced-motion preference handling.',
    remediation: 'Preserve prefers-reduced-motion/reduced-motion policy and verify animated navigation has a low-motion path.',
    pathPatterns: [UI, GIS],
    mode: 'protective',
    signals: [/prefers-reduced-motion/gu, /\breducedMotion\b/gu, /\breduceMotion\b/gu, /\bmotionPolicy\b/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'accessibility', 'motion'],
  },
  {
    id: 'correlation-evidence-loss',
    domain: 'observability',
    severity: 'medium',
    title: 'Request correlation evidence was reduced',
    message: 'Diagnostic-rich request/runtime code lost request/trace/correlation identifiers.',
    remediation: 'Preserve bounded request correlation so failures can be traced without logging sensitive payloads.',
    pathPatterns: [WEB_RUNTIME, BACKEND],
    mode: 'protective',
    signals: [/\bcorrelationId\b/gu, /\brequestId\b/gu, /\btraceId\b/gu, /\bActivitySource\b/gu],
    minimumLoss: 1,
    tags: ['change-risk', 'observability', 'correlation'],
  },
  {
    id: 'unsafe-html-introduction',
    domain: 'security',
    severity: 'high',
    title: 'Unsafe HTML sink was introduced',
    message: 'The change introduces dangerouslySetInnerHTML/innerHTML assignment into browser runtime code.',
    remediation: 'Use structured React rendering or sanitize through the approved HTML boundary with focused XSS tests.',
    pathPatterns: [WEB_RUNTIME],
    mode: 'dangerous',
    signals: [/dangerouslySetInnerHTML/gu, /\.innerHTML\s*=/gu],
    tags: ['change-risk', 'security', 'xss'],
  },
  {
    id: 'dynamic-code-introduction',
    domain: 'security',
    severity: 'critical',
    title: 'Dynamic code execution was introduced',
    message: 'The change introduces eval/new Function into active runtime code.',
    remediation: 'Remove dynamic code execution and replace it with explicit parsing/dispatch.',
    pathPatterns: [WEB_RUNTIME, BACKEND],
    mode: 'dangerous',
    signals: [/\beval\s*\(/gu, /\bnew\s+Function\s*\(/gu],
    blocking: true,
    tags: ['change-risk', 'security', 'code-execution'],
  },
  {
    id: 'credential-storage-introduction',
    domain: 'security',
    severity: 'critical',
    title: 'Credential-like browser persistence was introduced',
    message: 'The change introduces token/credential persistence in localStorage/sessionStorage.',
    remediation: 'Keep secrets out of persistent browser storage; use approved bounded session handling.',
    pathPatterns: [WEB_RUNTIME],
    mode: 'dangerous',
    signals: [/(?:localStorage|sessionStorage)\.(?:setItem|getItem)\s*\([^\n]*(?:token|secret|password|credential|bearer)/giu],
    blocking: true,
    tags: ['change-risk', 'security', 'credential-storage'],
  },
  {
    id: 'wildcard-cors-introduction',
    domain: 'security',
    severity: 'critical',
    title: 'Wildcard CORS authority was introduced',
    message: 'The change introduces AllowAnyOrigin/wildcard origin handling in backend configuration.',
    remediation: 'Use explicit trusted origins and never combine wildcard origin with credentialed requests.',
    pathPatterns: [BACKEND, CONFIG],
    mode: 'dangerous',
    signals: [/AllowAnyOrigin\s*\(/gu, /WithOrigins\s*\(\s*["']\*["']/gu, /Access-Control-Allow-Origin[^\n]*\*/giu],
    blocking: true,
    tags: ['change-risk', 'security', 'cors'],
  },
  {
    id: 'tls-bypass-introduction',
    domain: 'security',
    severity: 'critical',
    title: 'TLS certificate validation bypass was introduced',
    message: 'The change introduces an always-accept certificate validation callback.',
    remediation: 'Remove certificate validation bypasses and use trusted certificates/CA configuration.',
    pathPatterns: [BACKEND],
    mode: 'dangerous',
    signals: [/DangerousAcceptAnyServerCertificateValidator/gu, /ServerCertificateCustomValidationCallback[^\n]*=>\s*true/gu],
    blocking: true,
    tags: ['change-risk', 'security', 'tls'],
  },
  {
    id: 'plain-http-introduction',
    domain: 'network',
    severity: 'high',
    title: 'Plain HTTP runtime reference was introduced',
    message: 'The change introduces an http:// runtime reference outside local loopback fixtures.',
    remediation: 'Use HTTPS/same-origin transport or an approved server-side proxy.',
    pathPatterns: [WEB_RUNTIME, BACKEND, CONFIG],
    mode: 'dangerous',
    signals: [/http:\/\/(?!localhost\b|127\.0\.0\.1\b|\[::1\])/giu],
    tags: ['change-risk', 'network', 'transport'],
  },
  {
    id: 'raw-sql-introduction',
    domain: 'security',
    severity: 'high',
    title: 'Raw SQL execution surface was introduced',
    message: 'The change introduces FromSqlRaw/ExecuteSqlRaw or direct command text and requires parameterization review.',
    remediation: 'Use parameterized APIs and focused injection tests for request-derived values.',
    pathPatterns: [SQL_OR_BACKEND],
    mode: 'dangerous',
    signals: [/\bFromSqlRaw\s*\(/gu, /\bExecuteSqlRaw\s*\(/gu, /CommandText\s*=/gu],
    tags: ['change-risk', 'security', 'sql'],
  },
  {
    id: 'gis-wildcard-fields-introduction',
    domain: 'gis',
    severity: 'high',
    title: 'GIS wildcard attribute fetch was introduced',
    message: 'The change introduces wildcard outFields and may inflate payload/memory cost.',
    remediation: 'Request only fields required by the feature and preserve bounded payload contracts.',
    pathPatterns: [GIS],
    mode: 'dangerous',
    signals: [/outFields\s*:\s*\[\s*["']\*["']\s*\]/gu, /outFields\s*=\s*\[\s*["']\*["']\s*\]/gu],
    tags: ['change-risk', 'gis', 'payload'],
  },
  {
    id: 'gis-geometry-payload-introduction',
    domain: 'gis',
    severity: 'medium',
    title: 'GIS geometry payload request was introduced',
    message: 'The change turns on returnGeometry and should prove the geometry payload is required and bounded.',
    remediation: 'Keep returnGeometry false when attributes suffice; otherwise add feature/geometry budget tests.',
    pathPatterns: [GIS],
    mode: 'dangerous',
    signals: [/returnGeometry\s*:\s*true/gu, /returnGeometry\s*=\s*true/gu],
    tags: ['change-risk', 'gis', 'payload'],
  },
  {
    id: 'infinite-loop-introduction',
    domain: 'performance',
    severity: 'critical',
    title: 'Unbounded loop primitive was introduced',
    message: 'The change introduces while(true) or for(;;) in active runtime code.',
    remediation: 'Replace infinite loops with explicit bounded/cancellable iteration.',
    pathPatterns: [WEB_RUNTIME, BACKEND, GIS, SEARCH, DATA],
    mode: 'dangerous',
    signals: [/while\s*\(\s*true\s*\)/gu, /for\s*\(\s*;\s*;\s*\)/gu],
    blocking: true,
    tags: ['change-risk', 'performance', 'loop'],
  },
  {
    id: 'workflow-failure-bypass-introduction',
    domain: 'build',
    severity: 'high',
    title: 'Workflow failure bypass was introduced',
    message: 'The change introduces continue-on-error or forced-success validation semantics.',
    remediation: 'Remove failure bypass from authoritative validation and keep diagnostics separate from enforcing gates.',
    pathPatterns: [WORKFLOW],
    mode: 'dangerous',
    signals: [/continue-on-error\s*:\s*true/giu, /(?:\|\|\s*true\b|\|\|\s*exit\s+0\b|;\s*exit\s+0\b)/gu],
    tags: ['change-risk', 'ci', 'failure-semantics'],
  },
]);

export const SAFETY_CONTRACT_POLICIES: readonly SafetyContractPolicy[] = POLICIES;

function matchesPath(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(path));
}

function countMatches(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      count += 1;
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }
  return count;
}

function shouldEvaluate(change: RepositoryChange): boolean {
  const path = change.path;
  return !change.test &&
    !isTestPath(path) &&
    !isDocumentationPath(path) &&
    !isGeneratedPath(path) &&
    change.kind !== 'renamed';
}

function beforeText(change: RepositoryChange): string {
  return change.before?.text ?? '';
}

function afterText(change: RepositoryChange): string {
  return change.after?.text ?? '';
}

function observation(policy: SafetyContractPolicy, change: RepositoryChange): SafetyContractObservation | null {
  if (!matchesPath(change.path, policy.pathPatterns)) return null;
  const beforeCount = countMatches(beforeText(change), policy.signals);
  const afterCount = countMatches(afterText(change), policy.signals);
  const delta = afterCount - beforeCount;
  let triggered = false;
  if (policy.mode === 'protective') {
    const minimumLoss = policy.minimumLoss ?? 1;
    triggered = change.kind === 'modified' && beforeCount > afterCount && beforeCount - afterCount >= minimumLoss;
  } else {
    triggered = afterCount > beforeCount && afterCount > 0;
  }
  return {
    policyId: policy.id,
    file: change.path,
    mode: policy.mode,
    beforeCount,
    afterCount,
    delta,
    triggered,
  };
}

function makeFinding(
  policy: SafetyContractPolicy,
  item: SafetyContractObservation,
): Finding {
  const evidence = policy.mode === 'protective'
    ? `${item.beforeCount} -> ${item.afterCount} protective signal(s)`
    : `${item.beforeCount} -> ${item.afterCount} dangerous signal(s)`;
  return {
    id: `safety-delta-${policy.id}`,
    domain: policy.domain,
    severity: policy.severity,
    title: policy.title,
    message: policy.message,
    location: { file: item.file, line: 1 },
    evidence: {
      excerpt: evidence,
      metadata: {
        beforeCount: item.beforeCount,
        afterCount: item.afterCount,
        delta: item.delta,
      },
    },
    remediation: policy.remediation,
    tags: policy.tags,
    ...(policy.blocking ? { blocking: true } : {}),
  };
}

function findingsByPolicy(findings: readonly Finding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const key = finding.id.replace(/^safety-delta-/u, '');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function auditSafetyContractDelta(
  baseline: RepositoryInventory,
  current: RepositoryInventory,
): AuditSection<SafetyContractDeltaSummary> {
  const startedAt = Date.now();
  const changes = collectRepositoryChanges(baseline, current).filter(shouldEvaluate);
  const observations: SafetyContractObservation[] = [];
  const findings: Finding[] = [];

  for (const change of changes) {
    for (const policy of POLICIES) {
      const item = observation(policy, change);
      if (!item) continue;
      observations.push(item);
      if (item.triggered) findings.push(makeFinding(policy, item));
    }
  }

  observations.sort((left, right) =>
    left.file.localeCompare(right.file, 'en') || left.policyId.localeCompare(right.policyId, 'en'));
  const sortedFindings = stableSortFindings(findings);
  const summary: SafetyContractDeltaSummary = {
    evaluatedChanges: changes.length,
    observations,
    protectivePolicies: POLICIES.filter(policy => policy.mode === 'protective').length,
    dangerousPolicies: POLICIES.filter(policy => policy.mode === 'dangerous').length,
    protectiveLosses: observations.filter(item => item.mode === 'protective' && item.triggered).length,
    dangerousIntroductions: observations.filter(item => item.mode === 'dangerous' && item.triggered).length,
    findingsByPolicy: findingsByPolicy(sortedFindings),
  };

  return {
    domain: 'release',
    title: 'Exact-base safety contract delta audit',
    summary,
    findings: sortedFindings,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

export function safetyContractDeltaMarkdown(section: AuditSection<SafetyContractDeltaSummary>): string {
  const lines = [
    '# Kent Rehberi — Safety Contract Delta',
    '',
    `- Evaluated changed files: ${section.summary.evaluatedChanges}`,
    `- Protective policies: ${section.summary.protectivePolicies}`,
    `- Dangerous policies: ${section.summary.dangerousPolicies}`,
    `- Protective losses: ${section.summary.protectiveLosses}`,
    `- Dangerous introductions: ${section.summary.dangerousIntroductions}`,
    `- Findings: ${section.findings.length}`,
    '',
    '## Findings',
    '',
  ];
  if (section.findings.length === 0) lines.push('No exact-base safety contract regressions.');
  else {
    for (const finding of section.findings) {
      lines.push(`- **${finding.severity.toUpperCase()}** \`${finding.id}\` — ${finding.title} (${finding.location?.file ?? 'repository'})`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
