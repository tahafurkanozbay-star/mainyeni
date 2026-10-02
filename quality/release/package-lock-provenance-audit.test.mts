import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildRepositoryInventory } from './inventory.mts';
import { auditPackageLockProvenance } from './package-lock-provenance-audit.mts';
import type { RepositoryInventory, SourceFile } from './contracts.mts';

const PACKAGE_PATH = 'Webclient.app/package-lock.json';

function source(text: string, repositoryPath = PACKAGE_PATH): SourceFile {
  return {
    absolutePath: `/repo/${repositoryPath}`,
    repositoryPath,
    extension: '.json',
    kind: 'json',
    bytes: text.length,
    lines: text.length === 0 ? 0 : text.split('\n').length,
    text,
  };
}

function inventory(text?: string): RepositoryInventory {
  const files = text === undefined ? [] : [source(text)];
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: files.length === 0 ? [] : [{ kind: 'json', files: 1, lines: files[0]!.lines, bytes: files[0]!.bytes }],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-10-02T00:00:00.000Z',
  };
}

function canonicalPackage(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    version: '1.2.3',
    resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
    integrity: 'sha512-YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==',
    license: 'MIT',
    ...overrides,
  };
}

function lockDocument(options: Readonly<{
  lockfileVersion?: number;
  root?: Readonly<Record<string, unknown>>;
  packages?: Readonly<Record<string, unknown>>;
}> = {}): string {
  const root = options.root ?? {
    name: 'webclient',
    version: '1.0.0',
    engines: { node: '>=24.0.0', npm: '>=11.0.0' },
    dependencies: { example: '^1.2.3' },
  };
  const packages = options.packages ?? { 'node_modules/example': canonicalPackage() };
  return JSON.stringify({
    name: 'webclient',
    version: '1.0.0',
    lockfileVersion: options.lockfileVersion ?? 3,
    requires: true,
    packages: { '': root, ...packages },
  }, null, 2);
}

function blockingIds(text: string): readonly string[] {
  return auditPackageLockProvenance(inventory(text)).findings
    .filter(finding => finding.blocking === true)
    .map(finding => finding.id);
}

function findingById(text: string, id: string) {
  return auditPackageLockProvenance(inventory(text)).findings.find(finding => finding.id === id);
}

test('canonical npm 11 lock provenance passes without blocking findings', () => {
  const report = auditPackageLockProvenance(inventory(lockDocument()));
  assert.equal(report.lockfileCount, 1);
  assert.equal(report.packageCount, 1);
  assert.equal(report.lockfiles[0]?.registryPackages, 1);
  assert.deepEqual(report.findings.filter(finding => finding.blocking === true), []);
});

test('missing Webclient lockfile fails closed', () => {
  const report = auditPackageLockProvenance(inventory());
  assert.deepEqual(report.findings.map(finding => finding.id), ['package-lock-required-lockfile-missing']);
  assert.equal(report.findings[0]?.severity, 'critical');
});

test('invalid lockfile JSON is blocking', () => {
  assert.ok(blockingIds('{ invalid json').includes('package-lock-json-invalid'));
});

test('npm lockfileVersion 2 is rejected by the Node 24/npm 11 release baseline', () => {
  assert.ok(blockingIds(lockDocument({ lockfileVersion: 2 })).includes('package-lock-version-unsupported'));
});

test('missing packages map is blocking', () => {
  const text = JSON.stringify({ lockfileVersion: 3, requires: true });
  assert.ok(blockingIds(text).includes('package-lock-packages-missing'));
});

test('root direct HTTPS dependency source is rejected', () => {
  const text = lockDocument({
    root: {
      name: 'webclient',
      engines: { node: '>=24.0.0', npm: '>=11.0.0' },
      dependencies: { example: 'https://example.com/example.tgz' },
    },
  });
  const item = findingById(text, 'package-lock-direct-source-specifier');
  assert.equal(item?.severity, 'critical');
  assert.equal(item?.blocking, true);
});

test('root git dependency source is rejected', () => {
  const text = lockDocument({
    root: {
      name: 'webclient',
      engines: { node: '>=24.0.0', npm: '>=11.0.0' },
      devDependencies: { example: 'git+ssh://git@example.com/repo.git' },
    },
  });
  assert.ok(blockingIds(text).includes('package-lock-direct-source-specifier'));
});

test('root local file dependency source is rejected', () => {
  const text = lockDocument({
    root: {
      name: 'webclient',
      engines: { node: '>=24.0.0', npm: '>=11.0.0' },
      optionalDependencies: { example: 'file:../example' },
    },
  });
  assert.ok(blockingIds(text).includes('package-lock-direct-source-specifier'));
});

test('Node engine below 24 is blocking', () => {
  const text = lockDocument({
    root: { name: 'webclient', engines: { node: '>=22', npm: '>=11' }, dependencies: { example: '^1.2.3' } },
  });
  assert.ok(blockingIds(text).includes('package-lock-node-engine-baseline'));
});

test('npm engine below 11 is blocking', () => {
  const text = lockDocument({
    root: { name: 'webclient', engines: { node: '>=24', npm: '>=10' }, dependencies: { example: '^1.2.3' } },
  });
  assert.ok(blockingIds(text).includes('package-lock-npm-engine-baseline'));
});

test('missing engine metadata fails closed', () => {
  const ids = blockingIds(lockDocument({ root: { name: 'webclient', dependencies: { example: '^1.2.3' } } }));
  assert.ok(ids.includes('package-lock-node-engine-baseline'));
  assert.ok(ids.includes('package-lock-npm-engine-baseline'));
});

test('local linked package is rejected', () => {
  const text = lockDocument({ packages: { 'node_modules/example': { link: true, resolved: '../example' } } });
  assert.ok(blockingIds(text).includes('package-lock-local-link'));
});

test('package key traversal is rejected', () => {
  const text = lockDocument({ packages: { 'node_modules/../escape': canonicalPackage() } });
  assert.ok(blockingIds(text).includes('package-lock-path-traversal'));
});

test('Windows-style package key is rejected', () => {
  const text = lockDocument({ packages: { 'node_modules\\example': canonicalPackage() } });
  assert.ok(blockingIds(text).includes('package-lock-path-traversal'));
});

test('missing immutable version is blocking', () => {
  const entry = canonicalPackage();
  const { version: _version, ...withoutVersion } = entry;
  const text = lockDocument({ packages: { 'node_modules/example': withoutVersion } });
  assert.ok(blockingIds(text).includes('package-lock-version-missing'));
});

test('missing resolved source is blocking', () => {
  const entry = canonicalPackage();
  const { resolved: _resolved, ...withoutResolved } = entry;
  const text = lockDocument({ packages: { 'node_modules/example': withoutResolved } });
  assert.ok(blockingIds(text).includes('package-lock-resolved-missing'));
});

test('plain non-URL resolved source is blocking', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ resolved: '../tarballs/example.tgz' }) } });
  assert.ok(blockingIds(text).includes('package-lock-source-non-url'));
});

test('HTTP registry source is blocking', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ resolved: 'http://registry.npmjs.org/example/-/example-1.2.3.tgz' }) } });
  assert.ok(blockingIds(text).includes('package-lock-source-insecure-protocol'));
});

test('unapproved HTTPS package host is blocking', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ resolved: 'https://cdn.example.com/example-1.2.3.tgz' }) } });
  const item = findingById(text, 'package-lock-source-unapproved-host');
  assert.equal(item?.blocking, true);
  assert.equal(item?.evidence?.metadata?.host, 'cdn.example.com');
});

test('credentials embedded in registry URL are blocking', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ resolved: 'https://token:secret@registry.npmjs.org/example/-/example-1.2.3.tgz' }) } });
  assert.ok(blockingIds(text).includes('package-lock-source-credentials'));
});

test('missing SRI integrity is blocking', () => {
  const entry = canonicalPackage();
  const { integrity: _integrity, ...withoutIntegrity } = entry;
  const text = lockDocument({ packages: { 'node_modules/example': withoutIntegrity } });
  assert.ok(blockingIds(text).includes('package-lock-integrity-missing'));
});

test('sha1 integrity is rejected', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ integrity: 'sha1-deadbeef' }) } });
  assert.ok(blockingIds(text).includes('package-lock-integrity-weak'));
});

test('sha256 integrity is treated as noncanonical for npm 11 release lock', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ integrity: 'sha256-YWJjZA==' }) } });
  assert.ok(blockingIds(text).includes('package-lock-integrity-noncanonical'));
});

test('install lifecycle scripts remain visible without becoming an automatic blocker', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ hasInstallScript: true }) } });
  const item = findingById(text, 'package-lock-install-script');
  assert.equal(item?.severity, 'medium');
  assert.equal(item?.blocking, false);
  assert.deepEqual(blockingIds(text), []);
});

test('non-object package entries fail closed', () => {
  const text = lockDocument({ packages: { 'node_modules/example': 'invalid' } });
  assert.ok(blockingIds(text).includes('package-lock-entry-invalid'));
});

test('summary separates reviewed registry packages from external sources', () => {
  const text = lockDocument({
    packages: {
      'node_modules/example': canonicalPackage(),
      'node_modules/external': canonicalPackage({ version: '2.0.0', resolved: 'https://packages.example.com/external-2.0.0.tgz' }),
    },
  });
  const report = auditPackageLockProvenance(inventory(text));
  assert.equal(report.lockfiles[0]?.packages, 2);
  assert.equal(report.lockfiles[0]?.registryPackages, 1);
  assert.equal(report.lockfiles[0]?.externalSources, 1);
});

test('summary counts missing and weak integrity independently', () => {
  const text = lockDocument({
    packages: {
      'node_modules/missing': { version: '1.0.0', resolved: 'https://registry.npmjs.org/missing/-/missing-1.0.0.tgz' },
      'node_modules/weak': canonicalPackage({ integrity: 'sha1-deadbeef' }),
    },
  });
  const signal = auditPackageLockProvenance(inventory(text)).lockfiles[0];
  assert.equal(signal?.missingIntegrity, 1);
  assert.equal(signal?.weakIntegrity, 1);
});

test('findings are deterministic across repeated audits', () => {
  const text = lockDocument({
    lockfileVersion: 2,
    packages: {
      'node_modules/z': canonicalPackage({ resolved: 'http://registry.npmjs.org/z/-/z-1.2.3.tgz' }),
      'node_modules/a': canonicalPackage({ integrity: 'sha1-deadbeef' }),
    },
  });
  const first = auditPackageLockProvenance(inventory(text)).findings.map(finding => ({ id: finding.id, severity: finding.severity, blocking: finding.blocking, location: finding.location, metadata: finding.evidence?.metadata }));
  const second = auditPackageLockProvenance(inventory(text)).findings.map(finding => ({ id: finding.id, severity: finding.severity, blocking: finding.blocking, location: finding.location, metadata: finding.evidence?.metadata }));
  assert.deepEqual(first, second);
});

test('canonical findings preserve package path evidence', () => {
  const text = lockDocument({ packages: { 'node_modules/example': canonicalPackage({ resolved: 'https://mirror.example.org/example.tgz' }) } });
  const item = findingById(text, 'package-lock-source-unapproved-host');
  assert.equal(item?.evidence?.metadata?.packagePath, 'node_modules/example');
  assert.equal(item?.location?.file, PACKAGE_PATH);
});

test('real Webclient lockfile has no blocking provenance findings', () => {
  const root = resolve(import.meta.dirname, '../..');
  const repository = buildRepositoryInventory({ root, maxTextBytes: 16 * 1024 * 1024, includeTests: true });
  const report = auditPackageLockProvenance(repository);
  const blocking = report.findings.filter(finding => finding.blocking === true);
  assert.equal(report.lockfileCount, 1, 'Webclient.app/package-lock.json must remain in release inventory');
  assert.deepEqual(blocking, [], blocking.map(finding => `${finding.id}: ${finding.message}`).join('\n'));
});
