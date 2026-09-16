import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  INTEGRITY_MANIFEST_FILE,
  bundleDigest,
  createIntegrityManifest,
  generateBuildIntegrityManifest,
  sriDigest,
  verifyBuildIntegrityManifest,
} from './build-integrity.mjs';

const temporaryBuild = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kent-rehberi-build-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<script type="module" src="./assets/app.js"></script>');
  await writeFile(join(directory, 'assets', 'app.js'), 'console.log("app");');
  await writeFile(join(directory, 'assets', 'app.css'), 'body{margin:0}');
  return directory;
};

describe('build integrity manifest', () => {
  test('creates deterministic SRI digests', () => {
    assert.equal(sriDigest('hello'), sriDigest(Buffer.from('hello')));
    assert.match(sriDigest('hello'), /^sha384-[A-Za-z0-9+/]+=*$/);
    assert.notEqual(sriDigest('hello'), sriDigest('world'));
  });

  test('sorts file entries before computing the bundle fingerprint', () => {
    const first = [
      { path: 'z.js', bytes: 1, integrity: sriDigest('z') },
      { path: 'a.js', bytes: 1, integrity: sriDigest('a') },
    ];
    const second = [...first].reverse();
    assert.equal(bundleDigest(first), bundleDigest(second));
    assert.deepEqual(createIntegrityManifest(first).files.map((file) => file.path), ['a.js', 'z.js']);
  });

  test('generates and verifies a complete production manifest', async () => {
    const directory = await temporaryBuild();
    try {
      const manifest = await generateBuildIntegrityManifest(directory);
      assert.equal(manifest.fileCount, 3);
      assert.deepEqual(manifest.files.map((file) => file.path), [
        'assets/app.css',
        'assets/app.js',
        'index.html',
      ]);

      const persisted = JSON.parse(await readFile(join(directory, INTEGRITY_MANIFEST_FILE), 'utf8'));
      assert.equal(persisted.bundleIntegrity, manifest.bundleIntegrity);
      assert.deepEqual(await verifyBuildIntegrityManifest(directory, persisted), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('detects modified build files after the manifest was generated', async () => {
    const directory = await temporaryBuild();
    try {
      const manifest = await generateBuildIntegrityManifest(directory);
      await writeFile(join(directory, 'assets', 'app.js'), 'console.log("tampered");');
      const errors = await verifyBuildIntegrityManifest(directory, manifest);
      assert.match(errors.join('\n'), /size changed|integrity changed/i);
      assert.match(errors.join('\n'), /bundle integrity fingerprint/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('detects files added after manifest generation', async () => {
    const directory = await temporaryBuild();
    try {
      const manifest = await generateBuildIntegrityManifest(directory);
      await writeFile(join(directory, 'assets', 'late.js'), 'export const late = true;');
      const errors = await verifyBuildIntegrityManifest(directory, manifest);
      assert.ok(errors.includes('Unexpected build artifact missing from manifest: assets/late.js'));
      assert.match(errors.join('\n'), /artifact count mismatch/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('detects manifest references to removed artifacts', async () => {
    const directory = await temporaryBuild();
    try {
      const manifest = await generateBuildIntegrityManifest(directory);
      await rm(join(directory, 'assets', 'app.css'));
      const errors = await verifyBuildIntegrityManifest(directory, manifest);
      assert.ok(errors.includes('Manifest references missing build artifact: assets/app.css'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
