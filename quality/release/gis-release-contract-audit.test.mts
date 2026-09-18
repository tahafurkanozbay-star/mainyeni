import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGisReleaseContracts } from './gis-release-contract-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function ids(path: string, text: string): string[] {
  return auditGisReleaseContracts(fixtureInventory([{ path, text }])).findings.map(finding => finding.id);
}

test('blocks WMS integration', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    { path: 'Webclient.app/src/gis-engine/service.ts', text: "export const url = '/wms?service=WMS';" },
  ]));
  const finding = section.findings.find(item => item.id === 'gis-forbidden-wms');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('blocks WFS integration', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/service.ts',
    "export const url = '/wfs?service=WFS';",
  ).includes('gis-forbidden-wfs'));
});

test('blocks WMTS integration', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/service.ts',
    "export const url = '/wmts?service=WMTS';",
  ).includes('gis-forbidden-wmts'));
});

test('flags direct esri-loader import', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/featureRuntime.ts',
    "import { loadModules } from 'esri-loader';",
  ).includes('gis-direct-esri-loader'));
});

test('approved ArcGIS module loader may contain the legacy compatibility boundary', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/arcgisModuleLoader.ts',
      text: "import { loadModules } from 'esri-loader';\nexport async function load() { return loadModules(['esri/Map']); }",
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-direct-esri-loader'));
  assert.ok(!section.findings.some(item => item.id === 'gis-loadmodules-direct'));
});

test('flags credential-shaped ArcGIS configuration without embedding a fixture secret in test source', () => {
  const fakeValue = 'x'.repeat(32);
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/auth.ts',
      text: `const apiKey = '${fakeValue}';`,
    },
  ]));
  const finding = section.findings.find(item => item.id === 'gis-api-key-literal');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('flags insecure service URL', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/service.ts',
    "const url = 'http://example.test/arcgis/rest/services/a/FeatureServer';",
  ).includes('gis-http-service'));
});

test('flags axios bypass', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    'axios.get(url);',
  ).includes('gis-axios-runtime'));
});

test('flags XMLHttpRequest bypass', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    'const xhr = new XMLHttpRequest();',
  ).includes('gis-xhr-runtime'));
});

test('approved ArcGIS REST transport may own direct browser fetch', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/arcgisRestTransport.ts',
      text: 'export async function request(url: string, signal: AbortSignal) { return fetch(url, { signal }); }',
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-direct-fetch'));
});

test('feature runtimes may not use direct fetch outside the transport boundary', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/featureRuntime.ts',
      text: 'export async function load(url: string) { return fetch(url); }',
    },
  ]));
  const finding = section.findings.find(item => item.id === 'gis-direct-fetch');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
});

test('reports wildcard outFields', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    "const query = { outFields: ['*'] };",
  ).includes('gis-outfields-star'));
});

test('reports geometry payload requests', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    'const query = { returnGeometry: true };',
  ).includes('gis-return-geometry'));
});

test('flags infinite loops', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    'while (true) { await next(); }',
  ).includes('gis-unbounded-loop'));
});

test('reports unbounded feature Promise.all', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/render.ts',
    'await Promise.all(features.map(render));',
  ).includes('gis-promise-all-features'));
});

test('reports legacy watchUtils', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/view.ts',
    "watchUtils.watch(view, 'scale', fn);",
  ).includes('gis-watch-utils'));
});

test('reports legacy QueryTask', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    'const task = new QueryTask({ url });',
  ).includes('gis-querytask-constructor'));
});

test('flags direct loadModules outside loader boundary', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/featureRuntime.ts',
    "const [Layer] = await loadModules(['esri/layers/FeatureLayer']);",
  ).includes('gis-loadmodules-direct'));
});

test('reports synchronous geometry work in iteration', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/spatial.ts',
    'for (const feature of features) { geometryEngine.buffer(feature.geometry, 10); }',
  ).includes('gis-geometry-engine-sync-loop'));
});

test('reports embedded layer service URLs', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/layer.ts',
    "const layer = new FeatureLayer({ url: 'https://example.test/arcgis/rest/services/x/FeatureServer/0' });",
  ).includes('gis-layer-url-literal'));
});

test('service registry is allowed to own an absolute ArcGIS service URL', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/serviceRegistry.ts',
      text: "export const layer = new FeatureLayer({ url: 'https://example.test/arcgis/rest/services/x/FeatureServer/0' });",
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-layer-url-literal'));
});

test('reports direct icon literals outside icon authority', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/renderer.ts',
    "const icon = 'images/park.svg';",
  ).includes('gis-icon-asset-literal'));
});

test('shared icon resolver is allowed to own icon asset literals', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/iconResolver.ts',
      text: "export const fallback = 'images/default.svg';",
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-icon-asset-literal'));
});

test('reports direct graphics accumulation', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/debug.ts',
    'layer.graphics.addMany(graphics);',
  ).includes('gis-debug-graphics-add'));
});

test('SceneView fatalError observation without recovery is reported', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/sceneRuntime.ts',
      text: "reactiveUtils.watch(() => view.fatalError, error => report(error));",
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'gis-scene-fatal-recovery-missing'));
});

test('SceneView bounded recovery evidence satisfies the fatal-error contract', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/sceneRuntime.ts',
      text: "reactiveUtils.watch(() => view.fatalError, () => view.tryFatalErrorRecovery());",
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-scene-fatal-recovery-missing'));
  assert.deepEqual(section.summary.recoveryContracts, ['Webclient.app/src/gis-engine/sceneRuntime.ts']);
});

test('pagination without max page or feature budget is reported', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/queryWindow.ts',
      text: 'let resultOffset = 0;\nwhile (hasMore) { resultOffset += page.length; }',
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'gis-pagination-budget-missing'));
});

test('pagination with explicit maxPages budget is accepted', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/queryWindow.ts',
      text: 'let resultOffset = 0;\nconst maxPages = 10;\nfor (let page = 0; page < maxPages; page += 1) { resultOffset += 100; }',
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-pagination-budget-missing'));
});

test('pagination with explicit maxFeatures budget is accepted', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/queryWindow.ts',
      text: 'let resultOffset = 0;\nconst maxFeatures = 1000;\nif (resultOffset >= maxFeatures) return;',
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-pagination-budget-missing'));
});

test('request-oriented GIS module without AbortSignal evidence is reported', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/queryRuntime.ts',
      text: 'export async function run(layer) { return layer.queryFeatures({ where: "1=1" }); }',
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'gis-request-cancellation-evidence-missing'));
});

test('request-oriented GIS module with AbortSignal evidence satisfies cancellation contract', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/queryRuntime.ts',
      text: 'export async function run(layer, signal: AbortSignal) { if (signal.aborted) return; return layer.queryFeatures({ where: "1=1", signal }); }',
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-request-cancellation-evidence-missing'));
  assert.deepEqual(section.summary.cancellationContracts, ['Webclient.app/src/gis-engine/queryRuntime.ts']);
});

test('ArcGIS allocation without ownership evidence is reported', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/layerRuntime.ts',
      text: 'export function create() { return new FeatureLayer({}); }',
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'gis-resource-ownership-evidence-missing'));
});

test('ArcGIS allocation with deterministic teardown satisfies ownership contract', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/layerRuntime.ts',
      text: 'const layer = new FeatureLayer({});\nexport function dispose() { layer.destroy(); }',
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-resource-ownership-evidence-missing'));
  assert.deepEqual(section.summary.ownershipContracts, ['Webclient.app/src/gis-engine/layerRuntime.ts']);
});

test('camera goTo without reduced-motion evidence is reported', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/navigation.ts',
      text: 'export async function zoom(view) { await view.goTo({ zoom: 12 }); }',
    },
  ]));
  assert.ok(section.findings.some(item => item.id === 'gis-camera-reduced-motion-evidence-missing'));
});

test('camera goTo with reduced-motion policy is accepted', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/navigation.ts',
      text: 'export async function zoom(view, reducedMotion) { await view.goTo({ zoom: 12 }, { duration: reducedMotion ? 0 : 250 }); }',
    },
  ]));
  assert.ok(!section.findings.some(item => item.id === 'gis-camera-reduced-motion-evidence-missing'));
});

test('test fixtures are excluded from production GIS findings', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/queryRuntime.test.ts',
      text: "import { loadModules } from 'esri-loader';\nwhile (true) { break; }\n",
    },
  ]));
  assert.equal(section.findings.length, 0);
  assert.equal(section.summary.scannedFiles, 0);
});

test('non-GIS application modules are excluded', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/Components/Common/View.tsx',
      text: "import { loadModules } from 'esri-loader';",
    },
  ]));
  assert.equal(section.findings.length, 0);
});

test('rule findings are capped at two matches per file', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/query.ts',
      text: 'axios.get(a);\naxios.get(b);\naxios.get(c);\n',
    },
  ]));
  assert.equal(section.findings.filter(item => item.id === 'gis-axios-runtime').length, 2);
});

test('summary counts module-boundary and protocol violations', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/legacy.ts',
      text: "import { loadModules } from 'esri-loader';\nconst url = '/wfs?service=WFS';",
    },
  ]));
  assert.equal(section.summary.moduleBoundaryViolations, 1);
  assert.equal(section.summary.forbiddenProtocolFindings, 1);
});

test('summary counts direct transport findings', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/feature.ts',
      text: 'fetch(url);',
    },
  ]));
  assert.ok(section.summary.directTransportFindings >= 1);
});

test('summary partitions engine, map shell and query files', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    { path: 'Webclient.app/src/gis-engine/a.ts', text: 'export const a = 1;' },
    { path: 'Webclient.app/src/Components/App/Map.tsx', text: 'export const Map = () => null;' },
    { path: 'Webclient.app/src/Components/Query/Window.tsx', text: 'export const Window = () => null;' },
  ]));
  assert.equal(section.summary.gisEngineFiles, 1);
  assert.equal(section.summary.mapShellFiles, 1);
  assert.equal(section.summary.queryFiles, 1);
});

test('findingsByRule is deterministic', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/query.ts',
      text: "axios.get(a);\naxios.get(b);\nconst query = { outFields: ['*'] };",
    },
  ]));
  assert.equal(section.summary.findingsByRule['gis-axios-runtime'], 2);
  assert.equal(section.summary.findingsByRule['gis-outfields-star'], 1);
  assert.deepEqual(
    Object.keys(section.summary.findingsByRule),
    [...Object.keys(section.summary.findingsByRule)].sort((a, b) => a.localeCompare(b, 'en')),
  );
});

test('clean modern GIS runtime remains free of release-contract findings', () => {
  const section = auditGisReleaseContracts(fixtureInventory([
    {
      path: 'Webclient.app/src/gis-engine/cleanRuntime.ts',
      text: [
        'export async function run(layer, signal: AbortSignal, maxPages: number) {',
        '  if (signal.aborted) return;',
        '  for (let page = 0; page < maxPages; page += 1) {',
        '    await layer.queryFeatures({ where: "1=1", signal });',
        '  }',
        '}',
      ].join('\n'),
    },
  ]));
  assert.equal(section.findings.length, 0);
});
