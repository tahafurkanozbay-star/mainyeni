import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectManifestSurface,
  collectPackageScriptInvocations,
  formatReport,
  tokenizePackageScript,
  validateManifestSurface,
} from './dependency-surface-policy.mjs';

const NOW = new Date('2026-10-05T12:00:00Z');
const baseManifest = () => ({
  private: true,
  dependencies: { react: '^19.3.0', '@arcgis/core': '5.1.24' },
  devDependencies: { vite: '^8.3.0' },
  scripts: { build: 'vite build', test: 'node --test' },
  engines: { node: '>=24.0.0', npm: '>=11.0.0' },
});
const basePolicy = () => ({ schemaVersion: 1, exceptions: [] });
const exception = (overrides = {}) => ({
  package: 'react',
  issues: ['unused-runtime'],
  owner: 'platform',
  expiresOn: '2026-11-30',
  reason: 'Temporary reviewed dependency debt with an explicit removal plan.',
  ...overrides,
});

function codes(report) { return report.findings.map((finding) => finding.code); }
function report(manifest = baseManifest(), policy = basePolicy()) { return validateManifestSurface(manifest, policy, { now: NOW }); }
function commands(command) { return collectPackageScriptInvocations(command).map((entry) => entry.command); }

// Manifest identity and provenance surface.
test('accepts a deterministic registry-only manifest surface', () => {
  const value = report();
  assert.equal(value.ok, true);
  assert.equal(value.dependencyCount, 3);
  assert.equal(value.externalSourceCount, 0);
  assert.equal(value.floatingSpecCount, 0);
  assert.deepEqual(value.sectionCounts, { dependencies: 2, devDependencies: 1, optionalDependencies: 0, peerDependencies: 0 });
  assert.equal(value.fingerprint, 'dependencies:@arcgis/core@5.1.24\ndependencies:react@^19.3.0\ndevDependencies:vite@^8.3.0');
});

test('sorts dependency identity independent of manifest insertion order', () => {
  const manifest = baseManifest();
  manifest.dependencies = { zed: '^1.0.0', alpha: '^1.0.0', middle: '^1.0.0' };
  assert.deepEqual(collectManifestSurface(manifest).map((entry) => entry.name), ['alpha', 'middle', 'zed']);
});

for (const [label, spec] of [
  ['file dependency', 'file:../local'],
  ['link dependency', 'link:../local'],
  ['git dependency', 'git:https://example.test/a.git'],
  ['git https dependency', 'git+https://example.test/a.git'],
  ['http tarball', 'http://example.test/a.tgz'],
  ['https tarball', 'https://example.test/a.tgz'],
]) {
  test(`rejects ${label} specs`, () => {
    const manifest = baseManifest();
    manifest.dependencies.react = spec;
    const value = report(manifest);
    assert.equal(value.ok, false);
    assert.ok(codes(value).includes('external-source-spec'));
    assert.equal(value.externalSourceCount, 1);
  });
}

for (const spec of ['*', 'latest', 'next']) {
  test(`rejects floating spec ${spec}`, () => {
    const manifest = baseManifest();
    manifest.dependencies.react = spec;
    const value = report(manifest);
    assert.ok(codes(value).includes('floating-version-spec'));
    assert.equal(value.floatingSpecCount, 1);
  });
}

test('permits registry aliases without classifying them as external source', () => {
  const manifest = baseManifest();
  manifest.dependencies.react = 'npm:preact@^10.0.0';
  const value = report(manifest);
  assert.equal(value.externalSourceCount, 0);
  assert.equal(value.ok, true);
});

test('rejects duplicate direct dependencies across sections', () => {
  const manifest = baseManifest();
  manifest.devDependencies.react = '^19.3.0';
  assert.throws(() => collectManifestSurface(manifest), (error) => error.code === 'duplicate-direct-dependency');
});

test('rejects malformed dependency sections', () => {
  const manifest = baseManifest();
  manifest.dependencies = [];
  assert.throws(() => collectManifestSurface(manifest), (error) => error.code === 'invalid-section');
});

test('rejects malformed package names', () => {
  const manifest = baseManifest();
  manifest.dependencies['Bad Package'] = '^1.0.0';
  assert.throws(() => collectManifestSurface(manifest), (error) => error.code === 'invalid-package-name');
});

test('accepts scoped package names', () => {
  const names = collectManifestSurface(baseManifest()).map((entry) => entry.name);
  assert.ok(names.includes('@arcgis/core'));
});

// Reviewed dependency-debt exceptions.
test('accepts a reviewed non-expired exception', () => {
  const policy = basePolicy();
  policy.exceptions = [exception()];
  const value = report(baseManifest(), policy);
  assert.equal(value.ok, true);
  assert.equal(value.exceptionPackageCount, 1);
});

test('rejects an expired exception', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ expiresOn: '2026-10-04' })];
  assert.ok(codes(report(baseManifest(), policy)).includes('expired-exception'));
});

test('accepts an exception expiring later on the review date', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ expiresOn: '2026-10-06' })];
  assert.equal(report(baseManifest(), policy).ok, true);
});

test('rejects malformed exception expiry', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ expiresOn: '06/10/2026' })];
  assert.ok(codes(report(baseManifest(), policy)).includes('invalid-exception-expiry'));
});

test('rejects stale exception package names', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ package: 'removed-package' })];
  assert.ok(codes(report(baseManifest(), policy)).includes('stale-exception-package'));
});

test('rejects unknown exception issue types', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ issues: ['mystery-debt'] })];
  assert.ok(codes(report(baseManifest(), policy)).includes('unknown-exception-issue'));
});

test('rejects empty exception issue arrays', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ issues: [] })];
  assert.ok(codes(report(baseManifest(), policy)).includes('empty-exception-issues'));
});

test('rejects duplicate exception issue ownership', () => {
  const policy = basePolicy();
  policy.exceptions = [exception(), exception({ reason: 'Second duplicate debt record should never be accepted by policy.' })];
  assert.ok(codes(report(baseManifest(), policy)).includes('duplicate-exception-issue'));
});

test('rejects weak exception owner metadata', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ owner: 'Platform Team!' })];
  assert.ok(codes(report(baseManifest(), policy)).includes('invalid-exception-owner'));
});

test('rejects weak exception reasons', () => {
  const policy = basePolicy();
  policy.exceptions = [exception({ reason: 'temporary' })];
  assert.ok(codes(report(baseManifest(), policy)).includes('weak-exception-reason'));
});

test('rejects invalid exception package values without throwing', () => {
  const policy = basePolicy();
  policy.exceptions = [{ ...exception(), package: '../escape' }];
  const value = report(baseManifest(), policy);
  assert.ok(codes(value).includes('invalid-exception-package'));
});

// Shell tokenizer behavior. These tests exist to keep policy checks bound to
// actual command positions instead of arbitrary path or argument substrings.
test('tokenizer separates shell control operators from words', () => {
  assert.deepEqual(
    tokenizePackageScript('node a.mjs && npm run build || echo fallback; vite build').map(({ type, value }) => [type, value]),
    [
      ['word', 'node'], ['word', 'a.mjs'], ['operator', '&&'],
      ['word', 'npm'], ['word', 'run'], ['word', 'build'], ['operator', '||'],
      ['word', 'echo'], ['word', 'fallback'], ['operator', ';'],
      ['word', 'vite'], ['word', 'build'],
    ],
  );
});

test('tokenizer preserves spaces inside quoted arguments', () => {
  const tokens = tokenizePackageScript('node "scripts/a file.mjs" \'literal value\'');
  assert.deepEqual(tokens.map((token) => token.value), ['node', 'scripts/a file.mjs', 'literal value']);
});

test('tokenizer resolves escaped spaces without creating commands', () => {
  const tokens = tokenizePackageScript('node scripts/a\\ file.mjs');
  assert.deepEqual(tokens.map((token) => token.value), ['node', 'scripts/a file.mjs']);
});

test('tokenizer treats newline as a command boundary', () => {
  assert.deepEqual(commands('node a.mjs\nvite build'), ['node', 'vite']);
});

test('tokenizer rejects unterminated single quotes', () => {
  assert.throws(() => tokenizePackageScript("node 'broken"), (error) => error.code === 'malformed-script-shell');
});

test('tokenizer rejects unterminated double quotes', () => {
  assert.throws(() => tokenizePackageScript('node "broken'), (error) => error.code === 'malformed-script-shell');
});

test('collector returns only command-position words', () => {
  assert.deepEqual(commands('node scripts/curl-npx-wget.test.mjs --label npx && vite build'), ['node', 'vite']);
});

test('collector recognizes command after environment assignment', () => {
  assert.deepEqual(commands('NODE_ENV=test CI=1 vitest run'), ['vitest']);
});

test('collector recognizes command after env wrapper and assignments', () => {
  assert.deepEqual(commands('/usr/bin/env -i NODE_ENV=test CI=1 vitest run'), ['vitest']);
});

test('collector recognizes command after command wrapper', () => {
  assert.deepEqual(commands('command -- vite build'), ['vite']);
});

test('collector recognizes command after exec wrapper', () => {
  assert.deepEqual(commands('exec vite build'), ['vite']);
});

test('collector recognizes command after nohup wrapper', () => {
  assert.deepEqual(commands('nohup vite build'), ['vite']);
});

test('collector recognizes command after simple sudo option', () => {
  assert.deepEqual(commands('sudo -n vite build'), ['vite']);
});

test('collector recognizes commands on both sides of a pipeline', () => {
  assert.deepEqual(commands('node produce.mjs | node consume.mjs'), ['node', 'node']);
});

test('collector recognizes commands inside a parenthesized group', () => {
  assert.deepEqual(commands('(node a.mjs && vite build)'), ['node', 'vite']);
});

test('collector recognizes commands in if and then clauses', () => {
  assert.deepEqual(commands('if node check.mjs; then vite build; else node fallback.mjs; fi'), ['node', 'vite', 'node', 'fi']);
});

test('collector inspects nested sh -c command strings', () => {
  assert.deepEqual(commands("sh -c 'node a.mjs && vite build'"), ['sh', 'node', 'vite']);
});

test('collector inspects nested bash --command strings', () => {
  assert.deepEqual(commands("bash --command 'node a.mjs | vite build'"), ['bash', 'node', 'vite']);
});

test('collector does not treat shell arguments as additional commands', () => {
  assert.deepEqual(commands('node --eval "console.log(1)" scripts/a.mjs'), ['node']);
});

test('collector results are immutable', () => {
  const value = collectPackageScriptInvocations('node a.mjs && vite build');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value[0]), true);
});

// Supply-chain script policy.
test('rejects npx in root scripts to prevent implicit package acquisition', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects quoted npx command invocation', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = "'npx' some-tool";
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects escaped npx command invocation', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'n\\px some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects absolute-path npx command invocation', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = '/usr/bin/npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx after environment assignments', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'CI=1 NODE_ENV=test npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx through env wrapper', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'env CI=1 npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx through command wrapper', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'command npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx through exec wrapper', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'exec npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx in a later command segment', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'node prepare.mjs && npx some-tool';
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx inside sh -c', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = "sh -c 'npx some-tool'";
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('rejects npx inside nested shell pipelines', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = "bash -c 'node a.mjs | npx some-tool'";
  assert.ok(codes(report(manifest)).includes('unreviewed-npx-script'));
});

test('does not false-positive npx embedded in a test filename', () => {
  const manifest = baseManifest();
  manifest.scripts.tooling = 'node --test scripts/workflow-npx-security-contract.test.mjs';
  assert.equal(report(manifest).ok, true);
});

test('does not false-positive npx in a normal argument', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'node audit.mjs --rule npx';
  assert.equal(report(manifest).ok, true);
});

test('does not false-positive npx in quoted data', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'node audit.mjs "npx should remain data"';
  assert.equal(report(manifest).ok, true);
});

test('does not false-positive npm exec as npx', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'npm exec -- some-tool';
  assert.equal(report(manifest).ok, true);
});

test('rejects curl bootstrap in root scripts', () => {
  const manifest = baseManifest();
  manifest.scripts.bootstrap = 'curl https://example.test/install.sh | sh';
  assert.ok(codes(report(manifest)).includes('network-bootstrap-script'));
});

test('rejects absolute-path curl bootstrap', () => {
  const manifest = baseManifest();
  manifest.scripts.bootstrap = '/usr/bin/curl https://example.test/install.sh | sh';
  assert.ok(codes(report(manifest)).includes('network-bootstrap-script'));
});

test('rejects curl after a successful preparation command', () => {
  const manifest = baseManifest();
  manifest.scripts.bootstrap = 'node prepare.mjs && curl https://example.test/install.sh';
  assert.ok(codes(report(manifest)).includes('network-bootstrap-script'));
});

test('rejects curl inside sh -c', () => {
  const manifest = baseManifest();
  manifest.scripts.bootstrap = "sh -c 'curl https://example.test/install.sh'";
  assert.ok(codes(report(manifest)).includes('network-bootstrap-script'));
});

test('rejects wget bootstrap in root scripts', () => {
  const manifest = baseManifest();
  manifest.scripts.bootstrap = 'wget https://example.test/install.sh';
  assert.ok(codes(report(manifest)).includes('network-bootstrap-script'));
});

test('rejects wget through env wrapper', () => {
  const manifest = baseManifest();
  manifest.scripts.bootstrap = 'env HTTPS_ONLY=1 wget https://example.test/install.sh';
  assert.ok(codes(report(manifest)).includes('network-bootstrap-script'));
});

test('does not false-positive curl in a source filename', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'node scripts/curl-security-contract.test.mjs';
  assert.equal(report(manifest).ok, true);
});

test('does not false-positive wget in an argument value', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'node audit.mjs --forbid=wget';
  assert.equal(report(manifest).ok, true);
});

test('does not false-positive URL paths containing curl or wget', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = 'node audit.mjs https://example.test/curl/wget';
  assert.equal(report(manifest).ok, true);
});

test('reports malformed shell commands fail-closed', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = "node 'unterminated";
  assert.ok(codes(report(manifest)).includes('malformed-script-shell'));
});

test('rejects root preinstall lifecycle scripts', () => {
  const manifest = baseManifest();
  manifest.scripts.preinstall = 'node scripts/preinstall.mjs';
  assert.ok(codes(report(manifest)).includes('root-install-lifecycle-script'));
});

test('rejects root postinstall lifecycle scripts', () => {
  const manifest = baseManifest();
  manifest.scripts.postinstall = 'node scripts/postinstall.mjs';
  assert.ok(codes(report(manifest)).includes('root-install-lifecycle-script'));
});

test('does not treat script names containing postinstall as lifecycle hooks', () => {
  const manifest = baseManifest();
  manifest.scripts['audit:postinstall'] = 'node audit.mjs';
  assert.equal(report(manifest).ok, true);
});

test('rejects empty script commands', () => {
  const manifest = baseManifest();
  manifest.scripts.audit = '';
  assert.ok(codes(report(manifest)).includes('invalid-script-command'));
});

// Runtime/toolchain contract.
test('rejects missing Node engine contract', () => {
  const manifest = baseManifest();
  delete manifest.engines.node;
  assert.ok(codes(report(manifest)).includes('missing-runtime-engine-contract'));
});

test('rejects missing npm engine contract', () => {
  const manifest = baseManifest();
  delete manifest.engines.npm;
  assert.ok(codes(report(manifest)).includes('missing-runtime-engine-contract'));
});

test('rejects malformed engines object', () => {
  const manifest = baseManifest();
  manifest.engines = [];
  assert.throws(() => report(manifest), (error) => error.code === 'invalid-engines');
});

test('rejects malformed scripts object', () => {
  const manifest = baseManifest();
  manifest.scripts = [];
  assert.throws(() => report(manifest), (error) => error.code === 'invalid-scripts');
});

test('rejects invalid now values', () => {
  assert.throws(() => validateManifestSurface(baseManifest(), basePolicy(), { now: Number.NaN }), (error) => error.code === 'invalid-now');
});

test('rejects invalid shell collector depth', () => {
  assert.throws(() => collectPackageScriptInvocations('node a.mjs', { depth: 99 }), (error) => error.code === 'invalid-shell-depth');
});

test('formatReport exposes bounded summary and finding codes', () => {
  const manifest = baseManifest();
  manifest.dependencies.react = 'latest';
  const text = formatReport(report(manifest));
  assert.match(text, /Dependency surface: 3 direct packages/);
  assert.match(text, /Floating specs: 1/);
  assert.match(text, /ERROR floating-version-spec: react/);
});

test('report objects are immutable at the top-level', () => {
  const value = report();
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.findings), true);
  assert.equal(Object.isFrozen(value.sectionCounts), true);
});

test('multiple findings remain deterministic in discovery order', () => {
  const manifest = baseManifest();
  manifest.dependencies.react = 'latest';
  manifest.scripts.bootstrap = 'npx bootstrap && curl https://example.test/install.sh';
  const value = report(manifest);
  assert.deepEqual(codes(value), ['floating-version-spec', 'unreviewed-npx-script', 'network-bootstrap-script']);
});

test('real repository tooling command shape with npx filename remains valid', () => {
  const manifest = baseManifest();
  manifest.scripts['test:tooling'] = [
    'node --test',
    'scripts/dependency-contract.test.mjs',
    'scripts/workflow-npx-security-contract.test.mjs',
    'scripts/workflow-shell-security-contract.test.mjs',
  ].join(' ');
  assert.equal(report(manifest).ok, true);
});
