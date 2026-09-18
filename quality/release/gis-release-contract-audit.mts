import {
  stableSortFindings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type Severity,
  type SourceFile,
} from './contracts.mts';

interface GisRule {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly pattern: RegExp;
  readonly tag: string;
  readonly blocking: boolean;
}

export interface GisReleaseContractSummary {
  readonly scannedFiles: number;
  readonly gisEngineFiles: number;
  readonly mapShellFiles: number;
  readonly queryFiles: number;
  readonly moduleBoundaryViolations: number;
  readonly forbiddenProtocolFindings: number;
  readonly credentialFindings: number;
  readonly directTransportFindings: number;
  readonly lifecycleFindings: number;
  readonly performanceFindings: number;
  readonly recoveryContracts: readonly string[];
  readonly cancellationContracts: readonly string[];
  readonly ownershipContracts: readonly string[];
  readonly findingsByRule: Readonly<Record<string, number>>;
}

const GENERATED = /(^|\/)(?:node_modules|dist|build|coverage|bin|obj|qa-artifacts)(?:\/|$)/i;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|\.|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GIS_PATH = /^Webclient\.app\/src\/(?:gis-engine\/|Components\/(?:App|Query|Map|GIS)\/|Toolbox\/Gis)/i;
const APPROVED_LOADER = /Webclient\.app\/src\/gis-engine\/(?:arcgisModuleLoader|arcgisModuleTransport)\.[cm]?[jt]sx?$/i;
const APPROVED_TRANSPORT = /Webclient\.app\/src\/gis-engine\/(?:arcgisRestTransport|arcgisRequestTransport|arcgisModuleLoader|arcgisModuleTransport)\.[cm]?[jt]sx?$/i;
const ICON_AUTHORITY = /Webclient\.app\/src\/gis-engine\/(?:iconResolver|iconPresentation|iconRegistryRuntime)\.[cm]?[jt]sx?$/i;
const SERVICE_AUTHORITY = /Webclient\.app\/src\/gis-engine\/(?:serviceRegistry|serviceCatalog|arcgisRestTransport)\.[cm]?[jt]sx?$/i;

const RULES: readonly GisRule[] = [
  {
    id: 'gis-forbidden-wms',
    severity: 'critical',
    title: 'Forbidden WMS integration detected',
    message: 'Repository policy explicitly forbids introducing WMS integrations.',
    pattern: new RegExp('\\bWMS\\b|service=WMS|/wms(?:\\?|/|$)', 'gi'),
    tag: 'protocol',
    blocking: true,
  },
  {
    id: 'gis-forbidden-wfs',
    severity: 'critical',
    title: 'Forbidden WFS integration detected',
    message: 'Repository policy explicitly forbids introducing WFS integrations.',
    pattern: new RegExp('\\bWFS\\b|service=WFS|/wfs(?:\\?|/|$)', 'gi'),
    tag: 'protocol',
    blocking: true,
  },
  {
    id: 'gis-forbidden-wmts',
    severity: 'critical',
    title: 'Forbidden WMTS integration detected',
    message: 'Repository policy does not permit a new WMTS path without explicit architecture approval.',
    pattern: new RegExp('\\bWMTS\\b|service=WMTS|/wmts(?:\\?|/|$)', 'gi'),
    tag: 'protocol',
    blocking: true,
  },
  {
    id: 'gis-direct-esri-loader',
    severity: 'high',
    title: 'Direct esri-loader dependency bypasses the module boundary',
    message: 'ArcGIS module loading must be centralized so the transport can move toward @arcgis/core without touching feature code.',
    pattern: new RegExp('(?:from\\s+["\']esri-loader["\']|require\\s*\\(\\s*["\']esri-loader["\'])', 'gi'),
    tag: 'module-boundary',
    blocking: false,
  },
  {
    id: 'gis-api-key-literal',
    severity: 'critical',
    title: 'ArcGIS credential-like literal detected',
    message: 'API keys and tokens must never be embedded in browser GIS source.',
    pattern: new RegExp('(?:apiKey|accessToken|token)\\s*[:=]\\s*["\'][A-Za-z0-9_-]{20,}["\']', 'gi'),
    tag: 'credential',
    blocking: true,
  },
  {
    id: 'gis-http-service',
    severity: 'high',
    title: 'Insecure GIS service URL detected',
    message: 'GIS service traffic must use HTTPS or an approved same-origin backend proxy.',
    pattern: new RegExp('http://[^\\s"\']+(?:MapServer|FeatureServer|SceneServer|ImageServer)', 'gi'),
    tag: 'network',
    blocking: false,
  },
  {
    id: 'gis-axios-runtime',
    severity: 'high',
    title: 'GIS runtime bypasses the approved transport with axios',
    message: 'GIS runtime requests should use the repository transport abstraction for timeout, cancellation, dedupe and policy enforcement.',
    pattern: new RegExp('\\baxios\\.(?:get|post|request)\\s*\\(', 'gi'),
    tag: 'network',
    blocking: false,
  },
  {
    id: 'gis-xhr-runtime',
    severity: 'high',
    title: 'GIS runtime uses XMLHttpRequest directly',
    message: 'Direct XHR bypasses the typed transport and cancellation policy.',
    pattern: new RegExp('\\bnew\\s+XMLHttpRequest\\s*\\(', 'gi'),
    tag: 'network',
    blocking: false,
  },
  {
    id: 'gis-outfields-star',
    severity: 'low',
    title: 'Query requests all fields',
    message: 'outFields [\'*\'] increases payload size and weakens data minimization.',
    pattern: new RegExp('outFields\\s*:\\s*\\[?\\s*["\']\\*["\']', 'gi'),
    tag: 'data-minimization',
    blocking: false,
  },
  {
    id: 'gis-return-geometry',
    severity: 'info',
    title: 'Query explicitly returns geometry',
    message: 'Geometry payloads can be large; ensure the consumer really needs geometry and applies feature/page budgets.',
    pattern: new RegExp('returnGeometry\\s*:\\s*true', 'gi'),
    tag: 'data-minimization',
    blocking: false,
  },
  {
    id: 'gis-unbounded-loop',
    severity: 'high',
    title: 'Potentially unbounded GIS loop detected',
    message: 'Infinite loops in query/render orchestration need an explicit break/deadline/budget contract.',
    pattern: new RegExp('\\bwhile\\s*\\(\\s*true\\s*\\)', 'gi'),
    tag: 'runtime',
    blocking: false,
  },
  {
    id: 'gis-promise-all-features',
    severity: 'low',
    title: 'Feature collection is processed with unbounded Promise.all',
    message: 'Large GIS collections should use bounded concurrency to avoid memory and network bursts.',
    pattern: new RegExp('Promise\\.all\\s*\\(\\s*[^\\n;]*features\\.(?:map|flatMap)\\s*\\(', 'gi'),
    tag: 'performance',
    blocking: false,
  },
  {
    id: 'gis-watch-utils',
    severity: 'low',
    title: 'Legacy watchUtils usage remains',
    message: 'Prefer reactiveUtils/watch handles with explicit disposal for current ArcGIS runtimes.',
    pattern: new RegExp('\\bwatchUtils\\.', 'gi'),
    tag: 'lifecycle',
    blocking: false,
  },
  {
    id: 'gis-querytask-constructor',
    severity: 'low',
    title: 'Legacy QueryTask constructor remains',
    message: 'Prefer modern layer/query APIs or a typed compatibility boundary to reduce legacy SDK coupling.',
    pattern: new RegExp('\\bnew\\s+QueryTask\\s*\\(', 'gi'),
    tag: 'sdk',
    blocking: false,
  },
  {
    id: 'gis-loadmodules-direct',
    severity: 'high',
    title: 'Direct loadModules call bypasses the approved ArcGIS loader boundary',
    message: 'Feature modules should depend on the typed ArcGIS module loader rather than invoking loadModules themselves.',
    pattern: new RegExp('\\bloadModules\\s*\\(', 'gi'),
    tag: 'module-boundary',
    blocking: false,
  },
  {
    id: 'gis-token-query-parameter',
    severity: 'high',
    title: 'Token is appended to a GIS URL',
    message: 'Bearer/API tokens should not be assembled into browser-visible query strings.',
    pattern: new RegExp('[?&]token=\\$?\\{?[^\\s&"\']+', 'gi'),
    tag: 'credential',
    blocking: false,
  },
  {
    id: 'gis-geometry-engine-sync-loop',
    severity: 'low',
    title: 'Synchronous geometry engine work appears inside iteration',
    message: 'Large geometry sets should use bounded or worker-capable processing and avoid blocking the UI thread.',
    pattern: new RegExp('(?:for\\s*\\([^)]*\\)|\\.forEach\\s*\\([^)]*)[\\s\\S]{0,180}\\bgeometryEngine\\.', 'gi'),
    tag: 'performance',
    blocking: false,
  },
  {
    id: 'gis-layer-url-literal',
    severity: 'info',
    title: 'Layer constructor embeds an absolute ArcGIS service URL',
    message: 'Central service registries improve environment control, dedupe and security review.',
    pattern: new RegExp('new\\s+(?:FeatureLayer|MapImageLayer|SceneLayer|TileLayer)\\s*\\(\\s*\\{[\\s\\S]{0,180}url\\s*:\\s*["\']https?://', 'gi'),
    tag: 'service-registry',
    blocking: false,
  },
  {
    id: 'gis-icon-asset-literal',
    severity: 'info',
    title: 'GIS runtime embeds an icon asset path',
    message: 'Use the shared icon resolver/registry so 2D, 3D and list views remain deterministic.',
    pattern: new RegExp('["\'][^"\']*images\\/[^"\']+\\.(?:svg|png|webp)["\']', 'gi'),
    tag: 'icons',
    blocking: false,
  },
  {
    id: 'gis-debug-graphics-add',
    severity: 'info',
    title: 'Graphics are appended directly',
    message: 'Direct graphics accumulation should be bounded or owned by a lifecycle-aware collection.',
    pattern: new RegExp('\\.graphics\\.add(?:Many)?\\s*\\(', 'gi'),
    tag: 'ownership',
    blocking: false,
  },
];

function eligible(file: SourceFile): boolean {
  return GIS_PATH.test(file.repositoryPath)
    && (file.kind === 'javascript' || file.kind === 'typescript')
    && !GENERATED.test(file.repositoryPath)
    && !TEST_FILE.test(file.repositoryPath);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 199)}…`;
}

function remediation(rule: GisRule): string {
  if (rule.tag === 'protocol') return 'Remove the WMS/WFS/WMTS path and use the repository-verified ArcGIS REST MapServer/FeatureServer/service contract.';
  if (rule.tag === 'module-boundary') return 'Route ArcGIS module acquisition through the typed arcgisModuleLoader/transport boundary.';
  if (rule.tag === 'credential') return 'Remove browser-visible credentials. Use server-side authorization or approved runtime credential handling without committing secrets.';
  if (rule.tag === 'network') return 'Use the approved GIS transport with HTTPS, timeout, AbortSignal cancellation, dedupe and bounded retry.';
  if (rule.tag === 'data-minimization') return 'Request only required fields/geometry and preserve maxFeatures/maxPages budgets.';
  if (rule.tag === 'performance') return 'Use bounded concurrency/work budgets and avoid unbounded geometry or feature fan-out on the main thread.';
  if (rule.tag === 'lifecycle' || rule.tag === 'ownership') return 'Register the ArcGIS handle/resource with deterministic teardown and bounded ownership.';
  if (rule.tag === 'service-registry') return 'Move environment-specific service URLs to the shared service registry/catalog.';
  if (rule.tag === 'icons') return 'Resolve symbols through the shared icon registry/resolver and preserve the default fallback.';
  return 'Migrate this GIS path to the repository typed ArcGIS runtime contract and protect it with regression coverage.';
}

function ruleAllowed(file: SourceFile, rule: GisRule): boolean {
  if ((rule.id === 'gis-direct-esri-loader' || rule.id === 'gis-loadmodules-direct') && APPROVED_LOADER.test(file.repositoryPath)) return false;
  if ((rule.id === 'gis-axios-runtime' || rule.id === 'gis-xhr-runtime') && APPROVED_TRANSPORT.test(file.repositoryPath)) return false;
  if (rule.id === 'gis-layer-url-literal' && SERVICE_AUTHORITY.test(file.repositoryPath)) return false;
  if (rule.id === 'gis-icon-asset-literal' && ICON_AUTHORITY.test(file.repositoryPath)) return false;
  return true;
}

function findingsForRule(file: SourceFile, rule: GisRule): Finding[] {
  if (!ruleAllowed(file, rule)) return [];
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
  const uniqueMatches: { readonly match: RegExpMatchArray; readonly line: number }[] = [];
  const seenLines = new Set<number>();
  for (const match of file.text.matchAll(pattern)) {
    const line = lineAt(file.text, match.index ?? 0);
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    uniqueMatches.push({ match, line });
    if (uniqueMatches.length >= 2) break;
  }
  return uniqueMatches.map(({ match, line }) => ({
    id: rule.id,
    domain: rule.tag === 'icons' ? 'icons' : rule.tag === 'network' || rule.tag === 'credential' ? 'network' : 'gis',
    severity: rule.severity,
    title: rule.title,
    message: rule.message,
    location: {
      file: file.repositoryPath,
      line,
    },
    evidence: {
      excerpt: compact(match[0]),
    },
    remediation: remediation(rule),
    tags: ['gis-release-contract', rule.tag],
    ...(rule.blocking ? { blocking: true } : {}),
  }));
}

function directFetchFinding(file: SourceFile): Finding[] {
  if (APPROVED_TRANSPORT.test(file.repositoryPath)) return [];
  const matches = [...file.text.matchAll(/\bfetch\s*\(/g)].slice(0, 2);
  return matches.map(match => ({
    id: 'gis-direct-fetch',
    domain: 'network',
    severity: 'high',
    title: 'GIS module calls fetch outside the approved transport',
    message: 'Direct browser fetch bypasses the shared timeout, cancellation, dedupe and policy boundary.',
    location: { file: file.repositoryPath, line: lineAt(file.text, match.index ?? 0) },
    evidence: { excerpt: compact(match[0]) },
    remediation: 'Inject or call the shared ArcGIS REST transport rather than using fetch directly.',
    tags: ['gis-release-contract', 'network'],
  }));
}

function sceneRecoveryFinding(file: SourceFile): Finding[] {
  if (!/fatalError/.test(file.text)) return [];
  if (/tryFatalErrorRecovery\s*\(/.test(file.text)) return [];
  return [{
    id: 'gis-scene-fatal-recovery-missing',
    domain: 'gis',
    severity: 'medium',
    title: 'SceneView fatal-error observation lacks recovery evidence',
    message: 'A SceneView fatalError path is observed without a visible bounded tryFatalErrorRecovery contract.',
    location: { file: file.repositoryPath, line: lineAt(file.text, file.text.indexOf('fatalError')) },
    remediation: 'Use bounded/cooldown-protected tryFatalErrorRecovery and enter a degraded state after the retry budget is exhausted.',
    tags: ['gis-release-contract', 'sceneview', 'webgl'],
  }];
}

function paginationFinding(file: SourceFile): Finding[] {
  const pagination = /resultOffset|start\s*[:=]|exceededTransferLimit/.test(file.text);
  if (!pagination) return [];
  const bounded = /maxPages|maxFeatures|pageBudget|featureBudget|remainingPages|remainingFeatures/.test(file.text);
  if (bounded) return [];
  return [{
    id: 'gis-pagination-budget-missing',
    domain: 'gis',
    severity: 'medium',
    title: 'ArcGIS pagination logic lacks an obvious page/feature budget',
    message: 'Pagination without an explicit maximum can amplify malformed transfer-limit responses into unbounded work or memory growth.',
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'Add explicit maxPages/maxFeatures budgets, non-progress detection and AbortSignal cancellation.',
    tags: ['gis-release-contract', 'pagination', 'performance'],
  }];
}

function cancellationFinding(file: SourceFile): Finding[] {
  const requestLike = /queryFeatures\s*\(|queryObjectIds\s*\(|queryFeaturesJSON|arcgisRequest|fetch\s*\(/.test(file.text);
  if (!requestLike) return [];
  if (/AbortSignal|signal\s*[,:]|aborted/.test(file.text)) return [];
  return [{
    id: 'gis-request-cancellation-evidence-missing',
    domain: 'gis',
    severity: 'low',
    title: 'GIS request-oriented module lacks visible cancellation evidence',
    message: 'Long-running GIS requests should participate in AbortSignal cancellation so navigation and superseded queries do not keep consuming resources.',
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'Thread AbortSignal through the request/query boundary and suppress stale results after cancellation.',
    tags: ['gis-release-contract', 'cancellation'],
  }];
}

function ownershipFinding(file: SourceFile): Finding[] {
  const allocates = /new\s+(?:FeatureLayer|MapImageLayer|SceneLayer|GraphicsLayer|GroupLayer|MapView|SceneView)\s*\(/.test(file.text);
  if (!allocates) return [];
  if (/dispose|destroy|remove|ownership|registerHandle|resourceOwner|teardown/i.test(file.text)) return [];
  return [{
    id: 'gis-resource-ownership-evidence-missing',
    domain: 'gis',
    severity: 'low',
    title: 'ArcGIS resource allocation lacks visible ownership teardown',
    message: 'Views, layers and watch handles should have one deterministic owner to avoid duplicated layers and leaked WebGL/watch resources.',
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'Attach the resource to the shared lifecycle/ownership coordinator and make teardown idempotent.',
    tags: ['gis-release-contract', 'ownership'],
  }];
}

function cameraMotionFinding(file: SourceFile): Finding[] {
  if (!/\.goTo\s*\(/.test(file.text)) return [];
  if (/prefers-reduced-motion|reducedMotion|duration\s*:\s*0/.test(file.text)) return [];
  return [{
    id: 'gis-camera-reduced-motion-evidence-missing',
    domain: 'accessibility',
    severity: 'low',
    title: 'GIS camera transition lacks reduced-motion evidence',
    message: 'Programmatic map/scene navigation should honor reduced-motion preferences.',
    location: { file: file.repositoryPath, line: 1 },
    remediation: 'Resolve the shared reduced-motion preference and use a zero-duration navigation policy when requested.',
    tags: ['gis-release-contract', 'accessibility', 'camera'],
  }];
}

function countRules(findings: readonly Finding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.id] = (counts[finding.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function filesWith(files: readonly SourceFile[], pattern: RegExp): string[] {
  return files.filter(file => pattern.test(file.text)).map(file => file.repositoryPath).sort((a, b) => a.localeCompare(b, 'en'));
}

export function auditGisReleaseContracts(inventory: RepositoryInventory): AuditSection<GisReleaseContractSummary> {
  const started = performance.now();
  const files = inventory.files.filter(eligible);
  const findings = stableSortFindings(files.flatMap(file => [
    ...RULES.flatMap(rule => findingsForRule(file, rule)),
    ...directFetchFinding(file),
    ...sceneRecoveryFinding(file),
    ...paginationFinding(file),
    ...cancellationFinding(file),
    ...ownershipFinding(file),
    ...cameraMotionFinding(file),
  ]));
  return {
    domain: 'gis',
    title: 'ArcGIS transport, lifecycle, data and 2D/3D release-contract audit',
    summary: {
      scannedFiles: files.length,
      gisEngineFiles: files.filter(file => /\/gis-engine\//.test(file.repositoryPath)).length,
      mapShellFiles: files.filter(file => /\/Components\/(?:App|Map|GIS)\//.test(file.repositoryPath)).length,
      queryFiles: files.filter(file => /\/Components\/Query\//.test(file.repositoryPath)).length,
      moduleBoundaryViolations: findings.filter(item => item.tags?.includes('module-boundary')).length,
      forbiddenProtocolFindings: findings.filter(item => item.tags?.includes('protocol')).length,
      credentialFindings: findings.filter(item => item.tags?.includes('credential')).length,
      directTransportFindings: findings.filter(item => item.id === 'gis-direct-fetch' || item.tags?.includes('network')).length,
      lifecycleFindings: findings.filter(item => item.tags?.includes('lifecycle') || item.tags?.includes('ownership')).length,
      performanceFindings: findings.filter(item => item.tags?.includes('performance')).length,
      recoveryContracts: filesWith(files, /tryFatalErrorRecovery\s*\(/),
      cancellationContracts: filesWith(files, /AbortSignal|signal\s*[,:]|aborted/),
      ownershipContracts: filesWith(files, /dispose|destroy|resourceOwner|ownership|teardown/i),
      findingsByRule: countRules(findings),
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - started),
  };
}
