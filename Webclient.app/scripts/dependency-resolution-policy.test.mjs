import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeResolutionPolicy, formatResolutionReport, inspectResolvedUrl } from './dependency-resolution-policy.mjs';

const integrity = 'sha512-' + 'A'.repeat(86) + '==';
const tarball = (name, version = '1.2.3') => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
const entry = (name, version = '1.2.3', extra = {}) => ({ version, resolved: tarball(name, version), integrity, ...extra });
const lock = (packages = {}) => ({ lockfileVersion: 3, packages: { '': { name: 'webclient', version: '1.0.0' }, ...packages } });

const codes = (result) => result.issues.map((item) => item.code);

test('accepts registry npm tarballs over https', () => {
  assert.deepEqual(inspectResolvedUrl('https://registry.npmjs.org/react/-/react-19.3.0.tgz'), { ok: true, host: 'registry.npmjs.org' });
});

test('rejects missing resolution', () => assert.equal(inspectResolvedUrl('').reason, 'missing'));
test('rejects malformed resolution', () => assert.equal(inspectResolvedUrl('not a url').reason, 'invalid-url'));
test('rejects insecure http resolution', () => assert.equal(inspectResolvedUrl('http://registry.npmjs.org/a/-/a-1.0.0.tgz').reason, 'protocol:http:'));
test('rejects unapproved registry host', () => assert.equal(inspectResolvedUrl('https://evil.example/a/-/a-1.0.0.tgz').reason, 'host:evil.example'));
test('rejects embedded credentials', () => assert.equal(inspectResolvedUrl('https://u:p@registry.npmjs.org/a/-/a-1.0.0.tgz').reason, 'credentials'));
test('rejects query strings', () => assert.equal(inspectResolvedUrl('https://registry.npmjs.org/a/-/a-1.0.0.tgz?token=x').reason, 'query-or-fragment'));
test('rejects fragments', () => assert.equal(inspectResolvedUrl('https://registry.npmjs.org/a/-/a-1.0.0.tgz#x').reason, 'query-or-fragment'));
test('rejects non tarball paths', () => assert.equal(inspectResolvedUrl('https://registry.npmjs.org/a').reason, 'non-tarball-path'));
test('supports explicit registry allowlist', () => assert.equal(inspectResolvedUrl('https://npm.internal.example/a/-/a-1.0.0.tgz', ['npm.internal.example']).ok, true));

test('accepts a minimal healthy lock graph', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/react': entry('react', '19.3.0') }));
  assert.deepEqual(result.issues, []);
  assert.equal(result.packageCount, 1);
  assert.deepEqual(result.duplicatePackages, []);
  assert.deepEqual(result.allowedRegistryHosts, ['registry.npmjs.org']);
  assert.match(result.fingerprints[0], /^react@19\.3\.0\|registry\.npmjs\.org\|noscript$/);
});

test('accepts scoped package paths', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/@scope/pkg': entry('@scope/pkg') }));
  assert.deepEqual(result.issues, []);
  assert.match(result.fingerprints[0], /^@scope\/pkg@1\.2\.3/);
});

test('accepts nested package paths and derives the nested package name', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a/node_modules/b': entry('b') }));
  assert.deepEqual(result.issues, []);
  assert.match(result.fingerprints[0], /^b@1\.2\.3/);
});

test('rejects malformed scoped package path', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/@scope': entry('scope') }));
  assert.ok(codes(result).includes('package-path-invalid'));
});

test('rejects non-object package entries', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a': 'bad' }));
  assert.ok(codes(result).includes('package-entry-invalid'));
});

test('requires lockfile packages object', () => {
  const result = analyzeResolutionPolicy({ lockfileVersion: 3 });
  assert.deepEqual(codes(result), ['lockfile-packages-missing']);
  assert.equal(result.packageCount, 0);
});

test('rejects array packages container', () => assert.deepEqual(codes(analyzeResolutionPolicy({ packages: [] })), ['lockfile-packages-missing']));

test('requires concrete semantic version', () => {
  for (const version of ['', 'latest', '^1.2.3', 'v1', '1.2', '01.2.3']) {
    const result = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a', version || '1.2.3', { version }) }));
    assert.ok(codes(result).includes('version-not-concrete-semver'), version);
  }
});

test('accepts prerelease and build semantic versions', () => {
  for (const version of ['1.2.3-beta.1', '1.2.3+build.7', '0.0.0']) {
    assert.deepEqual(analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a', version) })).issues, []);
  }
});

test('requires strong integrity metadata', () => {
  for (const bad of [undefined, '', 'md5-abc', 'sha1-abc', 'sha512-!bad']) {
    const candidate = entry('a');
    if (bad === undefined) delete candidate.integrity; else candidate.integrity = bad;
    assert.ok(codes(analyzeResolutionPolicy(lock({ 'node_modules/a': candidate }))).includes('integrity-invalid'));
  }
});

test('accepts sha256 sha384 and sha512 integrity algorithms', () => {
  for (const algorithm of ['sha256', 'sha384', 'sha512']) {
    const candidate = entry('a', '1.2.3', { integrity: `${algorithm}-QUJDRA==` });
    assert.deepEqual(analyzeResolutionPolicy(lock({ 'node_modules/a': candidate })).issues, []);
  }
});

test('rejects linked packages', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a', '1.2.3', { link: true }) }));
  assert.ok(codes(result).includes('linked-package-forbidden'));
});

test('rejects bundled package metadata', () => {
  const first = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a', '1.2.3', { bundled: true }) }));
  const second = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a', '1.2.3', { inBundle: true }) }));
  assert.ok(codes(first).includes('bundled-package-forbidden'));
  assert.ok(codes(second).includes('bundled-package-forbidden'));
});

test('enforces package-count budget', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a'), 'node_modules/b': entry('b') }), { maxPackageCount: 1 });
  assert.ok(codes(result).includes('package-count-budget'));
});

test('reports duplicate package versions deterministically', () => {
  const result = analyzeResolutionPolicy(lock({
    'node_modules/a': entry('a', '1.0.0'),
    'node_modules/x/node_modules/a': entry('a', '2.0.0'),
    'node_modules/y/node_modules/a': entry('a', '3.0.0'),
  }));
  assert.deepEqual(result.duplicatePackages, ['a']);
  assert.equal(codes(result).includes('duplicate-version-budget'), false);
});

test('enforces duplicate version budget', () => {
  const result = analyzeResolutionPolicy(lock({
    'node_modules/a': entry('a', '1.0.0'),
    'node_modules/x/node_modules/a': entry('a', '2.0.0'),
  }), { maxDuplicateVersions: 1 });
  assert.ok(codes(result).includes('duplicate-version-budget'));
  assert.match(result.issues.find((item) => item.code === 'duplicate-version-budget').detail, /1\.0\.0,2\.0\.0/);
});

test('does not count repeated same version as duplicate-version pressure', () => {
  const result = analyzeResolutionPolicy(lock({
    'node_modules/a': entry('a', '1.0.0'),
    'node_modules/x/node_modules/a': entry('a', '1.0.0'),
  }), { maxDuplicateVersions: 1 });
  assert.equal(codes(result).includes('duplicate-version-budget'), false);
});

test('sorts findings independently of lockfile insertion order', () => {
  const left = analyzeResolutionPolicy(lock({
    'node_modules/b': { version: 'bad' },
    'node_modules/a': { version: 'bad' },
  }));
  const right = analyzeResolutionPolicy(lock({
    'node_modules/a': { version: 'bad' },
    'node_modules/b': { version: 'bad' },
  }));
  assert.deepEqual(left.issues, right.issues);
  assert.deepEqual(left.fingerprints, right.fingerprints);
});

test('fingerprints distinguish install-script exposure', () => {
  const clean = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a') }));
  const scripted = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a', '1.2.3', { hasInstallScript: true }) }));
  assert.match(clean.fingerprints[0], /noscript$/);
  assert.match(scripted.fingerprints[0], /script$/);
});

test('reports every independent provenance defect', () => {
  const result = analyzeResolutionPolicy(lock({
    'node_modules/a': { version: 'latest', resolved: 'http://evil.example/a.tgz', integrity: 'sha1-x', link: true, bundled: true },
  }));
  assert.deepEqual(new Set(codes(result)), new Set([
    'version-not-concrete-semver', 'linked-package-forbidden', 'bundled-package-forbidden', 'resolution-provenance', 'integrity-invalid',
  ]));
});

test('formats passing report', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a') }));
  assert.equal(formatResolutionReport(result), 'dependency resolution policy: PASS\npackages=1\nduplicatePackages=0');
});

test('formats failing report with stable location', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a': { version: '1.0.0' } }));
  const report = formatResolutionReport(result);
  assert.match(report, /^dependency resolution policy: FAIL/m);
  assert.match(report, /integrity-invalid: node_modules\/a: missing/);
  assert.match(report, /resolution-provenance: node_modules\/a: missing/);
});

test('does not mutate caller lockfile', () => {
  const candidate = lock({ 'node_modules/a': entry('a') });
  const before = JSON.stringify(candidate);
  analyzeResolutionPolicy(candidate);
  assert.equal(JSON.stringify(candidate), before);
});

test('freezes public collections', () => {
  const result = analyzeResolutionPolicy(lock({ 'node_modules/a': entry('a') }));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issues), true);
  assert.equal(Object.isFrozen(result.fingerprints), true);
  assert.equal(Object.isFrozen(result.duplicatePackages), true);
});

test('custom registry allowlist is sorted in snapshot', () => {
  const result = analyzeResolutionPolicy(lock({
    'node_modules/a': { version: '1.0.0', resolved: 'https://z.example/a/-/a-1.0.0.tgz', integrity },
  }), { allowedRegistryHosts: ['z.example', 'a.example'] });
  assert.deepEqual(result.allowedRegistryHosts, ['a.example', 'z.example']);
  assert.deepEqual(result.issues, []);
});

test('registry host matching is exact rather than suffix based', () => {
  const result = inspectResolvedUrl('https://registry.npmjs.org.evil.example/a/-/a-1.0.0.tgz');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'host:registry.npmjs.org.evil.example');
});

test('root metadata is excluded from package count and provenance checks', () => {
  const result = analyzeResolutionPolicy(lock());
  assert.equal(result.packageCount, 0);
  assert.deepEqual(result.issues, []);
});
