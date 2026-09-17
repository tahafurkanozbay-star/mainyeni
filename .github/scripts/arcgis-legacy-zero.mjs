import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const migrations = new Map([
  ['Webclient.app/src/Business/CommonBusiness.js', '../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/App/MapComponent.legacy.js', '../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Query/ParklarQuery/ParklarQueryWindow.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Query/VicinityQuery/VicinityQueryWindow.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Widget/AdvancedSketch/AdvancedSketchWidgetMain.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Widget/Basemap/BasemapWidget.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Widget/LayerList/LayerListWidget.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Widget/OverviewMap/OverviewMapWidget.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Components/Widget/Sketch/SketchWidget.js', '../../../gis-engine/arcgisModuleRuntime'],
  ['Webclient.app/src/Toolbox/GisQueryHelper.js', '../gis-engine/arcgisModuleRuntime'],
]);

const loaderImportPattern = /import\s*\{\s*loadModules\s*\}\s*from\s*["']esri-loader["'];?/;

for (const [file, runtimePath] of migrations) {
  const absolute = resolve(root, file);
  const source = readFileSync(absolute, 'utf8');
  if (!loaderImportPattern.test(source)) {
    throw new Error(`Expected a direct loadModules import in ${file}`);
  }
  const replacement = `import { loadArcgisModules as loadModules } from "${runtimePath}";`;
  writeFileSync(absolute, source.replace(loaderImportPattern, replacement));
}

const boundaryPath = resolve(root, 'Webclient.app/src/gis-engine/arcgisModuleBoundary.test.ts');
let boundary = readFileSync(boundaryPath, 'utf8');
boundary = boundary.replace(
  /const LEGACY_IMPORT_ALLOWLIST = new Set\(\[[\s\S]*?\]\);\nconst MAX_LEGACY_DIRECT_CONSUMERS = \d+;/,
  'const LEGACY_IMPORT_ALLOWLIST = new Set<string>();\nconst MAX_LEGACY_DIRECT_CONSUMERS = 0;',
);
writeFileSync(boundaryPath, boundary);

const forbidden = [];
for (const file of migrations.keys()) {
  const source = readFileSync(resolve(root, file), 'utf8');
  if (source.includes('esri-loader')) forbidden.push(file);
}
if (forbidden.length) {
  throw new Error(`Legacy loader imports remain after migration: ${forbidden.join(', ')}`);
}

console.log(`[arcgis-legacy-zero] migrated ${migrations.size} direct consumers; ratchet is now zero.`);
