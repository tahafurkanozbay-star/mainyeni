import { gzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const BUILD_DIR = new URL('../build/', import.meta.url);
const MAX_JS_GZIP_BYTES = 650 * 1024;
const MAX_CSS_GZIP_BYTES = 250 * 1024;
const MAX_TOTAL_GZIP_BYTES = 2.5 * 1024 * 1024;

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

const fail = (message) => {
  console.error(`\n[build:verify] ${message}`);
  process.exitCode = 1;
};

const buildPath = BUILD_DIR.pathname;
try {
  const buildStats = await stat(buildPath);
  if (!buildStats.isDirectory()) throw new Error('build path is not a directory');
} catch (error) {
  console.error('[build:verify] Production build directory is missing.', error);
  process.exit(1);
}

const files = await walk(buildPath);
const relativeFiles = files.map((file) => relative(buildPath, file));

if (!relativeFiles.includes('index.html')) {
  fail('index.html is missing from the production bundle.');
}

const sourceMaps = relativeFiles.filter((file) => file.endsWith('.map'));
if (sourceMaps.length > 0) {
  fail(`Source maps must not ship in production: ${sourceMaps.join(', ')}`);
}

const assets = [];
let totalGzipBytes = 0;
for (const file of files) {
  const extension = extname(file).toLowerCase();
  if (!['.js', '.css'].includes(extension)) continue;
  const content = await readFile(file);
  const gzipBytes = gzipSync(content, { level: 9 }).byteLength;
  const rawBytes = content.byteLength;
  totalGzipBytes += gzipBytes;
  assets.push({
    file: relative(buildPath, file),
    extension,
    rawBytes,
    gzipBytes,
  });
}

if (assets.length === 0) {
  fail('No JavaScript or CSS assets were emitted.');
}

for (const asset of assets) {
  const limit = asset.extension === '.js' ? MAX_JS_GZIP_BYTES : MAX_CSS_GZIP_BYTES;
  if (asset.gzipBytes > limit) {
    fail(`${asset.file} exceeds gzip budget (${formatBytes(asset.gzipBytes)} > ${formatBytes(limit)}).`);
  }
}

if (totalGzipBytes > MAX_TOTAL_GZIP_BYTES) {
  fail(`Total JS/CSS gzip footprint exceeds budget (${formatBytes(totalGzipBytes)} > ${formatBytes(MAX_TOTAL_GZIP_BYTES)}).`);
}

const html = await readFile(join(buildPath, 'index.html'), 'utf8');
if (!html.includes('<script') || !html.includes('type="module"')) {
  fail('Production index.html does not contain a module entrypoint.');
}
if (html.includes('%PUBLIC_URL%')) {
  fail('CRA %PUBLIC_URL% placeholders leaked into the Vite bundle.');
}
if (/sourceMappingURL=/i.test(html)) {
  fail('Unexpected source-map reference found in production HTML.');
}

assets
  .sort((left, right) => right.gzipBytes - left.gzipBytes)
  .forEach((asset) => {
    console.log(
      `[build:verify] ${asset.file}: ${formatBytes(asset.rawBytes)} raw / ${formatBytes(asset.gzipBytes)} gzip`,
    );
  });
console.log(`[build:verify] Total JS/CSS gzip: ${formatBytes(totalGzipBytes)}`);

if (process.exitCode) process.exit(process.exitCode);
console.log('[build:verify] Production bundle passed integrity and size budgets.');
