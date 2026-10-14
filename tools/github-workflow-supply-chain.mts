#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Workflow files are executable supply-chain policy. The audit deliberately
// checks all workflows, not only the files touched in a pull request.
const SHA_PIN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
const find = (code, file, line, detail) => Object.freeze({
  code, file, line, severity: 'error', message: detail,
});
const linesOf = source => String(source).split(/\r?\n/);
const lineNumber = (lines, index) => index >= 0 ? index + 1 : 1;
const isComment = line => /^\s*#/.test(line);
const trimRef = value => value.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Structural inspection of our restricted GitHub Actions dialect.
 * We do not interpret expressions or run untrusted workflow content.
 * Every step action must be pinned to an immutable full commit SHA.
 */
export const auditWorkflowSource = (file, source) => {
  const lines = linesOf(source);
  const findings = [];
  const permissionsAt = lines.findIndex(line => /^permissions:\s*$/.test(line));
  if (permissionsAt < 0) {
    findings.push(find('workflow-permissions-missing', file, 1,
      'Workflow must explicitly restrict the GITHUB_TOKEN permissions.'));
  } else {
    const block = [];
    for (let i = permissionsAt + 1; i < lines.length && /^\s/.test(lines[i]); i++) {
      if (!isComment(lines[i]) && lines[i].trim()) block.push({ line: i + 1, text: lines[i].trim() });
    }
    if (!block.some(item => item.text === 'contents: read')) {
      findings.push(find('workflow-permissions-contents', file, permissionsAt + 1,
        'Workflow requires contents: read and no elevated token permissions.'));
    }
    for (const item of block) {
      if (/\bwrite\b|write-all/i.test(item.text) || item.text === 'contents: write') {
        findings.push(find('workflow-permissions-elevated', file, item.line,
          'Elevated workflow token permissions require a separate reviewed release policy.'));
      }
    }
  }
  // Scalar permission declarations cannot establish a read-only token boundary.
  const scalarPermissionsAt = lines.findIndex(line => /^permissions:\s*\S/.test(line));
  if (scalarPermissionsAt >= 0) {
    findings.push(find('workflow-permissions-scalar', file, scalarPermissionsAt + 1,
      'Workflow permissions must use an explicit read-only contents mapping.'));
  }
  // GitHub/YAML loaders may treat the last duplicate mapping as authoritative.
  // Checking only the first permissions block would miss a later write override.
  const topLevelPermissionLines = lines.flatMap((line, index) =>
    /^permissions:\s*/.test(line) ? [index + 1] : []);
  if (topLevelPermissionLines.length > 1) {
    findings.push(find('workflow-permissions-duplicate', file, topLevelPermissionLines[1],
      'Duplicate workflow permissions can shadow the reviewed read-only token policy.'));
  }
  // YAML permits scalar/list and quoted trigger forms. Checking only the
  // indented mapping form leaves privileged event admission unreviewed.
  // Treat the workflow event map as a single authority. A second YAML key
  // can shadow the reviewed trigger map, including with a quoted 'on' key.
  const triggerHeaders = lines.flatMap((line, index) =>
    /^(?:on|'on'|"on")\s*:/.test(line) ? [index] : []);
  if (triggerHeaders.length === 0) {
    findings.push(find('workflow-trigger-missing', file, 1,
      'Quality workflows must declare an explicit event trigger.'));
  }
  if (triggerHeaders.length > 1) {
    findings.push(find('workflow-trigger-duplicate', file, triggerHeaders[1] + 1,
      'Duplicate workflow triggers can shadow the reviewed event policy.'));
  }
  for (const triggerHeader of triggerHeaders) {
    const header = lines[triggerHeader].replace(/\s+#.*$/, '');
    const privileged = /\b(?:pull_request_target|workflow_run)\b/;
    let untrusted = privileged.test(header);
    if (/\s*:\s*[&*]/.test(header)) {
      findings.push(find('workflow-trigger-alias', file, triggerHeader + 1,
        'Workflow event aliases and anchors require an explicit reviewed trigger map.'));
    }
    for (let i = triggerHeader + 1; i < lines.length &&
      (!lines[i].trim() || /^\s/.test(lines[i])); i++) {
      if (isComment(lines[i])) continue;
      if (/^  ['"]?(?:pull_request_target|workflow_run)['"]?\s*:/.test(lines[i])) {
        untrusted = true;
      }
      if (/^  <<\s*:/.test(lines[i])) {
        findings.push(find('workflow-trigger-merge-alias', file, i + 1,
          'YAML merge aliases cannot supply reviewed workflow events.'));
      }
    }
    if (untrusted) {
      findings.push(find('workflow-untrusted-trigger', file, triggerHeader + 1,
        'Privileged pull_request_target/workflow_run triggers are not permitted in quality workflows.'));
    }
  }
  // Direct GitHub expression interpolation inside a shell command is an injection
  // hazard when any part of the expression can be influenced by a PR author.
  // Values must cross into scripts through environment variables instead.
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i].match(/^\s{8}run:\s*(.*)$/);
    if (!run) continue;
    if (run[1].includes('${{')) findings.push(find('workflow-shell-expression', file, i + 1,
      'Pass GitHub expressions through env instead of interpolating shell commands.'));
    if (!/^[|>][-+]?\s*(?:#.*)?$/.test(run[1])) continue;
    for (let j = i + 1; j < lines.length && (/^\s{10}/.test(lines[j]) || !lines[j].trim()); j++) {
      if (lines[j].includes('${{')) findings.push(find('workflow-shell-expression', file, j + 1,
        'Pass GitHub expressions through env instead of interpolating shell commands.'));
    }
  }
  // Check each job independently. A timeout on one job must not hide an
  // unbounded job elsewhere in the same workflow.
  const jobsStart = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsStart >= 0) {
    for (let i = jobsStart + 1; i < lines.length; i++) {
      if (lines[i] && !/^\s/.test(lines[i])) break;
      const job = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (!job) continue;
      let end = i + 1;
      while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end]) &&
        (!lines[end] || /^\s/.test(lines[end]))) end++;
      const timeouts = lines.slice(i + 1, end).filter(line =>
        /^    timeout-minutes:\s*(?:[1-9][0-9]*)\s*$/.test(line));
      if (timeouts.length !== 1 || Number(timeouts[0].trim().split(':')[1]) > 120) {
        findings.push(find('workflow-job-timeout-invalid', file, i + 1,
          'Every job requires exactly one positive timeout of at most 120 minutes.'));
      }
      // Reusable workflow jobs bypass step-action pinning and can introduce
      // an independently privileged execution graph. Require explicit review
      // before admitting this syntax to quality workflows.
      const reusableAt = lines.findIndex((line, index) =>
        index > i && index < end && /^    uses:\s*/.test(line));
      if (reusableAt >= 0) {
        findings.push(find('workflow-job-reusable-unreviewed', file, reusableAt + 1,
          'Reusable workflow jobs require a dedicated provenance and permission policy.'));
      }
      // A job override replaces the top-level token permission map.
      const jobPermissionAt = lines.findIndex((line, index) =>
        index > i && index < end && /^    permissions:\s*/.test(line));
      const jobPermissionDeclarations = lines.slice(i + 1, end).filter(line =>
        /^    permissions:\s*/.test(line));
      if (jobPermissionDeclarations.length > 1) {
        findings.push(find('workflow-job-permissions-duplicate', file, jobPermissionAt + 1,
          'Duplicate job permission declarations can shadow reviewed token permissions.'));
      }
      if (jobPermissionAt >= 0) {
        const declaration = lines[jobPermissionAt].trim();
        const block = [];
        for (let j = jobPermissionAt + 1; j < end; j++) {
          if (lines[j].trim() && !/^ {6}/.test(lines[j])) break;
          if (lines[j].trim() && !isComment(lines[j])) {
            block.push({ line: j + 1, text: lines[j].trim() });
          }
        }
        if (declaration !== 'permissions:') {
          findings.push(find('workflow-job-permissions-format', file, jobPermissionAt + 1,
            'Job permissions must use an explicit read-only mapping.'));
        }
        if (!block.some(item => item.text === 'contents: read')) {
          findings.push(find('workflow-job-permissions-contents', file, jobPermissionAt + 1,
            'Job permission overrides must retain contents: read.'));
        }
        if (/\bwrite\b|write-all/i.test(declaration)) {
          findings.push(find('workflow-job-permissions-elevated', file, jobPermissionAt + 1,
            'Job-level write permissions are not allowed in quality workflows.'));
        }
        for (const item of block) {
          if (/\bwrite\b|write-all/i.test(item.text)) {
            findings.push(find('workflow-job-permissions-elevated', file, item.line,
              'Job-level write permissions are not allowed in quality workflows.'));
          }
        }
      }
      i = end - 1;
    }
  }
  const actions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment(line)) continue;
    const match = line.match(/^\s{6,}(?:-\s+)?uses:\s*(.+?)\s*$/);
    if (!match) continue;
    const reference = trimRef(match[1]);
    actions.push(Object.freeze({ line: i + 1, reference }));
    if (!SHA_PIN.test(reference)) {
      findings.push(find('workflow-action-unpinned', file, i + 1,
        'Third-party actions must use a 40-character lowercase commit SHA.'));
    }
    if (!reference.startsWith('actions/checkout@')) continue;
    // Find the enclosing step, not an arbitrary later checkout setting.
    let start = i;
    while (start > 0 && !/^\s{6}-\s/.test(lines[start])) start--;
    let end = i + 1;
    while (end < lines.length && !/^\s{6}-\s/.test(lines[end])) end++;
    const step = lines.slice(start, end).join('\n');
    if (!/^\s{10}persist-credentials:\s*false\s*(?:#.*)?$/m.test(step)) {
      findings.push(find('workflow-checkout-credentials', file, i + 1,
        'Checkout must explicitly disable persisted credentials.'));
    }
  }
  if (actions.length === 0) {
    findings.push(find('workflow-actions-missing', file, 1,
      'Quality workflow must use reviewed immutable action references.'));
  }
  const jobTimeouts = lines.filter(line => /^\s{4}timeout-minutes:\s*\d+\s*$/.test(line));
  if (jobTimeouts.length === 0) {
    findings.push(find('workflow-timeout-missing', file, 1,
      'At least one bounded job timeout is required.'));
  }
  return Object.freeze({
    file, actions: Object.freeze(actions),
    findings: Object.freeze(findings),
  });
};

export const evaluateWorkflowSupplyChain = entries => {
  if (!Array.isArray(entries)) throw new TypeError('workflow entries must be an array');
  const findings = [], inventory = [], seen = new Set();
  for (const entry of [...entries].sort((a, b) => a.file.localeCompare(b.file, 'en'))) {
    if (!/^\.github\/workflows\/[a-z0-9][a-z0-9-]*\.ya?ml$/.test(entry.file)) {
      findings.push(find('workflow-file-invalid', String(entry.file), 1,
        'Only canonical .github/workflows/*.yml files are audited.'));
      continue;
    }
    if (seen.has(entry.file)) {
      findings.push(find('workflow-file-duplicate', entry.file, 1, 'Duplicate workflow entry.'));
      continue;
    }
    seen.add(entry.file);
    const report = auditWorkflowSource(entry.file, entry.source);
    inventory.push(Object.freeze({ file: entry.file, actions: report.actions }));
    findings.push(...report.findings);
  }
  if (inventory.length === 0) {
    findings.push(find('workflow-inventory-empty', '.github/workflows', 1,
      'No quality workflows were found.'));
  }
  findings.sort((a, b) => a.file.localeCompare(b.file, 'en') ||
    a.line - b.line || a.code.localeCompare(b.code, 'en'));
  return Object.freeze({
    ok: findings.length === 0,
    summary: Object.freeze({ workflows: inventory.length,
      actions: inventory.reduce((sum, entry) => sum + entry.actions.length, 0),
      violations: findings.length }),
    fingerprint: sha(inventory),
    workflows: Object.freeze(inventory), findings: Object.freeze(findings),
  });
};
export const loadWorkflowInventory = async root => {
  const dir = path.join(root, '.github', 'workflows');
  const files = (await readdir(dir)).filter(file => /\.ya?ml$/.test(file)).sort();
  return Promise.all(files.map(async file => ({
    file: '.github/workflows/' + file,
    source: await readFile(path.join(dir, file), 'utf8'),
  })));
};
const escapeMd = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
export const renderWorkflowSupplyChainMarkdown = report => [
  '# GitHub Actions Supply-Chain Contract', '',
  '- Gate: **' + (report.ok ? 'PASS' : 'FAIL') + '**',
  '- Fingerprint: ' + report.fingerprint,
  '- Workflows: **' + report.summary.workflows + '**',
  '- Pinned actions: **' + report.summary.actions + '**',
  '- Violations: **' + report.summary.violations + '**', '',
  '| Workflow | Pinned actions |', '| --- | ---: |',
  ...report.workflows.map(item => '| ' + escapeMd(item.file) + ' | ' + item.actions.length + ' |'),
  '', '## Findings', '',
  '| Code | File | Line | Detail |', '| --- | --- | ---: | --- |',
  ...(report.findings.length ? report.findings.map(item =>
    '| ' + item.code + ' | ' + escapeMd(item.file) + ' | ' + item.line +
    ' | ' + escapeMd(item.message) + ' |') : ['| _none_ | | | |']), '',
].join('\n');
export const runWorkflowSupplyChain = async root =>
  evaluateWorkflowSupplyChain(await loadWorkflowInventory(root));
const main = async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const report = await runWorkflowSupplyChain(root);
  const dir = path.join(root, 'artifacts', 'platform-audit');
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'workflow-supply-chain.json'), JSON.stringify(report, null, 2) + '\n'),
    writeFile(path.join(dir, 'workflow-supply-chain.md'), renderWorkflowSupplyChainMarkdown(report)),
  ]);
  console.log(JSON.stringify(report.summary));
  if (!report.ok) process.exitCode = 2;
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
