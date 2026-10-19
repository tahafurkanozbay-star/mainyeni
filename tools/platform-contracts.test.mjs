import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runPlatformContracts } from './platform-contracts.mjs';

async function fixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-platform-contracts-'));
  const files = {
    'Webclient.app/package.json': JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        react: '^19.3.0',
        'react-dom': '^19.3.0',
        bootstrap: '^5.3.8',
      },
      devDependencies: {
        typescript: '^7.0.2',
        vite: '^8.3.0',
        vitest: '^5.0.1',
        oxlint: '^1.36.0',
        '@vitejs/plugin-react': '^6.0.0',
      },
      engines: { node: '>=24.0.0', npm: '>=11.0.0' },
      scripts: {
        dev: 'vite',
        build: 'vite build',
        'build:verify': 'node scripts/verify-build.mjs',
        'quality:module-graph': 'node ../tools/platform-module-graph.mjs --strict',
        'quality:language-ratchet': 'node ../tools/platform-language-ratchet.mjs --strict',
        'quality:platform-boundaries': 'node ../tools/platform-boundary-audit.mjs --strict',
        'quality:browser-runtime': 'node ../tools/browser-runtime-boundary.mjs --strict',
        lint: 'oxlint src',
        'lint:strict': 'oxlint --deny-warnings src',
        'test:ci': 'vitest run',
        typecheck: 'tsc --noEmit -p tsconfig.json && npm run typecheck:platform && npm run typecheck:platform-tests && npm run typecheck:gis && npm run typecheck:experience && npm run typecheck:data-search',
        'typecheck:platform': 'tsc --noEmit -p tsconfig.platform.json',
        'typecheck:platform-tests': 'tsc --noEmit -p tsconfig.platform-tests.json',
        'typecheck:gis': 'tsc --noEmit -p tsconfig.gis.json',
        'typecheck:experience': 'tsc --noEmit -p tsconfig.experience.json',
        'typecheck:data-search': 'tsc --noEmit -p tsconfig.data-search.json',
        verify: 'npm run lint:strict && npm run typecheck && npm run test:ci && npm run build && npm run build:verify',
      },
    }, null, 2),
    'Webclient.app/tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        isolatedModules: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true,
        forceConsistentCasingInFileNames: true,
        verbatimModuleSyntax: true,
        allowJs: true,
      },
    }),
    'Webclient.app/tsconfig.platform.json': JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { allowJs: false, checkJs: false },
      include: ['src/platform/**/*.ts'],
    }),
    'Webclient.app/tsconfig.platform-tests.json': JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { allowJs: false, checkJs: false, strict: true, types: ['vitest/globals', 'vite/client'] },
      include: ['src/platform/runtime/runtime.test.ts'],
    }),
    'Webclient.app/tsconfig.gis.json': JSON.stringify({ extends: './tsconfig.json', include: ['src/gis-engine/**/*.ts'] }),
    'Webclient.app/tsconfig.experience.json': JSON.stringify({ extends: './tsconfig.json', include: ['src/experience/**/*.ts'] }),
    'Webclient.app/tsconfig.data-search.json': JSON.stringify({ extends: './tsconfig.json', include: ['src/data-search/**/*.ts'] }),
    'Webclient.app/index.html': '<div id="root"></div>',
    'Webclient.app/src/main.tsx': 'export {};\n',
    'Webclient.app/vite.config.ts': 'export default {};\n',
    'Webclient.app/vitest.config.ts': 'export default {};\n',
    ...overrides,
  };

  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test('accepts the modern frontend toolchain baseline without requiring a backend toolchain', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runPlatformContracts(root);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.passed, true);
  assert.ok(report.findings.some((finding) => finding.code === 'typescript-legacy-js-bridge'));
});

test('fails when a typecheck script references a missing project', async (t) => {
  const root = await fixture({ 'Webclient.app/tsconfig.gis.json': null });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runPlatformContracts(root);
  assert.ok(report.findings.some((finding) => finding.code === 'tsconfig-missing' && finding.detail?.project === 'tsconfig.gis.json'));
  assert.equal(report.summary.passed, false);
});

test('resolves inherited strict compiler options for slice configs', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runPlatformContracts(root);
  assert.equal(report.findings.some((finding) => finding.code.startsWith('tsconfig-strict')), false);
  assert.equal(report.findings.some((finding) => finding.code === 'tsconfig-module-resolution'), false);
});

test('rejects CRA commands and downgraded modern toolchain dependencies', async (t) => {
  const packageJson = {
    private: true,
    type: 'module',
    dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0', bootstrap: '^4.6.2', 'react-scripts': '^5.0.1' },
    devDependencies: { typescript: '^6.0.0', vite: '^7.0.0', vitest: '^4.0.0', oxlint: '^1.0.0', '@vitejs/plugin-react': '^5.0.0' },
    engines: { node: '>=22', npm: '>=10' },
    scripts: {
      dev: 'react-scripts start',
      build: 'react-scripts build',
      'build:verify': 'node scripts/verify-build.mjs',
      lint: 'oxlint src',
      'lint:strict': 'oxlint --deny-warnings src',
      'test:ci': 'vitest run',
      typecheck: 'tsc -p tsconfig.json && tsc -p tsconfig.platform.json && tsc -p tsconfig.gis.json && tsc -p tsconfig.experience.json && tsc -p tsconfig.data-search.json',
      verify: 'npm run typecheck',
    },
  };
  const root = await fixture({ 'Webclient.app/package.json': JSON.stringify(packageJson) });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runPlatformContracts(root);
  const codes = new Set(report.findings.map((finding) => finding.code));
  assert.ok(codes.has('cra-script'));
  assert.ok(codes.has('legacy-build-dependency'));
  assert.ok(codes.has('dependency-react-version'));
  assert.ok(codes.has('dev-dependency-typescript-version'));
  assert.ok(codes.has('engine-node-version'));
  assert.equal(report.summary.passed, false);
});

test('rejects Platform TypeScript boundary when allowJs is not explicitly disabled', async (t) => {
  const root = await fixture({
    'Webclient.app/tsconfig.platform.json': JSON.stringify({
      extends: './tsconfig.json',
      include: ['src/platform/**/*.ts'],
    }),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runPlatformContracts(root);
  assert.ok(report.findings.some((finding) => finding.code === 'tsconfig-platform-allow-js'));
  assert.equal(report.summary.passed, false);
});

test('requires module graph and language ratchet scripts in the web quality surface', async (t) => {
  const packageJson = JSON.parse((await fs.readFile(
    path.join(await fixture(), 'Webclient.app/package.json'),
    'utf8',
  )));
  delete packageJson.scripts['quality:module-graph'];
  delete packageJson.scripts['quality:language-ratchet'];
  delete packageJson.scripts['quality:platform-boundaries'];
  delete packageJson.scripts['quality:browser-runtime'];
  const root = await fixture({
    'Webclient.app/package.json': JSON.stringify(packageJson),
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await runPlatformContracts(root);
  const codes = report.findings
    .filter((finding) => finding.code === 'webclient-script-missing')
    .map((finding) => finding.detail?.script)
    .filter(Boolean);
  assert.ok(codes.includes('quality:module-graph'));
  assert.ok(codes.includes('quality:language-ratchet'));
  assert.ok(codes.includes('quality:platform-boundaries'));
  assert.ok(codes.includes('quality:browser-runtime'));
  assert.equal(report.summary.passed, false);
});


test('package quality commands inspect the actual repository when invoked from Webclient.app', async () => {
  const run = promisify(execFile);
  const root = path.resolve(import.meta.dirname, '..');
  for (const name of ['platform-language-ratchet', 'platform-module-graph', 'platform-boundary-audit', 'browser-runtime-boundary']) {
    const { stdout } = await run(process.execPath, [path.join(root, 'tools', name + '.mjs'), '--strict'], { cwd: path.join(root, 'Webclient.app'), maxBuffer: 2 * 1024 * 1024 });
    const summary = JSON.parse(stdout);
    assert.equal(summary.passed, true, name);
    if (name === 'platform-module-graph') assert.ok(summary.productionFiles > 100, 'empty module inventory must not pass');
    if (name === 'platform-language-ratchet') assert.ok(summary.productionTypescriptFiles > 100, 'empty language inventory must not pass');
    if (name === 'browser-runtime-boundary') assert.ok(summary.productionFiles > 100, 'empty browser inventory must not pass');
    if (name === 'platform-boundary-audit') assert.ok(summary.platformProductionEdges > 0, 'empty platform inventory must not pass');
  }
});
