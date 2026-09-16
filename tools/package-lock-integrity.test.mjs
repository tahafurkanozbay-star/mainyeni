import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditPackageDirectory, compareManifestAndLock, findPackageDirectories, formatReport } from './package-lock-integrity.mjs';

test('reports lock-only root dependencies', () => {
  const findings = compareManifestAndLock(
    { dependencies: { react: '^17.0.1' } },
    { packages: { '': { dependencies: { react: '^17.0.1', 'react-app-polyfill': '^2.0.0' } } } },
  );
  assert.deepEqual(findings, [{ kind: 'lock-only-root-dependency', group: 'dependencies', name: 'react-app-polyfill', lockVersion: '^2.0.0' }]);
});

test('reports manifest-only and version drift independently', () => {
  const findings = compareManifestAndLock(
    { dependencies: { axios: '^1.12.0', react: '^19.0.0' } },
    { packages: { '': { dependencies: { axios: '^0.21.1' } } } },
  );
  assert.deepEqual(findings, [
    { kind: 'root-dependency-version-drift', group: 'dependencies', name: 'axios', manifestVersion: '^1.12.0', lockVersion: '^0.21.1' },
    { kind: 'manifest-only-root-dependency', group: 'dependencies', name: 'react', manifestVersion: '^19.0.0' },
  ]);
});

test('compares dependency groups without mixing production and development metadata', () => {
  const findings = compareManifestAndLock(
    { dependencies: { app: '1.0.0' }, devDependencies: { test: '2.0.0' } },
    { packages: { '': { dependencies: { app: '1.0.0' }, devDependencies: { test: '3.0.0' } } } },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].group, 'devDependencies');
  assert.equal(findings[0].name, 'test');
});

test('audits a real package directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-lock-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { a: '^1.0.0' } }));
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { a: '^1.0.0' } } } }));
  const audit = await auditPackageDirectory(root);
  assert.equal(audit.packageName, 'fixture');
  assert.equal(audit.lockfileVersion, 3);
  assert.deepEqual(audit.findings, []);
});

test('discovers package directories while skipping generated dependency trees', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kent-lock-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['app', 'node_modules/ignored']) {
    const target = path.join(root, directory);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'package.json'), '{}');
    await fs.writeFile(path.join(target, 'package-lock.json'), '{"packages":{"":{}}}');
  }
  const directories = await findPackageDirectories(root);
  assert.deepEqual(directories, [path.join(root, 'app')]);
});

test('formats a deterministic human-readable report', () => {
  const root = '/repo';
  const report = formatReport(root, [{
    directory: '/repo/web',
    packageName: 'web',
    lockfileVersion: 2,
    findings: [{ kind: 'lock-only-root-dependency', group: 'dependencies', name: 'legacy', lockVersion: '^1.0.0' }],
  }]);
  assert.equal(report.findingCount, 1);
  assert.match(report.markdown, /LOCK_ONLY dependencies: legacy@\^1\.0\.0/);
  assert.match(report.markdown, /Total findings: 1/);
});
