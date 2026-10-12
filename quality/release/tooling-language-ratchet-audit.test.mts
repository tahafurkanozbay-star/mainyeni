import assert from 'node:assert/strict';
import test from 'node:test';
import { auditToolingLanguageRatchet } from './tooling-language-ratchet-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const BASELINE = 'quality/release/tooling-language-baseline.json';

function baseline(
  productionLegacy: readonly string[] = [],
  testLegacy: readonly string[] = [],
): FixtureFileInput {
  return {
    path: BASELINE,
    text: JSON.stringify({
      schemaVersion: 1,
      description: 'test baseline',
      productionLegacy,
      testLegacy,
    }, null, 2),
  };
}

function audit(files: readonly FixtureFileInput[]) {
  return auditToolingLanguageRatchet(fixtureInventory(files));
}

test('accepts exact baseline inventory', () => {
  const production = ['tools/legacy.mjs'];
  const tests = ['tools/legacy.test.mjs'];
  const result = audit([
    baseline(production, tests),
    { path: production[0]!, text: 'export const value = 1;' },
    { path: tests[0]!, text: 'export const testValue = 1;' },
  ]);
  assert.equal(result.summary.productionLegacy, 1);
  assert.equal(result.summary.testLegacy, 1);
  assert.deepEqual(result.summary.unlistedProduction, []);
  assert.deepEqual(result.summary.unlistedTests, []);
  assert.equal(result.findings.length, 0);
});

test('blocks new production legacy tooling module', () => {
  const result = audit([
    baseline(),
    { path: 'tools/new-audit.mjs', text: 'export function audit() { return true; }' },
  ]);
  const finding = result.findings.find(item => item.id === 'tooling-language-new-legacy-production');
  assert.ok(finding);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.blocking, true);
});

test('blocks new legacy tooling test', () => {
  const result = audit([
    baseline(),
    { path: 'tools/new-audit.test.mjs', text: 'export const fixture = true;' },
  ]);
  const finding = result.findings.find(item => item.id === 'tooling-language-new-legacy-test');
  assert.ok(finding);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.blocking, true);
});

test('accepts tiny typed compatibility shim without baseline entry', () => {
  const result = audit([
    baseline(),
    {
      path: 'Webclient.app/scripts/compat.mjs',
      text: [
        "export * from '../../quality/release/compat.mts';",
        "import { runCli } from '../../quality/release/compat.mts';",
        'runCli();',
      ].join('\n'),
    },
  ]);
  assert.equal(result.summary.compatibilityShims, 1);
  assert.deepEqual(result.summary.unlistedProduction, []);
  assert.ok(!result.findings.some(item => item.id === 'tooling-language-new-legacy-production'));
});

test('does not classify a shim containing policy logic as compatibility-only', () => {
  const result = audit([
    baseline(),
    {
      path: 'Webclient.app/scripts/not-a-shim.mjs',
      text: [
        "export * from '../../quality/release/compat.mts';",
        "import { runCli } from '../../quality/release/compat.mts';",
        'const allow = true;',
        'if (allow) runCli();',
      ].join('\n'),
    },
  ]);
  assert.equal(result.summary.compatibilityShims, 0);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-new-legacy-production'));
});

test('does not classify a large forwarding file as a compatibility shim', () => {
  const lines = [
    "export * from '../../quality/release/compat.mts';",
    ...Array.from({ length: 20 }, (_, index) => `// compatibility comment ${index}`),
  ];
  const result = audit([
    baseline(),
    { path: 'Webclient.app/scripts/large-shim.mjs', text: lines.join('\n') },
  ]);
  assert.equal(result.summary.compatibilityShims, 0);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-new-legacy-production'));
});

test('reports stale production baseline entry', () => {
  const result = audit([baseline(['tools/removed.mjs'])]);
  assert.deepEqual(result.summary.staleBaselineProduction, ['tools/removed.mjs']);
  const finding = result.findings.find(item => item.id === 'tooling-language-stale-production-baseline');
  assert.ok(finding);
  assert.equal(finding.severity, 'info');
});

test('reports stale test baseline entry', () => {
  const result = audit([baseline([], ['tools/removed.test.mjs'])]);
  assert.deepEqual(result.summary.staleBaselineTests, ['tools/removed.test.mjs']);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-stale-test-baseline'));
});

test('blocks missing baseline', () => {
  const result = audit([{ path: 'tools/legacy.mjs', text: 'export {};' }]);
  const finding = result.findings.find(item => item.id === 'tooling-language-baseline-missing');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('blocks invalid baseline JSON', () => {
  const result = audit([{ path: BASELINE, text: '{ nope' }]);
  const finding = result.findings.find(item => item.id === 'tooling-language-baseline-invalid-json');
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test('blocks baseline schema mismatch', () => {
  const result = audit([{
    path: BASELINE,
    text: JSON.stringify({ schemaVersion: 2, productionLegacy: [], testLegacy: [] }),
  }]);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-baseline-schema-invalid' && item.blocking === true));
});

test('blocks non-array baseline path fields', () => {
  const result = audit([{
    path: BASELINE,
    text: JSON.stringify({ schemaVersion: 1, productionLegacy: 'tools/a.mjs', testLegacy: [] }),
  }]);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-baseline-schema-invalid'));
});

test('blocks duplicate production baseline entries', () => {
  const result = audit([baseline(['tools/a.mjs', 'tools/a.mjs'])]);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-baseline-duplicate' && item.blocking === true));
});

test('blocks duplicate test baseline entries', () => {
  const result = audit([baseline([], ['tools/a.test.mjs', 'tools/a.test.mjs'])]);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-baseline-duplicate' && item.blocking === true));
});

test('reports unsorted production baseline', () => {
  const result = audit([
    baseline(['tools/z.mjs', 'tools/a.mjs']),
    { path: 'tools/z.mjs', text: 'export const z = 1;' },
    { path: 'tools/a.mjs', text: 'export const a = 1;' },
  ]);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-baseline-unsorted'));
});

test('reports unsorted test baseline', () => {
  const result = audit([
    baseline([], ['tools/z.test.mjs', 'tools/a.test.mjs']),
    { path: 'tools/z.test.mjs', text: 'export const z = 1;' },
    { path: 'tools/a.test.mjs', text: 'export const a = 1;' },
  ]);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-baseline-unsorted'));
});

test('ignores generated output', () => {
  const result = audit([
    baseline(),
    { path: 'tools/generated/new.mjs', text: 'export const generated = true;' },
    { path: 'quality/dist/report.mjs', text: 'export const generated = true;' },
  ]);
  assert.equal(result.summary.productionLegacy, 0);
  assert.equal(result.findings.length, 0);
});

test('ignores fixture and snapshot JavaScript', () => {
  const result = audit([
    baseline(),
    { path: 'quality/fixtures/unsafe.mjs', text: 'export const fixture = true;' },
    { path: 'quality/snapshots/output.js', text: 'module.exports = {};' },
  ]);
  assert.equal(result.summary.productionLegacy, 0);
});

test('does not scan product source JavaScript as tooling debt', () => {
  const result = audit([
    baseline(),
    { path: 'Webclient.app/src/legacy.js', text: 'export const legacy = true;' },
  ]);
  assert.equal(result.summary.productionLegacy, 0);
  assert.equal(result.summary.testLegacy, 0);
});

test('counts Webclient admin tooling', () => {
  const path = 'Webclient.admin/tooling/admin-build-budget.mjs';
  const result = audit([
    baseline([path]),
    { path, text: 'export const budget = 1;' },
  ]);
  assert.equal(result.summary.productionLegacy, 1);
});

test('counts Webclient app release scripts', () => {
  const path = 'Webclient.app/scripts/release-evidence-audit.mjs';
  const result = audit([
    baseline([path]),
    { path, text: 'export function audit() { return true; }' },
  ]);
  assert.equal(result.summary.productionLegacy, 1);
});

test('counts root tools', () => {
  const path = 'tools/platform-audit.mjs';
  const result = audit([
    baseline([path]),
    { path, text: 'export const report = true;' },
  ]);
  assert.equal(result.summary.productionLegacy, 1);
});

test('migration queue prioritizes release production over tests', () => {
  const prod = 'Webclient.app/scripts/release-evidence-audit.mjs';
  const testPath = 'tools/huge.test.mjs';
  const result = audit([
    baseline([prod], [testPath]),
    { path: prod, text: 'export function audit() { return true; }' },
    { path: testPath, text: 'x'.repeat(50_000) },
  ]);
  assert.equal(result.summary.migrationQueue[0]?.file, prod);
});

test('migration queue prefers larger files within same class', () => {
  const small = 'tools/release-small.mjs';
  const large = 'tools/release-large.mjs';
  const result = audit([
    baseline([large, small].sort()),
    { path: small, text: 'export const x = 1;' },
    { path: large, text: 'export const x = ' + JSON.stringify('a'.repeat(8_000)) + ';' },
  ]);
  assert.equal(result.summary.migrationQueue[0]?.file, large);
});

test('compatibility shims are excluded from migration queue', () => {
  const result = audit([
    baseline(),
    {
      path: 'tools/compat.mjs',
      text: "export * from '../quality/release/compat.mts';\nimport { runCli } from '../quality/release/compat.mts';\nrunCli();\n",
    },
  ]);
  assert.equal(result.summary.compatibilityShims, 1);
  assert.equal(result.summary.migrationQueue.length, 0);
});

test('stale baseline entries do not count as active legacy debt', () => {
  const result = audit([baseline(['tools/removed.mjs'])]);
  assert.equal(result.summary.productionLegacy, 0);
  assert.equal(result.summary.baselineProductionBudget, 1);
});

test('summary exposes frozen baseline budgets independently from current counts', () => {
  const result = audit([
    baseline(['tools/a.mjs', 'tools/b.mjs']),
    { path: 'tools/a.mjs', text: 'export const a = 1;' },
  ]);
  assert.equal(result.summary.baselineProductionBudget, 2);
  assert.equal(result.summary.productionLegacy, 1);
});

test('new production debt remains blocking even when below baseline numeric budget', () => {
  const result = audit([
    baseline(['tools/old-a.mjs', 'tools/old-b.mjs']),
    { path: 'tools/new.mjs', text: 'export const value = 1;' },
  ]);
  assert.equal(result.summary.productionLegacy, 1);
  assert.ok(result.findings.some(item => item.id === 'tooling-language-new-legacy-production' && item.blocking === true));
});

test('path identity is the ratchet authority, not extension count alone', () => {
  const result = audit([
    baseline(['tools/approved.mjs']),
    { path: 'tools/other.mjs', text: 'export const value = 1;' },
  ]);
  assert.deepEqual(result.summary.unlistedProduction, ['tools/other.mjs']);
  assert.deepEqual(result.summary.staleBaselineProduction, ['tools/approved.mjs']);
});

test('keeps output deterministic regardless of fixture order', () => {
  const fixtures: readonly FixtureFileInput[] = [
    baseline(['tools/a.mjs', 'tools/z.mjs']),
    { path: 'tools/z.mjs', text: 'export const z = 1;' },
    { path: 'tools/a.mjs', text: 'export const a = 1;' },
  ];
  const left = audit(fixtures);
  const right = audit([fixtures[0]!, ...fixtures.slice(1).reverse()]);
  assert.deepEqual(left.summary.migrationQueue, right.summary.migrationQueue);
  assert.deepEqual(
    left.findings.map(item => ({ id: item.id, file: item.location?.file })),
    right.findings.map(item => ({ id: item.id, file: item.location?.file })),
  );
});

test('test and production baselines stay independent', () => {
  const result = audit([
    baseline(['tools/a.mjs'], ['tools/a.test.mjs']),
    { path: 'tools/a.mjs', text: 'export const a = 1;' },
    { path: 'tools/a.test.mjs', text: 'export const a = 1;' },
  ]);
  assert.equal(result.summary.productionLegacy, 1);
  assert.equal(result.summary.testLegacy, 1);
  assert.equal(result.summary.baselineProductionBudget, 1);
  assert.equal(result.summary.baselineTestBudget, 1);
});
