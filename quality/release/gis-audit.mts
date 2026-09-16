import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  asString,
  isRecord,
  safeJsonParse,
  stableSortFindings,
  uniqueStrings,
  type AuditSection,
  type Finding,
  type GisRuntimePresence,
  type GisSummary,
  type IconRegistryEntry,
  type IconRegistrySummary,
  type RepositoryInventory,
  type SourceFile,
} from './contracts.mts';
import {
  createLineIndex,
  findFile,
  resolveRepositoryFile,
  selectWebSource,
  snippetAround,
} from './inventory.mts';

export interface GisAuditDetails extends GisSummary {
  readonly iconRegistry: IconRegistrySummary;
  readonly twoDSignals: readonly string[];
  readonly threeDSignals: readonly string[];
  readonly queryRuntimeSignals: readonly string[];
  readonly serviceRuntimeSignals: readonly string[];
}

const REQUIRED_GIS_RUNTIMES: readonly { path: string; role: string }[] = Object.freeze([
  { path: 'Webclient.app/src/gis-engine/iconRegistry.json', role: 'single JSON icon authority' },
  { path: 'Webclient.app/src/gis-engine/iconResolver.js', role: 'shared icon resolver' },
  { path: 'Webclient.app/src/gis-engine/iconPresentation.js', role: 'shared list/map presentation adapter' },
  { path: 'Webclient.app/src/gis-engine/serviceRegistry.js', role: 'service resilience/health registry' },
  { path: 'Webclient.app/src/gis-engine/serviceCatalog.js', role: 'service catalog normalization' },
  { path: 'Webclient.app/src/gis-engine/layerRuntime.js', role: 'layer lifecycle runtime' },
  { path: 'Webclient.app/src/gis-engine/layerFactory.js', role: 'ArcGIS layer factory' },
  { path: 'Webclient.app/src/gis-engine/layerOwnership.js', role: 'cross-tool ownership guard' },
  { path: 'Webclient.app/src/gis-engine/spatialEngine.js', role: 'spatial validation/runtime' },
  { path: 'Webclient.app/src/gis-engine/sceneRuntime.js', role: '3D scene lifecycle/runtime' },
  { path: 'Webclient.app/src/gis-engine/identifyRuntime.js', role: 'identify lifecycle/runtime' },
  { path: 'Webclient.app/src/gis-engine/measurementRuntime.js', role: 'measurement lifecycle/runtime' },
  { path: 'Webclient.app/src/gis-engine/queryRuntime.js', role: 'bounded GIS query runtime' },
]);

const GIS_CODE_PATH = /^Webclient\.app\/src\/(?:gis-engine|Components|Business|Toolbox)\//;
const FORBIDDEN_PROTOCOL_PATTERN = /(?:service\s*=\s*['"]?(WMS|WFS)|\b(WMS|WFS)(?:Layer|Service|Client|Url|URL)\b)/gi;
const ARCGIS_SERVICE_PATTERN = /\b(?:MapServer|FeatureServer|SceneServer|ImageServer|VectorTileServer)\b/g;
const GLOBAL_CLEAR_PATTERN = /\bRemoveAllGraphics\s*\(|\.graphics\.removeAll\s*\(/g;
const SCENE_SIGNAL_PATTERN = /\b(?:SceneView|WebScene|sceneRuntime|createScene|destroyScene|viewType\s*[:=]\s*['"]3d)/gi;
const MAP_SIGNAL_PATTERN = /\b(?:MapView|WebMap|MapComponent|viewType\s*[:=]\s*['"]2d)/gi;
const QUERY_SIGNAL_PATTERN = /\b(?:queryFeatures|QueryTask|resultOffset|resultRecordCount|exceededTransferLimit|queryRuntime)/gi;
const SERVICE_SIGNAL_PATTERN = /\b(?:GisServiceRegistry|serviceRegistry|timeoutMs|retries|AbortController|health)/gi;

function normalizeLookup(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9çğıöşü]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractRegistryRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.entries)) return value.entries.filter(isRecord);
  if (Array.isArray(value.icons)) return value.icons.filter(isRecord);
  return Object.entries(value)
    .filter(([, row]) => isRecord(row))
    .map(([key, row]) => ({ id: key, ...(row as Record<string, unknown>) }));
}

function rowAliases(row: Record<string, unknown>): string[] {
  const aliases = Array.isArray(row.aliases) ? row.aliases.map(asString) : [];
  return uniqueStrings([
    asString(row.id),
    asString(row.type),
    asString(row.category),
    ...aliases,
  ].filter(Boolean));
}

function parseIconRegistry(inventory: RepositoryInventory): IconRegistrySummary {
  const path = 'Webclient.app/src/gis-engine/iconRegistry.json';
  const file = findFile(inventory, path);
  const findings: Finding[] = [];
  if (!file) {
    findings.push({
      id: 'gis-icon-registry-missing',
      domain: 'icons',
      severity: 'critical',
      title: 'Shared GIS icon registry missing',
      message: 'The single JSON-driven icon authority is required for 2D/3D/list parity.',
      location: { file: path, line: 1 },
      remediation: 'Restore the verified shared registry rather than creating a parallel mapping system.',
      blocking: true,
    });
    return { path: null, entries: [], duplicateKeys: [], duplicateAliases: [], missingAssets: [], findings };
  }

  const parsed = safeJsonParse<unknown>(file.text);
  if (!parsed.ok) {
    findings.push({
      id: 'gis-icon-registry-invalid-json',
      domain: 'icons',
      severity: 'critical',
      title: 'Invalid GIS icon registry JSON',
      message: 'The icon registry cannot be parsed.',
      location: { file: path, line: 1 },
      evidence: { value: parsed.error ?? 'JSON parse error' },
      remediation: 'Repair JSON syntax and rerun icon resolver regression tests.',
      blocking: true,
    });
    return { path, entries: [], duplicateKeys: [], duplicateAliases: [], missingAssets: [], findings };
  }

  const rows = extractRegistryRows(parsed.value);
  const entries: IconRegistryEntry[] = [];
  const keyOwners = new Map<string, string[]>();
  const aliasOwners = new Map<string, string[]>();
  const missingAssets: string[] = [];

  for (const [index, row] of rows.entries()) {
    const key = asString(row.id || row.key || row.name || `row-${index}`);
    const icon = asString(row.icon || row.asset || row.path);
    const aliases = rowAliases(row);
    entries.push({ key, aliases, ...(icon ? { asset: icon } : {}), raw: row });

    const normalizedKey = normalizeLookup(key);
    if (normalizedKey) {
      const owners = keyOwners.get(normalizedKey) ?? [];
      owners.push(key);
      keyOwners.set(normalizedKey, owners);
    }
    for (const alias of aliases) {
      const normalizedAlias = normalizeLookup(alias);
      if (!normalizedAlias) continue;
      const owners = aliasOwners.get(normalizedAlias) ?? [];
      if (!owners.includes(key)) owners.push(key);
      aliasOwners.set(normalizedAlias, owners);
    }

    if (!icon) {
      findings.push({
        id: 'gis-icon-entry-missing-asset',
        domain: 'icons',
        severity: key === 'default' ? 'critical' : 'high',
        title: 'Icon registry entry missing asset',
        message: `Registry entry ${key} does not declare an icon asset.`,
        location: { file: path, line: index + 2 },
        evidence: { value: key },
        remediation: 'Assign an existing optimized local icon through the single registry authority.',
        ...(key === 'default' ? { blocking: true } : {}),
      });
    } else {
      const candidates = [
        `Webclient.app/public/${icon.replace(/^\/+/, '')}`,
        `Webclient.app/src/${icon.replace(/^\/+/, '')}`,
        icon.replace(/^\/+/, ''),
      ];
      const exists = candidates.some(candidate => resolveRepositoryFile(inventory.root, candidate) !== null || existsSync(resolve(inventory.root, candidate)));
      if (!exists) {
        missingAssets.push(icon);
        findings.push({
          id: 'gis-icon-asset-missing',
          domain: 'icons',
          severity: key === 'default' ? 'critical' : 'high',
          title: 'Icon asset path does not resolve',
          message: `The registry asset for ${key} cannot be resolved in the repository checkout.`,
          location: { file: path, line: index + 2 },
          evidence: { value: icon },
          remediation: 'Fix the registry path or restore the local asset; do not add a remote fallback.',
          ...(key === 'default' ? { blocking: true } : {}),
        });
      }
    }
  }

  const duplicateKeys = [...keyOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key]) => key)
    .sort();
  const duplicateAliases = [...aliasOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([alias]) => alias)
    .sort();

  for (const key of duplicateKeys) {
    findings.push({
      id: 'gis-icon-duplicate-key',
      domain: 'icons',
      severity: 'high',
      title: 'Duplicate normalized icon key',
      message: 'Two registry rows collapse to the same normalized identifier.',
      location: { file: path, line: 1 },
      evidence: { value: key },
      remediation: 'Unify the entries or make the identifiers semantically distinct.',
    });
  }

  for (const alias of duplicateAliases) {
    const owners = aliasOwners.get(alias) ?? [];
    const uniqueAssets = new Set(entries.filter(entry => owners.includes(entry.key)).map(entry => entry.asset).filter(Boolean));
    if (uniqueAssets.size <= 1) continue;
    findings.push({
      id: 'gis-icon-alias-collision',
      domain: 'icons',
      severity: 'medium',
      title: 'Icon alias maps to multiple assets',
      message: 'A normalized alias can resolve to multiple visual meanings depending on iteration order.',
      location: { file: path, line: 1 },
      evidence: { value: `${alias}: ${owners.join(', ')}` },
      remediation: 'Make alias ownership deterministic in the central registry/resolver.',
    });
  }

  if (!entries.some(entry => normalizeLookup(entry.key) === 'default')) {
    findings.push({
      id: 'gis-icon-default-missing',
      domain: 'icons',
      severity: 'critical',
      title: 'Default icon fallback missing',
      message: 'Unknown categories require a deterministic local fallback icon.',
      location: { file: path, line: 1 },
      remediation: 'Restore one default registry entry and validate list/2D/3D presentation parity.',
      blocking: true,
    });
  }

  return {
    path,
    entries,
    duplicateKeys,
    duplicateAliases,
    missingAssets: uniqueStrings(missingAssets),
    findings: stableSortFindings(findings),
  };
}

function runtimePresence(inventory: RepositoryInventory): GisRuntimePresence[] {
  return REQUIRED_GIS_RUNTIMES.map(expected => ({
    expectedPath: expected.path,
    present: findFile(inventory, expected.path) !== undefined,
    role: expected.role,
  }));
}

function runtimeFindings(runtimes: readonly GisRuntimePresence[]): Finding[] {
  return runtimes
    .filter(runtime => !runtime.present)
    .map(runtime => ({
      id: `gis-runtime-missing-${runtime.expectedPath.split('/').at(-1)?.replace(/[^a-z0-9]+/gi, '-') ?? 'unknown'}`,
      domain: 'gis' as const,
      severity: 'critical' as const,
      title: 'Required shared GIS runtime missing',
      message: `${runtime.expectedPath} (${runtime.role}) is absent.`,
      location: { file: runtime.expectedPath, line: 1 },
      remediation: 'Restore the shared runtime; do not reintroduce per-screen duplicate GIS implementations.',
      blocking: true,
    }));
}

function scanForbiddenProtocols(files: readonly SourceFile[]): { protocols: string[]; findings: Finding[] } {
  const protocols: string[] = [];
  const findings: Finding[] = [];
  for (const file of files) {
    if (!GIS_CODE_PATH.test(file.repositoryPath)) continue;
    const lineIndex = createLineIndex(file.text);
    const matcher = new RegExp(FORBIDDEN_PROTOCOL_PATTERN.source, FORBIDDEN_PROTOCOL_PATTERN.flags);
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = matcher.exec(file.text)) !== null) {
      const protocol = String(match[1] ?? match[2] ?? 'unknown').toUpperCase();
      protocols.push(protocol);
      findings.push({
        id: `gis-forbidden-protocol-${protocol.toLowerCase()}`,
        domain: 'gis',
        severity: 'critical',
        title: `Forbidden GIS protocol drift: ${protocol}`,
        message: `${protocol} runtime integration is not part of the repository-verified service contract.`,
        location: { file: file.repositoryPath, line: lineIndex.lineAt(match.index) },
        evidence: { excerpt: snippetAround(file.text, match.index, 90) },
        remediation: 'Use only real configured ArcGIS REST service types. Do not invent replacement endpoints.',
        blocking: true,
      });
      count += 1;
      if (count >= 8) break;
    }
  }
  return { protocols: uniqueStrings(protocols), findings };
}

function scanOwnershipRisks(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!GIS_CODE_PATH.test(file.repositoryPath)) continue;
    if (/layerOwnership\.js$/.test(file.repositoryPath)) continue;
    const lineIndex = createLineIndex(file.text);
    const matcher = new RegExp(GLOBAL_CLEAR_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = matcher.exec(file.text)) !== null) {
      findings.push({
        id: 'gis-global-resource-clear',
        domain: 'gis',
        severity: 'high',
        title: 'Global GIS resource cleanup',
        message: 'Global graphic clearing can remove resources owned by another tool or async request.',
        location: { file: file.repositoryPath, line: lineIndex.lineAt(match.index) },
        evidence: { excerpt: snippetAround(file.text, match.index, 100) },
        remediation: 'Use ownership-scoped cleanup through the shared GIS lifecycle layer.',
        tags: ['ownership', 'lifecycle'],
      });
      count += 1;
      if (count >= 8) break;
    }
  }
  return findings;
}

function scanLifecycleRisks(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!GIS_CODE_PATH.test(file.repositoryPath)) continue;
    const hasWatcher = /\.watch\s*\(|reactiveUtils\.(?:watch|when)/.test(file.text);
    const hasCleanup = /remove\s*\(|destroy\s*\(|dispose\s*\(|cleanup|AbortController|signal/.test(file.text);
    if (hasWatcher && !hasCleanup) {
      findings.push({
        id: 'gis-watcher-cleanup-review',
        domain: 'gis',
        severity: 'medium',
        title: 'GIS watcher without visible cleanup contract',
        message: 'ArcGIS watchers should have deterministic teardown to prevent leaks and stale updates.',
        location: { file: file.repositoryPath, line: 1 },
        remediation: 'Own watcher handles and release them when the view/tool/component is destroyed.',
        tags: ['memory', 'lifecycle'],
      });
    }
    const hasAsyncQuery = /queryFeatures\s*\(|QueryTask/.test(file.text);
    const hasAbort = /AbortController|signal|cancel|requestGate|stale/i.test(file.text);
    if (hasAsyncQuery && !hasAbort && !/\.test\./.test(file.repositoryPath)) {
      findings.push({
        id: 'gis-query-cancellation-review',
        domain: 'gis',
        severity: 'medium',
        title: 'GIS query cancellation not visible',
        message: 'Async GIS queries without cancellation/stale-response control can overwrite newer state.',
        location: { file: file.repositoryPath, line: 1 },
        remediation: 'Route through the shared query/request runtime or add explicit abort/stale-result protection.',
        tags: ['async', 'cancellation'],
      });
    }
  }
  return findings;
}

function filesWithSignal(files: readonly SourceFile[], pattern: RegExp): string[] {
  const result: string[] = [];
  for (const file of files) {
    const matcher = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    if (matcher.test(file.text)) result.push(file.repositoryPath);
  }
  return uniqueStrings(result);
}

function arcGisServiceEvidence(files: readonly SourceFile[]): string[] {
  const evidence: string[] = [];
  for (const file of files) {
    if (!GIS_CODE_PATH.test(file.repositoryPath)) continue;
    const matches = file.text.match(ARCGIS_SERVICE_PATTERN) ?? [];
    for (const match of matches) evidence.push(match);
  }
  return uniqueStrings(evidence);
}

export function auditGis(inventory: RepositoryInventory): AuditSection<GisAuditDetails> {
  const start = performance.now();
  const webFiles = selectWebSource(inventory).filter(file => !file.repositoryPath.startsWith('quality/release/'));
  const runtimes = runtimePresence(inventory);
  const iconRegistry = parseIconRegistry(inventory);
  const forbidden = scanForbiddenProtocols(webFiles);
  const ownershipRisks = scanOwnershipRisks(webFiles);
  const lifecycleRisks = scanLifecycleRisks(webFiles);
  const findings: Finding[] = [
    ...runtimeFindings(runtimes),
    ...iconRegistry.findings,
    ...forbidden.findings,
    ...ownershipRisks,
    ...lifecycleRisks,
  ];

  const serviceTypes = arcGisServiceEvidence(webFiles);
  if (serviceTypes.length === 0) {
    findings.push({
      id: 'gis-arcgis-service-evidence-missing',
      domain: 'gis',
      severity: 'high',
      title: 'ArcGIS REST service type evidence missing',
      message: 'No MapServer/FeatureServer/SceneServer/ImageServer/VectorTileServer token was detected in the active GIS source.',
      remediation: 'Verify the real service catalog and keep protocol handling aligned with actual configured services.',
    });
  }

  const twoDSignals = filesWithSignal(webFiles, MAP_SIGNAL_PATTERN);
  const threeDSignals = filesWithSignal(webFiles, SCENE_SIGNAL_PATTERN);
  const queryRuntimeSignals = filesWithSignal(webFiles, QUERY_SIGNAL_PATTERN);
  const serviceRuntimeSignals = filesWithSignal(webFiles, SERVICE_SIGNAL_PATTERN);
  if (threeDSignals.length > 0 && !runtimes.find(runtime => runtime.expectedPath.endsWith('sceneRuntime.js'))?.present) {
    findings.push({
      id: 'gis-3d-without-shared-scene-runtime',
      domain: 'gis',
      severity: 'critical',
      title: '3D usage without shared scene runtime',
      message: '3D entrypoints exist but the shared lifecycle authority is missing.',
      remediation: 'Restore sceneRuntime and preserve shared icon/view-state ownership.',
      blocking: true,
    });
  }

  const sorted = stableSortFindings(findings);
  return {
    domain: 'gis',
    title: 'GIS 2D/3D, service, lifecycle and icon audit',
    summary: {
      runtimes,
      forbiddenProtocols: forbidden.protocols,
      ownershipRisks,
      lifecycleRisks,
      findings: sorted,
      iconRegistry,
      twoDSignals,
      threeDSignals,
      queryRuntimeSignals,
      serviceRuntimeSignals,
    },
    findings: sorted,
    elapsedMs: Math.max(0, performance.now() - start),
  };
}
