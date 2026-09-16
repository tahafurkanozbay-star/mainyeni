import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectSbomComponents,
  createCycloneDxSbom,
  createReleaseManifest,
  packageNameFromLockPath,
  validateReleaseArtifacts,
  verifyReleaseManifestAssets,
} from './release-artifacts.mjs';

test('packageNameFromLockPath resolves scoped and nested npm packages', () => {
  assert.equal(packageNameFromLockPath('node_modules/react'), 'react');
  assert.equal(packageNameFromLockPath('node_modules/@vitejs/plugin-react'), '@vitejs/plugin-react');
  assert.equal(packageNameFromLockPath('node_modules/a/node_modules/b'), 'b');
  assert.equal(packageNameFromLockPath(''), null);
});

test('collectSbomComponents is deterministic and preserves runtime/dev scope', () => {
  const lockfile = {
    packages: {
      '': { name: 'webclient', version: '1.0.0' },
      'node_modules/react': { version: '19.3.0', integrity: 'sha512-cmVhY3Q=' },
      'node_modules/vitest': { version: '5.0.1', dev: true, integrity: 'sha512-dml0ZXN0' },
      'node_modules/fsevents': { version: '2.3.3', optional: true },
    },
  };

  const components = collectSbomComponents(lockfile);
  assert.deepEqual(
    components.map(({ name, version, scope }) => ({ name, version, scope })),
    [
      { name: 'fsevents', version: '2.3.3', scope: 'optional' },
      { name: 'react', version: '19.3.0', scope: 'required' },
      { name: 'vitest', version: '5.0.1', scope: 'excluded' },
    ],
  );
  assert.equal(components.find(({ name }) => name === 'react').hashes[0].alg, 'SHA-512');
});

test('release manifest fingerprints production assets and validates against the SBOM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kent-rehberi-release-'));
  try {
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><script type="module"></script>');
    await writeFile(join(directory, 'assets', 'app.js'), 'console.log("ok")');

    const packageJson = { name: 'webclient', version: '24.7.3.1' };
    const lockfile = {
      packages: {
        '': packageJson,
        'node_modules/react': { version: '19.3.0' },
      },
    };
    const generatedAt = '2026-09-16T00:00:00.000Z';
    const sourceRevision = '0123456789abcdef0123456789abcdef01234567';

    const releaseManifest = await createReleaseManifest({
      buildDirectory: directory,
      projectName: packageJson.name,
      projectVersion: packageJson.version,
      generatedAt,
      sourceRevision,
    });
    const sbom = createCycloneDxSbom({
      projectName: packageJson.name,
      projectVersion: packageJson.version,
      generatedAt,
      sourceRevision,
      lockfile,
    });

    assert.equal(releaseManifest.assetCount, 2);
    assert.equal(releaseManifest.assets[0].sha256.length, 64);
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.deepEqual(validateReleaseArtifacts({
      releaseManifest,
      sbom,
      packageJson,
      lockfile,
    }), []);
    assert.deepEqual(await verifyReleaseManifestAssets(directory, releaseManifest), []);

    await writeFile(join(directory, 'assets', 'app.js'), 'console.log("tampered")');
    assert.match(
      (await verifyReleaseManifestAssets(directory, releaseManifest)).join('\n'),
      /SHA-256 changed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
