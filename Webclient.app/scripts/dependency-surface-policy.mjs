import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const POLICY_PATH = path.join(ROOT, 'scripts', 'dependency-policy.json');
const ISSUE_TYPES = new Set(['unused-runtime', 'deprecated-direct', 'install-script-direct']);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const FORBIDDEN_SPEC_PREFIXES = ['file:', 'link:', 'git:', 'git+http:', 'git+https:', 'http:', 'https:'];

export class DependencySurfacePolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DependencySurfacePolicyError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function assertObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DependencySurfacePolicyError(code, `${label} must be an object`);
  }
  return value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function packageNameValid(name) {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(name);
}

function specKind(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return 'invalid';
  const value = spec.trim();
  if (FORBIDDEN_SPEC_PREFIXES.some((prefix) => value.startsWith(prefix))) return 'external-source';
  if (value === '*' || value === 'latest' || value === 'next') return 'floating';
  if (/^(?:workspace:|npm:)/.test(value)) return 'alias';
  return 'registry-range';
}

function parseDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DependencySurfacePolicyError('invalid-date', `${label} must use YYYY-MM-DD`, { value });
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) {
    throw new DependencySurfacePolicyError('invalid-date', `${label} is not a real date`, { value });
  }
  return timestamp;
}

export function collectManifestSurface(manifest) {
  assertObject(manifest, 'invalid-manifest', 'manifest');
  const seen = new Map();
  const entries = [];
  for (const section of DEP_SECTIONS) {
    const deps = manifest[section];
    if (deps === undefined) continue;
    assertObject(deps, 'invalid-section', section);
    for (const [name, spec] of Object.entries(deps)) {
      if (!packageNameValid(name)) {
        throw new DependencySurfacePolicyError('invalid-package-name', `Invalid package name: ${name}`, { section, name });
      }
      if (seen.has(name)) {
        throw new DependencySurfacePolicyError('duplicate-direct-dependency', `${name} appears in multiple dependency sections`, {
          name,
          firstSection: seen.get(name),
          secondSection: section,
        });
      }
      seen.set(name, section);
      entries.push(Object.freeze({ name, section, spec, specKind: specKind(spec) }));
    }
  }
  return Object.freeze(entries.sort((a, b) => a.name.localeCompare(b.name)));
}

export function validateManifestSurface(manifest, policy, options = {}) {
  const now = options.now ?? new Date();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new DependencySurfacePolicyError('invalid-now', 'now must be a valid Date or timestamp');

  const entries = collectManifestSurface(manifest);
  const policyObject = assertObject(policy, 'invalid-policy', 'policy');
  const exceptions = Array.isArray(policyObject.exceptions) ? policyObject.exceptions : [];
  const findings = [];
  const directNames = new Set(entries.map((entry) => entry.name));
  const exceptionKeys = new Set();

  for (const entry of entries) {
    if (entry.specKind === 'invalid') {
      findings.push({ severity: 'error', code: 'invalid-version-spec', package: entry.name, section: entry.section });
    } else if (entry.specKind === 'external-source') {
      findings.push({ severity: 'error', code: 'external-source-spec', package: entry.name, section: entry.section, spec: entry.spec });
    } else if (entry.specKind === 'floating') {
      findings.push({ severity: 'error', code: 'floating-version-spec', package: entry.name, section: entry.section, spec: entry.spec });
    }
  }

  for (const exception of exceptions) {
    assertObject(exception, 'invalid-exception', 'exception');
    const name = exception.package;
    if (typeof name !== 'string' || !packageNameValid(name)) {
      findings.push({ severity: 'error', code: 'invalid-exception-package', package: String(name ?? '') });
      continue;
    }
    if (!directNames.has(name)) findings.push({ severity: 'error', code: 'stale-exception-package', package: name });
    if (!Array.isArray(exception.issues) || exception.issues.length === 0) {
      findings.push({ severity: 'error', code: 'empty-exception-issues', package: name });
      continue;
    }
    for (const issue of exception.issues) {
      if (!ISSUE_TYPES.has(issue)) findings.push({ severity: 'error', code: 'unknown-exception-issue', package: name, issue });
      const key = `${name}:${issue}`;
      if (exceptionKeys.has(key)) findings.push({ severity: 'error', code: 'duplicate-exception-issue', package: name, issue });
      exceptionKeys.add(key);
    }
    if (typeof exception.owner !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(exception.owner)) {
      findings.push({ severity: 'error', code: 'invalid-exception-owner', package: name });
    }
    if (typeof exception.reason !== 'string' || exception.reason.trim().length < 24) {
      findings.push({ severity: 'error', code: 'weak-exception-reason', package: name });
    }
    try {
      const expiry = parseDate(exception.expiresOn, `${name}.expiresOn`);
      if (expiry < nowMs) findings.push({ severity: 'error', code: 'expired-exception', package: name, expiresOn: exception.expiresOn });
    } catch {
      findings.push({ severity: 'error', code: 'invalid-exception-expiry', package: name });
    }
  }

  const scripts = assertObject(manifest.scripts ?? {}, 'invalid-scripts', 'scripts');
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || !command.trim()) findings.push({ severity: 'error', code: 'invalid-script-command', script: name });
    if (/\bnpx\b/.test(String(command))) findings.push({ severity: 'error', code: 'unreviewed-npx-script', script: name });
    if (/\bcurl\b|\bwget\b/.test(String(command))) findings.push({ severity: 'error', code: 'network-bootstrap-script', script: name });
    if (/\b(?:preinstall|postinstall)\b/.test(name)) findings.push({ severity: 'error', code: 'root-install-lifecycle-script', script: name });
  }

  const engines = assertObject(manifest.engines ?? {}, 'invalid-engines', 'engines');
  if (!engines.node || !engines.npm) findings.push({ severity: 'error', code: 'missing-runtime-engine-contract' });

  const sectionCounts = Object.fromEntries(DEP_SECTIONS.map((section) => [section, entries.filter((entry) => entry.section === section).length]));
  const fingerprint = entries.map(({ name, section, spec }) => `${section}:${name}@${spec}`).join('\n');
  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    dependencyCount: entries.length,
    sectionCounts: Object.freeze(sectionCounts),
    externalSourceCount: entries.filter((entry) => entry.specKind === 'external-source').length,
    floatingSpecCount: entries.filter((entry) => entry.specKind === 'floating').length,
    exceptionPackageCount: sortedUnique(exceptions.map((entry) => entry?.package).filter((value) => typeof value === 'string')).length,
    fingerprint,
  });
}

export function formatReport(report) {
  const lines = [
    `Dependency surface: ${report.dependencyCount} direct packages`,
    `Exceptions: ${report.exceptionPackageCount}`,
    `External sources: ${report.externalSourceCount}`,
    `Floating specs: ${report.floatingSpecCount}`,
  ];
  for (const finding of report.findings) lines.push(`ERROR ${finding.code}: ${finding.package ?? finding.script ?? 'manifest'}`);
  return lines.join('\n');
}

export function runCli({ manifestPath = PACKAGE_PATH, policyPath = POLICY_PATH, now = new Date() } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const report = validateManifestSurface(manifest, policy, { now });
  process.stdout.write(`${formatReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) runCli();
