#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotnetPackageInventory, parseProjectFile } from './dotnet-package-governance.mts';

// Explicit solution boundaries: an API host may compose shared services,
// but shared services must never acquire an executable host dependency.
export const LAYER_EDGES = Object.freeze({
  'Toolbox/Toolbox.csproj': [],
  'Business/Business.csproj': ['Toolbox/Toolbox.csproj'],
  'Api.Core/Api.Core.csproj': ['Business/Business.csproj', 'Toolbox/Toolbox.csproj'],
  'Api.User/Api.User.csproj': ['Api.Core/Api.Core.csproj', 'Business/Business.csproj', 'Toolbox/Toolbox.csproj'],
  'tests/Platform.Security.Tests/Platform.Security.Tests.csproj': [
    'Api.Core/Api.Core.csproj', 'Api.User/Api.User.csproj',
    'Business/Business.csproj', 'Toolbox/Toolbox.csproj',
  ],
});
const order = (a, b) => a.localeCompare(b, 'en');
const issue = (code, file, message) => Object.freeze({ code, file, message, severity: 'error', package: null });
const normalizeProject = value => {
  if (typeof value !== 'string' || !value || value.startsWith('/') ||
      /^[A-Za-z]:/.test(value) || value.includes('\0')) return null;
  const unix = value.replaceAll('\\', '/');
  if (!unix.endsWith('.csproj') || unix.split('/').some(x => !x || x === '.' || x === '..')) return null;
  return unix;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Audit all declared edges, including conditional ProjectReferences. */
export const evaluateDotnetLayerPolicy = ({ projects, requireComplete = true }) => {
  if (!Array.isArray(projects)) throw new TypeError('projects must be an array');
  const findings = [], inventory = [], seen = new Set();
  for (const project of projects) {
    const source = normalizeProject(project?.path);
    if (!source) {
      findings.push(issue('layer-project-path-invalid', String(project?.path ?? '<missing>'),
        'Project path must be repository-relative and cannot contain traversal.'));
      continue;
    }
    if (seen.has(source)) {
      findings.push(issue('layer-project-duplicate', source, 'Project is declared more than once.'));
      continue;
    }
    seen.add(source);
    const allowed = LAYER_EDGES[source];
    if (!allowed) findings.push(issue('layer-project-unclassified', source,
      'Classify new projects and review their dependency direction before merging.'));
    const references = Array.isArray(project.projectReferences) ? project.projectReferences :
      parseProjectFile(project.xml ?? '', source).projectReferences;
    const edges = new Set();
    for (const reference of references) {
      const raw = typeof reference === 'string' ? reference : reference?.path;
      if (typeof raw !== 'string' || !raw || raw.startsWith('/') ||
          /^[A-Za-z]:/.test(raw) || raw.includes('\0')) {
        findings.push(issue('layer-reference-invalid', source, 'ProjectReference must be relative.'));
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), raw.replaceAll('\\', '/')));
      if (!target.endsWith('.csproj') || target === '..' || target.startsWith('../')) {
        findings.push(issue('layer-reference-invalid', source, 'ProjectReference escapes the project inventory.'));
        continue;
      }
      if (edges.has(target)) {
        findings.push(issue('layer-reference-duplicate', source, 'Duplicate direct dependency on ' + target));
        continue;
      }
      edges.add(target);
      if (allowed && !allowed.includes(target)) findings.push(issue('layer-reference-forbidden', source,
        'Forbidden dependency on ' + target + '; review layer boundaries.'));
    }
    inventory.push(Object.freeze({ path: source, role: source.split('/')[0],
      references: Object.freeze([...edges].sort(order)) }));
  }
  if (requireComplete) for (const required of Object.keys(LAYER_EDGES)) {
    if (!seen.has(required)) findings.push(issue('layer-required-project-missing', required,
      'Required active solution project is missing.'));
  }
  inventory.sort((a, b) => order(a.path, b.path));
  findings.sort((a, b) => order(a.code, b.code) || order(a.file, b.file) || order(a.message, b.message));
  return Object.freeze({
    ok: findings.length === 0,
    summary: Object.freeze({ projects: inventory.length,
      references: inventory.reduce((n, p) => n + p.references.length, 0),
      violations: findings.length }),
    fingerprint: hash(inventory),
    projects: Object.freeze(inventory), findings: Object.freeze(findings),
  });
};
const escapeMd = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
export const renderDotnetLayerPolicyMarkdown = report => [
  '# .NET Layer Dependency Contract', '',
  '- Gate: **' + (report.ok ? 'PASS' : 'FAIL') + '**',
  '- Fingerprint: ' + report.fingerprint,
  '- Projects: **' + report.summary.projects + '**',
  '- Direct references: **' + report.summary.references + '**',
  '- Violations: **' + report.summary.violations + '**', '',
  '| Project | Role | Direct dependencies |',
  '| --- | --- | --- |',
  ...report.projects.map(p => '| ' + escapeMd(p.path) + ' | ' + escapeMd(p.role) +
    ' | ' + escapeMd(p.references.join(', ') || '(none)') + ' |'),
  '', '## Findings', '',
  '| Code | Project | Detail |', '| --- | --- | --- |',
  ...(report.findings.length ? report.findings.map(f =>
    '| ' + f.code + ' | ' + escapeMd(f.file) + ' | ' + escapeMd(f.message) + ' |') :
    ['| _none_ | | |']), '',
].join('\n');
export const runDotnetLayerPolicy = async root =>
  evaluateDotnetLayerPolicy({ projects: (await loadDotnetPackageInventory(root)).projects });
const main = async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runDotnetLayerPolicy(root);
  const out = path.join(root, 'artifacts', 'platform-audit');
  await mkdir(out, { recursive: true });
  await Promise.all([
    writeFile(path.join(out, 'dotnet-layer-policy.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(path.join(out, 'dotnet-layer-policy.md'), renderDotnetLayerPolicyMarkdown(report)),
  ]);
  console.log(JSON.stringify(report.summary));
  if (!report.ok) process.exitCode = 2;
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
