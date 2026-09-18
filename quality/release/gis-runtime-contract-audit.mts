import {
  stableSortFindings,
  uniqueStrings,
  type AuditSection,
  type Finding,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';

export interface GisRuntimeContractSignal {
  readonly file: string;
  readonly directLegacyLoader: number;
  readonly viewConstructors: number;
  readonly queryCalls: number;
  readonly wildcardOutFields: number;
  readonly hardcodedArcgisUrls: number;
  readonly pictureMarkerBypasses: number;
  readonly watchRegistrations: number;
}

export interface GisRuntimeContractSummary {
  readonly files: number;
  readonly signals: readonly GisRuntimeContractSignal[];
  readonly directLegacyLoaderFiles: readonly string[];
  readonly unmanagedViewFiles: readonly string[];
  readonly queryFiles: readonly string[];
  readonly hardcodedServiceFiles: readonly string[];
  readonly iconBypassFiles: readonly string[];
  readonly findingsByRule: Readonly<Record<string, number>>;
}

interface LocatedMatch {
  readonly index: number;
  readonly line: number;
  readonly excerpt: string;
}

const GIS_PATH = /^Webclient\.app\/src\/(?:gis-engine|Components|Business|Toolbox|platform)\//;
const GENERATED = /(^|\/)(?:dist|build|coverage|node_modules)(\/|$)/i;
const TEST = /(^|\/)(?:__tests__|tests?|fixtures?|mocks?)(\/|\.|$)/i;
const LEGACY_LOADER = /(?:from\s+['"]esri-loader['"]|require\s*\(\s*['"]esri-loader['"]\s*\)|\bloadModules\s*\()/g;
const VIEW_CONSTRUCTOR = /new\s+(?:MapView|SceneView)\s*\(/g;
const VIEW_DESTROY = /(?:\.destroy\s*\(|destroyView\s*\(|dispose\s*\(|cleanup\b)/i;
const SCENE_VIEW = /new\s+SceneView\s*\(/;
const FATAL_RECOVERY = /(?:fatalError|tryFatalErrorRecovery|recover(?:Scene|View)|webglcontextlost)/i;
const QUERY = /\b(?:queryFeatures|executeQueryJSON|executeForIds|queryObjectIds)\s*\(/g;
const QUERY_BOUND = /(?:resultRecordCount|maxRecordCount|maxFeatures|maxPages|pageSize|resultOffset|exceededTransferLimit|objectIds)/i;
const QUERY_CANCELLATION = /(?:AbortController|AbortSignal|\bsignal\b|cancel(?:led|lation)?|stale|requestGate|generation|sequence)/i;
const WILDCARD_OUTFIELDS = /outFields\s*[:=]\s*(?:\[\s*['"]\*['"]\s*\]|['"]\*['"])/g;
const ALL_ROWS_WHERE = /where\s*[:=]\s*['"]\s*1\s*=\s*1\s*['"]/g;
const HARDCODED_ARCGIS_URL = /https?:\/\/[^\s'"\`<>]+\/(?:arcgis\/rest\/services|rest\/services)\/[^\s'"\`<>]+\/(?:MapServer|FeatureServer|SceneServer|ImageServer)(?:\/\d+)?/gi;
const SERVICE_AUTHORITY = /(?:serviceCatalog|serviceRegistry|serviceConfig|AppConfig|configuration|arcgisModuleRuntime|arcgisTransport|serviceUrlResolver)/i;
const PICTURE_MARKER = /(?:new\s+PictureMarkerSymbol\s*\(|type\s*:\s*['"]picture-marker['"]|PictureMarkerSymbol\s*\()/g;
const ICON_AUTHORITY = /(?:iconResolver|iconPresentation|iconRegistry|resolveIcon|resolve.*Symbol)/i;
const WATCH = /(?:reactiveUtils\.(?:watch|when|on)|\.watch\s*\()/g;
const WATCH_CLEANUP = /(?:\.remove\s*\(|removeHandles\s*\(|addHandles\s*\(|destroy\s*\(|dispose\s*\(|cleanup\b)/i;
const LAYER_ADD = /(?:map|view\.map|scene)\.(?:add|addMany)\s*\(/g;
const LAYER_REMOVE = /(?:\.remove\s*\(|\.removeMany\s*\(|layerOwnership|ownLayer|dispose\s*\(|destroy\s*\()/i;
const GOTO = /\.goTo\s*\(/g;
const REDUCED_MOTION = /(?:prefers-reduced-motion|reducedMotion|animation\s*:\s*false|duration\s*:\s*0)/i;
const FEATURE_SERVER = /\/(?:FeatureServer|MapServer)\/\d+/i;
const RAW_FETCH_SERVICE = /fetch\s*\([^\n]{0,240}\/(?:FeatureServer|MapServer|SceneServer)/i;
const SHARED_TRANSPORT = /(?:arcgisRequest|queryRuntime|requestCoordinator|apiClient|serviceRegistry|transport)/i;
const RETURN_GEOMETRY = /returnGeometry\s*[:=]\s*true/g;
const SPATIAL_USAGE = /(?:geometry|spatialReference|extent|intersects|contains|distance|project|goTo|highlight)/i;

function eligible(file: SourceFile): boolean {
  return (file.kind === 'typescript' || file.kind === 'javascript')
    && GIS_PATH.test(file.repositoryPath)
    && !GENERATED.test(file.repositoryPath)
    && !TEST.test(file.repositoryPath)
    && !file.repositoryPath.startsWith('quality/release/');
}

function locate(file: SourceFile, pattern: RegExp, limit = 12): LocatedMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const lines = createLineIndex(file.text);
  const results: LocatedMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(file.text)) !== null) {
    results.push({
      index: match.index,
      line: lines.lineAt(match.index),
      excerpt: snippetAround(file.text, match.index, 120),
    });
    if (results.length >= limit) break;
    if (match[0].length === 0) matcher.lastIndex += 1;
  }
  return results;
}

function count(file: SourceFile, pattern: RegExp): number {
  return locate(file, pattern, 200).length;
}

function finding(
  id: string,
  severity: Finding['severity'],
  title: string,
  message: string,
  file: SourceFile,
  match: LocatedMatch | undefined,
  remediation: string,
  tags: readonly string[],
  blocking = false,
): Finding {
  return {
    id,
    domain: 'gis',
    severity,
    title,
    message,
    location: { file: file.repositoryPath, line: match?.line ?? 1 },
    ...(match ? { evidence: { excerpt: match.excerpt } } : {}),
    remediation,
    tags,
    ...(blocking ? { blocking: true } : {}),
  };
}

function loaderFindings(file: SourceFile): Finding[] {
  if (/arcgisModuleRuntime\.(?:ts|js)$/.test(file.repositoryPath)) return [];
  return locate(file, LEGACY_LOADER).map(match => finding(
    'gis-direct-legacy-loader',
    'high',
    'Direct legacy ArcGIS loader usage bypasses the shared module boundary',
    'GIS runtime code should not create a second ArcGIS module-loading authority.',
    file,
    match,
    'Route ArcGIS module access through the shared typed module runtime and preserve its compatibility/cancellation policy.',
    ['arcgis', 'loader', 'architecture'],
  ));
}

function viewLifecycleFindings(file: SourceFile): Finding[] {
  const constructors = locate(file, VIEW_CONSTRUCTOR);
  if (constructors.length === 0 || VIEW_DESTROY.test(file.text)) return [];
  return [finding(
    'gis-view-without-destroy-contract',
    'high',
    'MapView/SceneView construction lacks a visible teardown contract',
    'ArcGIS views own WebGL/DOM/listener resources and require deterministic destruction when the owning surface is disposed.',
    file,
    constructors[0],
    'Own the view in the shared lifecycle layer and call destroy/dispose during deterministic teardown.',
    ['2d', '3d', 'lifecycle', 'memory'],
  )];
}

function sceneRecoveryFindings(file: SourceFile): Finding[] {
  if (!SCENE_VIEW.test(file.text) || FATAL_RECOVERY.test(file.text)) return [];
  const match = locate(file, VIEW_CONSTRUCTOR, 1)[0];
  return [finding(
    'gis-scene-fatal-recovery-missing',
    'medium',
    'SceneView construction lacks visible fatal-error recovery',
    '3D WebGL context loss or fatal SceneView errors should enter a bounded recovery/degraded path instead of leaving a dead scene.',
    file,
    match,
    'Observe SceneView fatalError and use bounded tryFatalErrorRecovery/degraded-state handling through the shared 3D runtime.',
    ['3d', 'webgl', 'resilience'],
  )];
}

function watcherFindings(file: SourceFile): Finding[] {
  const watches = locate(file, WATCH);
  if (watches.length === 0 || WATCH_CLEANUP.test(file.text)) return [];
  return [finding(
    'gis-reactive-handle-without-cleanup',
    'medium',
    'ArcGIS reactive handle lacks visible cleanup ownership',
    'Reactive watcher handles can retain views, layers, and component closures after the owning surface changes.',
    file,
    watches[0],
    'Store watcher handles in the lifecycle owner and remove them during dispose/destroy.',
    ['watcher', 'lifecycle', 'memory'],
  )];
}

function queryBoundFindings(file: SourceFile): Finding[] {
  const queries = locate(file, QUERY);
  if (queries.length === 0 || QUERY_BOUND.test(file.text)) return [];
  return [finding(
    'gis-query-without-result-bound',
    'high',
    'GIS query has no visible result/page bound',
    'Unbounded feature queries can amplify transfer, parsing, memory, and rendering cost on large municipal datasets.',
    file,
    queries[0],
    'Use the shared bounded query/window runtime with page/feature limits and explicit transfer-limit completion handling.',
    ['query', 'pagination', 'performance'],
  )];
}

function queryCancellationFindings(file: SourceFile): Finding[] {
  const queries = locate(file, QUERY);
  if (queries.length === 0 || QUERY_CANCELLATION.test(file.text)) return [];
  return [finding(
    'gis-query-without-cancellation',
    'medium',
    'GIS query has no visible cancellation or stale-result guard',
    'Superseded searches and map interactions can race and apply stale feature results.',
    file,
    queries[0],
    'Propagate AbortSignal or use the shared request/query coordinator with generation/stale-result suppression.',
    ['query', 'cancellation', 'race'],
  )];
}

function wildcardFieldFindings(file: SourceFile): Finding[] {
  return locate(file, WILDCARD_OUTFIELDS).map(match => finding(
    'gis-query-wildcard-outfields',
    'medium',
    'GIS query requests every attribute field',
    'outFields="*" increases payload size and can expose attributes that the active experience does not need.',
    file,
    match,
    'Request the minimal explicit field set required by rendering, identity, labeling, and interaction.',
    ['query', 'data-minimization', 'performance'],
  ));
}

function allRowsFindings(file: SourceFile): Finding[] {
  return locate(file, ALL_ROWS_WHERE).map(match => finding(
    'gis-query-unfiltered-all-rows',
    'high',
    'Browser GIS query uses an unconditional all-records predicate',
    'where="1=1" can turn an interaction into a full-layer scan when combined with large FeatureServer layers.',
    file,
    match,
    'Use bounded, purpose-specific predicates and the shared paging/query runtime; require an explicit reviewed bulk-data path when needed.',
    ['query', 'data-volume', 'performance'],
  ));
}

function hardcodedServiceFindings(file: SourceFile): Finding[] {
  if (SERVICE_AUTHORITY.test(file.repositoryPath) || SERVICE_AUTHORITY.test(file.text)) return [];
  return locate(file, HARDCODED_ARCGIS_URL).map(match => finding(
    'gis-hardcoded-service-url',
    'medium',
    'ArcGIS REST service URL bypasses the service authority',
    'Hardcoded service endpoints fragment environment configuration, health policy, timeout behavior, and migration control.',
    file,
    match,
    'Resolve the verified service from the shared service catalog/configuration boundary.',
    ['arcgis-rest', 'configuration', 'network'],
  ));
}

function rawServiceFetchFindings(file: SourceFile): Finding[] {
  if (!RAW_FETCH_SERVICE.test(file.text) || SHARED_TRANSPORT.test(file.repositoryPath) || SHARED_TRANSPORT.test(file.text)) return [];
  const match = locate(file, /fetch\s*\(/g, 1)[0];
  return [finding(
    'gis-raw-service-fetch',
    'high',
    'Direct fetch targets an ArcGIS service endpoint',
    'Direct service fetch can bypass shared timeout, cancellation, dedupe, response validation, and service-health policy.',
    file,
    match,
    'Use the shared ArcGIS/query transport and keep browser calls aligned with the verified same-origin/service policy.',
    ['arcgis-rest', 'transport', 'network'],
  )];
}

function iconBypassFindings(file: SourceFile): Finding[] {
  if (ICON_AUTHORITY.test(file.repositoryPath) || ICON_AUTHORITY.test(file.text)) return [];
  return locate(file, PICTURE_MARKER).map(match => finding(
    'gis-picture-marker-bypasses-icon-authority',
    'high',
    'Picture marker construction bypasses the shared icon authority',
    'Ad-hoc marker symbols can break deterministic table/2D/3D category parity and fallback behavior.',
    file,
    match,
    'Resolve category presentation through iconRegistry/iconResolver/iconPresentation and reuse the shared fallback contract.',
    ['icons', '2d', '3d', 'parity'],
  ));
}

function layerOwnershipFindings(file: SourceFile): Finding[] {
  const additions = locate(file, LAYER_ADD);
  if (additions.length === 0 || LAYER_REMOVE.test(file.text)) return [];
  return [finding(
    'gis-layer-add-without-ownership-cleanup',
    'medium',
    'Layer addition lacks visible ownership-scoped cleanup',
    'Layers added by temporary tools or workflows should be removed by the same owner rather than accumulating across sessions.',
    file,
    additions[0],
    'Register the layer with the shared ownership/lifecycle runtime and dispose it when the owning feature ends.',
    ['layer', 'ownership', 'memory'],
  )];
}

function navigationMotionFindings(file: SourceFile): Finding[] {
  const goTo = locate(file, GOTO);
  if (goTo.length === 0 || REDUCED_MOTION.test(file.text)) return [];
  return [finding(
    'gis-goto-reduced-motion-review',
    'low',
    'Map/scene navigation lacks visible reduced-motion handling',
    'Animated camera movement can cause discomfort and should honor the product reduced-motion contract.',
    file,
    goTo[0],
    'Route camera movement through the shared navigation runtime and use zero-duration/non-animated navigation for reduced-motion users.',
    ['navigation', 'accessibility', '3d'],
  )];
}

function geometryPayloadFindings(file: SourceFile): Finding[] {
  const geometry = locate(file, RETURN_GEOMETRY);
  if (geometry.length === 0 || SPATIAL_USAGE.test(file.text)) return [];
  return [finding(
    'gis-return-geometry-without-spatial-use',
    'low',
    'Query requests geometry without a visible spatial consumer',
    'Feature geometry can dominate payload size for dense layers when only attributes are used.',
    file,
    geometry[0],
    'Set returnGeometry=false for attribute-only paths or document the downstream spatial/render use.',
    ['query', 'geometry', 'performance'],
  )];
}

function featureLayerUrlShapeFindings(file: SourceFile): Finding[] {
  if (!FEATURE_SERVER.test(file.text)) return [];
  if (/serviceCatalog|layerFactory|serviceRegistry/.test(file.repositoryPath)) return [];
  if (HARDCODED_ARCGIS_URL.test(file.text)) return [];
  HARDCODED_ARCGIS_URL.lastIndex = 0;
  return [];
}

function signal(file: SourceFile): GisRuntimeContractSignal {
  return {
    file: file.repositoryPath,
    directLegacyLoader: count(file, LEGACY_LOADER),
    viewConstructors: count(file, VIEW_CONSTRUCTOR),
    queryCalls: count(file, QUERY),
    wildcardOutFields: count(file, WILDCARD_OUTFIELDS),
    hardcodedArcgisUrls: count(file, HARDCODED_ARCGIS_URL),
    pictureMarkerBypasses: count(file, PICTURE_MARKER),
    watchRegistrations: count(file, WATCH),
  };
}

function findingsFor(file: SourceFile): Finding[] {
  return [
    ...loaderFindings(file),
    ...viewLifecycleFindings(file),
    ...sceneRecoveryFindings(file),
    ...watcherFindings(file),
    ...queryBoundFindings(file),
    ...queryCancellationFindings(file),
    ...wildcardFieldFindings(file),
    ...allRowsFindings(file),
    ...hardcodedServiceFindings(file),
    ...rawServiceFetchFindings(file),
    ...iconBypassFindings(file),
    ...layerOwnershipFindings(file),
    ...navigationMotionFindings(file),
    ...geometryPayloadFindings(file),
    ...featureLayerUrlShapeFindings(file),
  ];
}

function countsByRule(findings: readonly Finding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of findings) counts[item.id] = (counts[item.id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

function filesFor(signals: readonly GisRuntimeContractSignal[], key: keyof Omit<GisRuntimeContractSignal, 'file'>): string[] {
  return uniqueStrings(signals.filter(item => item[key] > 0).map(item => item.file));
}

export function auditGisRuntimeContracts(inventory: RepositoryInventory): AuditSection<GisRuntimeContractSummary> {
  const start = performance.now();
  const files = inventory.files.filter(eligible);
  const signals = files.map(signal);
  const findings = stableSortFindings(files.flatMap(findingsFor));
  return {
    domain: 'gis',
    title: 'GIS runtime contract and 2D/3D release regression audit',
    summary: {
      files: files.length,
      signals,
      directLegacyLoaderFiles: filesFor(signals, 'directLegacyLoader'),
      unmanagedViewFiles: uniqueStrings(findings.filter(item => item.id === 'gis-view-without-destroy-contract').map(item => item.location?.file ?? '')),
      queryFiles: filesFor(signals, 'queryCalls'),
      hardcodedServiceFiles: filesFor(signals, 'hardcodedArcgisUrls'),
      iconBypassFiles: filesFor(signals, 'pictureMarkerBypasses'),
      findingsByRule: countsByRule(findings),
    },
    findings,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
