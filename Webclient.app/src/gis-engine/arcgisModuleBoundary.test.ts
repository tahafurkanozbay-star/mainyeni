import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const ALLOWED_ESRI_LOADER_IMPORT = 'gis-engine/arcgisModuleRuntime.ts';

const collectSourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });

describe('ArcGIS module loading boundary', () => {
  it('keeps esri-loader imports isolated behind arcgisModuleRuntime', () => {
    const sourceRoot = resolve(process.cwd(), 'src');
    const offenders = collectSourceFiles(sourceRoot)
      .filter((file) => readFileSync(file, 'utf8').includes('esri-loader'))
      .map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))
      .filter((file) => file !== ALLOWED_ESRI_LOADER_IMPORT)
      .sort();

    expect(offenders).toEqual([]);
  });
});
