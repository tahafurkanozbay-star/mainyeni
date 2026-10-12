import assert from 'node:assert/strict';
import test from 'node:test';
import { auditModuleGraphModernization } from './module-graph-modernization-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditModuleGraphModernization(fixtureInventory(files));
}

test('accepts a simple typed acyclic graph', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts'; export const a = b + 1;" },
    { path: 'Webclient.app/src/b.ts', text: 'export const b = 1;' },
  ]);
  assert.equal(result.summary.files, 2);
  assert.equal(result.summary.typedFiles, 2);
  assert.equal(result.summary.resolvedRelativeImports, 1);
  assert.equal(result.summary.cycles.length, 0);
  assert.equal(result.findings.length, 0);
});

test('resolves extensionless typed import', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b'; export const a = b;" },
    { path: 'Webclient.app/src/b.ts', text: 'export const b = 1;' },
  ]);
  assert.equal(result.summary.resolvedRelativeImports, 1);
  assert.ok(!result.findings.some(item => item.id === 'module-graph-relative-import-unresolved'));
});

test('resolves directory index module', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './feature'; export const a = b;" },
    { path: 'Webclient.app/src/feature/index.ts', text: 'export const b = 1;' },
  ]);
  assert.equal(result.summary.resolvedRelativeImports, 1);
});

test('reports unresolved relative import', () => {
  const result = audit([{ path: 'Webclient.app/src/a.ts', text: "import { b } from './missing'; export const a = b;" }]);
  assert.ok(result.findings.some(item => item.id === 'module-graph-relative-import-unresolved'));
});

test('blocks nonliteral dynamic import', () => {
  const result = audit([{ path: 'Webclient.app/src/loader.ts', text: 'export async function load(name: string) { return import(name); }' }]);
  const finding = result.findings.find(item => item.id === 'module-graph-dynamic-import-nonliteral');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('accepts literal dynamic import', () => {
  const result = audit([
    { path: 'Webclient.app/src/loader.ts', text: "export const load = () => import('./feature.ts');" },
    { path: 'Webclient.app/src/feature.ts', text: 'export const feature = true;' },
  ]);
  assert.ok(!result.findings.some(item => item.id === 'module-graph-dynamic-import-nonliteral'));
  assert.equal(result.summary.dynamicImports, 1);
});

test('blocks node builtin import from browser source', () => {
  const result = audit([{ path: 'Webclient.app/src/hash.ts', text: "import { createHash } from 'node:crypto'; export { createHash };" }]);
  const finding = result.findings.find(item => item.id === 'module-graph-browser-node-builtin');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('blocks remote module import', () => {
  const result = audit([{ path: 'Webclient.app/src/remote.ts', text: "import 'https://cdn.example.com/runtime.mjs';" }]);
  assert.ok(result.findings.some(item => item.id === 'module-graph-remote-module-import' && item.blocking === true));
});

test('reports typed source importing legacy JavaScript', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { legacy } from './legacy.js'; export const a = legacy;" },
    { path: 'Webclient.app/src/legacy.js', text: 'export const legacy = 1;' },
  ]);
  assert.ok(result.findings.some(item => item.id === 'module-graph-typed-source-imports-legacy-js'));
  assert.deepEqual(result.summary.legacyTargets, ['Webclient.app/src/legacy.js']);
});

test('does not report legacy target when JavaScript module is not imported', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: 'export const a = 1;' },
    { path: 'Webclient.app/src/legacy.js', text: 'export const legacy = 1;' },
  ]);
  assert.deepEqual(result.summary.legacyTargets, []);
});

test('reports deep relative imports', () => {
  const result = audit([
    { path: 'Webclient.app/src/a/b/c/d/source.ts', text: "import { shared } from '../../../../shared.ts'; export const value = shared;" },
    { path: 'Webclient.app/src/shared.ts', text: 'export const shared = 1;' },
  ]);
  assert.ok(result.findings.some(item => item.id === 'module-graph-deep-relative-import'));
});

test('does not report shallow relative imports', () => {
  const result = audit([
    { path: 'Webclient.app/src/a/source.ts', text: "import { shared } from '../shared.ts'; export const value = shared;" },
    { path: 'Webclient.app/src/shared.ts', text: 'export const shared = 1;' },
  ]);
  assert.ok(!result.findings.some(item => item.id === 'module-graph-deep-relative-import'));
});

test('detects a two-node cycle', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts'; export const a = b;" },
    { path: 'Webclient.app/src/b.ts', text: "import { a } from './a.ts'; export const b = a;" },
  ]);
  assert.ok(result.findings.some(item => item.id === 'module-graph-cycle'));
  assert.ok(result.summary.cycles.length >= 1);
});

test('detects a longer cycle', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts'; export const a = b;" },
    { path: 'Webclient.app/src/b.ts', text: "import { c } from './c.ts'; export const b = c;" },
    { path: 'Webclient.app/src/c.ts', text: "import { a } from './a.ts'; export const c = a;" },
  ]);
  const cycle = result.summary.cycles[0];
  assert.ok(cycle);
  assert.equal(cycle.edgeCount, 3);
});

test('does not invent a cycle for one-way imports', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts'; export const a = b;" },
    { path: 'Webclient.app/src/b.ts', text: "import { c } from './c.ts'; export const b = c;" },
    { path: 'Webclient.app/src/c.ts', text: 'export const c = 1;' },
  ]);
  assert.equal(result.summary.cycles.length, 0);
});

test('deduplicates equivalent cycles discovered from different start nodes', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts';" },
    { path: 'Webclient.app/src/b.ts', text: "import { c } from './c.ts';" },
    { path: 'Webclient.app/src/c.ts', text: "import { a } from './a.ts';" },
  ]);
  assert.equal(result.summary.cycles.length, 1);
});

test('tracks export-from edges', () => {
  const result = audit([
    { path: 'Webclient.app/src/index.ts', text: "export { value } from './value.ts';" },
    { path: 'Webclient.app/src/value.ts', text: 'export const value = 1;' },
  ]);
  assert.equal(result.summary.resolvedRelativeImports, 1);
  assert.equal(result.summary.imports[0]?.kind, 'export');
});

test('tracks side-effect imports', () => {
  const result = audit([
    { path: 'Webclient.app/src/index.ts', text: "import './setup.ts';" },
    { path: 'Webclient.app/src/setup.ts', text: 'export {};' },
  ]);
  assert.equal(result.summary.resolvedRelativeImports, 1);
  assert.equal(result.summary.imports[0]?.kind, 'side-effect');
});

test('does not double count import-from as side-effect import', () => {
  const result = audit([
    { path: 'Webclient.app/src/index.ts', text: "import { value } from './value.ts'; export { value };" },
    { path: 'Webclient.app/src/value.ts', text: 'export const value = 1;' },
  ]);
  assert.equal(result.summary.imports.length, 1);
});

test('ignores test and fixture source files as graph roots', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.test.ts', text: "import 'node:fs';" },
    { path: 'Webclient.app/src/fixtures/a.ts', text: "import 'node:path';" },
  ]);
  assert.equal(result.summary.files, 0);
  assert.equal(result.findings.length, 0);
});

test('ignores build and generated output', () => {
  const result = audit([
    { path: 'Webclient.app/src/generated/a.ts', text: "import 'node:fs';" },
    { path: 'Webclient.app/src/build/a.ts', text: "import 'node:path';" },
  ]);
  assert.equal(result.summary.files, 0);
});

test('counts legacy product files independently from imported targets', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: 'export const a = 1;' },
    { path: 'Webclient.app/src/b.js', text: 'export const b = 1;' },
  ]);
  assert.equal(result.summary.typedFiles, 1);
  assert.equal(result.summary.legacyFiles, 1);
});

test('preserves query suffix while resolving import target', () => {
  const result = audit([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts?raw'; export const a = b;" },
    { path: 'Webclient.app/src/b.ts', text: 'export const b = 1;' },
  ]);
  assert.equal(result.summary.resolvedRelativeImports, 1);
});

test('caps cycle enumeration for adversarial graphs', () => {
  const files: FixtureFileInput[] = [];
  for (let index = 0; index < 40; index += 1) {
    const next = (index + 1) % 40;
    files.push({ path: 'Webclient.app/src/cycle-' + index + '.ts', text: "import './cycle-" + next + ".ts';" });
  }
  const result = audit(files);
  assert.ok(result.summary.cycles.length <= 32);
});

test('keeps signals deterministic regardless of fixture order', () => {
  const files: readonly FixtureFileInput[] = [
    { path: 'Webclient.app/src/z.ts', text: "import './a.ts';" },
    { path: 'Webclient.app/src/a.ts', text: 'export const a = 1;' },
  ];
  const left = audit(files);
  const right = audit([...files].reverse());
  assert.deepEqual(
    left.summary.imports.map(item => ({ source: item.source, line: item.line, specifier: item.specifier, resolved: item.resolved })),
    right.summary.imports.map(item => ({ source: item.source, line: item.line, specifier: item.specifier, resolved: item.resolved })),
  );
  assert.deepEqual(
    left.findings.map(item => ({ id: item.id, file: item.location?.file })),
    right.findings.map(item => ({ id: item.id, file: item.location?.file })),
  );
});

test('reports nonliteral dynamic import expression with evidence', () => {
  const result = audit([{
    path: 'Webclient.app/src/loader.ts',
    text: 'export const load = (name: string) => import(`./widgets/${name}.tsx`);',
  }]);
  const finding = result.findings.find(item => item.id === 'module-graph-dynamic-import-nonliteral');
  assert.ok(finding);
  assert.ok(finding.evidence?.excerpt?.includes('import'));
});

test('allows package imports such as react', () => {
  const result = audit([{ path: 'Webclient.app/src/App.tsx', text: "import React from 'react'; export const App = () => <main />;" }]);
  assert.equal(result.findings.length, 0);
});

test('summary counts nonliteral dynamic imports', () => {
  const result = audit([{ path: 'Webclient.app/src/loader.ts', text: 'export const load = (path: string) => import(path);' }]);
  assert.equal(result.summary.dynamicImports, 1);
  assert.equal(result.summary.nonLiteralDynamicImports, 1);
});

test('does not scan tooling modules as product graph roots', () => {
  const result = audit([{ path: 'quality/release/tool.mts', text: "import 'node:fs';" }]);
  assert.equal(result.summary.files, 0);
  assert.equal(result.findings.length, 0);
});

test('result remains deterministic across repeated audits', () => {
  const inventory = fixtureInventory([
    { path: 'Webclient.app/src/a.ts', text: "import { b } from './b.ts';" },
    { path: 'Webclient.app/src/b.ts', text: "import { a } from './a.ts';" },
  ]);
  const first = auditModuleGraphModernization(inventory);
  const second = auditModuleGraphModernization(inventory);
  assert.deepEqual(first.summary.cycles, second.summary.cycles);
  assert.deepEqual(
    first.findings.map(item => ({ id: item.id, severity: item.severity, file: item.location?.file })),
    second.findings.map(item => ({ id: item.id, severity: item.severity, file: item.location?.file })),
  );
});
