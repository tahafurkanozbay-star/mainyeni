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
  directTransport: 'src/data-services/kentRehberiPlanAskiDirect.ts',
  icons: 'src/gis-engine/iconRegistry.json',
  vite: 'vite.config.ts',
  configurationBusiness: 'src/Business/ConfigurationBusiness.ts',
  envExample: '.env.example',
  package: 'package.json',
  qualityWorkflow: '../.github/workflows/webclient-quality.yml',
  releaseWorkflow: '../.github/workflows/release-qa.yml',
});

const GROUPS = Object.freeze([['ABB', 17], ['EGO', 8], ['ASKI', 6], ['ISTIRAK', 9]]);
const inventory = () => {
  const items = [];
  let index = 1;
  for (const [group, count] of GROUPS) {
    for (let within = 0; within < count; within += 1) {
      items.push(Object.freeze({
        group,
        label: `${group} Service ${index}`,
        windowId: `window-${index}`,
        iconType: `icon-${index}`,
        serviceKey: `YeniService${index}QueryUrl`,
      }));
      index += 1;
    }
  }
  return Object.freeze(items);
};

const sidebarSource = (items) => `export const SIDEBAR_ITEMS = Object.freeze([
${items.map((item) => `  { group: '${item.group}', label: '${item.label}', windowId: '${item.windowId}', iconType: '${item.iconType}', serviceKey: '${item.serviceKey}' },`).join('\n')}
]);`;

const windowSource = (items) => `export const QUERY_WINDOW_DEFINITIONS = Object.freeze([
${items.map((item) => `  defineWindow('${item.windowId}', '${item.label}', loader, 'Window'),`).join('\n')}
]);`;

const profileSource = (items) => `const PROFILES = Object.freeze([
${items.map((item) => `  freezeProfile({
    serviceKey: '${item.serviceKey}',
    title: '${item.label}',
    probes: ['service ${item.serviceKey}'],
    preferTerms: ['service'],
    excludeTerms: [],
    mode: 'first',
  }),`).join('\n')}
]);`;

const iconSource = (items) => JSON.stringify(items.map((item, index) => ({ id: `icon-${index + 1}`, aliases: [item.serviceKey] })));

const validFixture = () => {
  const items = inventory();
  return {
    [PATHS.sidebar]: sidebarSource(items),
    [PATHS.windows]: windowSource(items),
    [PATHS.profiles]: profileSource(items),
    [PATHS.businessFactory]: `
      import { createKentRehberiFastAccessBusiness } from './kentRehberiFastAccessRuntime';
      const business = createKentRehberiFastAccessBusiness(serviceKey);
      if (!business) {
         throw new Error('No PlanASKI Kent Rehberi profile is registered');
       }
    `,
    [PATHS.runtime]: `
      import { fetchKentRehberiTypeCatalog } from '../data-services/kentRehberiGeoJsonLayer';
      const CATEGORY_LIMIT = 2000;
      export const KENT_REHBERI_FAST_ACCESS_SOURCE = 'kent-rehberi';
      export const resolveKentRehberiTypesFromCatalog = () => [];
      const resolved = await resolveCatalogTypes(profile, control);
    `,
    [PATHS.transport]: `
      import { fetchPlanAskiGeoJsonDirect, fetchPlanAskiFeatureDirect, fetchPlanAskiTypeCatalogDirect } from './kentRehberiPlanAskiDirect';
      const maxPayloadBytes = 1024;
      const controller = new AbortController();
      await fetchPlanAskiGeoJsonDirect({ signal: controller.signal });
      await fetchPlanAskiFeatureDirect(1, { signal: controller.signal });
      await fetchPlanAskiTypeCatalogDirect({ signal: controller.signal });
    `,
    [PATHS.directTransport]: `
      const SOURCE = 'https://planaski.ankara.bel.tr/kentrehberiapi/api/kentrehberi';
      const MIN_TYPE = 0;
      const MAX_TYPE = 42;
      const MAX_BYTES_PER_TYPE = 8 * 1024 * 1024;
      const MAX_IN_FLIGHT = 4;
      const response = await fetchImpl(SOURCE + '?tur=' + String(tur), { signal });
      const controller = new AbortController();
    `,
    [PATHS.icons]: iconSource(items),
    [PATHS.vite]: `
      export default defineConfig(() => ({
        envPrefix: ['VITE_'],
        server: { host: '0.0.0.0', port: 3000 },
      }));
    `,
    [PATHS.configurationBusiness]: `
      const STATIC_MAP_CONFIGURATION = Object.freeze({ Centerx: 32.854, Centery: 39.92, Zoom: 12 });
      const getMapConfiguration = async () => completed({ configValue: JSON.stringify(STATIC_MAP_CONFIGURATION) });
      const getConfigServices = async () => completed(Object.freeze([]));
      export const ConfigurationBusiness = Object.freeze({ GetMapConfiguration: getMapConfiguration, GetConfigServices: getConfigServices });
    `,
    [PATHS.envExample]: 'VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP=false\\n',
    [PATHS.package]: JSON.stringify({
      scripts: {
        'quality:kent-rehberi-all-layers': 'node scripts/kent-rehberi-all-layers-audit.mjs --strict',
        'test:tooling': 'node --test scripts/kent-rehberi-all-layers-audit.test.mjs',
        verify: 'npm run quality:kent-rehberi-all-layers',
      },
    }),
    [PATHS.qualityWorkflow]: 'run: npm run quality:kent-rehberi-all-layers',
    [PATHS.releaseWorkflow]: 'run: npm run quality:kent-rehberi-all-layers',
  };
};

const errorIds = (result) => new Set(result.errors.map((item) => item.id));

describe('parsers', () => {
  test('parses the sidebar inventory, query window identifiers and service profiles', () => {
    const items = inventory();
    assert.equal(parseSidebarItems(sidebarSource(items)).length, 40);
    assert.equal(parseQueryWindowIds(windowSource(items)).length, 40);
    assert.equal(parseFastAccessProfiles(profileSource(items)).length, 40);
  });

  test('maps service icon aliases to their deterministic icon owners', () => {
    const aliases = parseIconServiceAliases(iconSource(inventory()));
    assert.deepEqual(aliases.get('YeniService1QueryUrl'), ['icon-1']);
    assert.equal(aliases.has('icon-1'), false);
  });
});

describe('PlanASKI-only all-layer contract', () => {
  test('accepts a coherent 40-layer direct-only fixture without an API proxy or backend', () => {
    const result = auditKentRehberiAllLayersSources(validFixture());
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.sidebarItems, 40);
    assert.deepEqual(result.errors, []);
  });

  test('rejects missing query windows, profiles and icons', () => {
    const files = validFixture();
    files[PATHS.windows] = windowSource(inventory().slice(1));
    files[PATHS.profiles] = profileSource(inventory().slice(1));
    files[PATHS.icons] = iconSource(inventory().slice(1));
    const ids = errorIds(auditKentRehberiAllLayersSources(files));
    assert.equal(ids.has('missing-query-window'), true);
    assert.equal(ids.has('missing-profile'), true);
    assert.equal(ids.has('missing-service-icon'), true);
  });

  test('rejects the legacy API fallback and requires fail-closed profile routing', () => {
    const files = validFixture();
    files[PATHS.businessFactory] = `
      const business = createKentRehberiFastAccessBusiness(serviceKey);
      const legacyBusiness = business ? null : createFastAccessBusiness(serviceKey);
    `;
    const ids = errorIds(auditKentRehberiAllLayersSources(files));
    assert.equal(ids.has('legacy-fast-access-fallback'), true);
    assert.equal(ids.has('missing-unsupported-profile-guard'), true);
  });

  test('requires direct PlanASKI source and bounded cancellable requests', () => {
    const files = validFixture();
    files[PATHS.directTransport] = `
      const SOURCE = 'https://example.invalid/data';
      const response = await fetchImpl(SOURCE);
    `;
    const ids = errorIds(auditKentRehberiAllLayersSources(files));
    assert.equal(ids.has('missing-fixed-planaski-host'), true);
    assert.equal(ids.has('missing-tur-range'), true);
    assert.equal(ids.has('missing-tur-query'), true);
    assert.equal(ids.has('missing-upstream-byte-budget'), true);
    assert.equal(ids.has('missing-upstream-concurrency'), true);
    assert.equal(ids.has('missing-upstream-abort'), true);
  });

  test('rejects same-origin/API fallback paths in the active browser data transport', () => {
    const files = validFixture();
    files[PATHS.transport] += `
      const url = runtimeConfig.apiBaseUrl;
      const request = fetchImpl('/kent-rehberi/types', { credentials: 'same-origin' });
    `;
    const ids = errorIds(auditKentRehberiAllLayersSources(files));
    assert.equal(ids.has('legacy-kent-rehberi-transport'), true);
  });

  test('rejects a local Vite API proxy and API configuration in the static bootstrap', () => {
    const files = validFixture();
    files[PATHS.vite] += `server: { proxy: { '/api': { target: 'https://localhost:3003' } } }`;
    files[PATHS.configurationBusiness] += `const apiClient = createClient(); apiClient.get('/AppSettings/List');`;
    files[PATHS.envExample] += 'VITE_API_URL=/api\\nVITE_API_PROXY_TARGET=https://localhost:3003\\nVITE_KENT_REHBERI_SOURCE=api\\n';
    const ids = errorIds(auditKentRehberiAllLayersSources(files));
    assert.equal(ids.has('legacy-local-api-proxy'), true);
    assert.equal(ids.has('legacy-configuration-api'), true);
    assert.equal(ids.has('legacy-runtime-env-keys'), true);
  });

  test('does not require an API/source-mode flag when local map defaults are present', () => {
    const files = validFixture();
    files[PATHS.configurationBusiness] = 'export const ConfigurationBusiness = {};';
    files[PATHS.envExample] = 'VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP=false';
    const ids = errorIds(auditKentRehberiAllLayersSources(files));
    assert.equal(ids.has('missing-static-map-configuration'), true);
    assert.equal(ids.has('missing-empty-legacy-service-list'), true);
    assert.equal(ids.has('legacy-runtime-env-keys'), false);
  });

  test('requires package, tooling and CI quality gates to remain connected', () => {
    for (const [file, mutate] of [
      [PATHS.package, (files) => { files[PATHS.package] = JSON.stringify({ scripts: {} }); }],
      [PATHS.qualityWorkflow, (files) => { files[PATHS.qualityWorkflow] = 'run: npm run lint'; }],
      [PATHS.releaseWorkflow, (files) => { files[PATHS.releaseWorkflow] = 'run: npm run lint'; }],
    ]) {
      const files = validFixture();
      mutate(files);
      const ids = errorIds(auditKentRehberiAllLayersSources(files));
      assert.ok([...ids].some((id) => id.startsWith('missing-')));
    }
  });

  test('fails closed on a missing required source and invalid icon JSON', () => {
    const files = validFixture();
    delete files[PATHS.directTransport];
    files[PATHS.icons] = '{';
    const result = auditKentRehberiAllLayersSources(files);
    const ids = errorIds(result);
    assert.equal(ids.has('missing-file'), true);
    assert.equal(ids.has('invalid-json'), true);
    assert.equal(result.ok, false);
  });

  test('returns deterministic checked-file ordering', () => {
    const result = auditKentRehberiAllLayersSources(validFixture());
    assert.deepEqual(result.checkedFiles, [...result.checkedFiles].sort());
  });
});
