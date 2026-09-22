import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PATHS = Object.freeze({
  sidebar: 'src/Components/App/SidebarCatalog.ts',
  windows: 'src/Components/Common/QueryWindowRegistry.tsx',
  profiles: 'src/Business/kentRehberiFastAccessProfiles.ts',
  businessFactory: 'src/Business/createFastAccessQueryBusiness.ts',
  runtime: 'src/Business/kentRehberiFastAccessRuntime.ts',
  transport: 'src/data-services/kentRehberiGeoJsonLayer.ts',
  icons: 'src/gis-engine/iconRegistry.json',
  vite: 'vite.config.ts',
  package: 'package.json',
  qualityWorkflow: '../.github/workflows/webclient-quality.yml',
  releaseWorkflow: '../.github/workflows/release-qa.yml',
  backendController: '../Api.User/Controllers/KentRehberiController.cs',
  backendRepository: '../Api.User/KentRehberi/KentRehberiRepository.cs',
  backendPlanAskiSource: '../Api.User/KentRehberi/KentRehberiPlanAskiSource.cs',
  backendPlanAskiRepository: '../Api.User/KentRehberi/KentRehberiPlanAskiRepository.cs',
  backendRegistration: '../Api.User/KentRehberi/KentRehberiServiceCollectionExtensions.cs',
  backendOptions: '../Api.User/KentRehberi/KentRehberiOptions.cs',
  backendSettings: '../Api.User/appsettings.json',
});

const EXPECTED_GROUP_COUNTS = Object.freeze({
  ABB: 17,
  EGO: 8,
  ASKI: 6,
  ISTIRAK: 9,
});

const EXPECTED_ITEM_COUNT = Object.values(EXPECTED_GROUP_COUNTS)
  .reduce((total, value) => total + value, 0);

const finding = (id, file, message) => Object.freeze({
  severity: 'error',
  id,
  file,
  message,
});

const readRequired = (files, file, errors) => {
  const source = files[file];
  if (typeof source === 'string') return source;
  errors.push(finding(
    'missing-file',
    file,
    `required Kent Rehberi all-layer contract file is missing: ${file}`,
  ));
  return '';
};

const parseJson = (source, file, errors) => {
  try {
    return JSON.parse(source);
  } catch (error) {
    errors.push(finding(
      'invalid-json',
      file,
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
};

export const parseSidebarItems = (source) => {
  const pattern = /\{\s*group:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*windowId:\s*'([^']+)'\s*,\s*iconType:\s*'([^']+)'\s*,\s*serviceKey:\s*'([^']+)'\s*\}/gu;
  return Object.freeze([...source.matchAll(pattern)].map((match) => Object.freeze({
    group: match[1],
    label: match[2],
    windowId: match[3],
    iconType: match[4],
    serviceKey: match[5],
  })));
};

export const parseQueryWindowIds = (source) => Object.freeze(
  [...source.matchAll(/defineWindow\(\s*'([^']+)'/gu)]
    .map((match) => match[1]),
);

const parseQuotedArray = (source) => Object.freeze(
  [...source.matchAll(/'([^']+)'/gu)]
    .map((match) => match[1]),
);

export const parseFastAccessProfiles = (source) => {
  const pattern = /freezeProfile\(\{\s*serviceKey:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'\s*,\s*probes:\s*\[([^\]]*)\][\s\S]*?mode:\s*'(first|union)'\s*,\s*\}\)/gu;
  return Object.freeze([...source.matchAll(pattern)].map((match) => Object.freeze({
    serviceKey: match[1],
    title: match[2],
    probes: parseQuotedArray(match[3]),
    mode: match[4],
  })));
};

export const parseIconServiceAliases = (source, errors = []) => {
  const parsed = parseJson(source, REQUIRED_PATHS.icons, errors);
  if (!Array.isArray(parsed)) return new Map();

  const aliases = new Map();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    if (!Array.isArray(entry.aliases)) continue;
    for (const alias of entry.aliases) {
      if (typeof alias !== 'string' || !alias.startsWith('Yeni')) continue;
      const existing = aliases.get(alias) ?? [];
      existing.push(entry.id);
      aliases.set(alias, existing);
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
    errors.push(finding(
      'sidebar-item-count',
      REQUIRED_PATHS.sidebar,
      `expected ${EXPECTED_ITEM_COUNT} service-bound sidebar items, found ${items.length}`,
    ));
  }

  const groupCounts = new Map();
  for (const item of items) {
    groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
    if (!item.serviceKey.startsWith('Yeni')) {
      errors.push(finding(
        'sidebar-service-key-shape',
        REQUIRED_PATHS.sidebar,
        `sidebar service key must use the Yeni* fast-access identity: ${item.serviceKey}`,
      ));
    }
  }

  for (const [group, expected] of Object.entries(EXPECTED_GROUP_COUNTS)) {
    const actual = groupCounts.get(group) ?? 0;
    if (actual !== expected) {
      errors.push(finding(
        'sidebar-group-count',
        REQUIRED_PATHS.sidebar,
        `${group} must contain ${expected} fast-access items, found ${actual}`,
      ));
    }
  }

  for (const unknown of [...groupCounts.keys()].filter(
    (group) => !Object.prototype.hasOwnProperty.call(EXPECTED_GROUP_COUNTS, group),
  )) {
    errors.push(finding(
      'sidebar-unknown-group',
      REQUIRED_PATHS.sidebar,
      `unexpected all-layer sidebar group: ${unknown}`,
    ));
  }

  for (const duplicate of duplicateValues(items.map((item) => item.windowId))) {
    errors.push(finding(
      'duplicate-window-id',
      REQUIRED_PATHS.sidebar,
      `sidebar window id must be unique: ${duplicate}`,
    ));
  }
  for (const duplicate of duplicateValues(items.map((item) => item.serviceKey))) {
    errors.push(finding(
      'duplicate-service-key',
      REQUIRED_PATHS.sidebar,
      `sidebar service key must be unique: ${duplicate}`,
    ));
  }

  return items;
};

const checkWindowCoverage = (files, items, errors) => {
  const source = readRequired(files, REQUIRED_PATHS.windows, errors);
  if (!source) return;
  const windows = parseQueryWindowIds(source);
  const windowSet = new Set(windows);

  for (const item of items) {
    if (windowSet.has(item.windowId)) continue;
    errors.push(finding(
      'missing-query-window',
      REQUIRED_PATHS.windows,
      `sidebar item ${item.label} has no registered query window: ${item.windowId}`,
    ));
  }

  for (const duplicate of duplicateValues(windows)) {
    errors.push(finding(
      'duplicate-query-window',
      REQUIRED_PATHS.windows,
      `query window registry contains duplicate id: ${duplicate}`,
    ));
  }
};

const checkProfileCoverage = (files, items, errors) => {
  const source = readRequired(files, REQUIRED_PATHS.profiles, errors);
  if (!source) return;
  const profiles = parseFastAccessProfiles(source);
  const itemKeys = new Set(items.map((item) => item.serviceKey));
  const profileKeys = new Set(profiles.map((profile) => profile.serviceKey));

  if (profiles.length !== EXPECTED_ITEM_COUNT) {
    errors.push(finding(
      'profile-count',
      REQUIRED_PATHS.profiles,
      `expected ${EXPECTED_ITEM_COUNT} fast-access profiles, found ${profiles.length}`,
    ));
  }

  for (const item of items) {
    if (profileKeys.has(item.serviceKey)) continue;
    errors.push(finding(
      'missing-profile',
      REQUIRED_PATHS.profiles,
      `sidebar service key has no Kent Rehberi fast-access profile: ${item.serviceKey}`,
    ));
  }

  for (const profile of profiles) {
    if (!itemKeys.has(profile.serviceKey)) {
      errors.push(finding(
        'orphan-profile',
        REQUIRED_PATHS.profiles,
        `fast-access profile is not represented in the sidebar catalog: ${profile.serviceKey}`,
      ));
    }
    if (profile.probes.length === 0) {
      errors.push(finding(
        'empty-profile-probes',
        REQUIRED_PATHS.profiles,
        `fast-access profile requires at least one bounded discovery term: ${profile.serviceKey}`,
      ));
    }
    if (profile.title.trim().length < 3) {
      errors.push(finding(
        'invalid-profile-title',
        REQUIRED_PATHS.profiles,
        `fast-access profile title is too short: ${profile.serviceKey}`,
      ));
    }
  }

  for (const duplicate of duplicateValues(profiles.map((profile) => profile.serviceKey))) {
    errors.push(finding(
      'duplicate-profile',
      REQUIRED_PATHS.profiles,
      `fast-access profile service key must be unique: ${duplicate}`,
    ));
  }
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
      owners.length === 0
        ? `service key has no deterministic icon alias: ${item.serviceKey}`
        : `service key resolves to multiple icon entries: ${item.serviceKey} -> ${owners.join(', ')}`,
    ));
  }
};

const requirePatterns = (files, file, contracts, errors) => {
  const source = readRequired(files, file, errors);
  if (!source) return;
  for (const contract of contracts) {
    if (contract.pattern.test(source)) continue;
    errors.push(finding(
      contract.id,
      file,
      contract.message,
    ));
  }
};

const checkFrontendRuntimeContracts = (files, errors) => {
  requirePatterns(files, REQUIRED_PATHS.businessFactory, [
    {
      id: 'missing-kent-rehberi-business-route',
      pattern: /createKentRehberiFastAccessBusiness\(serviceKey\)/u,
      message: 'fast-access business factory must route supported layers through Kent Rehberi runtime',
    },
    {
      id: 'missing-legacy-fallback',
      pattern: /kentRehberiBusiness\s*\?\s*null\s*:\s*createFastAccessBusiness\(serviceKey\)/u,
      message: 'legacy fast-access transport must remain only as an explicit fallback for unmapped services',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.runtime, [
    {
      id: 'missing-type-catalog-fetch',
      pattern: /fetchKentRehberiTypeCatalog/u,
      message: 'all-layer runtime must load the bounded backend type catalog',
    },
    {
      id: 'missing-catalog-classifier',
      pattern: /resolveKentRehberiTypesFromCatalog/u,
      message: 'all-layer runtime must classify service profiles against bounded catalog samples',
    },
    {
      id: 'missing-catalog-first-resolution',
      pattern: /await\s+resolveCatalogTypes\(profile,\s*control\)/u,
      message: 'category resolution must prefer the type catalog before probe fallback',
    },
    {
      id: 'missing-bounded-category-limit',
      pattern: /const\s+CATEGORY_LIMIT\s*=\s*2000/u,
      message: 'category fetches must remain bounded to the public API maximum',
    },
    {
      id: 'missing-fast-access-source-tag',
      pattern: /KENT_REHBERI_FAST_ACCESS_SOURCE\s*=\s*'kent-rehberi'/u,
      message: 'Kent Rehberi-backed results must retain a stable source tag',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.transport, [
    {
      id: 'missing-same-origin-credentials',
      pattern: /credentials:\s*'same-origin'/u,
      message: 'Kent Rehberi browser requests must remain same-origin',
    },
    {
      id: 'missing-type-catalog-path',
      pattern: /kent-rehberi\/types/u,
      message: 'frontend transport must use the bounded type catalog endpoint',
    },
    {
      id: 'missing-payload-budget',
      pattern: /maxPayloadBytes/u,
      message: 'frontend transport must enforce response payload budgets',
    },
    {
      id: 'missing-request-abort',
      pattern: /AbortController/u,
      message: 'frontend transport must support cancellation and timeouts',
    },
  ], errors);

  const vite = readRequired(files, REQUIRED_PATHS.vite, errors);
  if (vite) {
    if (!/target:\s*'https:\/\/localhost:3003'/u.test(vite)) {
      errors.push(finding(
        'insecure-or-missing-dev-api-proxy',
        REQUIRED_PATHS.vite,
        'local Vite /api proxy must target the real HTTPS User API on localhost:3003',
      ));
    }
    for (const marker of [
      'localKentRehberiDemo',
      'x-kent-rehberi-demo',
      'Yerel Demo — Kent Rehberi',
    ]) {
      if (!vite.includes(marker)) continue;
      errors.push(finding(
        'forbidden-local-demo-source',
        REQUIRED_PATHS.vite,
        `local demo data source must not replace the real backend contract: ${marker}`,
      ));
    }
  }
};

const checkBackendContracts = (files, errors) => {
  requirePatterns(files, REQUIRED_PATHS.backendController, [
    {
      id: 'missing-types-endpoint',
      pattern: /\[HttpGet\("types"\)\]/u,
      message: 'User API must expose the bounded Kent Rehberi type catalog',
    },
    {
      id: 'missing-types-service',
      pattern: /IKentRehberiTypeCatalogService/u,
      message: 'type catalog endpoint must execute through the governed catalog service',
    },
    {
      id: 'missing-types-cache-control',
      pattern: /TypeCatalogCacheTtlSeconds/u,
      message: 'type catalog endpoint must emit bounded cache policy',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.backendPlanAskiSource, [
    {
      id: 'missing-official-planaski-host',
      pattern: /planaski\.ankara\.bel\.tr/u,
      message: 'primary upstream source must be pinned to the official PlanASKI host',
    },
    {
      id: 'missing-planaski-path',
      pattern: /kentrehberiapi\/api\/kentrehberi/u,
      message: 'primary upstream source must use the official Kent Rehberi path',
    },
    {
      id: 'missing-planaski-tur-query',
      pattern: /"tur="\s*\+/u,
      message: 'PlanASKI source must issue bounded tur queries',
    },
    {
      id: 'missing-planaski-byte-budget',
      pattern: /PlanAskiMaxResponseBytesPerType/u,
      message: 'PlanASKI source must bound response bytes per type',
    },
    {
      id: 'missing-planaski-record-budget',
      pattern: /PlanAskiMaxRecordsPerType/u,
      message: 'PlanASKI source must bound records per type',
    },
    {
      id: 'missing-planaski-concurrency',
      pattern: /SemaphoreSlim/u,
      message: 'PlanASKI source must bound upstream concurrency',
    },
    {
      id: 'missing-planaski-cache',
      pattern: /PlanAskiCacheTtlSeconds/u,
      message: 'PlanASKI source must cache successful type responses',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.backendPlanAskiRepository, [
    {
      id: 'missing-planaski-all-types',
      pattern: /GetAllTypesAsync/u,
      message: 'PlanASKI repository must support the configured inclusive type catalog',
    },
    {
      id: 'missing-planaski-single-type',
      pattern: /GetTypeAsync/u,
      message: 'PlanASKI repository must fetch a requested category without loading unrelated types',
    },
    {
      id: 'missing-planaski-catalog',
      pattern: /GetTypeCatalogAsync/u,
      message: 'PlanASKI repository must expose the bounded type catalog',
    },
    {
      id: 'missing-planaski-nearby',
      pattern: /HaversineMeters/u,
      message: 'PlanASKI repository must preserve nearby-query behavior',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.backendRegistration, [
    {
      id: 'missing-planaski-http-client',
      pattern: /AddHttpClient/u,
      message: 'User API must own the PlanASKI HTTP transport server-side',
    },
    {
      id: 'missing-planaski-no-redirect',
      pattern: /AllowAutoRedirect\s*=\s*false/u,
      message: 'PlanASKI HTTP transport must not follow redirects',
    },
    {
      id: 'missing-planaski-source-selection',
      pattern: /KentRehberiOptions\.PlanAskiSource/u,
      message: 'repository selection must honor the configured PlanASKI source',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.backendRepository, [
    {
      id: 'missing-postgis-fallback-table',
      pattern: /kent_rehberi\.kent_rehberi_tumu_pggeom/u,
      message: 'PostGIS compatibility repository must retain its server-owned fixed table',
    },
    {
      id: 'missing-postgis-parameterization',
      pattern: /AddWithValue/u,
      message: 'PostGIS fallback must continue parameterizing user input',
    },
  ], errors);

  requirePatterns(files, REQUIRED_PATHS.backendOptions, [
    {
      id: 'missing-planaski-source-option',
      pattern: /PlanAskiSource/u,
      message: 'backend options must expose the reviewed PlanASKI source mode',
    },
    {
      id: 'missing-planaski-range-options',
      pattern: /PlanAskiMinTur[\s\S]*PlanAskiMaxTur/u,
      message: 'backend options must bound the official PlanASKI tur range',
    },
    {
      id: 'missing-planaski-url-validation',
      pattern: /planaski\.ankara\.bel\.tr/u,
      message: 'backend options must pin the upstream to the official PlanASKI host',
    },
    {
      id: 'missing-type-budget-option',
      pattern: /TypeCatalogMaxTypes/u,
      message: 'backend options must bound type catalog cardinality',
    },
    {
      id: 'missing-sample-budget-option',
      pattern: /TypeCatalogSamplesPerType/u,
      message: 'backend options must bound catalog samples per type',
    },
    {
      id: 'missing-catalog-byte-budget',
      pattern: /TypeCatalogMaxResponseBytes/u,
      message: 'backend options must bound serialized catalog size',
    },
  ], errors);

  const settingsSource = readRequired(files, REQUIRED_PATHS.backendSettings, errors);
  if (!settingsSource) return;
  const settings = parseJson(settingsSource, REQUIRED_PATHS.backendSettings, errors);
  const config = settings?.KentRehberiData;
  if (!config || typeof config !== 'object') {
    errors.push(finding(
      'missing-backend-settings',
      REQUIRED_PATHS.backendSettings,
      'KentRehberiData configuration is required',
    ));
    return;
  }

  const expected = {
    Source: 'PlanAski',
    PlanAskiBaseUri: 'https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi',
    PlanAskiMinTur: 0,
    PlanAskiMaxTur: 42,
    PlanAskiRequestTimeoutSeconds: 10,
    PlanAskiCacheTtlSeconds: 300,
    PlanAskiMaxConcurrentRequests: 6,
    PlanAskiMaxRecordsPerType: 20000,
    PlanAskiMaxResponseBytesPerType: 8388608,
    TypeCatalogMaxTypes: 43,
    TypeCatalogSamplesPerType: 16,
    TypeCatalogCacheTtlSeconds: 300,
    TypeCatalogMaxTextLength: 240,
    TypeCatalogMaxResponseBytes: 1048576,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] === value) continue;
    errors.push(finding(
      'backend-setting-drift',
      REQUIRED_PATHS.backendSettings,
      `KentRehberiData:${key} must remain at the reviewed bounded default ${value}`,
    ));
  }
};

const checkReleaseIntegration = (files, errors) => {
  const packageSource = readRequired(files, REQUIRED_PATHS.package, errors);
  if (packageSource) {
    const manifest = parseJson(packageSource, REQUIRED_PATHS.package, errors);
    const scripts = manifest?.scripts;
    const quality = scripts?.['quality:kent-rehberi-all-layers'];
    if (
      typeof quality !== 'string'
      || !quality.includes('kent-rehberi-all-layers-audit.mjs')
      || !quality.includes('--strict')
    ) {
      errors.push(finding(
        'missing-package-quality-gate',
        REQUIRED_PATHS.package,
        'package.json must expose strict quality:kent-rehberi-all-layers',
      ));
    }

    const tooling = scripts?.['test:tooling'];
    if (
      typeof tooling !== 'string'
      || !tooling.includes('kent-rehberi-all-layers-audit.test.mjs')
    ) {
      errors.push(finding(
        'missing-audit-unit-test',
        REQUIRED_PATHS.package,
        'test:tooling must execute the all-layer audit regression suite',
      ));
    }

    const verify = scripts?.verify;
    if (
      typeof verify !== 'string'
      || !verify.includes('quality:kent-rehberi-all-layers')
    ) {
      errors.push(finding(
        'missing-verify-quality-gate',
        REQUIRED_PATHS.package,
        'verify must execute the all-layer contract audit',
      ));
    }
  }

  for (const workflow of [
    REQUIRED_PATHS.qualityWorkflow,
    REQUIRED_PATHS.releaseWorkflow,
  ]) {
    const source = readRequired(files, workflow, errors);
    if (!source) continue;
    if (/npm\s+run\s+quality:kent-rehberi-all-layers/u.test(source)) continue;
    errors.push(finding(
      'missing-workflow-quality-gate',
      workflow,
      'workflow must execute quality:kent-rehberi-all-layers',
    ));
  }
};

export const auditKentRehberiAllLayersSources = (files) => {
  const errors = [];
  const items = checkSidebarInventory(files, errors);
  checkWindowCoverage(files, items, errors);
  checkProfileCoverage(files, items, errors);
  checkIconCoverage(files, items, errors);
  checkFrontendRuntimeContracts(files, errors);
  checkBackendContracts(files, errors);
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
    if (!fs.existsSync(absolute)) continue;
    files[file] = fs.readFileSync(absolute, 'utf8');
  }
  return files;
};

export const auditKentRehberiAllLayersRepository = (
  root = process.cwd(),
) => auditKentRehberiAllLayersSources(repositoryFiles(root));

const isEntrypoint = (
  import.meta.url === new URL(`file://${process.argv[1] ?? ''}`).href
  || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')
);

if (isEntrypoint) {
  const args = new Set(process.argv.slice(2));
  const result = auditKentRehberiAllLayersRepository();

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const error of result.errors) {
      process.stderr.write(
        `ERROR [${error.id}] ${error.file}: ${error.message}\n`,
      );
    }
    process.stdout.write(
      `Kent Rehberi all-layer audit checked ${result.checkedFiles.length} files and ${result.sidebarItems} sidebar layers: ${result.errors.length} error(s).\n`,
    );
  }

  if (args.has('--strict') && !result.ok) process.exit(1);
}
