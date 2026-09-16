import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory, type SourceFile } from './contracts.mts';

export interface BackendSecuritySummary {
  readonly backendFiles: number;
  readonly controllerFiles: number;
  readonly endpointFiles: number;
  readonly authorizationSignals: number;
  readonly anonymousSignals: number;
  readonly validationSignals: number;
  readonly sqlSignals: number;
  readonly outboundHttpSignals: number;
  readonly findingsByRule: Readonly<Record<string, number>>;
}

interface Rule {
  readonly id: string;
  readonly severity: Finding['severity'];
  readonly title: string;
  readonly message: string;
  readonly pattern: RegExp;
  readonly remediation: string;
  readonly tags: readonly string[];
  readonly blocking?: boolean;
}

const BACKEND_PATH = /(^|\/)(API|Api|Backend|Server|Webclient\.API|Webclient\.Api|Webclient\.Server)(\/|\.)/i;
const CSHARP_PATH = /\.cs$/i;
const GENERATED_PATH = /(^|\/)(bin|obj|dist|coverage|node_modules)(\/|$)/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures?|mocks?)(\/|\.|$)/i;
const CONTROLLER = /Controller\b|\[ApiController\]|Map(?:Get|Post|Put|Patch|Delete)\s*\(/i;
const ENDPOINT = /\[(?:HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route)\b|Map(?:Get|Post|Put|Patch|Delete)\s*\(/gi;
const AUTHORIZE = /\[Authorize(?:\([^\]]*\))?\]|RequireAuthorization\s*\(|AddAuthorization\s*\(/gi;
const ANONYMOUS = /\[AllowAnonymous\]|AllowAnonymous\s*\(/gi;
const VALIDATION = /ModelState\.IsValid|TryValidateModel|ValidateAsync\s*\(|IValidator<|FluentValidation|Results\.ValidationProblem|BadRequest\s*\(/gi;
const SQL = /FromSqlRaw|ExecuteSqlRaw|SqlCommand|CommandText|SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM/gi;
const OUTBOUND_HTTP = /HttpClient|IHttpClientFactory|SendAsync\s*\(|GetAsync\s*\(|PostAsync\s*\(/gi;

const RULES: readonly Rule[] = [
  {
    id: 'backend-cors-wildcard-credentials', severity: 'critical', title: 'Wildcard CORS combined with credentials',
    message: 'Credentialed cross-origin access must never use a wildcard origin policy.',
    pattern: /AllowAnyOrigin\s*\(\)[\s\S]{0,500}AllowCredentials\s*\(\)|AllowCredentials\s*\(\)[\s\S]{0,500}AllowAnyOrigin\s*\(\)/gi,
    remediation: 'Use an explicit allow-list of trusted origins and keep credential policy scoped to the minimum required endpoints.', tags: ['cors', 'credentials'], blocking: true,
  },
  {
    id: 'backend-tls-validation-disabled', severity: 'critical', title: 'Outbound TLS certificate validation disabled',
    message: 'Accepting arbitrary server certificates makes backend-to-service traffic vulnerable to interception.',
    pattern: /ServerCertificateCustomValidationCallback\s*=\s*(?:[^;]*=>\s*true|HttpClientHandler\.DangerousAcceptAnyServerCertificateValidator)|RemoteCertificateValidationCallback\s*=\s*[^;]*=>\s*true/gi,
    remediation: 'Restore platform certificate validation. If private PKI is required, trust the intended CA/certificate explicitly.', tags: ['tls', 'transport'], blocking: true,
  },
  {
    id: 'backend-command-shell-execution', severity: 'critical', title: 'Backend process/shell execution boundary',
    message: 'Starting OS commands from request-serving code creates a command-injection and privilege boundary that requires explicit containment.',
    pattern: /Process\.Start\s*\(|new\s+ProcessStartInfo\s*\(|FileName\s*=\s*["'](?:cmd|powershell|pwsh|bash|sh)(?:\.exe)?["']/gi,
    remediation: 'Avoid shell execution. If unavoidable, use fixed executable/argument allow-lists, no shell expansion, least privilege and dedicated regression tests.', tags: ['command-injection', 'process'], blocking: true,
  },
  {
    id: 'backend-path-composition-input', severity: 'high', title: 'Request input participates directly in filesystem path',
    message: 'Direct request-derived filesystem path composition can permit traversal or unintended file access.',
    pattern: /Path\.(?:Combine|Join)\s*\([^;\n]*(?:Request\.|Query\[|RouteValues|Form\[|model\.|dto\.)/gi,
    remediation: 'Resolve against a fixed root, normalize with GetFullPath, reject escaping paths and prefer opaque server-side identifiers.', tags: ['path-traversal', 'filesystem'],
  },
  {
    id: 'backend-open-redirect-input', severity: 'high', title: 'Request-derived redirect target',
    message: 'Redirecting directly to request-controlled values can create an open redirect and phishing boundary.',
    pattern: /Redirect(?:Permanent|PreserveMethod|ToAction)?\s*\(\s*(?:Request\.|[^,;\n]*(?:returnUrl|redirectUrl|callbackUrl))/gi,
    remediation: 'Require local URLs or resolve redirect destinations through a strict server-owned allow-list.', tags: ['redirect', 'input-validation'],
  },
  {
    id: 'backend-unbounded-request-body-read', severity: 'medium', title: 'Potentially unbounded request body buffering',
    message: 'Reading an entire request body without an evident size boundary can amplify memory pressure and denial-of-service risk.',
    pattern: /ReadToEndAsync\s*\(\)|CopyToAsync\s*\([^;]*(?:MemoryStream|new\s+MemoryStream)/gi,
    remediation: 'Apply server/request size limits and stream bounded payloads where possible.', tags: ['dos', 'memory', 'request-body'],
  },
  {
    id: 'backend-sensitive-log-value', severity: 'high', title: 'Sensitive value may be written to application logs',
    message: 'Passwords, bearer tokens, authorization headers and secrets must not be emitted into logs.',
    pattern: /Log(?:Trace|Debug|Information|Warning|Error|Critical)\s*\([^;\n]*(?:password|passwd|secret|authorization|bearer|accessToken|refreshToken|apiKey)/gi,
    remediation: 'Log event identity and bounded metadata only; redact credentials and security tokens at the source.', tags: ['logging', 'secrets'],
  },
];

function backendFiles(inventory: RepositoryInventory): SourceFile[] {
  return inventory.files.filter(file => CSHARP_PATH.test(file.repositoryPath) && !GENERATED_PATH.test(file.repositoryPath) && !TEST_PATH.test(file.repositoryPath) && (BACKEND_PATH.test(file.repositoryPath) || file.kind === 'csharp'));
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function excerpt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 70);
  return text.slice(start, Math.min(text.length, offset + length + 110)).replace(/\s+/g, ' ').trim().slice(0, 260);
}

function ruleFindings(file: SourceFile, rule: Rule): Finding[] {
  const findings: Finding[] = [];
  const matcher = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
  let match: RegExpExecArray | null;
  let emitted = 0;
  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: rule.id, domain: 'security', severity: rule.severity, title: rule.title, message: rule.message,
      location: { file: file.repositoryPath, line: lineAt(file.text, match.index) },
      evidence: { excerpt: excerpt(file.text, match.index, match[0].length) }, remediation: rule.remediation, tags: rule.tags,
      ...(rule.blocking ? { blocking: true } : {}),
    });
    emitted += 1;
    if (emitted >= 8) break;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return findings;
}

function endpointAuthorizationFindings(file: SourceFile): Finding[] {
  if (!CONTROLLER.test(file.text)) return [];
  const endpoints = count(file.text, ENDPOINT);
  if (endpoints === 0) return [];
  const authorize = count(file.text, AUTHORIZE);
  const anonymous = count(file.text, ANONYMOUS);
  if (authorize > 0 || anonymous >= endpoints) return [];
  return [{
    id: 'backend-endpoint-authorization-evidence-missing', domain: 'security', severity: 'high', title: 'Backend endpoint lacks local authorization evidence',
    message: `${endpoints} endpoint declaration(s) were detected without Authorize/RequireAuthorization or explicit AllowAnonymous evidence in the same source file.`,
    location: { file: file.repositoryPath, line: 1 }, evidence: { metadata: { endpoints, authorize, anonymous } },
    remediation: 'Require authorization by default at the route/controller boundary, or mark intentionally public endpoints explicitly and test their data-minimization contract.', tags: ['authorization', 'api'],
  }];
}

function rawSqlFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const pattern = /(?:FromSqlRaw|ExecuteSqlRaw|CommandText\s*=)\s*\(?\s*\$["'][^;\n]*\{|(?:FromSqlRaw|ExecuteSqlRaw)\s*\(\s*[^,)]*\+/gi;
  const matcher = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    findings.push({
      id: 'backend-interpolated-raw-sql', domain: 'security', severity: 'critical', title: 'Interpolated/concatenated raw SQL execution',
      message: 'Raw SQL appears to be assembled with interpolation or concatenation, creating an injection boundary.',
      location: { file: file.repositoryPath, line: lineAt(file.text, match.index) }, evidence: { excerpt: excerpt(file.text, match.index, match[0].length) },
      remediation: 'Use parameterized commands or framework parameter binding; never concatenate request-derived values into SQL.', tags: ['sql', 'injection'], blocking: true,
    });
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return findings;
}

function outboundHttpFindings(file: SourceFile): Finding[] {
  const outbound = count(file.text, OUTBOUND_HTTP);
  if (outbound === 0) return [];
  const timeout = /Timeout\s*=|CancellationToken|CancelAfter\s*\(|Polly|AddStandardResilienceHandler|AddResilienceHandler/i.test(file.text);
  if (timeout) return [];
  return [{
    id: 'backend-outbound-http-bounds-missing', domain: 'network', severity: 'medium', title: 'Outbound backend HTTP lacks timeout/cancellation evidence',
    message: `${outbound} outbound HTTP signal(s) were detected without a local timeout, cancellation or resilience signal.`,
    location: { file: file.repositoryPath, line: 1 }, evidence: { value: outbound },
    remediation: 'Use IHttpClientFactory/shared transport with bounded timeout and propagate CancellationToken through request lifecycles.', tags: ['http', 'timeout', 'cancellation'],
  }];
}

function findingsByRule(findings: readonly Finding[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const finding of findings) result[finding.id] = (result[finding.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function auditBackendSecurity(inventory: RepositoryInventory): AuditSection<BackendSecuritySummary> {
  const start = performance.now();
  const files = backendFiles(inventory);
  const findings: Finding[] = [];
  for (const file of files) {
    for (const rule of RULES) findings.push(...ruleFindings(file, rule));
    findings.push(...endpointAuthorizationFindings(file));
    findings.push(...rawSqlFindings(file));
    findings.push(...outboundHttpFindings(file));
  }
  const sorted = stableSortFindings(findings);
  return {
    domain: 'security', title: 'Backend API authorization, input and transport boundary audit',
    summary: {
      backendFiles: files.length,
      controllerFiles: files.filter(file => CONTROLLER.test(file.text)).length,
      endpointFiles: files.filter(file => count(file.text, ENDPOINT) > 0).length,
      authorizationSignals: files.reduce((sum, file) => sum + count(file.text, AUTHORIZE), 0),
      anonymousSignals: files.reduce((sum, file) => sum + count(file.text, ANONYMOUS), 0),
      validationSignals: files.reduce((sum, file) => sum + count(file.text, VALIDATION), 0),
      sqlSignals: files.reduce((sum, file) => sum + count(file.text, SQL), 0),
      outboundHttpSignals: files.reduce((sum, file) => sum + count(file.text, OUTBOUND_HTTP), 0),
      findingsByRule: findingsByRule(sorted),
    },
    findings: sorted, elapsedMs: Math.max(0, performance.now() - start),
  };
}
