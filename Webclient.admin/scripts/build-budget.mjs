import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const buildRoot = join(root, 'build');
const MiB = 1024 * 1024;
const budgets = Object.freeze({
  totalJavaScriptBytes: 12 * MiB,
  largestJavaScriptBytes: 4 * MiB,
  totalCssBytes: 1.5 * MiB,
  totalAssetBytes: 24 * MiB,
});

if (!existsSync(buildRoot)) {
  console.error('[build:budget] build directory is missing');
  process.exit(1);
}

const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const files = walk(buildRoot).map((path) => ({
  path,
  relative: relative(buildRoot, path).replaceAll('\\', '/'),
  bytes: statSync(path).size,
  extension: extname(path),
}));

const javascript = files.filter((file) => file.extension === '.js');
const css = files.filter((file) => file.extension === '.css');
const sum = (items) => items.reduce((total, item) => total + item.bytes, 0);
const jsBytes = sum(javascript);
const cssBytes = sum(css);
const totalBytes = sum(files);
const largestJs = javascript.reduce((largest, file) => file.bytes > largest.bytes ? file : largest, {
  relative: 'none',
  bytes: 0,
});

const errors = [];
if (jsBytes > budgets.totalJavaScriptBytes) {
  errors.push(`JavaScript total ${jsBytes} exceeds ${budgets.totalJavaScriptBytes}`);
}
if (largestJs.bytes > budgets.largestJavaScriptBytes) {
  errors.push(`Largest JS asset ${largestJs.relative} is ${largestJs.bytes} bytes; budget ${budgets.largestJavaScriptBytes}`);
}
if (cssBytes > budgets.totalCssBytes) {
  errors.push(`CSS total ${cssBytes} exceeds ${budgets.totalCssBytes}`);
}
if (totalBytes > budgets.totalAssetBytes) {
  errors.push(`Build total ${totalBytes} exceeds ${budgets.totalAssetBytes}`);
}

console.log(`[build:budget] JS total: ${jsBytes} bytes`);
console.log(`[build:budget] largest JS: ${largestJs.relative} (${largestJs.bytes} bytes)`);
console.log(`[build:budget] CSS total: ${cssBytes} bytes`);
console.log(`[build:budget] build total: ${totalBytes} bytes`);

if (errors.length > 0) {
  console.error('[build:budget] FAIL');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log('[build:budget] PASS');
