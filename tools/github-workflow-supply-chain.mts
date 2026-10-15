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
    for (let i = permissionsAt + 1; i < lines.length; i++) {
      // YAML blank lines and comments cannot terminate the permission mapping.
      if (!lines[i].trim() || isComment(lines[i])) continue;
      if (!/^\s/.test(lines[i])) break;
      block.push({ line: i + 1, text: lines[i].trim() });
    }
    if (!block.some(item => item.text === 'contents: read')) {
      findings.push(find('workflow-permissions-contents', file, permissionsAt + 1,
        'Workflow requires contents: read and no elevated token permissions.'));
    }
    for (const item of block) {
      if (/^<<\s*:|^[^\s:]+\s*:\s*(?:&[A-Za-z0-9_-]+\s+)?\*[A-Za-z0-9_-]+(?:\s|$)/.test(item.text)) {
        findings.push(find('workflow-permissions-alias', file, item.line,
          'Permission merge keys and scalar aliases cannot import unreviewed token grants.'));
      }
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
    /^(?:permissions|['"]permissions['"])\s*:/.test(line) ? [index + 1] : []);
  for (const lineNumber of topLevelPermissionLines) {
    if (!/^permissions:\s*(?:#.*)?$/.test(lines[lineNumber - 1])) {
      findings.push(find('workflow-permissions-format', file, lineNumber,
        'Workflow permissions must use an unquoted canonical mapping key.'));
    }
  }
  if (topLevelPermissionLines.length > 1) {
    findings.push(find('workflow-permissions-duplicate', file, topLevelPermissionLines[1],
      'Duplicate workflow permissions can shadow the reviewed read-only token policy.'));
  }
  // A duplicate or noncanonical jobs key can hide an unreviewed execution graph.
  const topLevelJobsLines = lines.flatMap((line, index) =>
    /^(?:jobs|['"]jobs['"])\s*:/.test(line) ? [index + 1] : []);
  if (topLevelJobsLines.length === 0) {
    findings.push(find('workflow-jobs-missing', file, 1,
      'Quality workflows must declare an explicit jobs mapping.'));
  }
  if (topLevelJobsLines.length > 1) {
    findings.push(find('workflow-jobs-duplicate', file, topLevelJobsLines[1],
      'Duplicate jobs mappings can shadow reviewed job policies.'));
  }
  for (const lineNumber of topLevelJobsLines) {
    if (!/^jobs:\s*$/.test(lines[lineNumber - 1])) {
      findings.push(find('workflow-jobs-format', file, lineNumber,
        'Jobs must use a canonical unquoted mapping key.'));
    }
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
      (!lines[i].trim() || /^\s/.test(lines[i]) || isComment(lines[i])); i++) {
      if (isComment(lines[i])) continue;
      if (/^  ['"]?(?:pull_request_target|workflow_run)['"]?\s*:/.test(lines[i]) ||
        /^  -\s*['"]?(?:pull_request_target|workflow_run)['"]?\s*(?:#.*)?$/.test(lines[i])) {
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
  // Expressions in both mapping-style and inline "- run:" steps execute in
  // a shell. Restrict run keys to canonical forms before inspecting values.
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i])) continue;
    if (/^(?: {6}-\s+| {8})(?:['"]run['"]|run\s+)\s*:/.test(lines[i])) {
      findings.push(find('workflow-shell-key-noncanonical', file, i + 1,
        'Shell run keys must use canonical unquoted syntax for injection review.'));
    }
    const inline = lines[i].match(/^ {6}-\s+run:\s*(.*)$/);
    const nested = lines[i].match(/^ {8}run:\s*(.*)$/);
    const run = inline ?? nested;
    if (!run) continue;
    if (run[1].includes('${{')) findings.push(find('workflow-shell-expression', file, i + 1,
      'Pass GitHub expressions through env instead of interpolating shell commands.'));
    if (!/^[|>][-+]?\s*(?:#.*)?$/.test(run[1])) continue;
    const bodyIndent = inline ? /^ {8}/ : /^ {10}/;
    for (let j = i + 1; j < lines.length && (bodyIndent.test(lines[j]) || !lines[j].trim()); j++) {
      if (lines[j].includes('${{')) findings.push(find('workflow-shell-expression', file, j + 1,
        'Pass GitHub expressions through env instead of interpolating shell commands.'));
    }
  }
  // Check each job independently. A timeout on one job must not hide an
  // unbounded job elsewhere in the same workflow.
  const jobsStart = lines.findIndex(line => /^jobs:\s*$/.test(line));
  if (jobsStart >= 0) {
    // Quoted, merged, aliased or whitespace-separated job IDs must not
    // bypass the per-job timeout and token checks below.
    for (let j = jobsStart + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() && !/^\s/.test(line) && !isComment(line)) break;
      if (!/^  \S/.test(line) || isComment(line)) continue;
      if (!/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
        findings.push(find('workflow-job-key-noncanonical', file, j + 1,
          'Jobs require canonical plain IDs and block mappings for timeout and token review.'));
      }
    }
    const seenJobNames = new Set();
    for (let i = jobsStart + 1; i < lines.length; i++) {
      if (lines[i].trim() && !/^\s/.test(lines[i]) && !isComment(lines[i])) break;
      const job = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (!job) continue;
      if (seenJobNames.has(job[1])) {
        findings.push(find('workflow-job-duplicate', file, i + 1,
          'Duplicate job names can shadow reviewed timeout and token policies.'));
      }
      seenJobNames.add(job[1]);
      let end = i + 1;
      while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end]) &&
        (!lines[end].trim() || /^\s/.test(lines[end]) || isComment(lines[end]))) end++;
      // Count every YAML spelling of the timeout key, including invalid and
      // duplicate declarations. Counting only valid values lets a later YAML
      // mapping silently shadow a previously reviewed bounded timeout.
      const jobLines = lines.slice(i + 1, end);
      const timeoutDeclarations = jobLines.flatMap((line, offset) =>
        /^ {4}(?:timeout-minutes|['"]timeout-minutes['"])\s*:/.test(line)
          ? [{ line: i + offset + 2, text: line }] : []);
      const timeout = timeoutDeclarations.length === 1
        ? timeoutDeclarations[0].text.match(/^    timeout-minutes:\s*([1-9][0-9]*)\s*$/)
        : null;
      if (!timeout || Number(timeout[1]) > 120) {
        findings.push(find('workflow-job-timeout-invalid', file, i + 1,
          'Every job requires exactly one canonical positive timeout of at most 120 minutes.'));
      }
      for (let offset = 0; offset < jobLines.length; offset++) {
        if (/^ {4}<<\s*:/.test(jobLines[offset])) {
          findings.push(find('workflow-job-merge-alias', file, i + offset + 2,
            'Job merge aliases cannot import unreviewed timeout or execution fields.'));
        }
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
      const jobPermissionDeclarations = lines.slice(i + 1, end).flatMap((line, offset) =>
        /^    (?:permissions|['"]permissions['"])\s*:/.test(line)
          ? [{ line: i + offset + 2, text: line }] : []);
      if (jobPermissionDeclarations.length > 1) {
        findings.push(find('workflow-job-permissions-duplicate', file, jobPermissionDeclarations[1].line,
          'Duplicate job permission declarations can shadow reviewed token permissions.'));
      }
      for (const declaration of jobPermissionDeclarations) {
        if (!/^    permissions:\s*(?:#.*)?$/.test(declaration.text)) {
          findings.push(find('workflow-job-permissions-format', file, declaration.line,
            'Job permissions require a canonical unquoted read-only mapping.'));
        }
      }
      if (jobPermissionAt >= 0) {
        const declaration = lines[jobPermissionAt].trim();
        const block = [];
        for (let j = jobPermissionAt + 1; j < end; j++) {
          if (isComment(lines[j])) continue;
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
          if (/^<<\s*:|^[^\s:]+\s*:\s*(?:&[A-Za-z0-9_-]+\s+)?\*[A-Za-z0-9_-]+(?:\s|$)/.test(item.text)) {
            findings.push(find('workflow-job-permissions-alias', file, item.line,
              'Job permission merge keys and scalar aliases cannot import unreviewed token grants.'));
          }
          if (/\bwrite\b|write-all/i.test(item.text)) {
            findings.push(find('workflow-job-permissions-elevated', file, item.line,
              'Job-level write permissions are not allowed in quality workflows.'));
          }
        }
      }
      i = end - 1;
    }
  }
  // YAML flow sequences, aliases and merged step mappings can resolve to
  // executable uses/run keys without exposing a canonical line to the
  // provenance and shell-injection checks. Fail closed on those structures.
  if (jobsStart >= 0) {
    let inJob = false;
    let stepsSeen = 0;
    for (let i = jobsStart + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() && !/^\s/.test(line) && !isComment(line)) break;
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
        inJob = true;
        stepsSeen = 0;
        continue;
      }
      if (!inJob || isComment(line)) continue;
      if (/^    (?:steps|['"]steps['"])\s*:/.test(line)) {
        stepsSeen++;
        if (stepsSeen > 1) {
          findings.push(find('workflow-steps-duplicate', file, i + 1,
            'Duplicate steps mappings can shadow the reviewed execution sequence.'));
        }
        if (!/^    steps:\s*(?:#.*)?$/.test(line)) {
          findings.push(find('workflow-steps-format', file, i + 1,
            'Steps must use a canonical block sequence without aliases or flow mappings.'));
        }
      }
      if (/^ {6}-\s*\S/.test(line) &&
        !/^ {6}-\s+(?:name|id|uses|run|if|env|with|shell|working-directory|continue-on-error|timeout-minutes):/.test(line)) {
        findings.push(find('workflow-step-structure-unreviewed', file, i + 1,
          'Step entries must begin with a canonical mapping key, not a flow map or alias.'));
      }
      if (/^ {8}<<\s*:/.test(line) ||
        /^(?: {8}| {6}-\s+)(?:uses|run):\s*[&*][A-Za-z0-9_-]+(?:\s|$)/.test(line)) {
        findings.push(find('workflow-step-structure-unreviewed', file, i + 1,
          'Step merge aliases and executable scalar aliases are not reviewed.'));
      }
    }
  }
  // YAML accepts quoted keys and whitespace before colons; these forms must
  // not bypass step-action provenance or reusable-workflow admission.
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i])) continue;
    if (/^(?: {4}| {8}| {6}-\s+)(?:['"]uses['"]|uses\s+)\s*:/.test(lines[i])) {
      findings.push(find('workflow-action-key-noncanonical', file, i + 1,
        'Action and reusable-workflow uses keys must use canonical unquoted syntax.'));
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
