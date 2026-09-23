import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const PLATFORM = path.join(ROOT, 'Webclient.app', 'src', 'platform');
const canonicalTypedModules = Object.freeze([
  'bootstrap/bootstrapApplication', 'bootstrap/bootstrapCore', 'bootstrap/bootstrapDiagnostics',
  'cache/requestCache', 'config/runtimeConfig', 'errors/appError', 'http/fetchTransport',
  'http/httpClient', 'http/networkDiagnostics', 'http/requestCoordinator', 'http/requestPolicy',
  'http/requestScheduler', 'http/responseParser', 'http/retryPolicy', 'http/runtimeCapabilities',
  'network/endpointPolicy', 'performance/performanceMonitor', 'runtime/index', 'runtime/runtimeKernel',
]);

const exists = async (file) => { try { return (await fs.stat(file)).isFile(); } catch { return false; } };
const walk = async (directory, files = []) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, files); else if (entry.isFile()) files.push(full);
  }
  return files;
};
const normalize = (value) => value.split(path.sep).join('/');

test('all migrated Platform runtime modules have one canonical TypeScript implementation', async () => {
  for (const stem of canonicalTypedModules) {
    assert.equal(await exists(path.join(PLATFORM, stem + '.ts')), true, 'missing typed module: ' + stem);
    assert.equal(await exists(path.join(PLATFORM, stem + '.js')), false, 'legacy shadow remains: ' + stem);
  }
});

test('cutover module list contains no duplicate stems', () => {
  assert.equal(new Set(canonicalTypedModules).size, canonicalTypedModules.length);
  assert.equal(canonicalTypedModules.length, 19);
});

test('Platform production JavaScript is fully eliminated', async () => {
  const files = await walk(PLATFORM);
  const productionJavascript = files
    .filter((file) => file.endsWith('.js'))
    .filter((file) => !/\.(?:test|spec|fixture|mock)\.js$/u.test(file))
    .map((file) => normalize(path.relative(ROOT, file))).sort();
  assert.deepEqual(productionJavascript, []);
});

test('typed bootstrap adapter remains the explicit application composition root', async () => {
  const bootstrap = path.join(PLATFORM, 'bootstrap', 'bootstrapApplication.ts');
  const source = await fs.readFile(bootstrap, 'utf8');
  assert.match(source, /Business\/ConfigurationBusiness/u);
  assert.match(source, /Business\/CommonBusiness/u);
  assert.match(source, /Store\/Managers\/MapManager/u);
  assert.match(source, /type BootstrapDependencies/u);
  assert.match(source, /applicationBootstrapDependencies: BootstrapDependencies/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /axios/u);
});

test('Platform TypeScript project explicitly disables JavaScript admission', async () => {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'tsconfig.platform.json'), 'utf8'));
  assert.equal(config.compilerOptions?.allowJs, false);
  assert.equal(config.compilerOptions?.checkJs, false);
  assert.deepEqual(config.include, ['src/platform/**/*.ts']);
});

test('Platform test JavaScript is fully eliminated and permanently ratcheted to zero', async () => {
  const files = await walk(PLATFORM);
  const testJavascript = files
    .filter((file) => /\.(?:test|spec)\.js$/u.test(file))
    .map((file) => normalize(path.relative(ROOT, file)))
    .sort();
  assert.deepEqual(testJavascript, []);
  const baseline = JSON.parse(await fs.readFile(path.join(ROOT, 'tools', 'platform-language-baseline.json'), 'utf8'));
  assert.equal(baseline.testDomains?.platform, 0);
});

test('Platform test TypeScript project is strict, complete and rejects JavaScript admission', async () => {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'tsconfig.platform-tests.json'), 'utf8'));
  assert.equal(config.compilerOptions?.allowJs, false);
  assert.equal(config.compilerOptions?.strict, true);
  assert.deepEqual(config.compilerOptions?.types, ['vitest/globals', 'vite/client']);
  const platformTests = (await walk(PLATFORM))
    .filter((file) => /\.(?:test|spec)\.tsx?$/u.test(file))
    .map((file) => normalize(path.relative(path.join(ROOT, 'Webclient.app'), file)))
    .sort();
  assert.deepEqual([...config.include].sort(), platformTests);
});

test('root compatibility bridge does not weaken Platform boundary', async () => {
  const rootConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'tsconfig.json'), 'utf8'));
  const platformConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'tsconfig.platform.json'), 'utf8'));
  assert.equal(rootConfig.compilerOptions?.allowJs, true);
  assert.equal(platformConfig.compilerOptions?.allowJs, false);
});

test('language baseline permanently ratchets Platform production JavaScript to zero', async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(ROOT, 'tools', 'platform-language-baseline.json'), 'utf8'));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.domains?.platform, 0);
  assert.deepEqual(baseline.platformLegacyAllowlist, []);
});

test('every canonical cutover stem resolves to exactly one source candidate', async () => {
  for (const stem of canonicalTypedModules) {
    const candidates = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'].map((extension) => path.join(PLATFORM, stem + extension));
    const existing = [];
    for (const candidate of candidates) if (await exists(candidate)) existing.push(normalize(path.relative(ROOT, candidate)));
    assert.deepEqual(existing, ['Webclient.app/src/platform/' + stem + '.ts']);
  }
});

test('canonical typed modules contain no TypeScript opt-outs or CommonJS runtime boundary', async () => {
  for (const stem of canonicalTypedModules) {
    const source = await fs.readFile(path.join(PLATFORM, stem + '.ts'), 'utf8');
    assert.doesNotMatch(source, /@ts-(?:nocheck|ignore|expect-error)/u, stem);
    assert.doesNotMatch(source, /\brequire\s*\(/u, stem);
    assert.doesNotMatch(source, /\bmodule\.exports\b/u, stem);
  }
});

test('package verify pipeline contains every Platform modernization gate', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'package.json'), 'utf8'));
  for (const name of ['quality:module-graph', 'quality:language-ratchet', 'quality:platform-boundaries', 'quality:browser-runtime']) {
    assert.equal(typeof packageJson.scripts?.[name], 'string', 'missing script: ' + name);
    assert.ok(packageJson.scripts.verify.includes('npm run ' + name), 'verify pipeline missing: ' + name);
  }
});

test('Architecture Audit keeps cutover and architecture gates wired', async () => {
  const workflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'platform-architecture-audit.yml'), 'utf8');
  for (const token of ['tools/platform-ts-cutover.test.mjs', 'tools/platform-module-graph.test.mjs', 'tools/platform-language-ratchet.test.mjs', 'tools/platform-boundary-audit.test.mjs', 'tools/browser-runtime-boundary.test.mjs']) {
    assert.ok(workflow.includes(token), 'missing workflow gate: ' + token);
  }
});
