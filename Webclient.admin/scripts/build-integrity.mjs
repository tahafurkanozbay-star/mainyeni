import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const buildRoot = join(root, 'build');
const errors = [];

const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

if (!existsSync(buildRoot) || !statSync(buildRoot).isDirectory()) {
  console.error('[build:integrity] build directory is missing');
  process.exit(1);
}

const indexPath = join(buildRoot, 'index.html');
if (!existsSync(indexPath)) errors.push('build/index.html is missing');
const files = walk(buildRoot);
const relativeFiles = files.map((file) => relative(buildRoot, file).replaceAll('\\', '/'));

if (!relativeFiles.some((file) => /^assets\/.*\.js$/u.test(file))) {
  errors.push('No JavaScript asset emitted by Vite');
}
if (!relativeFiles.some((file) => /^assets\/.*\.css$/u.test(file))) {
  errors.push('No CSS asset emitted by Vite');
}
if (relativeFiles.some((file) => file.endsWith('.map'))) {
  errors.push('Production source maps must remain disabled for Admin');
}

const textAssets = files.filter((file) => ['.html', '.js', '.css', '.json'].includes(extname(file)));
for (const file of textAssets) {
  const content = readFileSync(file, 'utf8');
  const rel = relative(buildRoot, file).replaceAll('\\', '/');
  if (/process\.env\.REACT_APP_/u.test(content)) errors.push(`${rel} contains CRA environment access`);
  if (/react-scripts/u.test(content)) errors.push(`${rel} contains react-scripts runtime/build residue`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) {
    errors.push(`${rel} contains private key material`);
  }
}

if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  if (!/<script[^>]+type=["']module["']/u.test(html)) errors.push('index.html has no ESM entry script');
  if (!/<meta[^>]+name=["']viewport["']/u.test(html)) errors.push('index.html has no viewport contract');
}

if (errors.length > 0) {
  console.error('[build:integrity] FAIL');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log('[build:integrity] PASS');
console.log(`[build:integrity] emitted files: ${files.length}`);
