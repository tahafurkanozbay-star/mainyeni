import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTEGRITY_MANIFEST_FILE,
  verifyBuildIntegrityManifest,
} from './build-integrity.mjs';
import {
  RELEASE_MANIFEST_FILE,
  SBOM_FILE,
  validateReleaseArtifacts,
  verifyReleaseManifestAssets,
} from './release-artifacts.mjs';

const BUILD_DIR = new URL('../build/', import.meta.url);
const PROJECT_ROOT = new URL('../', import.meta.url);
const VITE_MANIFEST_FILE = '.vite/manifest.json';
const MAX_JS_GZIP_BYTES = 650 * 1024;
const MAX_CSS_GZIP_BYTES = 250 * 1024;
const MAX_EAGER_GZIP_BYTES = 2.5 * 1024 * 1024;

const formatBytes = (value) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const normalizePath = (value) => value.replaceAll('\\', '/');

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

const collectEagerManifestAssets = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Vite manifest must be an object.');
  }
  const entries = Object.entries(manifest);
  const entryKeys = entries.filter(([, value]) => value?.isEntry === true).map(([key]) => key);
  if (entryKeys.length === 0) throw new Error('Vite manifest does not contain an application entry.');

  const visited = new Set();
  const assets = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk || typeof chunk !== 'object') throw new Error(`Vite manifest import is missing: ${key}`);
    if (typeof chunk.file === 'string') assets.add(normalizePath(chunk.file));
    if (Array.isArray(chunk.css)) {
      chunk.css.forEach((file) => {
        if (typeof file === 'string') assets.add(normalizePath(file));
      });
    }
    // Only static imports belong to startup transfer. dynamicImports are
    // intentionally excluded because they are fetched on feature demand.
    if (Array.isArray(chunk.imports)) chunk.imports.forEach(visit);
  };
  entryKeys.forEach(visit);
  return assets;
};

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`\n[build:verify] ${message}`);
};

const buildPath = fileURLToPath(BUILD_DIR);
const projectPath = fileURLToPath(PROJECT_ROOT);
try {
  const buildStats = await stat(buildPath);
  if (!buildStats.isDirectory()) throw new Error('build path is not a directory');
} catch (error) {
  console.error('[build:verify] Production build directory is missing.', error);
  process.exit(1);
}

const files = await walk(buildPath);
const relativeFiles = files.map((file) => normalizePath(relative(buildPath, file)));

if (!relativeFiles.includes('index.html')) fail('index.html is missing from the production bundle.');
if (!relativeFiles.includes(RELEASE_MANIFEST_FILE)) fail(`${RELEASE_MANIFEST_FILE} is missing; release provenance was not emitted.`);
if (!relativeFiles.includes(SBOM_FILE)) fail(`${SBOM_FILE} is missing; CycloneDX dependency inventory was not emitted.`);
if (!relativeFiles.includes(INTEGRITY_MANIFEST_FILE)) fail(`${INTEGRITY_MANIFEST_FILE} is missing; production artifacts were not fingerprinted.`);
if (!relativeFiles.includes(VITE_MANIFEST_FILE)) fail(`${VITE_MANIFEST_FILE} is missing; eager/lazy transfer boundaries cannot be verified.`);

const sourceMaps = relativeFiles.filter((file) => file.endsWith('.map'));
if (sourceMaps.length > 0) fail(`Source maps must not ship in production: ${sourceMaps.join(', ')}`);

const assets = [];
let emittedGzipBytes = 0;
for (const file of files) {
  const extension = extname(file).toLowerCase();
  if (!['.js', '.css'].includes(extension)) continue;
  const content = await readFile(file);
  const gzipBytes = gzipSync(content, { level: 9 }).byteLength;
  const rawBytes = content.byteLength;
  emittedGzipBytes += gzipBytes;
  assets.push({ file: normalizePath(relative(buildPath, file)), extension, rawBytes, gzipBytes });
}

if (assets.length === 0) fail('No JavaScript or CSS assets were emitted.');

for (const asset of assets) {
  const limit = asset.extension === '.js' ? MAX_JS_GZIP_BYTES : MAX_CSS_GZIP_BYTES;
  if (asset.gzipBytes > limit) {
    fail(`${asset.file} exceeds gzip budget (${formatBytes(asset.gzipBytes)} > ${formatBytes(limit)}).`);
  }
}

let eagerGzipBytes = 0;
let eagerAssets = new Set();
if (relativeFiles.includes(VITE_MANIFEST_FILE)) {
  try {
    const viteManifest = JSON.parse(await readFile(join(buildPath, VITE_MANIFEST_FILE), 'utf8'));
    eagerAssets = collectEagerManifestAssets(viteManifest);
    const assetByPath = new Map(assets.map((asset) => [asset.file, asset]));
    for (const file of eagerAssets) {
      const asset = assetByPath.get(file);
      if (asset) eagerGzipBytes += asset.gzipBytes;
    }
    if (eagerGzipBytes > MAX_EAGER_GZIP_BYTES) {
      fail(`Eager JS/CSS gzip footprint exceeds startup budget (${formatBytes(eagerGzipBytes)} > ${formatBytes(MAX_EAGER_GZIP_BYTES)}).`);
    }
  } catch (error) {
    fail(`Unable to validate Vite eager/lazy graph: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const html = await readFile(join(buildPath, 'index.html'), 'utf8');
if (!html.includes('<script') || !html.includes('type="module"')) fail('Production index.html does not contain a module entrypoint.');
if (html.includes('%PUBLIC_URL%')) fail('CRA %PUBLIC_URL% placeholders leaked into the Vite bundle.');
if (/sourceMappingURL=/i.test(html)) fail('Unexpected source-map reference found in production HTML.');
if (/<script\b[^>]*\bsrc=["']https?:\/\//i.test(html)) fail('Production HTML must not execute a remote static script; runtime providers must use controlled loaders.');
if (/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']https?:\/\//i.test(html)
  || /<link\b[^>]*\bhref=["']https?:\/\/[^>]*\brel=["']stylesheet["']/i.test(html)) {
  fail('Production HTML must not load an uncontrolled remote stylesheet.');
}

if (relativeFiles.includes(RELEASE_MANIFEST_FILE) && relativeFiles.includes(SBOM_FILE)) {
  try {
    const [releaseManifest, sbom, packageJson, lockfile] = await Promise.all([
      readFile(join(buildPath, RELEASE_MANIFEST_FILE), 'utf8').then(JSON.parse),
      readFile(join(buildPath, SBOM_FILE), 'utf8').then(JSON.parse),
      readFile(join(projectPath, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(projectPath, 'package-lock.json'), 'utf8').then(JSON.parse),
    ]);
    const releaseErrors = validateReleaseArtifacts({ releaseManifest, sbom, packageJson, lockfile });
    releaseErrors.push(...await verifyReleaseManifestAssets(buildPath, releaseManifest));
    releaseErrors.forEach((error) => fail(error));
    if (releaseErrors.length === 0) {
      console.log(`[build:verify] Release assets: ${releaseManifest.assetCount}`);
      console.log(`[build:verify] CycloneDX components: ${sbom.components.length}`);
    }
  } catch (error) {
    fail(`Unable to validate release provenance/SBOM: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (relativeFiles.includes(INTEGRITY_MANIFEST_FILE)) {
  try {
    const integrityManifest = JSON.parse(await readFile(join(buildPath, INTEGRITY_MANIFEST_FILE), 'utf8'));
    const integrityErrors = await verifyBuildIntegrityManifest(buildPath, integrityManifest);
    integrityErrors.forEach((error) => fail(error));
    if (integrityErrors.length === 0) console.log(`[build:verify] Bundle integrity: ${integrityManifest.bundleIntegrity}`);
  } catch (error) {
    fail(`Unable to validate ${INTEGRITY_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

assets.sort((left, right) => right.gzipBytes - left.gzipBytes).forEach((asset) => {
  const mode = eagerAssets.has(asset.file) ? 'eager' : 'lazy';
  console.log(`[build:verify] ${asset.file}: ${formatBytes(asset.rawBytes)} raw / ${formatBytes(asset.gzipBytes)} gzip (${mode})`);
});
console.log(`[build:verify] Eager JS/CSS gzip: ${formatBytes(eagerGzipBytes)}`);
console.log(`[build:verify] All emitted JS/CSS gzip: ${formatBytes(emittedGzipBytes)} (includes lazy capabilities)`);

if (failures.length > 0) process.exit(1);
console.log('[build:verify] Production bundle passed provenance, SBOM, integrity, origin and eager-transfer size budgets.');
