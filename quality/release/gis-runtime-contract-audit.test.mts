import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGisRuntimeContracts } from './gis-runtime-contract-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind = 'typescript'): SourceFile {
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: path.includes('.') ? `.${path.split('.').at(-1) ?? ''}` : '',
    kind,
    bytes: new TextEncoder().encode(text).byteLength,
    lines: text.split(/\r?\n/).length,
    text,
  };
}

function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-09-18T00:00:00.000Z',
  };
}

function audit(path: string, text: string): ReturnType<typeof auditGisRuntimeContracts> {
  return auditGisRuntimeContracts(inventory([source(path, text)]));
}

function ids(path: string, text: string): string[] {
  return audit(path, text).findings.map(item => item.id);
}

test('flags direct esri-loader import in GIS runtime', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/legacyBridge.ts',
    `import { loadModules } from 'esri-loader'; export async function x(){ return loadModules(['esri/Map']); }`,
  ).includes('gis-direct-legacy-loader'));
});

test('allows the shared ArcGIS module runtime to own loader compatibility', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/arcgisModuleRuntime.ts',
    `import { loadModules } from 'esri-loader'; export async function x(){ return loadModules(['esri/Map']); }`,
  ).includes('gis-direct-legacy-loader'));
});

test('flags MapView creation without deterministic destroy', () => {
  assert.ok(ids(
    'Webclient.app/src/Components/MapShell.tsx',
    `export function mount(){ const view = new MapView({ container: 'map' }); return view; }`,
  ).includes('gis-view-without-destroy-contract'));
});

test('accepts MapView creation with destroy ownership', () => {
  assert.ok(!ids(
    'Webclient.app/src/Components/MapShell.tsx',
    `export function mount(){ const view = new MapView({ container: 'map' }); return () => view.destroy(); }`,
  ).includes('gis-view-without-destroy-contract'));
});

test('flags SceneView without fatal recovery contract', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/sceneShell.ts',
    `const view = new SceneView({ map }); function dispose(){ view.destroy(); }`,
  ).includes('gis-scene-fatal-recovery-missing'));
});

test('accepts SceneView with fatal recovery contract', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/sceneShell.ts',
    `const view = new SceneView({ map }); view.fatalError.watch(() => view.tryFatalErrorRecovery()); function dispose(){ view.destroy(); }`,
  ).includes('gis-scene-fatal-recovery-missing'));
});

test('flags reactive watcher without cleanup handle', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/watchSelection.ts',
    `reactiveUtils.watch(() => view.extent, extent => update(extent));`,
  ).includes('gis-reactive-handle-without-cleanup'));
});

test('accepts watcher with remove ownership', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/watchSelection.ts',
    `const handle = reactiveUtils.watch(() => view.extent, update); export function dispose(){ handle.remove(); }`,
  ).includes('gis-reactive-handle-without-cleanup'));
});

test('flags unbounded queryFeatures call', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/search.ts',
    `export async function run(layer){ return layer.queryFeatures({ where: predicate }); }`,
  ).includes('gis-query-without-result-bound'));
});

test('accepts bounded queryFeatures paging', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/search.ts',
    `export async function run(layer, signal){ return layer.queryFeatures({ where: predicate, resultRecordCount: 250, resultOffset: 0 }, { signal }); }`,
  ).includes('gis-query-without-result-bound'));
});

test('flags GIS query without cancellation or stale-result guard', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/search.ts',
    `const resultRecordCount = 250; export async function run(layer){ return layer.queryFeatures({ resultRecordCount }); }`,
  ).includes('gis-query-without-cancellation'));
});

test('accepts AbortSignal-aware query', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/search.ts',
    `export async function run(layer, signal: AbortSignal){ return layer.queryFeatures({ resultRecordCount: 250 }, { signal }); }`,
  ).includes('gis-query-without-cancellation'));
});

test('flags wildcard outFields data selection', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    `const query = { outFields: ['*'], resultRecordCount: 100, signal };`,
  ).includes('gis-query-wildcard-outfields'));
});

test('accepts explicit outFields selection', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/query.ts',
    `const query = { outFields: ['OBJECTID', 'NAME'], resultRecordCount: 100, signal };`,
  ).includes('gis-query-wildcard-outfields'));
});

test('flags unconditional 1=1 query predicate', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/query.ts',
    `const query = { where: "1=1", resultRecordCount: 50, signal };`,
  ).includes('gis-query-unfiltered-all-rows'));
});

test('flags hardcoded ArcGIS REST service URL outside authority', () => {
  assert.ok(ids(
    'Webclient.app/src/Components/LayerPanel.tsx',
    `const url = 'https://example.gov/arcgis/rest/services/Base/FeatureServer/0';`,
  ).includes('gis-hardcoded-service-url'));
});

test('allows service catalog to contain verified ArcGIS URL', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/serviceCatalog.ts',
    `const url = 'https://example.gov/arcgis/rest/services/Base/FeatureServer/0';`,
  ).includes('gis-hardcoded-service-url'));
});

test('flags raw fetch to ArcGIS service outside shared transport', () => {
  const result = ids(
    'Webclient.app/src/Components/SearchPanel.tsx',
    `async function load(){ return fetch('https://example.gov/arcgis/rest/services/Base/FeatureServer/0/query'); }`,
  );
  assert.ok(result.includes('gis-raw-service-fetch'));
});

test('accepts ArcGIS service fetch inside shared transport boundary', () => {
  const result = ids(
    'Webclient.app/src/gis-engine/arcgisTransport.ts',
    `async function load(){ return fetch('https://example.gov/arcgis/rest/services/Base/FeatureServer/0/query'); }`,
  );
  assert.ok(!result.includes('gis-raw-service-fetch'));
});

test('flags ad-hoc picture marker construction', () => {
  assert.ok(ids(
    'Webclient.app/src/Components/ResultLayer.tsx',
    `const symbol = new PictureMarkerSymbol({ url: iconUrl });`,
  ).includes('gis-picture-marker-bypasses-icon-authority'));
});

test('allows picture marker construction in shared icon resolver', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/iconResolver.ts',
    `const symbol = new PictureMarkerSymbol({ url: resolveIcon(category) });`,
  ).includes('gis-picture-marker-bypasses-icon-authority'));
});

test('flags map layer addition without ownership cleanup', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/toolLayer.ts',
    `export function start(map, layer){ map.add(layer); }`,
  ).includes('gis-layer-add-without-ownership-cleanup'));
});

test('accepts layer addition with ownership-scoped remove', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/toolLayer.ts',
    `export function start(map, layer){ map.add(layer); return () => map.remove(layer); }`,
  ).includes('gis-layer-add-without-ownership-cleanup'));
});

test('flags goTo navigation without reduced-motion signal', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/navigation.ts',
    `export async function focus(view, target){ await view.goTo(target); }`,
  ).includes('gis-goto-reduced-motion-review'));
});

test('accepts goTo navigation with reduced-motion policy', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/navigation.ts',
    `export async function focus(view, target, reducedMotion){ await view.goTo(target, { duration: reducedMotion ? 0 : 250 }); }`,
  ).includes('gis-goto-reduced-motion-review'));
});

test('flags geometry payload when no spatial consumer is visible', () => {
  assert.ok(ids(
    'Webclient.app/src/gis-engine/tableQuery.ts',
    `const query = { returnGeometry: true, outFields: ['OBJECTID'], resultRecordCount: 25, signal }; await layer.queryFeatures(query);`,
  ).includes('gis-return-geometry-without-spatial-use'));
});

test('accepts geometry payload when spatial use is visible', () => {
  assert.ok(!ids(
    'Webclient.app/src/gis-engine/focusQuery.ts',
    `const query = { returnGeometry: true, outFields: ['OBJECTID'], resultRecordCount: 25, signal }; const result = await layer.queryFeatures(query); await view.goTo(result.features[0].geometry);`,
  ).includes('gis-return-geometry-without-spatial-use'));
});

test('ignores test fixtures and generated code', () => {
  const section = auditGisRuntimeContracts(inventory([
    source('Webclient.app/src/gis-engine/__tests__/bad.test.ts', `new MapView({}); loadModules([]);`),
    source('Webclient.app/dist/bundle.js', `new MapView({}); loadModules([]);`, 'javascript'),
  ]));
  assert.equal(section.findings.length, 0);
});

test('reports deterministic signals and file lists', () => {
  const section = auditGisRuntimeContracts(inventory([
    source('Webclient.app/src/gis-engine/a.ts', `loadModules([]); layer.queryFeatures({});`),
    source('Webclient.app/src/Components/b.tsx', `new PictureMarkerSymbol({ url });`),
  ]));
  assert.equal(section.summary.files, 2);
  assert.deepEqual(section.summary.directLegacyLoaderFiles, ['Webclient.app/src/gis-engine/a.ts']);
  assert.deepEqual(section.summary.queryFiles, ['Webclient.app/src/gis-engine/a.ts']);
  assert.deepEqual(section.summary.iconBypassFiles, ['Webclient.app/src/Components/b.tsx']);
});

test('reports deterministic finding counts', () => {
  const section = audit(
    'Webclient.app/src/gis-engine/a.ts',
    `loadModules([]); const q={outFields:['*'],where:'1=1'}; layer.queryFeatures(q);`,
  );
  assert.equal(section.summary.findingsByRule['gis-direct-legacy-loader'], 1);
  assert.equal(section.summary.findingsByRule['gis-query-wildcard-outfields'], 1);
  assert.equal(section.summary.findingsByRule['gis-query-unfiltered-all-rows'], 1);
});
