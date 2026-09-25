import {
  normalizeRepositoryPath,
  safeJsonParse,
  type AuditDomain,
  type Severity,
} from './contracts.mts';

export type ChangeRiskArea = 'security' | 'backend-api' | 'gis' | 'data' | 'search' | 'frontend-runtime' | 'accessibility' | 'responsive' | 'dependencies' | 'ci' | 'release-tooling' | 'database' | 'observability' | 'performance' | 'configuration';
export interface ChangeRiskPolicy { readonly area: ChangeRiskArea; readonly domain: AuditDomain; readonly uncoveredSeverity: Severity; readonly title: string; readonly description: string; readonly pathPatterns: readonly RegExp[]; readonly contentPatterns?: readonly RegExp[]; readonly testPatterns: readonly RegExp[]; readonly validationPatterns?: readonly RegExp[]; readonly requiresFocusedEvidence: boolean; readonly blockingWhenUncovered?: boolean; }
export interface DependencyChangeSummary { readonly changed: boolean; readonly added: readonly string[]; readonly removed: readonly string[]; readonly versionChanged: readonly string[]; readonly invalidBaseline: boolean; readonly invalidCurrent: boolean; }
export interface PathNature { readonly path: string; readonly test: boolean; readonly documentation: boolean; readonly generated: boolean; readonly workflow: boolean; readonly manifest: boolean; readonly lockfile: boolean; readonly releaseValidation: boolean; readonly productionCandidate: boolean; }

const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|\.Tests?\//iu;
const DOCUMENTATION_PATH = /(?:^|\/)(?:docs?|_docs|progress)(?:\/|$)|(?:^|\/)KENT_REHBERI_[^/]*\.md$|\.mdx?$/iu;
const GENERATED_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage|bin|obj|TestResults|artifacts|qa-artifacts)(?:\/|$)/iu;
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/iu;
const PACKAGE_MANIFEST = /(?:^|\/)package\.json$/iu;
const PACKAGE_LOCK = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/iu;
const RELEASE_VALIDATION_PATH = /^(?:quality\/release\/|Webclient\.app\/scripts\/(?:release-|workflow-|verify-chain|typecheck-regression|vitest-regression)|tools\/(?:platform-|package-lock-integrity|browser-runtime-boundary))/iu;
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|cs|css|scss|sass|less|html?|json|ya?ml|sql|xml|csproj|props|targets)$/iu;
const SECURITY_PATH = /(?:^|\/)(?:auth|authentication|authorization|security|identity|token|session|cookie|cors|crypto|permission|credential|secret|csrf|xss)(?:[._/-]|$)/iu;
const SECURITY_CONTENT = /(?:\bAuthorize\b|\bAllowAnonymous\b|AddAuthentication\b|AddAuthorization\b|UseAuthentication\b|UseAuthorization\b|AddCors\b|UseCors\b|localStorage\b|sessionStorage\b|Authorization\b|Bearer\b|Set-Cookie\b|SameSite\b|HttpOnly\b|SecurePolicy\b|dangerouslySetInnerHTML\b|FromSqlRaw\b|ExecuteSqlRaw\b|RemoteCertificateValidationCallback\b)/u;
const BACKEND_API_PATH = /^(?:Api\.(?:Admin|User|Core)|Business|Operations)\//u;
const BACKEND_API_CONTENT = /(?:\[(?:HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|Route|ApiController)\b|ControllerBase\b|Map(?:Get|Post|Put|Delete|Patch)\b|HttpClient\b)/u;
const GIS_PATH = /(?:^|\/)(?:gis|map|scene|spatial|arcgis|geometry|graphics|layer|feature|viewport|camera|cluster|basemap|geocode)(?:[._/-]|$)/iu;
const GIS_CONTENT = /(?:@arcgis\/core|SceneView\b|MapView\b|FeatureLayer\b|GraphicsLayer\b|MapImageLayer\b|FeatureServer\b|MapServer\b|goTo\b|queryFeatures\b|geometryEngine\b)/u;
const DATA_PATH = /(?:^|\/)(?:data|repository|store|cache|dataset|registry|model|entity|dto|schema)(?:[._/-]|$)|(?:Data|Repository|Store|Cache|Dataset|Registry|Model|Entity|Dto|Schema)(?=[A-Z._/-]|$)/u;
const SEARCH_PATH = /(?:^|\/)(?:search|address|geocode|autocomplete|suggest)(?:[._/-]|$)/iu;
const FRONTEND_PATH = /^Webclient\.(?:app|admin)\/(?:src|tooling|scripts)\//u;
const ACCESSIBILITY_PATH = /(?:^|\/)(?:accessibility|a11y|dialog|drawer|popover|modal|focus|keyboard)(?:[._/-]|$)/iu;
const ACCESSIBILITY_CONTENT = /(?:aria-[a-z-]+|tabIndex\b|onKeyDown\b|role=|focus\(|inert\b|prefers-reduced-motion|forced-colors)/u;
const RESPONSIVE_PATH = /(?:^|\/)(?:responsive|layout|viewport|breakpoint|mobile|drawer|sidebar)(?:[._/-]|$)|(?:responsive|layout|viewport|breakpoint|mobile|drawer|sidebar)(?=[A-Z._/-]|$)/u;
const RESPONSIVE_CONTENT = /(?:@media\b|@container\b|100vh\b|100dvh\b|min-width\b|max-width\b|ResizeObserver\b|matchMedia\b)/u;
const DEPENDENCY_PATH = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Directory\.Packages\.props|global\.json|[^/]+\.csproj)$/iu;
const CI_PATH = /^\.github\//u;
const DATABASE_PATH = /(?:^|\/)(?:database|migrations?|sql|seed|schema)(?:\/|[._-]|$)|\.sql$/iu;
const DATABASE_CONTENT = /(?:\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b|\bDROP\s+TABLE\b|\bTRUNCATE\s+TABLE\b|\bCREATE\s+INDEX\b|\bDbContext\b|\bMigrationBuilder\b)/iu;
const OBSERVABILITY_PATH = /(?:^|\/)(?:logging|logger|telemetry|metrics|observability|diagnostic|tracing|correlation)(?:[._/-]|$)/iu;
const OBSERVABILITY_CONTENT = /(?:ILogger\b|console\.(?:log|warn|error|info)\b|PerformanceObserver\b|traceId\b|correlationId\b|meter\b|ActivitySource\b)/u;
const PERFORMANCE_PATH = /(?:^|\/)(?:performance|budget|cache|worker|virtual|scheduler|queue|throttle|debounce|memo)(?:[._/-]|$)/iu;
const PERFORMANCE_CONTENT = /(?:requestAnimationFrame\b|setInterval\b|setTimeout\b|Promise\.all\b|Worker\b|OffscreenCanvas\b|memo\b|useMemo\b|useCallback\b)/u;
const CONFIG_PATH = /(?:^|\/)(?:appsettings(?:\.[^/]+)?\.json|launchSettings\.json|vite\.config\.[cm]?[jt]s|tsconfig(?:\.[^/]+)?\.json|Directory\.Build\.props|global\.json|\.env(?:\.[^/]+)?|web\.config|nginx\.conf)$/iu;
const SECURITY_TEST = /(?:^|\/)(?:tests?|__tests__)[^/]*\/.*(?:security|auth|authorization|token|session|cors)|(?:security|auth|authorization|token|session|cors).*\.(?:test|spec)\.[cm]?[jt]s|Platform\.Security\.Tests/iu;
const BACKEND_TEST = /^(?:tests\/|.*\.Tests?\/).*\.cs$/iu;
const GIS_TEST = /(?:gis|map|scene|spatial|arcgis|geometry|layer|feature|viewport|camera|cluster).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const DATA_TEST = /(?:data|repository|store|cache|dataset|registry|schema).*\.(?:test|spec)\.[cm]?[jt]s$|^(?:tests\/|.*\.Tests?\/).*\.cs$/iu;
const SEARCH_TEST = /(?:search|address|geocode|autocomplete|suggest).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const FRONTEND_TEST = /^Webclient\.(?:app|admin)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const ACCESSIBILITY_TEST = /(?:accessibility|a11y|dialog|drawer|popover|modal|focus|keyboard).*\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const RESPONSIVE_TEST = /(?:responsive|layout|viewport|breakpoint|mobile|drawer|sidebar).*\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const DEPENDENCY_TEST = /(?:dependency|package-lock|lockfile|manifest).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const CI_TEST = /(?:workflow|release-evidence|verify-chain|validation-integrity|ci-integrity).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const RELEASE_TEST = /^quality\/release\/.*\.test\.mts$/u;
const DATABASE_TEST = /(?:database|migration|sql|schema|repository).*\.(?:test|spec)\.[cm]?[jt]s$|^(?:tests\/|.*\.Tests?\/).*\.cs$/iu;
const OBSERVABILITY_TEST = /(?:observability|logging|logger|telemetry|metrics|diagnostic|tracing|correlation).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const PERFORMANCE_TEST = /(?:performance|budget|cache|worker|scheduler|queue|throttle|debounce).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const CONFIG_TEST = /(?:config|environment|runtime-config|validation-integrity|platform-contracts).*\.(?:test|spec)\.[cm]?[jt]s$/iu;
const WORKFLOW_VALIDATION = /^\.github\/workflows\/(?:webclient-quality|release-qa|release-evidence-contract|platform-architecture-audit|platform-typed-test-validation)\.ya?ml$/u;
const RELEASE_TOOL_VALIDATION = /^quality\/release\/.*\.test\.mts$/u;
const PLATFORM_VALIDATION = /^tools\/(?:platform-|browser-runtime-boundary|package-lock-integrity).*\.test\.mjs$/u;

const POLICIES: readonly ChangeRiskPolicy[] = Object.freeze([
  { area: 'security', domain: 'security', uncoveredSeverity: 'high', title: 'Security-sensitive change lacks focused regression evidence', description: 'Authentication, authorization, token/session, CORS, credential and unsafe-sink changes require focused security validation.', pathPatterns: [SECURITY_PATH], contentPatterns: [SECURITY_CONTENT], testPatterns: [SECURITY_TEST], validationPatterns: [RELEASE_TEST, CI_TEST], requiresFocusedEvidence: true },
  { area: 'backend-api', domain: 'security', uncoveredSeverity: 'high', title: 'Backend API change lacks focused regression evidence', description: 'Controller, endpoint and outbound HTTP changes require backend contract or security tests.', pathPatterns: [BACKEND_API_PATH], contentPatterns: [BACKEND_API_CONTENT], testPatterns: [BACKEND_TEST], validationPatterns: [WORKFLOW_VALIDATION], requiresFocusedEvidence: true },
  { area: 'gis', domain: 'gis', uncoveredSeverity: 'high', title: 'GIS runtime change lacks focused regression evidence', description: '2D/3D GIS, ArcGIS, layer, geometry, query and viewport changes require focused GIS regression coverage.', pathPatterns: [GIS_PATH], contentPatterns: [GIS_CONTENT], testPatterns: [GIS_TEST], validationPatterns: [WORKFLOW_VALIDATION, RELEASE_TEST], requiresFocusedEvidence: true },
  { area: 'data', domain: 'data', uncoveredSeverity: 'high', title: 'Data-model or repository change lacks regression evidence', description: 'Repository, store, cache, dataset and schema changes need focused integrity coverage.', pathPatterns: [DATA_PATH], testPatterns: [DATA_TEST], validationPatterns: [RELEASE_TEST], requiresFocusedEvidence: true },
  { area: 'search', domain: 'search', uncoveredSeverity: 'high', title: 'Search/address change lacks focused regression evidence', description: 'Search, address, geocoding and suggestion behavior changes require focused regression coverage.', pathPatterns: [SEARCH_PATH], testPatterns: [SEARCH_TEST], validationPatterns: [WORKFLOW_VALIDATION], requiresFocusedEvidence: true },
  { area: 'frontend-runtime', domain: 'architecture', uncoveredSeverity: 'medium', title: 'Frontend runtime change lacks adjacent tests', description: 'Runtime frontend changes should be accompanied by changed tests unless a more focused area policy already supplies evidence.', pathPatterns: [FRONTEND_PATH], testPatterns: [FRONTEND_TEST], validationPatterns: [WORKFLOW_VALIDATION], requiresFocusedEvidence: true },
  { area: 'accessibility', domain: 'accessibility', uncoveredSeverity: 'high', title: 'Accessibility-sensitive UI change lacks focused tests', description: 'Focus, keyboard, ARIA, modal surface and reduced-motion behavior require explicit accessibility regression evidence.', pathPatterns: [ACCESSIBILITY_PATH], contentPatterns: [ACCESSIBILITY_CONTENT], testPatterns: [ACCESSIBILITY_TEST], validationPatterns: [RELEASE_TEST], requiresFocusedEvidence: true },
  { area: 'responsive', domain: 'responsive', uncoveredSeverity: 'medium', title: 'Responsive/layout change lacks focused tests', description: 'Viewport, breakpoint and adaptive layout changes should have focused responsive regression evidence.', pathPatterns: [RESPONSIVE_PATH], contentPatterns: [RESPONSIVE_CONTENT], testPatterns: [RESPONSIVE_TEST], validationPatterns: [RELEASE_TEST], requiresFocusedEvidence: true },
  { area: 'dependencies', domain: 'dependencies', uncoveredSeverity: 'high', title: 'Dependency change lacks lockfile or dependency validation evidence', description: 'Dependency graph mutations require deterministic lockfile and validation evidence.', pathPatterns: [DEPENDENCY_PATH], testPatterns: [DEPENDENCY_TEST], validationPatterns: [WORKFLOW_VALIDATION, RELEASE_TEST, PLATFORM_VALIDATION], requiresFocusedEvidence: false },
  { area: 'ci', domain: 'build', uncoveredSeverity: 'high', title: 'CI workflow change lacks adversarial contract coverage', description: 'GitHub Actions changes require workflow security/reliability tests or typed release validation updates.', pathPatterns: [CI_PATH], testPatterns: [CI_TEST, RELEASE_TEST], validationPatterns: [RELEASE_TOOL_VALIDATION], requiresFocusedEvidence: true },
  { area: 'release-tooling', domain: 'release', uncoveredSeverity: 'high', title: 'Release tooling change lacks direct regression tests', description: 'Changes to release gate implementation must update or add typed release tests.', pathPatterns: [RELEASE_VALIDATION_PATH], testPatterns: [RELEASE_TEST, CI_TEST, PLATFORM_VALIDATION], validationPatterns: [WORKFLOW_VALIDATION], requiresFocusedEvidence: true },
  { area: 'database', domain: 'data', uncoveredSeverity: 'high', title: 'Database or migration change lacks regression evidence', description: 'Schema, migration and SQL changes require focused database/repository validation.', pathPatterns: [DATABASE_PATH], contentPatterns: [DATABASE_CONTENT], testPatterns: [DATABASE_TEST], validationPatterns: [WORKFLOW_VALIDATION], requiresFocusedEvidence: true },
  { area: 'observability', domain: 'observability', uncoveredSeverity: 'medium', title: 'Observability change lacks focused regression evidence', description: 'Logging, metrics, tracing and correlation changes should preserve bounded diagnostics and privacy contracts.', pathPatterns: [OBSERVABILITY_PATH], contentPatterns: [OBSERVABILITY_CONTENT], testPatterns: [OBSERVABILITY_TEST], validationPatterns: [RELEASE_TEST], requiresFocusedEvidence: true },
  { area: 'performance', domain: 'performance', uncoveredSeverity: 'medium', title: 'Performance-sensitive change lacks focused evidence', description: 'Scheduling, caching, queueing and hot-path changes should include focused performance/budget regression evidence.', pathPatterns: [PERFORMANCE_PATH], contentPatterns: [PERFORMANCE_CONTENT], testPatterns: [PERFORMANCE_TEST], validationPatterns: [WORKFLOW_VALIDATION, RELEASE_TEST], requiresFocusedEvidence: true },
  { area: 'configuration', domain: 'architecture', uncoveredSeverity: 'medium', title: 'Configuration/toolchain change lacks validation evidence', description: 'Runtime/build configuration changes should include validation or contract coverage.', pathPatterns: [CONFIG_PATH], testPatterns: [CONFIG_TEST, RELEASE_TEST], validationPatterns: [WORKFLOW_VALIDATION, PLATFORM_VALIDATION], requiresFocusedEvidence: true },
]);
export const CHANGE_RISK_POLICIES: readonly ChangeRiskPolicy[] = POLICIES;
export const RELEASE_CRITICAL_VALIDATION_PATHS: readonly RegExp[] = Object.freeze([/^\.github\/workflows\/release-qa\.ya?ml$/u, /^\.github\/workflows\/webclient-quality\.ya?ml$/u, /^\.github\/workflows\/release-evidence-contract\.ya?ml$/u, /^\.github\/workflows\/platform-architecture-audit\.ya?ml$/u, /^quality\/release\/release-engine\.mts$/u, /^quality\/release\/pr-gate\.mts$/u, /^quality\/release\/workflow-evidence-audit\.mts$/u, /^quality\/release\/release-evidence-matrix\.mts$/u, /^Webclient\.app\/scripts\/release-evidence-audit\.mjs$/u]);
function matchesAny(value: string, patterns: readonly RegExp[]): boolean { return patterns.some(pattern => pattern.test(value)); }
export function isTestPath(input: string): boolean { return TEST_PATH.test(normalizeRepositoryPath(input)); }
export function isDocumentationPath(input: string): boolean { return DOCUMENTATION_PATH.test(normalizeRepositoryPath(input)); }
export function isGeneratedPath(input: string): boolean { return GENERATED_PATH.test(normalizeRepositoryPath(input)); }
export function isWorkflowPath(input: string): boolean { return WORKFLOW_PATH.test(normalizeRepositoryPath(input)); }
export function isPackageManifestPath(input: string): boolean { return PACKAGE_MANIFEST.test(normalizeRepositoryPath(input)); }
export function isPackageLockPath(input: string): boolean { return PACKAGE_LOCK.test(normalizeRepositoryPath(input)); }
export function isReleaseValidationPath(input: string): boolean { const path = normalizeRepositoryPath(input); return RELEASE_VALIDATION_PATH.test(path) || WORKFLOW_VALIDATION.test(path) || PLATFORM_VALIDATION.test(path); }
export function isReleaseCriticalValidationPath(input: string): boolean { const path = normalizeRepositoryPath(input); return RELEASE_CRITICAL_VALIDATION_PATHS.some(pattern => pattern.test(path)); }
export function isProductionCandidatePath(input: string): boolean { const path = normalizeRepositoryPath(input); if (isGeneratedPath(path) || isDocumentationPath(path) || isTestPath(path)) return false; if (path.startsWith('.github/')) return false; return SOURCE_EXTENSION.test(path); }
export function pathNature(input: string): PathNature { const path = normalizeRepositoryPath(input); return { path, test: isTestPath(path), documentation: isDocumentationPath(path), generated: isGeneratedPath(path), workflow: isWorkflowPath(path), manifest: isPackageManifestPath(path), lockfile: isPackageLockPath(path), releaseValidation: isReleaseValidationPath(path), productionCandidate: isProductionCandidatePath(path) }; }
export function policyForArea(area: ChangeRiskArea): ChangeRiskPolicy { const policy = POLICIES.find(candidate => candidate.area === area); if (!policy) throw new Error(`Unknown change-risk area: ${area}`); return policy; }

export function classifyRiskAreas(input: string, text = ''): readonly ChangeRiskArea[] {
  const path = normalizeRepositoryPath(input);
  if (isGeneratedPath(path) || isDocumentationPath(path) || isTestPath(path)) return [];
  const releaseValidation = isReleaseValidationPath(path);
  const areas = new Set<ChangeRiskArea>();
  for (const policy of POLICIES) {
    const pathMatch = matchesAny(path, policy.pathPatterns);
    // Release-governance source defines the classifiers themselves. Treating those regex literals as
    // application content creates circular ownership (for example BACKEND_API_CONTENT containing
    // "HttpClient"). Path ownership still classifies these files as release-tooling; real application
    // sources continue to receive content-based classification.
    const contentMatch = !releaseValidation && policy.contentPatterns ? matchesAny(text, policy.contentPatterns) : false;
    if (pathMatch || contentMatch) areas.add(policy.area);
  }
  return [...areas].sort((left, right) => left.localeCompare(right, 'en'));
}
export function testSupportsArea(input: string, area: ChangeRiskArea): boolean { const path = normalizeRepositoryPath(input); if (!isTestPath(path)) return false; return matchesAny(path, policyForArea(area).testPatterns); }
export function validationSupportsArea(input: string, area: ChangeRiskArea): boolean { const path = normalizeRepositoryPath(input); const patterns = policyForArea(area).validationPatterns ?? []; return matchesAny(path, patterns); }
export function evidenceSupportsArea(input: string, area: ChangeRiskArea): boolean { return testSupportsArea(input, area) || validationSupportsArea(input, area); }
export function workspaceDirectory(input: string): string { const path = normalizeRepositoryPath(input); const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index); }
export function packageLockCandidates(manifestPath: string): readonly string[] { const directory = workspaceDirectory(manifestPath); const prefix = directory ? `${directory}/` : ''; return [`${prefix}package-lock.json`, `${prefix}pnpm-lock.yaml`, `${prefix}yarn.lock`, `${prefix}bun.lock`, `${prefix}bun.lockb`]; }
function dependencyMap(value: unknown): Readonly<Record<string, string>> { if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; const record = value as Record<string, unknown>; const result: Record<string, string> = {}; for (const [name, version] of Object.entries(record)) if (typeof version === 'string') result[name] = version; return result; }
function manifestDependencies(text: string): { readonly ok: boolean; readonly values: Readonly<Record<string, string>> } { const parsed = safeJsonParse<Record<string, unknown>>(text); if (!parsed.ok || !parsed.value) return { ok: false, values: {} }; const result: Record<string, string> = {}; for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) for (const [name, version] of Object.entries(dependencyMap(parsed.value[field]))) result[`${field}:${name}`] = version; return { ok: true, values: result }; }
export function compareManifestDependencies(baselineText: string, currentText: string): DependencyChangeSummary { const baseline = manifestDependencies(baselineText); const current = manifestDependencies(currentText); const names = new Set([...Object.keys(baseline.values), ...Object.keys(current.values)]); const added: string[] = []; const removed: string[] = []; const versionChanged: string[] = []; for (const name of names) { const before = baseline.values[name]; const after = current.values[name]; if (before === undefined && after !== undefined) added.push(name); else if (before !== undefined && after === undefined) removed.push(name); else if (before !== after) versionChanged.push(name); } added.sort((a,b)=>a.localeCompare(b,'en')); removed.sort((a,b)=>a.localeCompare(b,'en')); versionChanged.sort((a,b)=>a.localeCompare(b,'en')); return { changed: added.length > 0 || removed.length > 0 || versionChanged.length > 0, added, removed, versionChanged, invalidBaseline: !baseline.ok, invalidCurrent: !current.ok }; }
export function areaEvidencePaths(paths: readonly string[], area: ChangeRiskArea): readonly string[] { return paths.map(normalizeRepositoryPath).filter(path => evidenceSupportsArea(path, area)).sort((a,b)=>a.localeCompare(b,'en')); }
export function productionPathsForArea(files: readonly { readonly path: string; readonly text: string }[], area: ChangeRiskArea): readonly string[] { return files.filter(file => classifyRiskAreas(file.path, file.text).includes(area)).map(file => normalizeRepositoryPath(file.path)).sort((a,b)=>a.localeCompare(b,'en')); }
