#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_REGISTRY_HOSTS = Object.freeze(['registry.npmjs.org']);
const INTEGRITY_PATTERN = /^(?:sha512|sha384|sha256)-[A-Za-z0-9+/=]+$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PACKAGE_PATH_LENGTH = 512;
const MAX_PACKAGE_COUNT = 10000;
const MAX_DUPLICATE_VERSIONS = 4;

const packageNameFromPath = (path) => {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = path.slice(index + marker.length);
  if (!tail) return null;
  const parts = tail.split('/');
  if (parts[0]?.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] ?? null;
};

const stableSort = (values) => [...values].sort((a, b) => a.localeCompare(b));
const issue = (code, path, detail) => Object.freeze({ code, path, detail });

export const inspectResolvedUrl = (resolved, allowedHosts = DEFAULT_REGISTRY_HOSTS) => {
  if (typeof resolved !== 'string' || resolved.length === 0) return { ok: false, reason: 'missing' };
  let url;
  try { url = new URL(resolved); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: `protocol:${url.protocol}` };
  if (!allowedHosts.includes(url.hostname)) return { ok: false, reason: `host:${url.hostname}` };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.search || url.hash) return { ok: false, reason: 'query-or-fragment' };
  if (!url.pathname.includes('/-/')) return { ok: false, reason: 'non-tarball-path' };
  return { ok: true, host: url.hostname };
};

export const analyzeResolutionPolicy = (lockfile, options = {}) => {
  const allowedHosts = stableSort(options.allowedRegistryHosts ?? DEFAULT_REGISTRY_HOSTS);
  const maxPackageCount = options.maxPackageCount ?? MAX_PACKAGE_COUNT;
  const maxDuplicateVersions = options.maxDuplicateVersions ?? MAX_DUPLICATE_VERSIONS;
  const issues = [];
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    return Object.freeze({ issues: [issue('lockfile-packages-missing', '', 'lockfile.packages must be an object')], packageCount: 0, fingerprints: [] });
  }

  const paths = stableSort(Object.keys(packages).filter((path) => path !== ''));
  if (paths.length > maxPackageCount) issues.push(issue('package-count-budget', '', `${paths.length}>${maxPackageCount}`));
  const versionsByName = new Map();
  const fingerprints = [];

  for (const path of paths) {
    const entry = packages[path];
    const name = packageNameFromPath(path);
    if (!name) { issues.push(issue('package-path-invalid', path, 'cannot derive package name')); continue; }
    if (path.length > MAX_PACKAGE_PATH_LENGTH) issues.push(issue('package-path-too-long', path, String(path.length)));
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { issues.push(issue('package-entry-invalid', path, 'entry must be an object')); continue; }
    const version = typeof entry.version === 'string' ? entry.version : '';
    if (!SEMVER_PATTERN.test(version)) issues.push(issue('version-not-concrete-semver', path, version || 'missing'));
    if (entry.link === true) issues.push(issue('linked-package-forbidden', path, 'link=true'));
    if (entry.inBundle === true || entry.bundled === true) issues.push(issue('bundled-package-forbidden', path, 'bundled dependency'));

    const resolution = inspectResolvedUrl(entry.resolved, allowedHosts);
    if (!resolution.ok) issues.push(issue('resolution-provenance', path, resolution.reason));
    if (typeof entry.integrity !== 'string' || !INTEGRITY_PATTERN.test(entry.integrity)) {
      issues.push(issue('integrity-invalid', path, typeof entry.integrity === 'string' ? entry.integrity.slice(0, 32) : 'missing'));
    }

    if (!versionsByName.has(name)) versionsByName.set(name, new Set());
    if (version) versionsByName.get(name).add(version);
    fingerprints.push(`${name}@${version}|${resolution.ok ? resolution.host : 'invalid'}|${entry.hasInstallScript === true ? 'script' : 'noscript'}`);
  }

  for (const name of stableSort(versionsByName.keys())) {
    const versions = stableSort(versionsByName.get(name));
    if (versions.length > maxDuplicateVersions) issues.push(issue('duplicate-version-budget', name, `${versions.length}>${maxDuplicateVersions}:${versions.join(',')}`));
  }

  return Object.freeze({
    issues: Object.freeze(issues.sort((a, b) => a.code.localeCompare(b.code) || a.path.localeCompare(b.path) || a.detail.localeCompare(b.detail))),
    packageCount: paths.length,
    duplicatePackages: Object.freeze(stableSort([...versionsByName].filter(([, versions]) => versions.size > 1).map(([name]) => name))),
    fingerprints: Object.freeze(stableSort(fingerprints)),
    allowedRegistryHosts: Object.freeze(allowedHosts),
  });
};

export const formatResolutionReport = (result) => [
  `dependency resolution policy: ${result.issues.length === 0 ? 'PASS' : 'FAIL'}`,
  `packages=${result.packageCount}`,
  `duplicatePackages=${result.duplicatePackages?.length ?? 0}`,
  ...result.issues.map((item) => `${item.code}: ${item.path || '<root>'}: ${item.detail}`),
].join('\n');

export const runResolutionPolicy = async ({ lockfilePath = resolve(ROOT, 'package-lock.json'), options } = {}) => {
  const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'));
  const result = analyzeResolutionPolicy(lockfile, options);
  process.stdout.write(`${formatResolutionReport(result)}\n`);
  if (result.issues.length > 0) process.exitCode = 1;
  return result;
};

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await runResolutionPolicy();
