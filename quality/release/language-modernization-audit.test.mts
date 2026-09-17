import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLanguageModernization } from './language-modernization-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function tsconfig(overrides: Record<string, unknown> = {}): FixtureFileInput {
  return {
    path: 'Webclient.app/tsconfig.json',
    text: JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        useUnknownInCatchVariables: true,
        moduleResolution: 'Bundler',
        allowJs: true,
        checkJs: false,
        ...overrides,
      },
    }, null, 2),
  };
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return auditLanguageModernization(fixtureInventory([tsconfig(), ...files])).findings.map(item => item.id);
}

test('reports JSX that remains in production JavaScript', () => {
  const section = auditLanguageModernization(fixtureInventory([
    tsconfig(),
    { path: 'Webclient.app/src/Components/Card.js', text: 'export const Card = () => <div>card</div>;\n' },
  ]));
  const item = section.findings.find(candidate => candidate.id === 'language-jsx-in-javascript');
  assert.ok(item);
  assert.equal(item.location?.file, 'Webclient.app/src/Components/Card.js');
  assert.equal(section.summary.jsxInJavaScriptFiles, 1);
});

test('does not classify plain JavaScript runtime modules as JSX debt', () => {
  assert.ok(!ids([{ path: 'Webclient.app/src/runtime/cache.js', text: 'export const cache = new Map();\n' }]).includes('language-jsx-in-javascript'));
});

test('reports CommonJS in browser production source', () => {
  assert.ok(ids([{ path: 'Webclient.app/src/runtime/legacy.js', text: "const value = require('./value'); module.exports = value;\n" }]).includes('language-commonjs-production'));
});

test('ignores CommonJS outside Webclient production source', () => {
  assert.ok(!ids([{ path: 'scripts/tool.cjs', text: "module.exports = {};\n" }]).includes('language-commonjs-production'));
});

test('blocks @ts-nocheck in production source', () => {
  const section = auditLanguageModernization(fixtureInventory([
    tsconfig(),
    { path: 'Webclient.app/src/runtime/unsafe.ts', text: '// @ts-nocheck\nexport const value = missing;\n' },
  ]));
  const item = section.findings.find(candidate => candidate.id === 'language-ts-nocheck-production');
  assert.ok(item);
  assert.equal(item.blocking, true);
  assert.equal(item.severity, 'high');
});

test('reports @ts-ignore but permits documented expect-error', () => {
  const section = auditLanguageModernization(fixtureInventory([
    tsconfig(),
    { path: 'Webclient.app/src/runtime/ignore.ts', text: '// @ts-ignore\ncallLegacy();\n' },
    { path: 'Webclient.app/src/runtime/expected.ts', text: '// @ts-expect-error upstream contract\ncallLegacy();\n' },
  ]));
  assert.ok(section.findings.some(item => item.id === 'language-ts-ignore-production'));
  assert.equal(section.findings.filter(item => item.id === 'language-ts-ignore-production').length, 1);
});

test('blocks missing frontend tsconfig', () => {
  const section = auditLanguageModernization(fixtureInventory([
    { path: 'Webclient.app/src/runtime/value.ts', text: 'export const value = 1;\n' },
  ]));
  const item = section.findings.find(candidate => candidate.id === 'language-tsconfig-missing');
  assert.ok(item);
  assert.equal(item.blocking, true);
  assert.equal(item.severity, 'critical');
});

test('blocks a regression that disables strict TypeScript', () => {
  const section = auditLanguageModernization(fixtureInventory([tsconfig({ strict: false })]));
  const item = section.findings.find(candidate => candidate.id === 'language-typescript-strict-disabled');
  assert.ok(item);
  assert.equal(item.blocking, true);
  assert.equal(item.severity, 'critical');
});

test('reports weakened indexed-access and catch-variable contracts', () => {
  const section = auditLanguageModernization(fixtureInventory([
    tsconfig({ noUncheckedIndexedAccess: false, useUnknownInCatchVariables: false }),
  ]));
  const found = section.findings.map(item => item.id);
  assert.ok(found.includes('language-unchecked-index-access'));
  assert.ok(found.includes('language-catch-variable-not-unknown'));
});

test('summarizes production language inventory deterministically', () => {
  const section = auditLanguageModernization(fixtureInventory([
    tsconfig(),
    { path: 'Webclient.app/src/a.js', text: 'export const a = 1;\n' },
    { path: 'Webclient.app/src/b.jsx', text: 'export const B = () => <div />;\n' },
    { path: 'Webclient.app/src/c.ts', text: 'export const c: number = 1;\n' },
    { path: 'Webclient.app/src/d.tsx', text: 'export const D = () => null;\n' },
    { path: 'Webclient.app/src/d.test.tsx', text: 'test("d", () => {});\n' },
  ]));
  assert.equal(section.summary.productionJavaScriptFiles, 2);
  assert.equal(section.summary.productionTypeScriptFiles, 2);
  assert.equal(section.summary.strictTypeScript, true);
  assert.equal(section.summary.moduleResolution, 'Bundler');
});
