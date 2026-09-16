#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(CURRENT_FILE), '..');
const SOURCE_ROOT = resolve(ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts']);
const ALLOWED_LEGACY_ENV = new Set(['process.env.PUBLIC_URL']);

const normalizePath = (value) => value.replaceAll('\\', '/');

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', 'build', 'dist'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
};

export const findLegacyEnvironmentReferences = (source) => {
  const matches = source.match(/process\.env\.[A-Z0-9_]+/g) ?? [];
  return [...new Set(matches.filter((item) => !ALLOWED_LEGACY_ENV.has(item)))].sort();
};

export const findUnsafeRootAssets = (html) => {
  const findings = [];
  const assetPattern = /<(link|script)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(assetPattern)) {
    const tag = match[1]?.toLowerCase();
    const target = match[2] ?? '';
    const wholeTag = match[0];
    if (tag === 'script' && target === '/src/main.tsx') continue;
    if (target.startsWith('/') && !target.startsWith('//')) {
      findings.push(`root-relative public asset bypasses Vite base: ${target}`);
    }
    if (/^https?:\/\//i.test(target)) {
      const rel = wholeTag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? '';
      const isPreconnect = tag === 'link' && rel.split(/\s+/).includes('preconnect');
      if (!isPreconnect) findings.push(`remote presentation dependency in root HTML: ${target}`);
    }
  }
  return findings;
};

export const validateEnvironmentExample = (source) => {
  const findings = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const key = line.split('=', 1)[0]?.trim() ?? '';
    if (key.startsWith('REACT_APP_')) findings.push(`legacy CRA environment key remains: ${key}`);
    if (/(?:SECRET|TOKEN|PASSWORD|CLIENT_KEY|API_KEY|AUTHORIZATION)/i.test(key)) {
      findings.push(`secret-like browser environment key is forbidden: ${key}`);
    }
    if (key && !key.startsWith('VITE_')) findings.push(`browser environment key must use VITE_ prefix: ${key}`);
  }
  return findings;
};

export const validateViteConfigContract = (source) => {
  const findings = [];
  if (!/envPrefix\s*:\s*\[\s*['"]VITE_['"]\s*\]/.test(source)) {
    findings.push('vite.config.ts must expose only the VITE_ browser environment prefix');
  }
  if (!source.includes("'process.env.PUBLIC_URL': JSON.stringify('./')")) {
    findings.push('the bounded PUBLIC_URL compatibility bridge is missing or broadened');
  }
  if (/define\s*:\s*\{[^}]*['"]?process\.env['"]?\s*:/s.test(source)) {
    findings.push('generic process.env browser polyfill is forbidden');
  }
  return findings;
};

export const auditViteMigration = async (root = ROOT) => {
  const findings = [];
  if (existsSync(resolve(root, '.env'))) findings.push('tracked/local .env exists inside Webclient.app');

  const examplePath = resolve(root, '.env.example');
  if (!existsSync(examplePath)) findings.push('.env.example is required for local setup');
  else findings.push(...validateEnvironmentExample(await readFile(examplePath, 'utf8')));

  const indexPath = resolve(root, 'index.html');
  if (!existsSync(indexPath)) findings.push('Vite root index.html is missing');
  else findings.push(...findUnsafeRootAssets(await readFile(indexPath, 'utf8')));

  const viteConfigPath = resolve(root, 'vite.config.ts');
  if (!existsSync(viteConfigPath)) findings.push('vite.config.ts is missing');
  else findings.push(...validateViteConfigContract(await readFile(viteConfigPath, 'utf8')));

  const sourceRoot = resolve(root, 'src');
  if (existsSync(sourceRoot)) {
    const files = await walk(sourceRoot);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const reference of findLegacyEnvironmentReferences(source)) {
        findings.push(`${normalizePath(relative(root, file))}: forbidden browser environment reference ${reference}`);
      }
    }
  }

  return Object.freeze(findings.sort());
};

const selfTest = () => {
  const assert = (condition, message) => {
    if (!condition) throw new Error(`vite migration audit self-test failed: ${message}`);
  };
  assert(findLegacyEnvironmentReferences('process.env.PUBLIC_URL').length === 0, 'PUBLIC_URL bridge should be bounded and allowed');
  assert(findLegacyEnvironmentReferences('process.env.SECRET').includes('process.env.SECRET'), 'secret process env should be rejected');
  assert(findUnsafeRootAssets('<link rel="icon" href="/icon.png">').length === 1, 'root-relative asset should be rejected');
  assert(findUnsafeRootAssets('<link rel="icon" href="%BASE_URL%icon.png">').length === 0, 'BASE_URL asset should pass');
  assert(findUnsafeRootAssets('<link rel="preconnect" href="https://js.arcgis.com">').length === 0, 'preconnect should pass');
  assert(validateEnvironmentExample('VITE_API_URL=/api').length === 0, 'VITE example should pass');
  assert(validateEnvironmentExample('REACT_APP_API_URL=/api').length > 0, 'CRA key should fail');
};

if (process.argv.includes('--self-test')) {
  selfTest();
  console.log('[quality:vite] self-test PASS');
  process.exit(0);
}

const findings = await auditViteMigration();
if (findings.length > 0) {
  console.error(`[quality:vite] ${findings.length} migration contract violation(s):`);
  findings.forEach((finding) => console.error(`  - ${finding}`));
  process.exitCode = 1;
} else {
  console.log('[quality:vite] Vite environment, asset and migration contracts PASS.');
}
