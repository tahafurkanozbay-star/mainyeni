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

test('Platform test TypeScript project is strict, curated and rejects JavaScript admission', async () => {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'tsconfig.platform-tests.json'), 'utf8'));
  assert.equal(config.compilerOptions?.allowJs, false);
  assert.equal(config.compilerOptions?.checkJs, false);
  assert.equal(config.compilerOptions?.strict, true);
  assert.deepEqual(config.compilerOptions?.types, ['vitest/globals', 'vite/client']);
  assert.ok(Array.isArray(config.include));
  assert.ok(config.include.length > 0);
  assert.equal(new Set(config.include).size, config.include.length, 'strict Platform test includes must be unique');
  for (const entry of config.include) {
    assert.match(entry, /^src\/platform\/.+\.(?:test|spec)\.tsx?$/u, `invalid strict Platform test include: ${entry}`);
    assert.equal(await exists(path.join(ROOT, 'Webclient.app', entry)), true, `missing strict Platform test include: ${entry}`);
  }
  const requiredModernizationSuites = [
    'runtimeAdmissionController.test.ts',
    'runtimeBackpressureCoordinator.test.ts',
    'runtimeCapacityHealth.integration.test.ts',
    'runtimeCapacityReservationPool.test.ts',
    'runtimeConcurrencyGovernor.test.ts',
    'runtimeDegradationController.test.ts',
    'runtimeFailureBudget.test.ts',
    'runtimeFairShareAllocator.test.ts',
    'runtimeHealthEscalationMatrix.test.ts',
    'runtimeLoadWindow.test.ts',
    'runtimeOverloadGuard.test.ts',
    'runtimeQuarantineRegistry.test.ts',
    'runtimeRecoveryPlanner.test.ts',
    'runtimeSaturationLedger.test.ts',
  ].map((file) => `src/platform/runtime/${file}`);
  for (const required of requiredModernizationSuites) {
    assert.ok(config.include.includes(required), `modernized runtime suite escaped strict compilation: ${required}`);
  }
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

test('package verification pipeline keeps strict Platform compilation and tests wired', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'Webclient.app', 'package.json'), 'utf8'));
  assert.match(packageJson.scripts?.typecheck, /typecheck:platform/u);
  assert.match(packageJson.scripts?.typecheck, /typecheck:platform-tests/u);
  assert.match(packageJson.scripts?.verify, /npm run typecheck/u);
  assert.match(packageJson.scripts?.verify, /npm run test:ci/u);
  assert.equal(typeof packageJson.scripts?.['dependency:verify'], 'string');
});

test('Architecture Audit keeps cutover and architecture gates wired', async () => {
  const workflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'platform-architecture-audit.yml'), 'utf8');
  assert.match(workflow, /platform-ts-cutover\.test\.mjs/u);
  assert.match(workflow, /platform-language-ratchet\.mjs --strict/u);
  assert.match(workflow, /platform-boundary-audit\.mjs --strict/u);
});
