import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLBOX_RUNTIME_NAMES = Object.freeze([
  'AddressSearchRuntime',
  'DataIntegrityHelper',
  'DataReleaseGuardRuntime',
  'DataSearchNextRuntime',
  'RecordPresentationRuntime',
  'RecordSchemaRuntime',
  'SearchCoordinatorRuntime',
  'SearchDatasetRegistry',
  'SearchExecutionRuntime',
  'SearchIndexRuntime',
  'SearchObservabilityRuntime',
  'SearchResultAdapterRuntime',
  'SearchSessionRuntime',
]);

const walk = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(root, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

describe('Data/Search production language boundary', () => {
  const srcRoot = resolve(process.cwd(), 'src');
  const toolboxRoot = resolve(srcRoot, 'Toolbox');
  const dataSearchRoot = resolve(srcRoot, 'data-search');

  it('keeps canonical Toolbox production runtimes on TypeScript only', () => {
    for (const runtime of TOOLBOX_RUNTIME_NAMES) {
      expect(existsSync(resolve(toolboxRoot, `${runtime}.ts`))).toBe(true);
      expect(existsSync(resolve(toolboxRoot, `${runtime}.js`))).toBe(false);
    }
  });

  it('contains no production JavaScript implementation inside src/data-search', () => {
    const productionJavaScript = walk(dataSearchRoot)
      .filter(path => extname(path) === '.js')
      .filter(path => !path.endsWith('.test.js'));

    expect(productionJavaScript).toEqual([]);
  });

  it('fails closed if the strict compiler boundary re-enables JavaScript', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.data-search.json'), 'utf8'),
    );

    expect(config.compilerOptions?.allowJs).toBe(false);
    expect(config.compilerOptions?.checkJs).toBe(false);
    expect(config.include).toContain('src/data-search/**/*.ts');
  });

  it('keeps every canonical runtime explicitly inside the strict project', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.data-search.json'), 'utf8'),
    );
    const includes = new Set(config.include ?? []);

    for (const runtime of TOOLBOX_RUNTIME_NAMES) {
      expect(includes.has(`src/Toolbox/${runtime}.ts`)).toBe(true);
    }
  });
});
