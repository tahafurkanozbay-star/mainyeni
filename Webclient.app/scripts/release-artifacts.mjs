#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
export const RELEASE_MANIFEST_FILE = 'release-manifest.json';
export const SBOM_FILE = 'sbom.cdx.json';
export const RELEASE_SCHEMA_VERSION = 1;
export const CYCLONEDX_SPEC_VERSION = '1.6';

const normalizePath = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '');

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

export const sha256Hex = (content) => createHash('sha256').update(content).digest('hex');

export const packageNameFromLockPath = (lockPath) => {
  const normalized = normalizePath(lockPath);
  const marker = 'node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return null;
  const suffix = normalized.slice(index + marker.length);
  if (!suffix) return null;
  const segments = suffix.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[0]?.startsWith('@') && segments.length >= 2
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
};

const componentRef = (name, version, scope) => `npm:${name}@${version}:${scope}`;

const integrityHash = (integrity) => {
  if (typeof integrity !== 'string') return null;
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/i.exec(token);
    if (!match) continue;
    const algorithm = {
      sha1: 'SHA-1',
      sha256: 'SHA-256',
      sha384: 'SHA-384',
      sha512: 'SHA-512',
    }[match[1].toLowerCase()];
    if (!algorithm) continue;
    try {
      const content = Buffer.from(match[2], 'base64').toString('hex');
      if (content) return { alg: algorithm, content };
    } catch {
      return null;
    }
  }
  return null;
};

export const collectSbomComponents = (lockfile) => {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== 'object') return [];

  const components = [];
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (!lockPath || !metadata || typeof metadata !== 'object') continue;
    const name = packageNameFromLockPath(lockPath);
    const version = typeof metadata.version === 'string' ? metadata.version : null;
    if (!name || !version) continue;

    let scope = metadata.dev === true ? 'excluded' : 'required';
    if (metadata.optional === true) scope = 'optional';
    const component = {
      type: 'library',
      name,
      version,
      'bom-ref': componentRef(name, version, scope),
      scope,
    };
    const hash = integrityHash(metadata.integrity);
    if (hash) component.hashes = [hash];
    components.push(component);
  }

  const unique = new Map();
  for (const component of components) {
    const key = `${component.name}@${component.version}:${component.scope}`;
    if (!unique.has(key)) unique.set(key, component);
  }
  return [...unique.values()].sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version)
    || left.scope.localeCompare(right.scope)
  ));
};

const resolveSourceRevision = (projectRoot) => {
  const candidates = [
    process.env.GITHUB_SHA,
    process.env.VITE_GIT_SHA,
    process.env.SOURCE_REVISION,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const normalized = String(candidate).trim();
    if (/^[0-9a-f]{7,64}$/i.test(normalized)) return normalized.toLowerCase();
  }

  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
};

export const resolveGeneratedAt = () => {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isFinite(sourceDateEpoch) && sourceDateEpoch >= 0) {
    return new Date(sourceDateEpoch * 1000).toISOString();
  }
  return new Date().toISOString();
};

export const inventoryReleaseAssets = async (buildDirectory) => {
  const excluded = new Set([RELEASE_MANIFEST_FILE, SBOM_FILE, 'asset-integrity.json']);
  const emittedFiles = (await walk(buildDirectory))
    .filter((file) => !excluded.has(normalizePath(relative(buildDirectory, file))))
    .sort();

  const assets = [];
  for (const file of emittedFiles) {
    const content = await readFile(file);
    assets.push({
      path: normalizePath(relative(buildDirectory, file)),
      bytes: content.byteLength,
      sha256: sha256Hex(content),
    });
  }
  return assets;
};

export const createReleaseManifest = async ({
  buildDirectory,
  projectName,
  projectVersion,
  generatedAt,
  sourceRevision,
}) => {
  const assets = await inventoryReleaseAssets(buildDirectory);

  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    application: {
      name: projectName,
      version: projectVersion,
    },
    build: {
      generatedAt,
      sourceRevision,
      nodeVersion: process.version,
    },
    assetCount: assets.length,
    assets,
  };
};

export const verifyReleaseManifestAssets = async (buildDirectory, releaseManifest) => {
  const errors = [];
  if (!releaseManifest || !Array.isArray(releaseManifest.assets)) {
    return ['Release manifest asset inventory is missing.'];
  }
  const actual = await inventoryReleaseAssets(buildDirectory);
  const expectedByPath = new Map(releaseManifest.assets.map((asset) => [asset.path, asset]));
  const actualByPath = new Map(actual.map((asset) => [asset.path, asset]));

  for (const path of [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort()) {
    const expected = expectedByPath.get(path);
    const current = actualByPath.get(path);
    if (!expected) {
      errors.push(`Unexpected production asset missing from release manifest: ${path}`);
      continue;
    }
    if (!current) {
      errors.push(`Release manifest references missing production asset: ${path}`);
      continue;
    }
    if (expected.bytes !== current.bytes) {
      errors.push(`Release asset size changed: ${path} (${expected.bytes} != ${current.bytes}).`);
    }
    if (expected.sha256 !== current.sha256) {
      errors.push(`Release asset SHA-256 changed: ${path}.`);
    }
  }

  if (releaseManifest.assetCount !== actual.length) {
    errors.push(`Release asset count mismatch (${releaseManifest.assetCount} != ${actual.length}).`);
  }
  return errors;
};

export const createCycloneDxSbom = ({
  projectName,
  projectVersion,
  generatedAt,
  sourceRevision,
  lockfile,
}) => ({
  bomFormat: 'CycloneDX',
  specVersion: CYCLONEDX_SPEC_VERSION,
  version: 1,
  metadata: {
    timestamp: generatedAt,
    component: {
      type: 'application',
      name: projectName,
      version: projectVersion,
      ...(sourceRevision ? { properties: [{ name: 'source.revision', value: sourceRevision }] } : {}),
    },
  },
  components: collectSbomComponents(lockfile),
});

export const validateReleaseArtifacts = ({
  releaseManifest,
  sbom,
  packageJson,
  lockfile,
}) => {
  const errors = [];
  if (!releaseManifest || typeof releaseManifest !== 'object') {
    return ['Release manifest is not an object.'];
  }
  if (releaseManifest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    errors.push(`Release schema mismatch (${releaseManifest.schemaVersion} != ${RELEASE_SCHEMA_VERSION}).`);
  }
  if (releaseManifest.application?.name !== packageJson.name) {
    errors.push('Release manifest application name does not match package.json.');
  }
  if (releaseManifest.application?.version !== packageJson.version) {
    errors.push('Release manifest application version does not match package.json.');
  }
  if (!Array.isArray(releaseManifest.assets) || releaseManifest.assets.length === 0) {
    errors.push('Release manifest must inventory at least one production asset.');
  } else if (releaseManifest.assetCount !== releaseManifest.assets.length) {
    errors.push('Release manifest asset count does not match its asset inventory.');
  }

  if (!sbom || typeof sbom !== 'object') {
    errors.push('SBOM is not an object.');
    return errors;
  }
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== CYCLONEDX_SPEC_VERSION) {
    errors.push(`SBOM must use CycloneDX ${CYCLONEDX_SPEC_VERSION}.`);
  }
  if (sbom.metadata?.component?.name !== packageJson.name
      || sbom.metadata?.component?.version !== packageJson.version) {
    errors.push('SBOM application component does not match package.json.');
  }

  const expectedComponents = collectSbomComponents(lockfile);
  const actualComponents = Array.isArray(sbom.components) ? sbom.components : [];
  if (actualComponents.length !== expectedComponents.length) {
    errors.push(`SBOM component count mismatch (${actualComponents.length} != ${expectedComponents.length}).`);
  }
  return errors;
};

export const generateReleaseArtifacts = async (projectRoot, buildDirectory) => {
  const [packageJson, lockfile] = await Promise.all([
    readFile(join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
  ]);

  const buildStats = await stat(buildDirectory);
  if (!buildStats.isDirectory()) throw new Error('Production build directory is missing.');

  const generatedAt = resolveGeneratedAt();
  const sourceRevision = resolveSourceRevision(projectRoot);
  const releaseManifest = await createReleaseManifest({
    buildDirectory,
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

  await Promise.all([
    writeFile(
      join(buildDirectory, RELEASE_MANIFEST_FILE),
      `${JSON.stringify(releaseManifest, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      join(buildDirectory, SBOM_FILE),
      `${JSON.stringify(sbom, null, 2)}\n`,
      'utf8',
    ),
  ]);

  return { releaseManifest, sbom };
};

const main = async () => {
  const projectRoot = resolve(dirname(CURRENT_FILE), '..');
  const buildDirectory = resolve(projectRoot, 'build');
  const { releaseManifest, sbom } = await generateReleaseArtifacts(projectRoot, buildDirectory);
  console.log(`[release] Inventoried ${releaseManifest.assetCount} production assets.`);
  console.log(`[release] Emitted CycloneDX ${sbom.specVersion} SBOM with ${sbom.components.length} components.`);
  if (releaseManifest.build.sourceRevision) {
    console.log(`[release] Source revision: ${releaseManifest.build.sourceRevision}`);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  await main();
}
