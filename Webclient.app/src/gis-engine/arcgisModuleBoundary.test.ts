import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const LEGACY_LOADER_PACKAGE = ['esri', 'loader'].join('-');
const LEGACY_TRANSPORT_BOUNDARY = 'gis-engine/arcgisModuleRuntime.ts';
const LEGACY_IMPORT_ALLOWLIST = new Set([
  'Business/CommonBusiness.js',
  'Components/App/MapComponent.legacy.js',
  'Components/Query/ParklarQuery/ParklarQueryWindow.js',
  'Components/Query/VicinityQuery/VicinityQueryWindow.js',
  'Components/Widget/AdvancedSketch/AdvancedSketchWidgetMain.js',
  'Components/Widget/Basemap/BasemapWidget.js',
  'Components/Widget/LayerList/LayerListWidget.js',
  'Components/Widget/OverviewMap/OverviewMapWidget.js',
  'Components/Widget/Sketch/SketchWidget.js',
  'Toolbox/GisQueryHelper.js',
]);
const MAX_LEGACY_DIRECT_CONSUMERS = 10;

const collectSourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });

const stripComments = (source: string): string => {
  let output = '';
  let index = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedPackage = escapeRegExp(LEGACY_LOADER_PACKAGE);
const STATIC_IMPORT_PATTERN = new RegExp(
  `(?:^|\\n)\\s*import(?:\\s+type)?(?:\\s+[\\s\\S]*?\\s+from)?\\s*['"]${escapedPackage}['"]`,
  'm',
);
const REQUIRE_PATTERN = new RegExp(`\\brequire\\(\\s*['"]${escapedPackage}['"]\\s*\\)`);
const DYNAMIC_IMPORT_PATTERN = new RegExp(`\\bimport\\(\\s*['"]${escapedPackage}['"]\\s*\\)`);

const hasLegacyLoaderImport = (file: string): boolean => {
  const source = stripComments(readFileSync(file, 'utf8'));
  return STATIC_IMPORT_PATTERN.test(source)
    || REQUIRE_PATTERN.test(source)
    || DYNAMIC_IMPORT_PATTERN.test(source);
};

describe('ArcGIS module loading boundary', () => {
  it('keeps the direct legacy-loader consumer set equal to the shrinking migration allowlist', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const actualConsumers = collectSourceFiles(sourceRoot)
      .filter((file) => !file.includes('.test.'))
      .filter(hasLegacyLoaderImport)
      .map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))
      .filter((file) => file !== LEGACY_TRANSPORT_BOUNDARY)
      .sort();
    const allowedConsumers = [...LEGACY_IMPORT_ALLOWLIST].sort();

    expect(actualConsumers).toEqual(allowedConsumers);
    expect(actualConsumers.length).toBeLessThanOrEqual(MAX_LEGACY_DIRECT_CONSUMERS);
  });
});
