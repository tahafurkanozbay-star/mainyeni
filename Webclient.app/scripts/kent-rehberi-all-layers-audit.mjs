import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Kent Rehberi POI/category queries remain pinned to the official PlanASKI endpoint.
// The optional TomTom traffic-flow raster overlay is a separate visual map layer;
// it does not replace or participate in fast-access service/category queries.
// This audit guards the PlanASKI category/profile/icon contract without a local API.
const REQUIRED_PATHS = Object.freeze({
  sidebar: 'src/Components/App/SidebarCatalog.ts',
  windows: 'src/Components/Common/QueryWindowRegistry.tsx',
  profiles: 'src/Business/kentRehberiFastAccessProfiles.ts',
  businessFactory: 'src/Business/createFastAccessQueryBusiness.ts',
  runtime: 'src/Business/kentRehberiFastAccessRuntime.ts',
  transport: 'src/data-services/kentRehberiGeoJsonLayer.ts',
  directTransport: 'src/data-services/kentRehberiPlanAskiDirect.ts',
  icons: 'src/gis-engine/iconRegistry.json',
  vite: 'vite.config.ts',
  configurationBusiness: 'src/Business/ConfigurationBusiness.ts',
  envExample: '.env.example',
  package: 'package.json',
  qualityWorkflow: '../.github/workflows/webclient-quality.yml',
  releaseWorkflow: '../.github/workflows/release-qa.yml',
});

const EXPECTED_GROUP_COUNTS = Object.freeze({ ABB: 17, EGO: 8, ASKI: 6, ISTIRAK: 9 });
const EXPECTED_ITEM_COUNT = Object.values(EXPECTED_GROUP_COUNTS).reduce((total, value) => total + value, 0);

const finding = (id, file, message) => Object.freeze({ severity: 'error', id, file, message });

const readRequired = (files, file, errors) => {
  const source = files[file];
  if (typeof source === 'string') return source;
  errors.push(finding('missing-file', file, `required PlanASKI-only contract file is missing: ${file}`));
  return '';
};

const parseJson = (source, file, errors) => {
  try {
    return JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch (error) {
    errors.push(finding('invalid-json', file, `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
};

export const parseSidebarItems = (source) => {
  const pattern = /\{\s*group:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*windowId:\s*'([^']+)'\s*,\s*iconType:\s*'([^']+)'\s*,\s*serviceKey:\s*'([^']+)'\s*\}/gu;
  return Object.freeze([...source.matchAll(pattern)].map((match) => Object.freeze({
    group: match[1], label: match[2], windowId: match[3], iconType: match[4], serviceKey: match[5],
  })));
};

export const parseQueryWindowIds = (source) => Object.freeze(
  [...source.matchAll(/defineWindow\(\s*'([^']+)'/gu)].map((match) => match[1]),
);

const parseQuotedArray = (source) => Object.freeze([...source.matchAll(/'([^']+)'/gu)].map((match) => match[1]));

export const parseFastAccessProfiles = (source) => {
  const pattern = /freezeProfile\(\{\s*serviceKey:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'\s*,\s*probes:\s*\[([^\]]*)\][\s\S]*?mode:\s*'(first|union)'\s*,\s*\}\)/gu;
  return Object.freeze([...source.matchAll(pattern)].map((match) => Object.freeze({
    serviceKey: match[1], title: match[2], probes: parseQuotedArray(match[3]), mode: match[4],
  })));
};

export const parseIconServiceAliases = (source, errors = []) => {
  let parsed;
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch (error) {
    errors.push(finding('invalid-json', REQUIRED_PATHS.icons, `icon registry JSON is invalid: ${error instanceof Error ? error.message : String(error)}`));
    return new Map();
  }
  if (!Array.isArray(parsed)) return new Map();
  const aliases = new Map();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !Array.isArray(entry.aliases)) continue;
    for (const alias of entry.aliases) {
      if (typeof alias !== 'string' || !alias.startsWith('Yeni')) continue;
      aliases.set(alias, [...(aliases.get(alias) ?? []), entry.id]);
    }
  }
  return aliases;
};

const duplicateValues = (values) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates].sort();
};

const checkSidebarInventory = (files, errors) => {
  const source = readRequired(files, REQUIRED_PATHS.sidebar, errors);
  if (!source) return [];
  const items = parseSidebarItems(source);
  if (items.length !== EXPECTED_ITEM_COUNT) {
    errors.push(finding('sidebar-item-count', REQUIRED_PATHS.sidebar, `expected ${EXPECTED_ITEM_COUNT} service-bound sidebar items, found ${items.length}`));
  }
  const groupCounts = new Map();
  for (const item of items) {
    groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
    if (!item.serviceKey.startsWith('Yeni')) errors.push(finding(
      'sidebar-service-key-shape', REQUIRED_PATHS.sidebar, `sidebar service key must use the Yeni* identity: ${item.serviceKey}`,
    ));
  }
  for (const [group, expected] of Object.entries(EXPECTED_GROUP_COUNTS)) {
    const actual = groupCounts.get(group) ?? 0;
    if (actual !== expected) errors.push(finding('sidebar-group-count', REQUIRED_PATHS.sidebar, `${group} must contain ${expected} items, found ${actual}`));
  }
  for (const unknown of [...groupCounts.keys()].filter((group) => !Object.hasOwn(EXPECTED_GROUP_COUNTS, group))) {
    errors.push(finding('sidebar-unknown-group', REQUIRED_PATHS.sidebar, `unexpected sidebar group: ${unknown}`));
  }
  for (const duplicate of duplicateValues(items.map((item) => item.windowId))) errors.push(finding(
    'duplicate-window-id', REQUIRED_PATHS.sidebar, `sidebar window id must be unique: ${duplicate}`,
  ));
  for (const duplicate of duplicateValues(items.map((item) => item.serviceKey))) errors.push(finding(
    'duplicate-service-key', REQUIRED_PATHS.sidebar, `sidebar service key must be unique: ${duplicate}`,
  ));
  return items;
};

const checkWindowCoverage = (files, items, errors) => {
  const source = readRequired(files, REQUIRED_PATHS.windows, errors);
  if (!source) return;
  const windows = parseQueryWindowIds(source);
  const windowSet = new Set(windows);
  for (const item of items) if (!windowSet.has(item.windowId)) errors.push(finding(
    'missing-query-window', REQUIRED_PATHS.windows, `sidebar item ${item.label} has no registered query window: ${item.windowId}`,
  ));
  for (const duplicate of duplicateValues(windows)) errors.push(finding(
    'duplicate-query-window', REQUIRED_PATHS.windows, `query registry contains duplicate id: ${duplicate}`,
  ));
};

const checkProfileCoverage = (files, items, errors) => {
  const source = readRequired(files, REQUIRED_PATHS.profiles, errors);
  if (!source) return;
  const profiles = parseFastAccessProfiles(source);
  const itemKeys = new Set(items.map((item) => item.serviceKey));
  const profileKeys = new Set(profiles.map((profile) => profile.serviceKey));
  if (profiles.length !== EXPECTED_ITEM_COUNT) errors.push(finding(
    'profile-count', REQUIRED_PATHS.profiles, `expected ${EXPECTED_ITEM_COUNT} fast-access profiles, found ${profiles.length}`,
  ));
  for (const item of items) if (!profileKeys.has(item.serviceKey)) errors.push(finding(
    'missing-profile', REQUIRED_PATHS.profiles, `sidebar key has no PlanASKI profile: ${item.serviceKey}`,
  ));
  for (const profile of profiles) {
    if (!itemKeys.has(profile.serviceKey)) errors.push(finding(
      'orphan-profile', REQUIRED_PATHS.profiles, `profile is not represented in sidebar: ${profile.serviceKey}`,
    ));
    if (profile.probes.length === 0) errors.push(finding(
      'empty-profile-probes', REQUIRED_PATHS.profiles, `profile requires a discovery term: ${profile.serviceKey}`,
    ));
    if (profile.title.trim().length < 3) errors.push(finding(
      'invalid-profile-title', REQUIRED_PATHS.profiles, `profile title is too short: ${profile.serviceKey}`,
    ));
  }
  for (const duplicate of duplicateValues(profiles.map((profile) => profile.serviceKey))) errors.push(finding(
    'duplicate-profile', REQUIRED_PATHS.profiles, `profile service key must be unique: ${duplicate}`,
  ));
};

const checkIconCoverage = (files, items, errors) => {
  const source = readRequired(files, REQUIRED_PATHS.icons, errors);
  if (!source) return;
  const aliases = parseIconServiceAliases(source, errors);
  for (const item of items) {
    const owners = aliases.get(item.serviceKey) ?? [];
    if (owners.length === 1) continue;
    errors.push(finding(
      owners.length === 0 ? 'missing-service-icon' : 'ambiguous-service-icon',
      REQUIRED_PATHS.icons,
      owners.length === 0 ? `service key has no deterministic icon: ${item.serviceKey}` : `service key resolves to multiple icons: ${item.serviceKey} -> ${owners.join(', ')}`,
    ));
  }
};

const requirePatterns = (files, file, contracts, errors) => {
  const source = readRequired(files, file, errors);
  if (!source) return '';
  for (const contract of contracts) {
    if (contract.pattern.test(source)) continue;
    errors.push(finding(contract.id, file, contract.message));
  }
  return source;
};

const checkPlanAskiOnlyContracts = (files, errors) => {
  const factory = requirePatterns(files, REQUIRED_PATHS.businessFactory, [
    { id: 'missing-kent-rehberi-business-route', pattern: /createKentRehberiFastAccessBusiness\(serviceKey\)/u, message: 'all supported fast-access queries must route through the PlanASKI runtime' },
    { id: 'missing-unsupported-profile-guard', pattern: /if\s*\(!business\)\s*\{/u, message: 'unknown services must fail closed instead of falling back to another API' },
    { id: 'missing-unsupported-profile-error', pattern: /No PlanASKI Kent Rehberi profile is registered/u, message: 'unsupported service failures must clearly identify missing PlanASKI profiles' },
  ], errors);
  if (/createFastAccessBusiness|legacyBusiness|FastAccessQueryBusiness\.QueryFastAccessService/u.test(factory)) {
    errors.push(finding('legacy-fast-access-fallback', REQUIRED_PATHS.businessFactory, 'legacy API fallback must not be reachable from the active client'));
  }

  requirePatterns(files, REQUIRED_PATHS.runtime, [
    { id: 'missing-type-catalog-fetch', pattern: /fetchKentRehberiTypeCatalog/u, message: 'fast-access resolution must use the bounded PlanASKI type catalog' },
    { id: 'missing-catalog-classifier', pattern: /resolveKentRehberiTypesFromCatalog/u, message: 'profiles must be classified against PlanASKI catalog samples' },
    { id: 'missing-catalog-first-resolution', pattern: /await\s+resolveCatalogTypes\(profile,\s*control\)/u, message: 'type catalog must be queried before bounded text probes' },
    { id: 'missing-bounded-category-limit', pattern: /const\s+CATEGORY_LIMIT\s*=\s*2000/u, message: 'category requests must remain bounded to 2000 records' },
    { id: 'missing-fast-access-source-tag', pattern: /KENT_REHBERI_FAST_ACCESS_SOURCE\s*=\s*'kent-rehberi'/u, message: 'PlanASKI results must retain a stable source tag' },
  ], errors);

  const transport = requirePatterns(files, REQUIRED_PATHS.transport, [
    { id: 'missing-planaski-geojson-direct', pattern: /fetchPlanAskiGeoJsonDirect/u, message: 'GeoJSON data must load directly from PlanASKI' },
    { id: 'missing-planaski-feature-direct', pattern: /fetchPlanAskiFeatureDirect/u, message: 'feature details must load directly from PlanASKI' },
    { id: 'missing-planaski-catalog-direct', pattern: /fetchPlanAskiTypeCatalogDirect/u, message: 'type catalog must load directly from PlanASKI' },
    { id: 'missing-response-budget', pattern: /maxPayloadBytes/u, message: 'the browser transport must keep a response-size budget' },
    { id: 'missing-abort-controller', pattern: /AbortController/u, message: 'the browser transport must support abort/timeout cancellation' },
  ], errors);
  if (/runtimeConfig|apiBaseUrl|credentials:\s*['"]same-origin|\/kent-rehberi\/types|buildKentRehberiRequestPath/u.test(transport)) {
    errors.push(finding('legacy-kent-rehberi-transport', REQUIRED_PATHS.transport, 'Kent Rehberi transport must not retain same-origin API/proxy fallbacks'));
  }

  requirePatterns(files, REQUIRED_PATHS.directTransport, [
    { id: 'missing-fixed-planaski-host', pattern: /https:\/\/planaski\.ankara\.bel\.tr\/kentrehberiapi\/api\/kentrehberi/u, message: 'browser endpoint must be pinned to the official PlanASKI host and path' },
    { id: 'missing-tur-range', pattern: /const\s+MIN_TYPE\s*=\s*0[\s\S]*const\s+MAX_TYPE\s*=\s*42/u, message: 'PlanASKI tur values must remain bounded to 0..42' },
    { id: 'missing-tur-query', pattern: /\?tur=/u, message: 'all direct source requests must select an explicit tur category' },
    { id: 'missing-upstream-byte-budget', pattern: /MAX_BYTES_PER_TYPE/u, message: 'response bytes per category must be bounded' },
    { id: 'missing-upstream-concurrency', pattern: /MAX_IN_FLIGHT/u, message: 'concurrent upstream category requests must be limited' },
    { id: 'missing-upstream-abort', pattern: /AbortController/u, message: 'upstream fetch and catalog collection must support cancellation' },
  ], errors);
  if (/VITE_API_URL|VITE_API_BASE_URL|VITE_API_PROXY_TARGET|VITE_LOCAL_BOOTSTRAP_PREVIEW|VITE_PUBLIC_MAP_ONLY_MODE|VITE_KENT_REHBERI_SOURCE/u.test(files[REQUIRED_PATHS.envExample] ?? '')) {
    errors.push(finding('legacy-runtime-env-keys', REQUIRED_PATHS.envExample, 'static-only release must not configure API/proxy settings or an unnecessary source-mode flag'));
  }

  const vite = requirePatterns(files, REQUIRED_PATHS.vite, [
    { id: 'missing-planaski-only-vite-mode', pattern: /envPrefix:\s*\[\s*['"]VITE_['"]\s*\]/u, message: 'Vite must expose only public VITE environment values' },
  ], errors);
  if (/resolveLocalApiProxyTarget|apiProxyTarget|['"]\/api['"]|target:\s*apiProxyTarget/u.test(vite)) {
    errors.push(finding('legacy-local-api-proxy', REQUIRED_PATHS.vite, 'Vite must not proxy requests to a local User API'));
  }

  const configuration = requirePatterns(files, REQUIRED_PATHS.configurationBusiness, [
    { id: 'missing-static-map-configuration', pattern: /STATIC_MAP_CONFIGURATION/u, message: 'initial map configuration must be local and deterministic' },
    { id: 'missing-empty-legacy-service-list', pattern: /getConfigServices[\s\S]*?Object\.freeze\(\[\]\)/u, message: 'legacy GIS service catalogue must remain empty' },
  ], errors);
  if (/apiClient|AppSettings\/List|Gis\/ConfigService\/List|resolveLocalBootstrapPreviewEnabled/u.test(configuration)) {
    errors.push(finding('legacy-configuration-api', REQUIRED_PATHS.configurationBusiness, 'startup configuration must not call an API or use preview fallback flags'));
  }
};

const checkReleaseIntegration = (files, errors) => {
  const packageSource = readRequired(files, REQUIRED_PATHS.package, errors);
  if (packageSource) {
    const manifest = parseJson(packageSource, REQUIRED_PATHS.package, errors);
    const scripts = manifest?.scripts;
    if (typeof scripts?.['quality:kent-rehberi-all-layers'] !== 'string'
        || !scripts['quality:kent-rehberi-all-layers'].includes('kent-rehberi-all-layers-audit.mjs')
        || !scripts['quality:kent-rehberi-all-layers'].includes('--strict')) {
      errors.push(finding('missing-package-quality-gate', REQUIRED_PATHS.package, 'package.json must expose a strict all-layer quality gate'));
    }
    if (typeof scripts?.['test:tooling'] !== 'string' || !scripts['test:tooling'].includes('kent-rehberi-all-layers-audit.test.mjs')) {
      errors.push(finding('missing-audit-unit-test', REQUIRED_PATHS.package, 'test:tooling must execute all-layer contract tests'));
    }
    if (typeof scripts?.verify !== 'string' || !scripts.verify.includes('quality:kent-rehberi-all-layers')) {
      errors.push(finding('missing-verify-quality-gate', REQUIRED_PATHS.package, 'verify must execute the all-layer contract audit'));
    }
  }
  for (const workflow of [REQUIRED_PATHS.qualityWorkflow, REQUIRED_PATHS.releaseWorkflow]) {
    const source = readRequired(files, workflow, errors);
    if (source && !/npm\s+run\s+quality:kent-rehberi-all-layers/u.test(source)) {
      errors.push(finding('missing-workflow-quality-gate', workflow, 'workflow must execute quality:kent-rehberi-all-layers'));
    }
  }
};

export const auditKentRehberiAllLayersSources = (files) => {
  const errors = [];
  const items = checkSidebarInventory(files, errors);
  checkWindowCoverage(files, items, errors);
  checkProfileCoverage(files, items, errors);
  checkIconCoverage(files, items, errors);
  checkPlanAskiOnlyContracts(files, errors);
  checkReleaseIntegration(files, errors);
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    checkedFiles: Object.freeze(Object.keys(files).sort()),
    sidebarItems: items.length,
  });
};

const repositoryFiles = (root) => {
  const files = {};
  for (const file of Object.values(REQUIRED_PATHS)) {
    const absolute = path.resolve(root, file);
    if (fs.existsSync(absolute)) files[file] = fs.readFileSync(absolute, 'utf8');
  }
  return files;
};

export const auditKentRehberiAllLayersRepository = (root = process.cwd()) =>
  auditKentRehberiAllLayersSources(repositoryFiles(root));

const isEntrypoint = import.meta.url === new URL(`file://${process.argv[1] ?? ''}`).href
  || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (isEntrypoint) {
  const args = new Set(process.argv.slice(2));
  const result = auditKentRehberiAllLayersRepository();
  if (args.has('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const error of result.errors) process.stderr.write(`ERROR [${error.id}] ${error.file}: ${error.message}\n`);
    process.stdout.write(`Kent Rehberi all-layer audit checked ${result.checkedFiles.length} files and ${result.sidebarItems} sidebar layers: ${result.errors.length} error(s).\n`);
  }
  if (args.has('--strict') && !result.ok) process.exit(1);
}
