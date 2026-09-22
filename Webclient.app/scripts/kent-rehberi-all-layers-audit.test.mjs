import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  auditKentRehberiAllLayersSources,
  parseFastAccessProfiles,
  parseIconServiceAliases,
  parseQueryWindowIds,
  parseSidebarItems,
} from './kent-rehberi-all-layers-audit.mjs';

const PATHS = Object.freeze({
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

const GROUPS = Object.freeze([
  ['ABB', 17],
  ['EGO', 8],
  ['ASKI', 6],
  ['ISTIRAK', 9],
]);

const inventory = () => {
  const items = [];
  let index = 1;
  for (const [group, count] of GROUPS) {
    for (let groupIndex = 0; groupIndex < count; groupIndex += 1) {
      items.push(Object.freeze({
        group,
        label: `${group} Service ${groupIndex + 1}`,
        windowId: `window-${index}`,
        iconType: `icon-${index}`,
        serviceKey: `YeniService${index}QueryUrl`,
      }));
      index += 1;
    }
  }
  return Object.freeze(items);
};

const sidebarSource = (items) => `
export const SIDEBAR_ITEMS = Object.freeze([
${items.map((item) => `  { group: '${item.group}', label: '${item.label}', windowId: '${item.windowId}', iconType: '${item.iconType}', serviceKey: '${item.serviceKey}' },`).join('\n')}
]);
`;

const windowSource = (items) => `
export const QUERY_WINDOW_DEFINITIONS = Object.freeze([
${items.map((item) => `  defineWindow('${item.windowId}', '${item.label}', loader, 'Window'),`).join('\n')}
]);
`;

const profileSource = (items) => `
const PROFILES = Object.freeze([
${items.map((item) => `
  freezeProfile({
    serviceKey: '${item.serviceKey}',
    title: '${item.label}',
    probes: ['service ${item.serviceKey}'],
    preferTerms: ['service'],
    excludeTerms: [],
    mode: 'first',
  }),`).join('\n')}
]);
`;

const iconSource = (items) => JSON.stringify(items.map((item, index) => ({
  id: `icon-${index + 1}`,
  aliases: [item.serviceKey],
})));

const validFixture = () => {
  const items = inventory();
  return {
    [PATHS.sidebar]: sidebarSource(items),
    [PATHS.windows]: windowSource(items),
    [PATHS.profiles]: profileSource(items),
    [PATHS.businessFactory]: `
      const kentRehberiBusiness = createKentRehberiFastAccessBusiness(serviceKey);
      const legacyBusiness = kentRehberiBusiness ? null : createFastAccessBusiness(serviceKey);
    `,
    [PATHS.runtime]: `
      import { fetchKentRehberiTypeCatalog } from '../data-services/kentRehberiGeoJsonLayer';
      const CATEGORY_LIMIT = 2000;
      export const KENT_REHBERI_FAST_ACCESS_SOURCE = 'kent-rehberi';
      export const resolveKentRehberiTypesFromCatalog = () => [];
      const result = await resolveCatalogTypes(profile, control);
    `,
    [PATHS.transport]: `
      const path = '/kent-rehberi/types';
      const maxPayloadBytes = 1;
      const request = new AbortController();
      fetchImpl(path, { credentials: 'same-origin' });
    `,
    [PATHS.icons]: iconSource(items),
    [PATHS.vite]: `
      export default {
        server: {
          proxy: {
            '/api': {
              target: 'https://localhost:3003',
            },
          },
        },
      };
    `,
    [PATHS.package]: JSON.stringify({
      scripts: {
        'quality:kent-rehberi-all-layers': 'node scripts/kent-rehberi-all-layers-audit.mjs --strict',
        'test:tooling': 'node --test scripts/kent-rehberi-all-layers-audit.test.mjs',
        verify: 'npm run quality:kent-rehberi-all-layers',
      },
    }),
    [PATHS.qualityWorkflow]: 'run: npm run quality:kent-rehberi-all-layers',
    [PATHS.releaseWorkflow]: 'run: npm run quality:kent-rehberi-all-layers',
    [PATHS.backendController]: `
      private readonly IKentRehberiTypeCatalogService typeCatalogService;
      [HttpGet("types")]
      public Task Types() {
        var ttl = options.TypeCatalogCacheTtlSeconds;
        return Task.CompletedTask;
      }
    `,
    [PATHS.backendRepository]: `
      const string Table = "kent_rehberi.kent_rehberi_tumu_pggeom";
      command.Parameters.AddWithValue("tur", tur);
    `,
    [PATHS.backendPlanAskiSource]: `
      const string Host = "planaski.ankara.bel.tr";
      const string Path = "/kentrehberiapi/api/kentrehberi";
      var query = "tur=" + tur;
      var bytes = options.PlanAskiMaxResponseBytesPerType;
      var records = options.PlanAskiMaxRecordsPerType;
      var ttl = options.PlanAskiCacheTtlSeconds;
      var gate = new SemaphoreSlim(6, 6);
    `,
    [PATHS.backendPlanAskiRepository]: `
      public Task GetAll() => source.GetAllTypesAsync(default);
      public Task GetOne(short tur) => source.GetTypeAsync(tur, default);
      public Task GetTypeCatalogAsync() => Task.CompletedTask;
      private double HaversineMeters() => 0;
    `,
    [PATHS.backendRegistration]: `
      services.AddHttpClient("KentRehberi.PlanAski");
      var handler = new HttpClientHandler { AllowAutoRedirect = false };
      if (configured.Source == KentRehberiOptions.PlanAskiSource) return planAski;
    `,
    [PATHS.backendOptions]: `
      public const string PlanAskiSource = "PlanAski";
      public string PlanAskiBaseUri { get; set; } =
        "https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi";
      public short PlanAskiMinTur { get; set; }
      public short PlanAskiMaxTur { get; set; }
      public int TypeCatalogMaxTypes { get; set; }
      public int TypeCatalogSamplesPerType { get; set; }
      public int TypeCatalogMaxResponseBytes { get; set; }
    `,
    [PATHS.backendSettings]: JSON.stringify({
      KentRehberiData: {
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
      },
    }),
  };
};

describe('Kent Rehberi all-layer audit parsers', () => {
  test('parses all service-bound sidebar records deterministically', () => {
    const items = inventory();
    const parsed = parseSidebarItems(sidebarSource(items));

    assert.equal(parsed.length, 40);
    assert.deepEqual(parsed[0], items[0]);
    assert.deepEqual(parsed.at(-1), items.at(-1));
  });

  test('parses registered query-window ids in source order', () => {
    const items = inventory();
    const windows = parseQueryWindowIds(windowSource(items));

    assert.equal(windows.length, 40);
    assert.equal(windows[0], 'window-1');
    assert.equal(windows.at(-1), 'window-40');
  });

  test('parses profile service keys, probes and modes', () => {
    const items = inventory();
    const profiles = parseFastAccessProfiles(profileSource(items));

    assert.equal(profiles.length, 40);
    assert.equal(profiles[0]?.serviceKey, 'YeniService1QueryUrl');
    assert.equal(profiles[0]?.probes.length, 1);
    assert.equal(profiles[0]?.mode, 'first');
  });

  test('indexes only Yeni service aliases from icon registry', () => {
    const errors = [];
    const aliases = parseIconServiceAliases(JSON.stringify([
      { id: 'park', aliases: ['park', 'YeniParklarQeryUrl'] },
      { id: 'bus', aliases: ['otobüs', 'YeniEgoOtobusDuraklariQueryUrl'] },
    ]), errors);

    assert.deepEqual(errors, []);
    assert.deepEqual(aliases.get('YeniParklarQeryUrl'), ['park']);
    assert.equal(aliases.has('park'), false);
  });
});

describe('Kent Rehberi all-layer release contract', () => {
  test('accepts a coherent 40-layer fixture', () => {
    const result = auditKentRehberiAllLayersSources(validFixture());

    assert.equal(result.ok, true);
    assert.equal(result.sidebarItems, 40);
    assert.deepEqual(result.errors, []);
  });

  test('requires the complete ABB, EGO, ASKI and ISTIRAK inventory', () => {
    const files = validFixture();
    const items = inventory().slice(0, -1);
    files[PATHS.sidebar] = sidebarSource(items);

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('sidebar-item-count'), true);
    assert.equal(ids.has('sidebar-group-count'), true);
  });

  test('rejects duplicate stable service identities', () => {
    const files = validFixture();
    const items = [...inventory()];
    items[1] = Object.freeze({
      ...items[1],
      serviceKey: items[0].serviceKey,
    });
    files[PATHS.sidebar] = sidebarSource(items);

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => entry.id === 'duplicate-service-key'),
      true,
    );
  });

  test('requires every sidebar item to have a registered query window', () => {
    const files = validFixture();
    const items = inventory();
    files[PATHS.windows] = windowSource(items.slice(1));

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => (
        entry.id === 'missing-query-window'
        && entry.message.includes('window-1')
      )),
      true,
    );
  });

  test('requires every sidebar service key to have one Kent Rehberi profile', () => {
    const files = validFixture();
    const items = inventory();
    files[PATHS.profiles] = profileSource(items.slice(1));

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => (
        entry.id === 'missing-profile'
        && entry.message.includes('YeniService1QueryUrl')
      )),
      true,
    );
  });

  test('rejects profiles not represented by a sidebar item', () => {
    const files = validFixture();
    files[PATHS.profiles] += `
      freezeProfile({
        serviceKey: 'YeniOrphanQueryUrl',
        title: 'Orphan Service',
        probes: ['orphan'],
        preferTerms: [],
        excludeTerms: [],
        mode: 'first',
      });
    `;

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => entry.id === 'orphan-profile'),
      true,
    );
  });

  test('requires every sidebar service key to resolve to exactly one icon', () => {
    const files = validFixture();
    const icons = JSON.parse(files[PATHS.icons]);
    icons.shift();
    files[PATHS.icons] = JSON.stringify(icons);

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => entry.id === 'missing-service-icon'),
      true,
    );
  });

  test('rejects ambiguous icon ownership for the same service key', () => {
    const files = validFixture();
    const icons = JSON.parse(files[PATHS.icons]);
    icons.push({
      id: 'duplicate-icon',
      aliases: ['YeniService1QueryUrl'],
    });
    files[PATHS.icons] = JSON.stringify(icons);

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => entry.id === 'ambiguous-service-icon'),
      true,
    );
  });

  test('requires supported fast-access services to route through Kent Rehberi first', () => {
    const files = validFixture();
    files[PATHS.businessFactory] = `
      const legacyBusiness = createFastAccessBusiness(serviceKey);
    `;

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-kent-rehberi-business-route'), true);
    assert.equal(ids.has('missing-legacy-fallback'), true);
  });

  test('requires catalog-first category discovery with bounded category loads', () => {
    const files = validFixture();
    files[PATHS.runtime] = `
      export const KENT_REHBERI_FAST_ACCESS_SOURCE = 'kent-rehberi';
    `;

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-type-catalog-fetch'), true);
    assert.equal(ids.has('missing-catalog-classifier'), true);
    assert.equal(ids.has('missing-catalog-first-resolution'), true);
    assert.equal(ids.has('missing-bounded-category-limit'), true);
  });

  test('requires same-origin bounded abortable frontend transport', () => {
    const files = validFixture();
    files[PATHS.transport] = `
      const path = '/kent-rehberi';
    `;

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-same-origin-credentials'), true);
    assert.equal(ids.has('missing-type-catalog-path'), true);
    assert.equal(ids.has('missing-payload-budget'), true);
    assert.equal(ids.has('missing-request-abort'), true);
  });

  test('rejects local synthetic data middleware in Vite', () => {
    const files = validFixture();
    files[PATHS.vite] += `
      const localKentRehberiDemo = {};
      const marker = 'x-kent-rehberi-demo';
    `;

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.filter((entry) => entry.id === 'forbidden-local-demo-source').length,
      2,
    );
  });

  test('requires Vite to proxy to the real local HTTPS User API', () => {
    const files = validFixture();
    files[PATHS.vite] = `
      const config = { target: 'localhost' };
    `;

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.some((entry) => entry.id === 'insecure-or-missing-dev-api-proxy'),
      true,
    );
  });

  test('requires the governed backend type-catalog endpoint', () => {
    const files = validFixture();
    files[PATHS.backendController] = 'public sealed class KentRehberiController {}';

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-types-endpoint'), true);
    assert.equal(ids.has('missing-types-service'), true);
    assert.equal(ids.has('missing-types-cache-control'), true);
  });

  test('requires the official PlanASKI host, path and bounded tur transport', () => {
    const files = validFixture();
    files[PATHS.backendPlanAskiSource] = 'public sealed class KentRehberiPlanAskiSource {}';

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-official-planaski-host'), true);
    assert.equal(ids.has('missing-planaski-path'), true);
    assert.equal(ids.has('missing-planaski-tur-query'), true);
    assert.equal(ids.has('missing-planaski-byte-budget'), true);
    assert.equal(ids.has('missing-planaski-record-budget'), true);
    assert.equal(ids.has('missing-planaski-concurrency'), true);
    assert.equal(ids.has('missing-planaski-cache'), true);
  });

  test('requires PlanASKI repository coverage and nearby behavior', () => {
    const files = validFixture();
    files[PATHS.backendPlanAskiRepository] = 'public sealed class KentRehberiPlanAskiRepository {}';

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-planaski-all-types'), true);
    assert.equal(ids.has('missing-planaski-single-type'), true);
    assert.equal(ids.has('missing-planaski-catalog'), true);
    assert.equal(ids.has('missing-planaski-nearby'), true);
  });

  test('requires server-owned PlanASKI transport without redirects', () => {
    const files = validFixture();
    files[PATHS.backendRegistration] = 'public static class Registration {}';

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-planaski-http-client'), true);
    assert.equal(ids.has('missing-planaski-no-redirect'), true);
    assert.equal(ids.has('missing-planaski-source-selection'), true);
  });

  test('retains fixed-table parameterized PostGIS compatibility fallback', () => {
    const files = validFixture();
    files[PATHS.backendRepository] = 'public sealed class KentRehberiRepository {}';

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-postgis-fallback-table'), true);
    assert.equal(ids.has('missing-postgis-parameterization'), true);
  });

  test('requires reviewed backend catalog budgets', () => {
    const files = validFixture();
    const settings = JSON.parse(files[PATHS.backendSettings]);
    settings.KentRehberiData.PlanAskiMaxTur = 99;
    delete settings.KentRehberiData.TypeCatalogMaxResponseBytes;
    files[PATHS.backendSettings] = JSON.stringify(settings);

    const result = auditKentRehberiAllLayersSources(files);

    assert.equal(
      result.errors.filter((entry) => entry.id === 'backend-setting-drift').length,
      2,
    );
  });

  test('requires package quality, tooling and verify integration', () => {
    for (const script of [
      'quality:kent-rehberi-all-layers',
      'test:tooling',
      'verify',
    ]) {
      const files = validFixture();
      const manifest = JSON.parse(files[PATHS.package]);
      delete manifest.scripts[script];
      files[PATHS.package] = JSON.stringify(manifest);

      const result = auditKentRehberiAllLayersSources(files);

      assert.equal(
        result.errors.some((entry) => (
          entry.id === 'missing-package-quality-gate'
          || entry.id === 'missing-audit-unit-test'
          || entry.id === 'missing-verify-quality-gate'
        )),
        true,
        `expected package integration failure after removing ${script}`,
      );
    }
  });

  test('requires Webclient Quality and Release QA workflow execution', () => {
    for (const workflow of [
      PATHS.qualityWorkflow,
      PATHS.releaseWorkflow,
    ]) {
      const files = validFixture();
      files[workflow] = 'run: npm run lint';

      const result = auditKentRehberiAllLayersSources(files);

      assert.equal(
        result.errors.some((entry) => (
          entry.id === 'missing-workflow-quality-gate'
          && entry.file === workflow
        )),
        true,
      );
    }
  });

  test('reports missing required files and invalid JSON fail-closed', () => {
    const files = validFixture();
    delete files[PATHS.backendOptions];
    files[PATHS.icons] = '{';

    const result = auditKentRehberiAllLayersSources(files);
    const ids = new Set(result.errors.map((entry) => entry.id));

    assert.equal(ids.has('missing-file'), true);
    assert.equal(ids.has('invalid-json'), true);
    assert.equal(result.ok, false);
  });

  test('returns deterministic checked-file ordering for release artifacts', () => {
    const result = auditKentRehberiAllLayersSources(validFixture());
    const sorted = [...result.checkedFiles].sort();

    assert.deepEqual(result.checkedFiles, sorted);
  });
});
