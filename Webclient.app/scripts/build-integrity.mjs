#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
export const INTEGRITY_MANIFEST_FILE = 'asset-integrity.json';
export const INTEGRITY_ALGORITHM = 'sha384';
export const INTEGRITY_SCHEMA_VERSION = 1;

const normalizePath = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '');

export const sriDigest = (content, algorithm = INTEGRITY_ALGORITHM) => {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return `${algorithm}-${createHash(algorithm).update(buffer).digest('base64')}`;
};

export const bundleDigest = (files, algorithm = INTEGRITY_ALGORITHM) => {
  const hash = createHash(algorithm);
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(file.integrity);
    hash.update('\n');
  }
  return `${algorithm}-${hash.digest('base64')}`;
};

export const createIntegrityManifest = (files) => {
  const normalized = [...files]
    .map((file) => Object.freeze({
      path: normalizePath(String(file.path)),
      bytes: Number(file.bytes),
      integrity: String(file.integrity),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return Object.freeze({
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    algorithm: INTEGRITY_ALGORITHM,
    fileCount: normalized.length,
    bundleIntegrity: bundleDigest(normalized),
    files: Object.freeze(normalized),
  });
};

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
};

export const inventoryBuildDirectory = async (buildDirectory) => {
  const files = (await walk(buildDirectory))
    .filter((file) => normalizePath(relative(buildDirectory, file)) !== INTEGRITY_MANIFEST_FILE)
    .sort();
  const inventory = [];
  for (const file of files) {
    const content = await readFile(file);
    inventory.push({
      path: normalizePath(relative(buildDirectory, file)),
      bytes: content.byteLength,
      integrity: sriDigest(content),
    });
  }
  return inventory;
};

export const generateBuildIntegrityManifest = async (buildDirectory) => {
  const inventory = await inventoryBuildDirectory(buildDirectory);
  if (inventory.length === 0) throw new Error('Production build contains no files to fingerprint.');
  const manifest = createIntegrityManifest(inventory);
  await writeFile(
    join(buildDirectory, INTEGRITY_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
};

export const verifyBuildIntegrityManifest = async (buildDirectory, manifest) => {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return ['Integrity manifest is not an object.'];
  if (manifest.schemaVersion !== INTEGRITY_SCHEMA_VERSION) {
    errors.push(`Integrity schema mismatch (${manifest.schemaVersion} != ${INTEGRITY_SCHEMA_VERSION}).`);
  }
  if (manifest.algorithm !== INTEGRITY_ALGORITHM) {
    errors.push(`Integrity algorithm mismatch (${manifest.algorithm} != ${INTEGRITY_ALGORITHM}).`);
  }
  if (!Array.isArray(manifest.files)) return [...errors, 'Integrity manifest files must be an array.'];

  const actual = createIntegrityManifest(await inventoryBuildDirectory(buildDirectory));
  const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));

  for (const path of [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort()) {
    const expected = expectedByPath.get(path);
    const current = actualByPath.get(path);
    if (!expected) {
      errors.push(`Unexpected build artifact missing from manifest: ${path}`);
      continue;
    }
    if (!current) {
      errors.push(`Manifest references missing build artifact: ${path}`);
      continue;
    }
    if (expected.bytes !== current.bytes) {
      errors.push(`Build artifact size changed: ${path} (${expected.bytes} != ${current.bytes}).`);
    }
    if (expected.integrity !== current.integrity) {
      errors.push(`Build artifact integrity changed: ${path}.`);
    }
  }

  if (manifest.fileCount !== actual.fileCount) {
    errors.push(`Build artifact count mismatch (${manifest.fileCount} != ${actual.fileCount}).`);
  }
  if (manifest.bundleIntegrity !== actual.bundleIntegrity) {
    errors.push('Bundle integrity fingerprint does not match emitted files.');
  }
  return errors;
};

const main = async () => {
  const projectRoot = resolve(dirname(CURRENT_FILE), '..');
  const buildDirectory = resolve(projectRoot, 'build');
  const manifest = await generateBuildIntegrityManifest(buildDirectory);
  console.log(`[build:integrity] Fingerprinted ${manifest.fileCount} production files.`);
  console.log(`[build:integrity] Bundle integrity: ${manifest.bundleIntegrity}`);
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  await main();
}
