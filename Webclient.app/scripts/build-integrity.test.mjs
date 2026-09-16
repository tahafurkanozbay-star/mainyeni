import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(sriDigest('hello')).toBe(sriDigest(Buffer.from('hello')));
    expect(sriDigest('hello')).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
    expect(sriDigest('hello')).not.toBe(sriDigest('world'));
  });

  test('sorts file entries before computing the bundle fingerprint', () => {
    const first = [
      { path: 'z.js', bytes: 1, integrity: sriDigest('z') },
      { path: 'a.js', bytes: 1, integrity: sriDigest('a') },
    ];
    const second = [...first].reverse();
    expect(bundleDigest(first)).toBe(bundleDigest(second));
    expect(createIntegrityManifest(first).files.map((file) => file.path)).toEqual(['a.js', 'z.js']);
  });

  test('generates and verifies a complete production manifest', async () => {
    const directory = await temporaryBuild();
    try {
      const manifest = await generateBuildIntegrityManifest(directory);
      expect(manifest.fileCount).toBe(3);
      expect(manifest.files.map((file) => file.path)).toEqual([
        'assets/app.css',
        'assets/app.js',
        'index.html',
      ]);

      const persisted = JSON.parse(await readFile(join(directory, INTEGRITY_MANIFEST_FILE), 'utf8'));
      expect(persisted.bundleIntegrity).toBe(manifest.bundleIntegrity);
      await expect(verifyBuildIntegrityManifest(directory, persisted)).resolves.toEqual([]);
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
      expect(errors.join('\n')).toMatch(/size changed|integrity changed/i);
      expect(errors.join('\n')).toMatch(/bundle integrity fingerprint/i);
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
      expect(errors).toContain('Unexpected build artifact missing from manifest: assets/late.js');
      expect(errors.join('\n')).toMatch(/artifact count mismatch/i);
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
      expect(errors).toContain('Manifest references missing build artifact: assets/app.css');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
