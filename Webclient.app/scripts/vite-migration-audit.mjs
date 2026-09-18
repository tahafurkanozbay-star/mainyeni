#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(CURRENT_FILE), '..');
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

const linkRelation = (tag) =>
  tag.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];

export const findUnsafeRootAssets = (html) => {
  const findings = [];
  const assetPattern = /<(link|script)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(assetPattern)) {
    const tag = match[1]?.toLowerCase();
    const target = match[2] ?? '';
    const wholeTag = match[0];
    const relations = tag === 'link' ? linkRelation(wholeTag) : [];
    const isViteEntrypoint = tag === 'script' && target === '/src/main.tsx';
    const isPresentationLink = tag === 'link' && (
      relations.includes('stylesheet')
      || relations.includes('icon')
      || relations.includes('shortcut')
      || relations.includes('apple-touch-icon')
    );
    const isExecutableScript = tag === 'script';

    if (!isViteEntrypoint && (isPresentationLink || isExecutableScript)
      && target.startsWith('/') && !target.startsWith('//')) {
      findings.push(`root-relative public asset bypasses Vite base: ${target}`);
    }

    if (/^https?:\/\//i.test(target)) {
      const remoteExecutable = isExecutableScript;
      const remoteStylesheet = isPresentationLink && relations.includes('stylesheet');
      if (remoteExecutable || remoteStylesheet) {
        findings.push(`remote executable/presentation dependency in root HTML: ${target}`);
      }
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

export const validateGitignoreContract = (source) => {
  const patterns = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const protectsWebclientEnv = patterns.includes('Webclient.app/.env')
    || patterns.includes('Webclient.app/.env*')
    || patterns.includes('.env')
    || patterns.includes('.env.*');
  return protectsWebclientEnv ? [] : ['repository .gitignore must protect Webclient.app/.env'];
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
  if (!/target\s*:\s*['"]baseline-widely-available['"]/.test(source)) {
    findings.push('Vite 8 production target must use baseline-widely-available');
  }
  if (/noDiscovery\s*:\s*true/.test(source)) {
    findings.push('Vite dependency discovery must remain enabled during the legacy/CJS migration');
  }
  if (!source.includes("from './tooling/sourceTransforms.ts'")) {
    findings.push('Vite and Vitest must share the centralized legacy source transform boundary');
  }
  if (!source.includes("from './tooling/moduleResolutionGuard.ts'")) {
    findings.push('Vite must import the typed module resolution ambiguity guard');
  }
  if (!/moduleResolutionGuardPlugin\s*\(\s*\)/.test(source)) {
    findings.push('Vite must enforce the module resolution ambiguity guard before source transforms');
  }
  if (!/sourcemap\s*:\s*false/.test(source)) {
    findings.push('production source maps must remain disabled');
  }
  return findings;
};

export const auditViteMigration = async (root = ROOT) => {
  const findings = [];

  // Developers may create a git-ignored local .env. The repository contract is
  // that it cannot be accidentally tracked, not that local configuration is forbidden.
  const repositoryGitignore = resolve(root, '..', '.gitignore');
  if (!existsSync(repositoryGitignore)) findings.push('repository .gitignore is missing');
  else findings.push(...validateGitignoreContract(await readFile(repositoryGitignore, 'utf8')));

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
  assert(findUnsafeRootAssets('<link rel="canonical" href="https://kentrehberi.ankara.bel.tr/">').length === 0, 'canonical SEO link should pass');
  assert(findUnsafeRootAssets('<link rel="stylesheet" href="https://cdn.example.com/ui.css">').length === 1, 'remote stylesheet should fail');
  assert(findUnsafeRootAssets('<script src="https://cdn.example.com/app.js"></script>').length === 1, 'remote executable script should fail');
  assert(validateEnvironmentExample('VITE_API_URL=/api').length === 0, 'VITE example should pass');
  assert(validateEnvironmentExample('REACT_APP_API_URL=/api').length > 0, 'CRA key should fail');
  assert(validateGitignoreContract('Webclient.app/.env\n').length === 0, 'ignored local .env should pass');
  assert(validateGitignoreContract('node_modules\n').length > 0, 'missing env protection should fail');

  const validConfig = `
    import { legacyJsxPlugin } from './tooling/sourceTransforms.ts';
    import { moduleResolutionGuardPlugin } from './tooling/moduleResolutionGuard.ts';
    export default {
      envPrefix: ['VITE_'],
      plugins: [moduleResolutionGuardPlugin(), legacyJsxPlugin()],
      define: { 'process.env.PUBLIC_URL': JSON.stringify('./') },
      optimizeDeps: { include: ['react'] },
      build: { target: 'baseline-widely-available', sourcemap: false }
    };
  `;
  assert(validateViteConfigContract(validConfig).length === 0, 'modern Vite 8 contract should pass');
  assert(validateViteConfigContract(`${validConfig}\n// noDiscovery: true`).length > 0, 'disabled discovery should fail');
  assert(validateViteConfigContract(validConfig.replace('baseline-widely-available', 'es2022')).length > 0, 'narrow build target should fail');
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
