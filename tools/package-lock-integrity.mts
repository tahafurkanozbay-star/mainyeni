#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function sortedEntries(value = {}) {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
}

function dependencyMap(manifest) {
  return {
    dependencies: manifest.dependencies || {},
    devDependencies: manifest.devDependencies || {},
    optionalDependencies: manifest.optionalDependencies || {},
    peerDependencies: manifest.peerDependencies || {},
  };
}

export function compareManifestAndLock(manifest, lock) {
  const root = lock?.packages?.[''] || {};
  const expectedGroups = dependencyMap(manifest || {});
  const actualGroups = dependencyMap(root);
  const findings = [];

  for (const group of Object.keys(expectedGroups)) {
    const expected = expectedGroups[group];
    const actual = actualGroups[group];
    const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const name of [...names].sort()) {
      const manifestVersion = expected[name];
      const lockVersion = actual[name];
      if (manifestVersion === undefined) {
        findings.push({ kind: 'lock-only-root-dependency', group, name, lockVersion });
      } else if (lockVersion === undefined) {
        findings.push({ kind: 'manifest-only-root-dependency', group, name, manifestVersion });
      } else if (manifestVersion !== lockVersion) {
        findings.push({ kind: 'root-dependency-version-drift', group, name, manifestVersion, lockVersion });
      }
    }
  }

  return findings;
}

export async function auditPackageDirectory(directory) {
  const packagePath = path.join(directory, 'package.json');
  const lockPath = path.join(directory, 'package-lock.json');
  const [manifestText, lockText] = await Promise.all([
    fs.readFile(packagePath, 'utf8'),
    fs.readFile(lockPath, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  return {
    directory,
    packageName: manifest.name || null,
    lockfileVersion: lock.lockfileVersion || null,
    findings: compareManifestAndLock(manifest, lock),
  };
}

export async function findPackageDirectories(root) {
  const result = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const names = new Set(entries.map(entry => entry.name));
    if (names.has('package.json') && names.has('package-lock.json')) result.push(directory);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || ['node_modules', 'build', 'dist', 'coverage', 'bin', 'obj'].includes(entry.name)) continue;
      await walk(path.join(directory, entry.name));
    }
  }
  await walk(root);
  return result.sort();
}

export function formatReport(root, audits) {
  const lines = ['# Package Lock Integrity', ''];
  let findingCount = 0;
  for (const audit of audits) {
    const relative = path.relative(root, audit.directory).split(path.sep).join('/') || '.';
    lines.push(`## ${relative}`, '', `Package: ${audit.packageName || '(unnamed)'}`, `Lockfile version: ${audit.lockfileVersion ?? '(unknown)'}`, '');
    if (!audit.findings.length) {
      lines.push('- Root dependency metadata is synchronized.', '');
      continue;
    }
    for (const finding of audit.findings) {
      findingCount += 1;
      if (finding.kind === 'lock-only-root-dependency') lines.push(`- LOCK_ONLY ${finding.group}: ${finding.name}@${finding.lockVersion}`);
      else if (finding.kind === 'manifest-only-root-dependency') lines.push(`- MANIFEST_ONLY ${finding.group}: ${finding.name}@${finding.manifestVersion}`);
      else lines.push(`- VERSION_DRIFT ${finding.group}: ${finding.name} manifest=${finding.manifestVersion} lock=${finding.lockVersion}`);
    }
    lines.push('');
  }
  lines.push(`Total findings: ${findingCount}`, '');
  return { markdown: lines.join('\n'), findingCount };
}

async function main() {
  const root = path.resolve(process.cwd());
  const directories = await findPackageDirectories(root);
  const audits = await Promise.all(directories.map(auditPackageDirectory));
  const report = formatReport(root, audits);
  const outDir = path.join(root, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'package-lock-integrity.md'), report.markdown);
  await fs.writeFile(path.join(outDir, 'package-lock-integrity.json'), JSON.stringify({ findingCount: report.findingCount, audits: audits.map(audit => ({ ...audit, directory: path.relative(root, audit.directory).split(path.sep).join('/') || '.' })) }, null, 2) + '\n');
  process.stdout.write(report.markdown);
  if (process.argv.includes('--strict') && report.findingCount > 0) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error); process.exitCode = 1; });
