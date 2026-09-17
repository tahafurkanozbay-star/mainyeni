import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'Webclient.app/src/Toolbox/GisQueryHelper.test.js');
const source = readFileSync(file, 'utf8');
const next = source
  .replace("import { loadModules } from 'esri-loader';", "import { loadArcgisModules as loadModules } from '../gis-engine/arcgisModuleRuntime';")
  .replace("jest.mock('esri-loader', () => ({\n  loadModules: jest.fn(),\n}));", "jest.mock('../gis-engine/arcgisModuleRuntime', () => ({\n  loadArcgisModules: jest.fn(),\n}));");

if (next === source) throw new Error('Expected GisQueryHelper test boundary migration');
if (next.includes("from 'esri-loader'")) throw new Error('Legacy loader test import remains');
writeFileSync(file, next);
console.log('[arcgis-zero-test-boundary] migrated GisQueryHelper test mock to shared runtime.');
