import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd());
const TOOLS = path.join(ROOT, 'tools');

const migratedPairs = Object.freeze([
  ['browser-runtime-boundary.mjs', 'browser-runtime-boundary.mts'],
  ['browser-runtime-boundary.test.mjs', 'browser-runtime-boundary.test.mts'],
  ['package-lock-integrity.mjs', 'package-lock-integrity.mts'],
  ['package-lock-integrity.test.mjs', 'package-lock-integrity.test.mts'],
  ['platform-audit.mjs', 'platform-audit.mts'],
  ['platform-audit.test.mjs', 'platform-audit.test.mts'],
  ['platform-boundary-audit.mjs', 'platform-boundary-audit.mts'],
  ['platform-boundary-audit.test.mjs', 'platform-boundary-audit.test.mts'],
  ['platform-contracts.mjs', 'platform-contracts.mts'],
  ['platform-contracts.test.mjs', 'platform-contracts.test.mts'],
  ['platform-language-ratchet.mjs', 'platform-language-ratchet.mts'],
  ['platform-language-ratchet.test.mjs', 'platform-language-ratchet.test.mts'],
  ['platform-module-graph.mjs', 'platform-module-graph.mts'],
  ['platform-module-graph.test.mjs', 'platform-module-graph.test.mts'],
  ['platform-ts-cutover.test.mjs', 'platform-ts-cutover.test.mts'],
  ['typed-source-boundary.mjs', 'typed-source-boundary.mts'],
  ['typed-source-boundary.test.mjs', 'typed-source-boundary.test.mts'],
] as const);

const canonicalProduction = Object.freeze([
  'browser-runtime-boundary.mts',
  'package-lock-integrity.mts',
  'platform-audit.mts',
  'platform-boundary-audit.mts',
  'platform-contracts.mts',
  'platform-language-ratchet.mts',
  'platform-module-graph.mts',
  'typed-source-boundary.mts',
] as const);

const read = (relative: string) => fs.readFile(path.join(ROOT, relative), 'utf8');

const exists = async (relative: string): Promise<boolean> => {
  try {
    return (await fs.stat(path.join(ROOT, relative))).isFile();
  } catch {
    return false;
  }
};

test('canonical TypeScript ESM tooling exists for every staged legacy module', async () => {
  for (const [legacy, canonical] of migratedPairs) {
    assert.equal(await exists(`tools/${legacy}`), true, `missing compatibility source: ${legacy}`);
    assert.equal(await exists(`tools/${canonical}`), true, `missing canonical TypeScript source: ${canonical}`);
  }
});

test('staged TypeScript cutover preserves behavior byte-for-byte before legacy shadow removal', async () => {
  for (const [legacy, canonical] of migratedPairs) {
    const [legacySource, canonicalSource] = await Promise.all([
      read(`tools/${legacy}`),
      read(`tools/${canonical}`),
    ]);
    if (canonical === 'platform-ts-cutover.test.mts') continue;
    assert.equal(canonicalSource, legacySource, `${canonical} drifted from staged legacy behavior`);
  }
});

test('canonical production tools remain ESM-only and contain no TypeScript directive escape hatch', async () => {
  for (const file of canonicalProduction) {
    const source = await read(`tools/${file}`);
    assert.match(source, /\bimport\s/u, `${file} must use ESM imports`);
    assert.doesNotMatch(source, /\brequire\s*\(/u, `${file} must not use CommonJS require`);
    assert.doesNotMatch(source, /\bmodule\.exports\b/u, `${file} must not use CommonJS exports`);
    assert.doesNotMatch(source, /^\s*\/\/\s*@ts-(?:nocheck|ignore|expect-error)\b/mu, `${file} must not use TypeScript line-directive opt-outs`);
    assert.doesNotMatch(source, /\/\*\s*@ts-(?:nocheck|ignore|expect-error)\b/u, `${file} must not use TypeScript block-directive opt-outs`);
  }
});

test('Node 24 can load every canonical production TypeScript module natively', async () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'tooling cutover requires Node 24+');
  for (const file of canonicalProduction) {
    const moduleUrl = pathToFileURL(path.join(TOOLS, file)).href;
    const loaded = await import(moduleUrl);
    assert.equal(typeof loaded, 'object', `${file} did not load as native TypeScript ESM`);
  }
});

test('architecture workflow executes only canonical TypeScript tooling for migrated gates', async () => {
  const workflow = await read('.github/workflows/platform-architecture-audit.yml');
  for (const file of [
    'platform-audit',
    'platform-contracts',
    'platform-module-graph',
    'platform-language-ratchet',
    'platform-boundary-audit',
    'browser-runtime-boundary',
    'package-lock-integrity',
  ]) {
    assert.match(workflow, new RegExp(`tools/${file}\\.mts`, 'u'));
    assert.doesNotMatch(workflow, new RegExp(`tools/${file}\\.mjs(?:\\s|$)`, 'u'));
  }
  assert.match(workflow, /tools\/tooling-typescript-cutover\.test\.mts/u);
});

test('typed source boundary workflow runs canonical TypeScript ESM and immutable actions', async () => {
  const workflow = await read('.github/workflows/typed-source-boundary.yml');
  assert.match(workflow, /tools\/typed-source-boundary\.test\.mts/u);
  assert.match(workflow, /tools\/typed-source-boundary\.mts --strict/u);
  assert.doesNotMatch(workflow, /typed-source-boundary\.(?:mjs|js)/u);
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node)@v\d+/u);
  assert.match(workflow, /persist-credentials:\s+false/u);
});

test('developer verification scripts use canonical TypeScript platform gates', async () => {
  const packageJson = JSON.parse(await read('Webclient.app/package.json')) as {
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};
  assert.match(scripts['quality:module-graph'] ?? '', /platform-module-graph\.mts/u);
  assert.match(scripts['quality:language-ratchet'] ?? '', /platform-language-ratchet\.mts/u);
  assert.match(scripts['quality:platform-boundaries'] ?? '', /platform-boundary-audit\.mts/u);
  assert.match(scripts['quality:browser-runtime'] ?? '', /browser-runtime-boundary\.mts/u);
  assert.match(scripts['quality:tooling-cutover'] ?? '', /tooling-typescript-cutover\.test\.mts/u);
  assert.match(scripts.verify ?? '', /quality:tooling-cutover/u);
  assert.match(packageJson.engines?.node ?? '', />=24/u);
});

test('tools directory admits no CommonJS or JSX source during TypeScript migration', async () => {
  const names = await fs.readdir(TOOLS);
  const forbidden = names.filter((name) => /\.(?:cjs|jsx)$/iu.test(name)).sort();
  assert.deepEqual(forbidden, []);
});

test('legacy mjs surface is frozen to the declared staged compatibility set', async () => {
  const names = await fs.readdir(TOOLS);
  const actual = names.filter((name) => name.endsWith('.mjs')).sort();
  const declared = [...new Set(migratedPairs.map(([legacy]) => legacy))].sort();
  assert.deepEqual(actual, declared, 'new .mjs tooling requires TypeScript migration instead of budget growth');
});

test('every staged compatibility module has exactly one canonical mts counterpart', async () => {
  const names = new Set(await fs.readdir(TOOLS));
  for (const legacy of [...names].filter((name) => name.endsWith('.mjs'))) {
    const canonical = `${legacy.slice(0, -4)}.mts`;
    assert.equal(names.has(canonical), true, `${legacy} lacks canonical ${canonical}`);
  }
});

test('TypeScript canonical set contains no duplicate logical stems', () => {
  const stems = migratedPairs.map(([, canonical]) => canonical.replace(/\.mts$/u, ''));
  assert.equal(new Set(stems).size, stems.length);
});
