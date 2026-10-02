import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRuntimeSource, extractRuntimeImports, type RuntimeManifest } from './browser-runtime-governance.mts';

const manifest: RuntimeManifest = Object.freeze({
  dependencies: Object.freeze({ react: '^19.0.0', '@arcgis/core': '^4.0.0' }),
  devDependencies: Object.freeze({ vitest: '^4.0.0', typescript: '^7.0.0' }),
});

const codes = (source: string): readonly string[] =>
  auditRuntimeSource('Webclient.app/src/example.ts', source, manifest).map((item) => item.code);

test('accepts declared runtime packages and relative modules', () => {
  assert.deepEqual(codes("import React from 'react'; import x from './x'; export { x };"), []);
});

test('accepts scoped runtime dependency subpaths', () => {
  assert.deepEqual(codes("import Map from '@arcgis/core/Map.js';"), []);
});

test('blocks node builtins in browser production source', () => {
  assert.deepEqual(codes("import fs from 'node:fs';"), ['browser-node-builtin']);
  assert.deepEqual(codes("import path from 'path';"), ['browser-node-builtin']);
});

test('blocks node builtin subpaths', () => {
  assert.deepEqual(codes("import fs from 'node:fs/promises';"), ['browser-node-builtin']);
  assert.deepEqual(codes("import strict from 'node:assert/strict';"), ['browser-node-builtin']);
});

test('blocks remote executable module schemes', () => {
  for (const specifier of ['https://cdn.example/x.js', 'http://cdn.example/x.js', 'data:text/javascript,1', 'blob:abc', 'file:///tmp/x.js']) {
    assert.deepEqual(codes(`import '${specifier}';`), ['browser-remote-executable-import']);
  }
});

test('blocks packages declared only as dev dependencies', () => {
  assert.deepEqual(codes("import { expect } from 'vitest';"), ['browser-dev-dependency']);
});

test('blocks undeclared runtime dependencies', () => {
  assert.deepEqual(codes("import leftPad from 'left-pad';"), ['browser-undeclared-dependency']);
});

test('blocks arbitrary browser process environment reads', () => {
  assert.deepEqual(codes('const secret = process.env.API_SECRET;'), ['browser-process-env']);
});

test('permits the existing PUBLIC_URL compatibility read only', () => {
  assert.deepEqual(codes('const base = process.env.PUBLIC_URL;'), []);
});

test('blocks eval and Function construction', () => {
  assert.deepEqual(codes("eval('1')"), ['browser-dynamic-code']);
  assert.deepEqual(codes("const fn = new Function('return 1')"), ['browser-dynamic-code']);
});

test('blocks CommonJS require and exports in browser runtime', () => {
  assert.ok(codes("const x = require('react')").includes('browser-commonjs'));
  assert.ok(codes('module.exports = {}').includes('browser-commonjs'));
  assert.ok(codes('exports.x = 1').includes('browser-commonjs'));
});

test('literal require is independently classified as CommonJS and dependency use', () => {
  const findings = auditRuntimeSource('Webclient.app/src/example.ts', "const x = require('vitest')", manifest);
  assert.deepEqual(findings.map((item) => item.code), ['browser-commonjs', 'browser-dev-dependency']);
});

test('extracts static, export-from, dynamic and require literal references deterministically', () => {
  const source = [
    "import React from 'react';",
    "export { Map } from '@arcgis/core/Map.js';",
    "const lazy = import('./lazy');",
    "const legacy = require('vitest');",
  ].join('\n');
  assert.deepEqual(extractRuntimeImports(source).map((item) => item.specifier), [
    'react', '@arcgis/core/Map.js', './lazy', 'vitest',
  ]);
});

test('lexical scanner conservatively observes import-shaped text in comments', () => {
  assert.deepEqual(extractRuntimeImports('// import x from "left-pad"\nconst value = 1;').map((item) => item.specifier), ['left-pad']);
});

test('reports stable one-based line numbers', () => {
  const findings = auditRuntimeSource('Webclient.app/src/example.ts', "const a = 1;\nimport fs from 'node:fs';\n", manifest);
  assert.equal(findings[0]?.line, 2);
});

test('sorts multiple findings by line then code', () => {
  const findings = auditRuntimeSource(
    'Webclient.app/src/example.ts',
    "const a = process.env.SECRET;\nimport fs from 'node:fs';\neval('1');",
    manifest,
  );
  assert.deepEqual(findings.map((item) => item.line), [1, 2, 3]);
});

test('deduplicates overlapping import grammar matches', () => {
  const imports = extractRuntimeImports("export { default } from 'react';");
  assert.equal(imports.length, 1);
  assert.equal(imports[0]?.specifier, 'react');
});
