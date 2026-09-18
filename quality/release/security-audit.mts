import type { AuditSection, Finding, RepositoryInventory, SourceFile } from './contracts.mts';

export interface SecurityAuditSummary {
  readonly scannedFiles: number;
  readonly secretCandidates: number;
  readonly unsafeHtmlCandidates: number;
  readonly dynamicExecutionCandidates: number;
  readonly insecureStorageCandidates: number;
  readonly permissiveCorsCandidates: number;
  readonly findingsByRule: Readonly<Record<string, number>>;
}

interface LocatedMatch { readonly line: number; readonly excerpt: string; }
const GENERATED = /(^|\/)(node_modules|dist|build|coverage|bin|obj)(\/|$)/i;
const TESTS = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|\.|$)|\.(?:test|spec)\.[^/]+$/i;
const AUDITABLE = new Set(['javascript', 'typescript', 'csharp', 'json', 'yaml', 'html', 'xml']);
function eligible(file: SourceFile): boolean { return AUDITABLE.has(file.kind) && !GENERATED.test(file.repositoryPath) && !TESTS.test(file.repositoryPath) && !file.repositoryPath.startsWith('quality/release/'); }
function lineAt(text: string, offset: number): number { let line = 1; for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1; return line; }
function compact(value: string): string { const text = value.replace(/\s+/g, ' ').trim(); return text.length <= 220 ? text : `${text.slice(0, 219)}…`; }
function matches(text: string, pattern: RegExp): LocatedMatch[] { const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`; return [...text.matchAll(new RegExp(pattern.source, flags))].map(match => ({ line: lineAt(text, match.index ?? 0), excerpt: compact(match[0]) })); }
function make(id: string, severity: Finding['severity'], title: string, message: string, file: SourceFile, match: LocatedMatch, remediation: string, tags: readonly string[], blocking = false): Finding { return { id, domain: 'security', severity, title, message, location: { file: file.repositoryPath, line: match.line }, evidence: { excerpt: match.excerpt }, remediation, tags, ...(blocking ? { blocking: true } : {}) }; }
function limited<T>(values: readonly T[], max = 12): readonly T[] { return values.slice(0, max); }

const SECRET_PATTERNS: readonly { id: string; pattern: RegExp; label: string }[] = [
  { id: 'security-private-key-material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, label: 'private key material' },
  { id: 'security-aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key' },
  { id: 'security-github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g, label: 'GitHub token' },
  { id: 'security-jwt-literal', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: 'JWT-like credential' },
];

function secretFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  for (const rule of SECRET_PATTERNS) for (const match of limited(matches(file.text, rule.pattern), 4)) findings.push(make(rule.id, 'critical', `Potential ${rule.label} committed to source`, 'Credential-shaped material must not be committed to the repository or shipped to clients.', file, match, 'Revoke/rotate the credential if real, remove it from source, and load secrets from an approved server-side secret provider.', ['secret', 'credential'], true));
  if (/\.(?:env|properties|ya?ml|json)$/i.test(file.repositoryPath)) {
    for (const match of limited(matches(file.text, /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_+\/=.-]{16,}/gi), 8)) findings.push(make('security-config-secret-literal', 'critical', 'Credential-like configuration literal', 'A configuration file appears to contain a long-lived credential literal.', file, match, 'Replace with environment/secret-provider indirection and rotate the exposed value if it is genuine.', ['secret', 'configuration'], true));
  }
  return findings;
}

function browserFindings(file: SourceFile): Finding[] {
  if (!/Webclient\.(?:app|Admin)\/src\//.test(file.repositoryPath)) return [];
  const findings: Finding[] = [];
  for (const match of limited(matches(file.text, /dangerouslySetInnerHTML\s*=|\.innerHTML\s*=|insertAdjacentHTML\s*\(/g))) findings.push(make('security-unsafe-html-sink', 'high', 'Raw HTML injection sink requires sanitization review', 'Raw HTML sinks can turn untrusted data into DOM XSS.', file, match, 'Prefer React text rendering. If HTML is required, sanitize with an approved policy immediately before the sink.', ['xss', 'dom']));
  for (const match of limited(matches(file.text, /\b(?:eval|Function)\s*\(/g))) findings.push(make('security-dynamic-code-execution', 'critical', 'Dynamic code execution detected', 'eval/Function expands XSS impact and conflicts with a strict Content-Security-Policy.', file, match, 'Replace dynamic execution with explicit parsing/dispatch.', ['xss', 'csp'], true));
  for (const match of limited(matches(file.text, /(?:localStorage|sessionStorage)\.setItem\s*\(\s*["'`](?:token|accessToken|refreshToken|jwt|authorization)/gi))) findings.push(make('security-browser-token-storage', 'high', 'Authentication token stored in Web Storage', 'Web Storage is directly readable by injected script and should not hold bearer credentials.', file, match, 'Prefer server-managed HttpOnly Secure SameSite cookies or a bounded in-memory token strategy when architecture requires it.', ['token', 'browser-storage']));
  for (const match of limited(matches(file.text, /window\.open\s*\([^)]*,\s*["'`]_blank["'`](?![^)]*noopener)/gi))) findings.push(make('security-window-opener-isolation', 'medium', 'New browsing context may retain opener access', 'Opening _blank without opener isolation can expose the source window to reverse-tabnabbing behavior.', file, match, 'Use noopener/noreferrer semantics or explicitly null the opener.', ['navigation', 'tabnabbing']));
  return findings;
}

function backendFindings(file: SourceFile): Finding[] {
  if (file.kind !== 'csharp') return [];
  const findings: Finding[] = [];
  for (const match of limited(matches(file.text, /AllowAnyOrigin\s*\(\)|WithOrigins\s*\(\s*["']\*["']/g))) findings.push(make('security-permissive-cors', 'high', 'Permissive CORS policy detected', 'Wildcard browser origins broaden the trust boundary and can expose authenticated APIs.', file, match, 'Use an explicit environment-specific origin allowlist and avoid credentials with wildcard origins.', ['cors', 'backend']));
  for (const match of limited(matches(file.text, /ServerCertificateCustomValidationCallback\s*=\s*[^;]*(?:=>\s*true|return\s+true)/g))) findings.push(make('security-tls-validation-disabled', 'critical', 'TLS certificate validation appears disabled', 'Accepting arbitrary certificates enables man-in-the-middle attacks on backend outbound traffic.', file, match, 'Restore platform certificate validation; use test-only handlers behind explicit non-production composition.', ['tls', 'network'], true));
  for (const match of limited(matches(file.text, /new\s+SqlCommand\s*\(\s*\$?"[^"\n]*\{[^}]+\}[^"\n]*"/g))) findings.push(make('security-sql-interpolation', 'critical', 'Interpolated SQL command candidate', 'Building SQL with interpolation can allow injection when values originate from requests or data.', file, match, 'Use parameterized commands or the existing data-access abstraction.', ['injection', 'sql'], true));
  return findings;
}

function configFindings(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  if (/vite\.config\.|\.env/i.test(file.repositoryPath)) for (const match of limited(matches(file.text, /(?:VITE_|define\s*:)[^\n]*(?:SECRET|PASSWORD|PRIVATE_KEY|TOKEN)/gi))) findings.push(make('security-client-secret-exposure-contract', 'high', 'Client build configuration references secret-shaped data', 'Values exposed through Vite client configuration are bundled for browser access.', file, match, 'Keep secrets server-side and expose only non-sensitive public configuration to Vite.', ['vite', 'secret']));
  return findings;
}

function countRules(findings: readonly Finding[]): Readonly<Record<string, number>> { const result: Record<string, number> = {}; for (const finding of findings) result[finding.id] = (result[finding.id] ?? 0) + 1; return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b, 'en'))); }
export function auditSecurity(inventory: RepositoryInventory): AuditSection<SecurityAuditSummary> {
  const started = performance.now(); const files = inventory.files.filter(eligible); const findings = files.flatMap(file => [...secretFindings(file), ...browserFindings(file), ...backendFindings(file), ...configFindings(file)]);
  return { domain: 'security', title: 'Security boundary and credential regression audit', summary: { scannedFiles: files.length, secretCandidates: findings.filter(item => item.tags?.includes('secret')).length, unsafeHtmlCandidates: findings.filter(item => item.id === 'security-unsafe-html-sink').length, dynamicExecutionCandidates: findings.filter(item => item.id === 'security-dynamic-code-execution').length, insecureStorageCandidates: findings.filter(item => item.id === 'security-browser-token-storage').length, permissiveCorsCandidates: findings.filter(item => item.id === 'security-permissive-cors').length, findingsByRule: countRules(findings) }, findings, elapsedMs: performance.now() - started };
}
