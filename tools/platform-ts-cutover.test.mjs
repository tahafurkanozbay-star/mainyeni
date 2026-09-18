import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const PLATFORM = path.join(ROOT, 'Webclient.app', 'src', 'platform');

const canonicalTypedModules = Object.freeze([
  'bootstrap/bootstrapApplication',
  'bootstrap/bootstrapCore',
  'bootstrap/bootstrapDiagnostics',
  'cache/requestCache',
  'config/runtimeConfig',
  'errors/appError',
  'http/fetchTransport',
  'http/httpClient',
  'http/networkDiagnostics',
  'http/requestCoordinator',
  'http/requestPolicy',
  'http/requestScheduler',
  'http/responseParser',
  'http/retryPolicy',
  'http/runtimeCapabilities',
  'network/endpointPolicy',
  'performance/performanceMonitor',
  'runtime/index',
  'runtime/runtimeKernel',
]);

const exists = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};

const walk = async (directory, files = []) => {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
};

const normalize = (value) => value.split(path.sep).join('/');

test('all migrated Platform runtime modules have one canonical TypeScript implementation', async () => {
  for (const stem of canonicalTypedModules) {
    const typed = path.join(PLATFORM, stem + '.ts');
    const legacy = path.join(PLATFORM, stem + '.js');
    assert.equal(await exists(typed), true, 'missing typed module: ' + normalize(typed));
    assert.equal(await exists(legacy), false, 'legacy shadow remains: ' + normalize(legacy));
  }
});

test('cutover module list contains no duplicate stems', () => {
  const unique = new Set(canonicalTypedModules);
  assert.equal(unique.size, canonicalTypedModules.length);
  assert.equal(canonicalTypedModules.length, 19);
});

test('Platform production JavaScript is reduced to the bounded bootstrap composition adapter', async () => {
  const files = await walk(PLATFORM);
  const productionJavascript = files
    .filter((file) => file.endsWith('.js'))
    .filter((file) => !/\.(?:test|spec|fixture|mock)\.js$/u.test(file))
    .map((file) => normalize(path.relative(ROOT, file)))
    .sort();

  assert.deepEqual(productionJavascript, []);
});

test('bootstrap composition is strict TypeScript and no longer depends on legacy CommonBusiness', async () => {
  const bootstrap = path.join(PLATFORM, 'bootstrap', 'bootstrapApplication.ts');
  const source = await fs.readFile(bootstrap, 'utf8');
  assert.match(source, /Business\/ConfigurationBusiness/u);
  assert.doesNotMatch(source, /Business\/CommonBusiness/u);
  assert.match(source, /Store\/Managers\/MapManager/u);
  assert.match(source, /network\/arcgisProxyPolicy/u);
  assert.match(source, /\.\/bootstrapDiagnostics/u);
  assert.match(source, /\.\/bootstrapCore/u);
});

test('Platform TypeScript project explicitly disables JavaScript admission', async () => {
  const config = JSON.parse(await fs.readFile(
    path.join(ROOT, 'Webclient.app', 'tsconfig.platform.json'),
    'utf8',
  ));
  assert.equal(config.compilerOptions?.allowJs, false);
  assert.equal(config.compilerOptions?.checkJs, false);
  assert.deepEqual(config.include, ['src/platform/**/*.ts']);
});

test('root TypeScript compatibility bridge may remain staged without weakening Platform boundary', async () => {
  const rootConfig = JSON.parse(await fs.readFile(
    path.join(ROOT, 'Webclient.app', 'tsconfig.json'),
    'utf8',
  ));
  const platformConfig = JSON.parse(await fs.readFile(
    path.join(ROOT, 'Webclient.app', 'tsconfig.platform.json'),
    'utf8',
  ));
  assert.equal(rootConfig.compilerOptions?.allowJs, true);
  assert.equal(platformConfig.compilerOptions?.allowJs, false);
});

test('Vite module resolution guard runs before legacy source transforms', async () => {
  const source = await fs.readFile(path.join(ROOT, 'Webclient.app', 'vite.config.ts'), 'utf8');
  const importIndex = source.indexOf("from './tooling/moduleResolutionGuard'");
  const pluginIndex = source.indexOf('moduleResolutionGuardPlugin()');
  const environmentIndex = source.indexOf('legacyEnvironmentGuardPlugin()');
  const jsxIndex = source.indexOf('legacyJsxPlugin()');

  assert.ok(importIndex >= 0, 'module resolution guard import missing');
  assert.ok(pluginIndex >= 0, 'module resolution guard plugin missing');
  assert.ok(environmentIndex > pluginIndex, 'environment guard must run after resolution guard');
  assert.ok(jsxIndex > pluginIndex, 'legacy JSX transform must run after resolution guard');
});

test('package verify pipeline contains every Platform modernization gate', async () => {
  const packageJson = JSON.parse(await fs.readFile(
    path.join(ROOT, 'Webclient.app', 'package.json'),
    'utf8',
  ));
  const scripts = packageJson.scripts || {};
  const requiredScripts = [
    'quality:module-graph',
    'quality:language-ratchet',
    'quality:platform-boundaries',
    'quality:browser-runtime',
  ];
  for (const name of requiredScripts) {
    assert.equal(typeof scripts[name], 'string', 'missing script: ' + name);
    assert.ok(scripts.verify.includes('npm run ' + name), 'verify pipeline missing: ' + name);
  }
});

test('language baseline permanently ratchets Platform production JavaScript to zero', async () => {
  const baseline = JSON.parse(await fs.readFile(
    path.join(ROOT, 'tools', 'platform-language-baseline.json'),
    'utf8',
  ));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.domains?.platform, 0);
  assert.deepEqual(baseline.platformLegacyAllowlist, []);
});

test('domains already migrated to TypeScript retain zero JavaScript budgets', async () => {
  const baseline = JSON.parse(await fs.readFile(
    path.join(ROOT, 'tools', 'platform-language-baseline.json'),
    'utf8',
  ));
  assert.equal(baseline.domains?.['web-root'], 0);
  assert.equal(baseline.domains?.core, 0);
  assert.equal(baseline.domains?.store, 0);
  assert.equal(baseline.domains?.['data-search'], 0);
  assert.equal(baseline.domains?.gis, 0);
});

test('every canonical cutover stem resolves to exactly one source candidate', async () => {
  for (const stem of canonicalTypedModules) {
    const directCandidates = [
      '.ts',
      '.tsx',
      '.mts',
      '.js',
      '.jsx',
      '.mjs',
    ].map((extension) => path.join(PLATFORM, stem + extension));

    const existing = [];
    for (const candidate of directCandidates) {
      if (await exists(candidate)) existing.push(normalize(path.relative(ROOT, candidate)));
    }

    assert.deepEqual(existing, [
      'Webclient.app/src/platform/' + stem + '.ts',
    ]);
  }
});

test('canonical typed modules contain no TypeScript diagnostic opt-out directives', async () => {
  for (const stem of canonicalTypedModules) {
    const source = await fs.readFile(path.join(PLATFORM, stem + '.ts'), 'utf8');
    assert.doesNotMatch(source, /@ts-(?:nocheck|ignore|expect-error)/u, stem);
  }
});

test('canonical typed modules contain no CommonJS export or require boundary', async () => {
  for (const stem of canonicalTypedModules) {
    const source = await fs.readFile(path.join(PLATFORM, stem + '.ts'), 'utf8');
    assert.doesNotMatch(source, /\brequire\s*\(/u, stem);
    assert.doesNotMatch(source, /\bmodule\.exports\b/u, stem);
  }
});

test('retired CRA and legacy transport dependencies cannot return', async () => {
  const packageJson = JSON.parse(await fs.readFile(
    path.join(ROOT, 'Webclient.app', 'package.json'),
    'utf8',
  ));
  for (const dependency of ['axios', 'crypto-js', 'web-vitals']) {
    assert.equal(packageJson.dependencies?.[dependency], undefined, dependency + ' must stay removed');
  }

  assert.equal(
    await exists(path.join(ROOT, 'Webclient.app', 'src', 'reportWebVitals.js')),
    false,
    'unused CRA reportWebVitals entry must stay removed',
  );

  const vite = await fs.readFile(path.join(ROOT, 'Webclient.app', 'vite.config.ts'), 'utf8');
  assert.doesNotMatch(vite, /['"]crypto-js['"]/u);
});

test('module graph, language ratchet, boundary and browser audits are present', async () => {
  const required = [
    'platform-module-graph.mjs',
    'platform-language-ratchet.mjs',
    'platform-boundary-audit.mjs',
    'browser-runtime-boundary.mjs',
  ];
  for (const file of required) {
    assert.equal(await exists(path.join(ROOT, 'tools', file)), true, 'missing audit: ' + file);
  }
});

test('Platform Architecture workflow executes all cutover audits and their unit tests', async () => {
  const workflow = await fs.readFile(
    path.join(ROOT, '.github', 'workflows', 'platform-architecture-audit.yml'),
    'utf8',
  );
  for (const file of [
    'tools/platform-module-graph.test.mjs',
    'tools/platform-language-ratchet.test.mjs',
    'tools/platform-boundary-audit.test.mjs',
    'tools/browser-runtime-boundary.test.mjs',
  ]) {
    assert.ok(workflow.includes(file), 'missing workflow test: ' + file);
  }
  for (const command of [
    'node tools/platform-module-graph.mjs --strict',
    'node tools/platform-language-ratchet.mjs --strict',
    'node tools/platform-boundary-audit.mjs --strict',
    'node tools/browser-runtime-boundary.mjs --strict',
  ]) {
    assert.ok(workflow.includes(command), 'missing workflow command: ' + command);
  }
});

test('cutover invariant test itself remains wired to Architecture Audit', async () => {
  const workflow = await fs.readFile(
    path.join(ROOT, '.github', 'workflows', 'platform-architecture-audit.yml'),
    'utf8',
  );
  assert.ok(workflow.includes('tools/platform-ts-cutover.test.mjs'));
});
