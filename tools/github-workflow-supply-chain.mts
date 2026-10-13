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
  if (lines.some(line => /^\s{2}(pull_request_target|workflow_run):/.test(line))) {
    findings.push(find('workflow-untrusted-trigger', file, 1,
      'Privileged pull_request_target/workflow_run triggers are not permitted in quality workflows.'));
  }
  // Direct GitHub expression interpolation inside a shell command is an injection
  // hazard when any part of the expression can be influenced by a PR author.
  // Values must cross into scripts through environment variables instead.
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i].match(/^\\s{8}run:\\s*(.*)$/);
    if (!run) continue;
    if (run[1].includes('${{')) findings.push(find('workflow-shell-expression', file, i + 1,
      'Pass GitHub expressions through env instead of interpolating shell commands.'));
    if (!/^[|>][-+]?\\s*(?:#.*)?$/.test(run[1])) continue;
    for (let j = i + 1; j < lines.length && (/^\\s{10}/.test(lines[j]) || !lines[j].trim()); j++) {
      if (lines[j].includes('${{')) findings.push(find('workflow-shell-expression', file, j + 1,
        'Pass GitHub expressions through env instead of interpolating shell commands.'));
    }
  }
  // Check each job independently. A timeout on one job must not hide an
  // unbounded job elsewhere in the same workflow.
  const jobsStart = lines.findIndex(line => /^jobs:\\s*$/.test(line));
  if (jobsStart >= 0) {
    for (let i = jobsStart + 1; i < lines.length; i++) {
      if (lines[i] && !/^\\s/.test(lines[i])) break;
      const job = lines[i].match(/^  ([A-Za-z0-9_-]+):\\s*$/);
      if (!job) continue;
      let end = i + 1;
      while (end < lines.length && !/^  [A-Za-z0-9_-]+:\\s*$/.test(lines[end]) &&
        (!lines[end] || /^\\s/.test(lines[end]))) end++;
      const timeouts = lines.slice(i + 1, end).filter(line =>
        /^    timeout-minutes:\\s*(?:[1-9][0-9]*)\\s*$/.test(line));
      if (timeouts.length !== 1 || Number(timeouts[0].trim().split(':')[1]) > 120) {
        findings.push(find('workflow-job-timeout-invalid', file, i + 1,
          'Every job requires exactly one positive timeout of at most 120 minutes.'));
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
