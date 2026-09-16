import {
  dedupeFindings,
  normalizeRepositoryPath,
  stableSortFindings,
  type AuditSection,
  type Finding,
  type FileKind,
  type RepositoryInventory,
  type SourceFile,
  type TextRule,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface SourceAuditSummary {
  readonly filesScanned: number;
  readonly rulesEvaluated: number;
  readonly matches: number;
  readonly blockingMatches: number;
  readonly skippedGeneratedFiles: number;
}

const CODE_KINDS: readonly FileKind[] = ['javascript', 'typescript', 'csharp'];
const WEB_KINDS: readonly FileKind[] = ['javascript', 'typescript', 'html', 'css'];
const JS_KINDS: readonly FileKind[] = ['javascript', 'typescript'];

const EXCLUDED_PATHS = [
  /^quality\/release\//,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)vendor\//,
  /(?:^|\/)third[-_]?party\//i,
];

export const SOURCE_RULES: readonly TextRule[] = Object.freeze([
  {
    id: 'client-secret-env',
    domain: 'security',
    severity: 'critical',
    title: 'Privileged client secret identifier',
    message: 'Browser source references a secret-like environment variable or credential identifier.',
    pattern: /REACT_APP_(?:CLIENT_KEY|API_KEY|SECRET|TOKEN|PASSWORD)|(?:client|api)[_-]?secret\b/gi,
    includeKinds: JS_KINDS,
    remediation: 'Move privileged material to the server and expose only least-privilege, user-authorized operations.',
    blocking: true,
    maxFindingsPerFile: 8,
    tags: ['secret', 'browser-boundary'],
  },
  {
    id: 'hardcoded-bearer',
    domain: 'security',
    severity: 'critical',
    title: 'Hard-coded bearer credential',
    message: 'A bearer credential appears to be embedded directly in source.',
    pattern: /Authorization\s*[:=]\s*['"`]Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi,
    includeKinds: CODE_KINDS,
    remediation: 'Resolve credentials through server-side authentication or approved secret storage.',
    blocking: true,
    maxFindingsPerFile: 4,
    tags: ['secret', 'auth'],
  },
  {
    id: 'dynamic-eval',
    domain: 'security',
    severity: 'critical',
    title: 'Dynamic code execution',
    message: 'eval/new Function introduces code-injection and CSP bypass risk.',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Replace dynamic evaluation with explicit parsers, lookup tables, or typed dispatch.',
    blocking: true,
    maxFindingsPerFile: 8,
    tags: ['xss', 'csp'],
  },
  {
    id: 'unsafe-html-sink',
    domain: 'security',
    severity: 'high',
    title: 'Unsafe HTML sink',
    message: 'Direct HTML injection requires sanitization and Trusted Types review.',
    pattern: /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Prefer DOM/text APIs; if rich HTML is unavoidable, sanitize at a single reviewed boundary.',
    maxFindingsPerFile: 12,
    tags: ['xss', 'dom'],
  },
  {
    id: 'document-write',
    domain: 'security',
    severity: 'critical',
    title: 'document.write usage',
    message: 'document.write is an unsafe legacy HTML execution primitive.',
    pattern: /document\.write(?:ln)?\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Use DOM creation APIs or React rendering.',
    blocking: true,
    tags: ['xss', 'legacy'],
  },
  {
    id: 'plain-http-runtime',
    domain: 'network',
    severity: 'high',
    title: 'Plain HTTP runtime reference',
    message: 'Plain HTTP endpoints/assets permit transport downgrade and mixed content.',
    pattern: /['"`]http:\/\/[^'"`\s]+/gi,
    includeKinds: WEB_KINDS,
    remediation: 'Use HTTPS or same-origin server routing. Do not add speculative replacement endpoints.',
    maxFindingsPerFile: 12,
    tags: ['transport', 'mixed-content'],
  },
  {
    id: 'forbidden-wms-wfs',
    domain: 'gis',
    severity: 'critical',
    title: 'Forbidden WMS/WFS runtime drift',
    message: 'Runtime code appears to introduce WMS/WFS, which is outside the verified service protocol for this repository.',
    pattern: /(?:service\s*=\s*['"]?(?:WMS|WFS)|\b(?:WMS|WFS)(?:Layer|Service|Client|Url|URL)\b)/gi,
    includeKinds: CODE_KINDS,
    includePaths: [/^(?:Webclient\.app\/src|Api\.|Business\/|Toolbox\/)/],
    remediation: 'Use only repository-verified ArcGIS REST service types and real configured endpoints.',
    blocking: true,
    maxFindingsPerFile: 6,
    tags: ['gis', 'protocol'],
  },
  {
    id: 'unsafe-window-open',
    domain: 'security',
    severity: 'medium',
    title: 'Direct window.open call',
    message: 'Direct external navigation must be validated for URL scheme and opener isolation.',
    pattern: /window\.open\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Route through the shared safe external-navigation helper with noopener/noreferrer behavior.',
    maxFindingsPerFile: 12,
    tags: ['navigation', 'tabnabbing'],
  },
  {
    id: 'global-graphics-clear',
    domain: 'gis',
    severity: 'high',
    title: 'Cross-tool graphics cleanup risk',
    message: 'Global graphics clearing can destroy resources owned by another GIS tool/window.',
    pattern: /\bRemoveAllGraphics\s*\(|\.graphics\.removeAll\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Use ownership-scoped graphic/layer cleanup.',
    maxFindingsPerFile: 8,
    tags: ['gis', 'lifecycle', 'ownership'],
  },
  {
    id: 'sync-storage-token',
    domain: 'security',
    severity: 'high',
    title: 'Browser storage credential handling',
    message: 'Credential-like data appears to be persisted in local/session storage.',
    pattern: /(?:localStorage|sessionStorage)\.(?:setItem|getItem)\s*\(\s*['"`](?:token|jwt|access[_-]?token|refresh[_-]?token|password)/gi,
    includeKinds: JS_KINDS,
    remediation: 'Prefer secure server sessions or explicitly threat-model token storage.',
    maxFindingsPerFile: 8,
    tags: ['auth', 'storage'],
  },
  {
    id: 'weak-random-security',
    domain: 'security',
    severity: 'high',
    title: 'Math.random in security-looking flow',
    message: 'Math.random must not generate tokens, nonces, reset codes, or other security identifiers.',
    pattern: /Math\.random\s*\(\s*\).{0,120}(?:token|nonce|secret|password|reset|otp|code)/gis,
    includeKinds: JS_KINDS,
    remediation: 'Use Web Crypto / server-side cryptographic randomness.',
    maxFindingsPerFile: 4,
    tags: ['crypto'],
  },
  {
    id: 'console-production',
    domain: 'observability',
    severity: 'low',
    title: 'Direct console logging',
    message: 'Unbounded console logging can leak context and create noisy production diagnostics.',
    pattern: /console\.(?:log|debug|warn|error|trace)\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Use bounded structured logging/telemetry with redaction.',
    maxFindingsPerFile: 6,
    tags: ['logging'],
  },
  {
    id: 'catch-swallow',
    domain: 'observability',
    severity: 'medium',
    title: 'Potential swallowed exception',
    message: 'An empty catch block can hide runtime failures and regressions.',
    pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
    includeKinds: CODE_KINDS,
    remediation: 'Handle, normalize, or intentionally annotate ignored errors.',
    maxFindingsPerFile: 8,
    tags: ['error-handling'],
  },
  {
    id: 'promise-constructor-async',
    domain: 'performance',
    severity: 'medium',
    title: 'Promise constructor around async flow',
    message: 'Manual Promise construction often duplicates async error and cancellation semantics.',
    pattern: /new\s+Promise\s*\(\s*async\b/g,
    includeKinds: JS_KINDS,
    remediation: 'Use async functions directly and preserve cancellation semantics.',
    maxFindingsPerFile: 8,
    tags: ['async', 'maintainability'],
  },
  {
    id: 'react-index-key',
    domain: 'performance',
    severity: 'medium',
    title: 'Potential unstable React list key',
    message: 'Array index keys can cause state/DOM reuse bugs when result ordering changes.',
    pattern: /key\s*=\s*\{\s*(?:index|idx|i)\s*\}/g,
    includeKinds: JS_KINDS,
    remediation: 'Use a stable domain identifier or deterministic composite key.',
    maxFindingsPerFile: 10,
    tags: ['react', 'rendering'],
  },
  {
    id: 'react-legacy-string-ref',
    domain: 'architecture',
    severity: 'medium',
    title: 'Legacy React string ref',
    message: 'String refs are obsolete and complicate modern React migration.',
    pattern: /ref\s*=\s*['"][A-Za-z_$][\w$.-]*['"]/g,
    includeKinds: JS_KINDS,
    remediation: 'Use createRef/useRef/callback refs.',
    maxFindingsPerFile: 8,
    tags: ['react', 'legacy'],
  },
  {
    id: 'react-unsafe-lifecycle',
    domain: 'architecture',
    severity: 'medium',
    title: 'Legacy React lifecycle',
    message: 'Legacy lifecycle methods impede React 19 compatibility and concurrency-safe rendering.',
    pattern: /\b(?:componentWillMount|componentWillReceiveProps|componentWillUpdate|UNSAFE_componentWillMount|UNSAFE_componentWillReceiveProps|UNSAFE_componentWillUpdate)\b/g,
    includeKinds: JS_KINDS,
    remediation: 'Migrate to safe lifecycle methods or hooks in a focused component refactor.',
    maxFindingsPerFile: 12,
    tags: ['react', 'migration'],
  },
  {
    id: 'sync-xhr',
    domain: 'performance',
    severity: 'high',
    title: 'Synchronous XMLHttpRequest',
    message: 'Synchronous XHR blocks the browser main thread.',
    pattern: /\.open\s*\([^,]+,[^,]+,\s*false\s*\)/g,
    includeKinds: JS_KINDS,
    remediation: 'Use fetch/async request infrastructure with timeout and cancellation.',
    maxFindingsPerFile: 4,
    tags: ['network', 'blocking'],
  },
  {
    id: 'unbounded-interval',
    domain: 'performance',
    severity: 'medium',
    title: 'setInterval lifecycle review',
    message: 'Recurring timers require cleanup and visibility/lifecycle controls.',
    pattern: /\bsetInterval\s*\(/g,
    includeKinds: JS_KINDS,
    remediation: 'Ensure interval handles are disposed on teardown and polling cadence is justified.',
    maxFindingsPerFile: 8,
    tags: ['timer', 'lifecycle'],
  },
  {
    id: 'todo-marker',
    domain: 'release',
    severity: 'info',
    title: 'Implementation debt marker',
    message: 'TODO/FIXME/HACK marker should be tracked if it affects release behavior.',
    pattern: /\b(?:TODO|FIXME|HACK)\b/g,
    includeKinds: CODE_KINDS,
    maxFindingsPerFile: 3,
    tags: ['debt'],
  },
]);

function pathAllowed(file: SourceFile, rule: TextRule): boolean {
  if (EXCLUDED_PATHS.some(pattern => pattern.test(file.repositoryPath))) return false;
  if (rule.includeKinds && !rule.includeKinds.includes(file.kind)) return false;
  if (rule.includePaths && !rule.includePaths.some(pattern => pattern.test(file.repositoryPath))) return false;
  if (rule.excludePaths && rule.excludePaths.some(pattern => pattern.test(file.repositoryPath))) return false;
  return true;
}

function globalMatcher(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

export function scanFileWithRule(file: SourceFile, rule: TextRule): Finding[] {
  if (!pathAllowed(file, rule)) return [];
  const matcher = globalMatcher(rule.pattern);
  const lineIndex = createLineIndex(file.text);
  const findings: Finding[] = [];
  const maximum = rule.maxFindingsPerFile ?? 25;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: rule.id,
      domain: rule.domain,
      severity: rule.severity,
      title: rule.title,
      message: rule.message,
      location: {
        file: normalizeRepositoryPath(file.repositoryPath),
        line: lineIndex.lineAt(match.index),
        column: lineIndex.columnAt(match.index),
      },
      evidence: { excerpt: snippetAround(file.text, match.index, 100) },
      ...(rule.remediation ? { remediation: rule.remediation } : {}),
      ...(rule.blocking !== undefined ? { blocking: rule.blocking } : {}),
      ...(rule.tags ? { tags: rule.tags } : {}),
    });
    if (findings.length >= maximum) break;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return findings;
}

export function scanSource(
  inventory: RepositoryInventory,
  rules: readonly TextRule[] = SOURCE_RULES,
): AuditSection<SourceAuditSummary> {
  const start = performance.now();
  const findings: Finding[] = [];
  let filesScanned = 0;
  let skippedGeneratedFiles = 0;

  for (const file of inventory.files) {
    if (EXCLUDED_PATHS.some(pattern => pattern.test(file.repositoryPath))) {
      skippedGeneratedFiles += 1;
      continue;
    }
    let eligible = false;
    for (const rule of rules) {
      if (!pathAllowed(file, rule)) continue;
      eligible = true;
      findings.push(...scanFileWithRule(file, rule));
    }
    if (eligible) filesScanned += 1;
  }

  const normalized = stableSortFindings(dedupeFindings(findings));
  const blockingMatches = normalized.filter(finding => finding.blocking).length;
  return {
    domain: 'security',
    title: 'Source security and architecture audit',
    summary: {
      filesScanned,
      rulesEvaluated: rules.length,
      matches: normalized.length,
      blockingMatches,
      skippedGeneratedFiles,
    },
    findings: normalized,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}

export function ruleById(id: string): TextRule | undefined {
  return SOURCE_RULES.find(rule => rule.id === id);
}

export function rulesForDomain(domain: TextRule['domain']): TextRule[] {
  return SOURCE_RULES.filter(rule => rule.domain === domain);
}

export function sourceAuditFingerprint(section: AuditSection<SourceAuditSummary>): string {
  return section.findings
    .map(finding => `${finding.severity}:${finding.id}:${finding.location?.file ?? '-'}:${finding.location?.line ?? 0}`)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join('\n');
}
