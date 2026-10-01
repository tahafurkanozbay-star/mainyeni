import assert from 'node:assert/strict';
import test from 'node:test';
import { auditModuleBoundaryModernization } from './module-boundary-modernization-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditModuleBoundaryModernization(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

function packageWith(
  type: 'module' | 'commonjs' | undefined,
  files: readonly FixtureFileInput[],
): readonly FixtureFileInput[] {
  return [
    {
      path: 'tools/package.json',
      text: JSON.stringify({ name: 'tools', ...(type ? { type } : {}) }),
    },
    ...files,
  ];
}

test('accepts native ESM TypeScript module', () => {
  const result = audit(packageWith('module', [{
    path: 'tools/audit.mts',
    text: "import { readFile } from 'node:fs/promises';\nexport async function audit() { return readFile('x'); }\n",
  }]));
  assert.equal(result.findings.length, 0);
});

test('reports active CommonJS file as migration candidate', () => {
  assert.ok(ids(packageWith('commonjs', [{
    path: 'tools/legacy.cjs',
    text: "module.exports = { value: 1 };",
  }])).includes('module-active-commonjs-file'));
});

test('reports active JavaScript module outside typed boundary', () => {
  assert.ok(ids(packageWith('module', [{
    path: 'tools/runner.mjs',
    text: 'export const run = () => 1;',
  }])).includes('module-active-javascript-migration-candidate'));
});

test('does not flag config JavaScript only for migration-candidate rule', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/eslint.config.mjs',
    text: 'export default [];',
  }]));
  assert.equal(result.includes('module-active-javascript-migration-candidate'), false);
});

test('blocks require in TypeScript module', () => {
  assert.ok(ids(packageWith('module', [{
    path: 'tools/audit.ts',
    text: "const fs = require('node:fs');\nexport const x = fs;",
  }])).includes('module-commonjs-require-in-typescript'));
});

test('permits explicit createRequire compatibility bridge', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/compat.mts',
    text: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst pkg = require('legacy-package');\nexport { pkg };",
  }]));
  assert.equal(result.includes('module-commonjs-require-in-typescript'), false);
});

test('blocks module.exports in TypeScript', () => {
  assert.ok(ids(packageWith('module', [{
    path: 'tools/audit.ts',
    text: 'module.exports = { audit: true };',
  }])).includes('module-commonjs-export-in-typescript'));
});

test('blocks exports assignment in TypeScript', () => {
  assert.ok(ids(packageWith('module', [{
    path: 'tools/audit.ts',
    text: 'exports.audit = true;',
  }])).includes('module-commonjs-export-in-typescript'));
});

test('detects mixed ESM and CommonJS file', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/mixed.ts',
    text: "import fs from 'node:fs';\nconst x = require('x');\nexport { x, fs };",
  }]));
  assert.ok(result.includes('module-mixed-esm-commonjs'));
});

test('blocks require in type=module JavaScript package', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/index.js',
    text: "const fs = require('node:fs');",
  }]));
  assert.ok(result.includes('module-commonjs-in-esm-package'));
});

test('blocks ESM syntax in commonjs package .js file', () => {
  const result = ids(packageWith('commonjs', [{
    path: 'tools/index.js',
    text: "export const value = 1;",
  }]));
  assert.ok(result.includes('module-esm-syntax-in-commonjs-package'));
});

test('blocks computed dynamic require', () => {
  const result = ids(packageWith('commonjs', [{
    path: 'tools/plugin.cjs',
    text: 'const plugin = require(process.env.PLUGIN);',
  }]));
  assert.ok(result.includes('module-dynamic-require'));
});

test('does not classify literal require as dynamic require', () => {
  const result = ids(packageWith('commonjs', [{
    path: 'tools/plugin.cjs',
    text: "const plugin = require('plugin');",
  }]));
  assert.equal(result.includes('module-dynamic-require'), false);
});

test('blocks expression-derived import target', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/plugins.ts',
    text: 'export async function load(name: string) { return import(`./plugins/${name}.js`); }',
  }]));
  assert.ok(result.includes('module-dynamic-import-unbounded'));
});

test('blocks concatenated import target', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/plugins.ts',
    text: "export async function load(name: string) { return import('./plugins/' + name); }",
  }]));
  assert.ok(result.includes('module-dynamic-import-unbounded'));
});

test('accepts literal dynamic import for code splitting', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/plugins.ts',
    text: "export async function load() { return import('./plugins/default.mjs'); }",
  }]));
  assert.equal(result.includes('module-dynamic-import-unbounded'), false);
});

test('blocks ts-ignore suppression', () => {
  assert.ok(ids(packageWith('module', [{
    path: 'tools/audit.ts',
    text: '// @ts-ignore\nexport const value: string = 1;',
  }])).includes('module-typescript-diagnostic-suppression'));
});

test('blocks ts-nocheck suppression', () => {
  assert.ok(ids(packageWith('module', [{
    path: 'tools/audit.ts',
    text: '// @ts-nocheck\nexport const value = 1;',
  }])).includes('module-typescript-diagnostic-suppression'));
});

test('does not block ts-expect-error by this rule', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/audit.ts',
    text: '// @ts-expect-error legacy fixture\nexport const value: string = 1;',
  }]));
  assert.equal(result.includes('module-typescript-diagnostic-suppression'), false);
});

test('reports __dirname use in ESM JavaScript without bridge', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/path.js',
    text: 'export const root = __dirname;',
  }]));
  assert.ok(result.includes('module-cjs-globals-in-esm'));
});

test('accepts fileURLToPath bridge for ESM filesystem path', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/path.js',
    text: "import { fileURLToPath } from 'node:url';\nexport const root = fileURLToPath(new URL('.', import.meta.url));",
  }]));
  assert.equal(result.includes('module-cjs-globals-in-esm'), false);
});

test('reports JSON require inside ESM package', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/config.js',
    text: "const config = require('./config.json');\nexport { config };",
  }]));
  assert.ok(result.includes('module-json-require-in-esm'));
});

test('reports require.resolve inside ESM package without bridge', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/resolve.js',
    text: "export const p = require.resolve('pkg');",
  }]));
  assert.ok(result.includes('module-require-resolve-in-esm'));
});

test('accepts require.resolve when explicit createRequire bridge exists', () => {
  const result = ids(packageWith('module', [{
    path: 'tools/resolve.mts',
    text: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport const p = require.resolve('pkg');",
  }]));
  assert.equal(result.includes('module-require-resolve-in-esm'), false);
});

test('ignores generated dist files', () => {
  const result = audit(packageWith('module', [{
    path: 'tools/dist/generated.js',
    text: "module.exports = require(process.env.X);",
  }]));
  assert.equal(result.summary.files.length, 0);
  assert.equal(result.findings.length, 0);
});

test('ignores node_modules files', () => {
  const result = audit(packageWith('module', [{
    path: 'tools/node_modules/pkg/index.js',
    text: "module.exports = require(process.env.X);",
  }]));
  assert.equal(result.summary.files.length, 0);
});

test('ignores backend C# files', () => {
  const result = audit([{
    path: 'Api/Program.cs',
    text: 'var app = builder.Build();',
  }]);
  assert.equal(result.summary.files.length, 0);
});

test('counts typed and JavaScript source surfaces', () => {
  const result = audit(packageWith('module', [
    { path: 'tools/a.ts', text: 'export const a = 1;' },
    { path: 'tools/b.mts', text: 'export const b = 2;' },
    { path: 'tools/c.js', text: 'export const c = 3;' },
  ]));
  assert.equal(result.summary.typedFiles, 2);
  assert.equal(result.summary.javascriptFiles, 1);
});

test('counts commonjs and mixed module surfaces', () => {
  const result = audit(packageWith('module', [
    { path: 'tools/a.cjs', text: "module.exports = require('a');" },
    { path: 'tools/b.ts', text: "import b from 'b';\nconst c = require('c');\nexport { b, c };" },
  ]));
  assert.equal(result.summary.commonJsFiles, 2);
  assert.equal(result.summary.mixedModuleFiles, 1);
});

test('uses nearest nested package boundary', () => {
  const files: readonly FixtureFileInput[] = [
    { path: 'tools/package.json', text: JSON.stringify({ name: 'tools', type: 'module' }) },
    { path: 'tools/legacy/package.json', text: JSON.stringify({ name: 'legacy', type: 'commonjs' }) },
    { path: 'tools/legacy/index.js', text: "module.exports = require('x');" },
  ];
  const result = ids(files);
  assert.equal(result.includes('module-commonjs-in-esm-package'), false);
});

test('handles package without type as unknown boundary', () => {
  const result = ids(packageWith(undefined, [{
    path: 'tools/index.js',
    text: "const x = require('x');",
  }]));
  assert.equal(result.includes('module-commonjs-in-esm-package'), false);
});

test('stable output is deterministic across repeated scans', () => {
  const files = packageWith('module', [
    { path: 'tools/z.ts', text: '// @ts-ignore\nexport const z = 1;' },
    { path: 'tools/a.ts', text: 'const x = require(process.env.X);' },
  ]);
  const first = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  const second = audit(files).findings.map(item => `${item.severity}:${item.id}:${item.location?.file ?? ''}`);
  assert.deepEqual(first, second);
});
