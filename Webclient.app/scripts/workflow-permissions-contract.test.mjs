import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEBCLIENT_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(WEBCLIENT_ROOT, '..');
const WORKFLOWS = Object.freeze([
  '.github/workflows/webclient-quality.yml',
  '.github/workflows/release-evidence-contract.yml',
]);
const WRITE_LEVELS = new Set(['write', 'write-all']);
const DANGEROUS_TRIGGERS = new Set(['pull_request_target', 'workflow_run']);
const UNTRUSTED_EVENT_EXPRESSION = /\$\{\{[^}\n]*github\.event\.(?:pull_request\.(?:title|body)|issue\.(?:title|body)|comment\.body|head_commit\.message)[^}\n]*\}\}/;
const UNTRUSTED_CHECKOUT_REF = /\$\{\{\s*(?:github\.head_ref|github\.event\.pull_request\.head\.(?:ref|label|sha))\s*\}\}/;
const UNTRUSTED_CHECKOUT_REPOSITORY = /\$\{\{[^}\n]*(?:github\.event\.pull_request\.head\.repo\.(?:full_name|name)|github\.head_repository)[^}\n]*\}\}/;

function readWorkflow(relativePath) { return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'); }
function lines(text) { return text.split(/\r?\n/); }
function indentation(line) { return line.length - line.trimStart().length; }
function stripComment(line) {
  let quoted = false;
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && (!quoted || char === quote)) {
      if (quoted) { quoted = false; quote = ''; } else { quoted = true; quote = char; }
      continue;
    }
    if (char === '#' && !quoted) return line.slice(0, index);
  }
  return line;
}
function scalar(value) { return stripComment(value).trim().replace(/^['"]|['"]$/g, '').toLowerCase(); }
function topLevelDeclaration(text, key) {
  const source = lines(text);
  const index = source.findIndex((line) => new RegExp(`^${key}:`).test(stripComment(line)));
  if (index < 0) return null;
  return Object.freeze({ index, line: stripComment(source[index]).trim(), source });
}
function topLevelBlock(text, key) {
  const declaration = topLevelDeclaration(text, key);
  if (!declaration) return null;
  let end = declaration.source.length;
  for (let index = declaration.index + 1; index < declaration.source.length; index += 1) {
    const line = declaration.source[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentation(line) === 0) { end = index; break; }
  }
  return declaration.source.slice(declaration.index, end);
}
function permissionEntries(text) {
  const block = topLevelBlock(text, 'permissions');
  if (!block) return [];
  const entries = [];
  for (const line of block.slice(1)) {
    const match = stripComment(line).match(/^\s+([a-z-]+):\s*([^\s]+)\s*$/i);
    if (match) entries.push(Object.freeze({ scope: match[1], level: scalar(match[2]) }));
  }
  return entries;
}
function permissionContract(text) {
  const declaration = topLevelDeclaration(text, 'permissions');
  if (!declaration) return { ok: false, reason: 'missing-permissions', entries: [] };
  const inline = declaration.line.match(/^permissions:\s*(.*?)\s*$/i)?.[1] ?? '';
  if (inline) {
    const level = scalar(inline);
    if (level === 'read-all' || WRITE_LEVELS.has(level)) return { ok: false, reason: 'aggregate-permission', entries: [] };
    if (level === '{}') return { ok: false, reason: 'contents-not-read', entries: [] };
    return { ok: false, reason: 'unsupported-permission-scalar', entries: [] };
  }
  const entries = permissionEntries(text);
  if (!entries.some((entry) => entry.scope === 'contents' && entry.level === 'read')) return { ok: false, reason: 'contents-not-read', entries };
  if (entries.some((entry) => WRITE_LEVELS.has(entry.level))) return { ok: false, reason: 'write-permission', entries };
  return { ok: true, reason: null, entries };
}
function inlineTriggerNames(value) {
  const normalized = stripComment(value).trim();
  if (!normalized) return [];
  if (normalized.startsWith('[') && normalized.endsWith(']')) return normalized.slice(1, -1).split(',').map((item) => scalar(item)).filter(Boolean);
  if (/^[a-zA-Z_][\w-]*$/.test(normalized)) return [normalized];
  return [];
}
function triggerNames(text) {
  const declaration = topLevelDeclaration(text, 'on');
  if (!declaration) return [];
  const inline = declaration.line.match(/^on:\s*(.*?)\s*$/)?.[1] ?? '';
  if (inline) return inlineTriggerNames(inline);
  const block = topLevelBlock(text, 'on') ?? [];
  const names = [];
  for (const line of block.slice(1)) {
    const match = stripComment(line).match(/^\s{2}([a-zA-Z_][\w-]*):(?:\s|$)/);
    if (match) names.push(match[1]);
  }
  return names;
}
function dangerousTriggers(text) { return triggerNames(text).filter((name) => DANGEROUS_TRIGGERS.has(name)); }
function expressionRunFindings(text) {
  const source = lines(text);
  const findings = [];
  let runIndent = null;
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const runMatch = line.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
    if (runMatch) {
      runIndent = indentation(line);
      if (UNTRUSTED_EVENT_EXPRESSION.test(runMatch[1])) findings.push(index + 1);
      continue;
    }
    if (runIndent === null) continue;
    if (line.trim() && indentation(line) <= runIndent) { runIndent = null; continue; }
    if (UNTRUSTED_EVENT_EXPRESSION.test(line)) findings.push(index + 1);
  }
  return findings;
}
function checkoutInputFindings(text) {
  const source = lines(text);
  const findings = [];
  for (let index = 0; index < source.length; index += 1) {
    const usesLine = source[index];
    const usesMatch = usesLine.match(/^(\s*)(-\s+)?uses:\s*actions\/checkout@/);
    if (!usesMatch) continue;
    const usesIndent = usesMatch[1].length;
    const compactStep = Boolean(usesMatch[2]);
    const stepIndent = compactStep ? usesIndent : Math.max(0, usesIndent - 2);
    let withIndent = null;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const line = source[cursor];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const clean = stripComment(line);
      const indent = indentation(line);
      if (/^\s*-\s+(?:name|uses|run):/.test(clean) && indent <= stepIndent) break;
      if (indent < usesIndent) break;
      if (withIndent === null) {
        if (/^\s*with:\s*$/.test(clean) && (indent === usesIndent || indent > usesIndent)) {
          withIndent = indent;
          continue;
        }
        if (indent === usesIndent && !compactStep) break;
        continue;
      }
      if (indent <= withIndent) break;
      const inputMatch = clean.match(/^\s*(ref|repository):\s*(.*?)\s*$/);
      if (!inputMatch) continue;
      const [, input, value] = inputMatch;
      if (input === 'ref' && UNTRUSTED_CHECKOUT_REF.test(value)) findings.push(Object.freeze({ line: cursor + 1, input }));
      if (input === 'repository' && UNTRUSTED_CHECKOUT_REPOSITORY.test(value)) findings.push(Object.freeze({ line: cursor + 1, input }));
    }
  }
  return findings;
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} grants no write-capable top-level permission`, () => {
    const result = permissionContract(readWorkflow(workflow));
    assert.equal(result.ok, true, `${workflow} permission contract failed: ${result.reason}`);
  });
  test(`${workflow} avoids privileged event triggers`, () => assert.deepEqual(dangerousTriggers(readWorkflow(workflow)), []));
  test(`${workflow} keeps untrusted event text out of shell run bodies`, () => assert.deepEqual(expressionRunFindings(readWorkflow(workflow)), []));
  test(`${workflow} does not select attacker-controlled checkout inputs`, () => assert.deepEqual(checkoutInputFindings(readWorkflow(workflow)), []));
}

test('permission contract rejects non-contents write scopes', () => {
  for (const scope of ['issues', 'actions', 'checks', 'pull-requests', 'deployments']) {
    const result = permissionContract(`permissions:\n  contents: read\n  ${scope}: write\njobs: {}\n`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write-permission');
  }
});
test('permission contract rejects missing explicit contents read', () => assert.equal(permissionContract(`permissions:\n  checks: read\njobs: {}\n`).reason, 'contents-not-read'));
test('permission contract accepts additional explicit read scopes', () => assert.equal(permissionContract(`permissions:\n  contents: read\n  checks: read\n  pull-requests: read\njobs: {}\n`).ok, true));
test('permission contract rejects aggregate and unknown inline scalars', () => {
  for (const value of ['write-all', 'read-all', '{}', 'custom']) assert.equal(permissionContract(`permissions: ${value}\njobs: {}\n`).ok, false);
});
test('trigger contract detects block privileged triggers', () => {
  assert.deepEqual(dangerousTriggers(`on:\n  pull_request_target:\n    branches: [main]\n  workflow_run:\n    workflows: [CI]\njobs: {}\n`), ['pull_request_target', 'workflow_run']);
});
test('trigger contract detects inline privileged triggers', () => {
  assert.deepEqual(dangerousTriggers(`on: pull_request_target\njobs: {}\n`), ['pull_request_target']);
  assert.deepEqual(dangerousTriggers(`on: [push, pull_request_target]\njobs: {}\n`), ['pull_request_target']);
  assert.deepEqual(dangerousTriggers(`on: ["pull_request", "workflow_run"]\njobs: {}\n`), ['workflow_run']);
});
test('trigger contract allows ordinary pull request and push forms', () => {
  assert.deepEqual(dangerousTriggers(`on: [pull_request, push]\njobs: {}\n`), []);
  assert.deepEqual(dangerousTriggers(`on:\n  pull_request:\n  push:\njobs: {}\n`), []);
});
test('run-expression contract rejects attacker-controlled event text', () => {
  const fixture = `steps:\n  - run: echo "${'${{ github.event.pull_request.title }}'}"\n  - run: |\n      printf '%s' "${'${{ github.event.pull_request.body }}'}"\n  - run: echo "${'${{ github.event.comment.body }}'}"\n  - run: echo "${'${{ github.event.issue.title }}'}"\n  - run: echo "${'${{ github.event.head_commit.message }}'}"\n`;
  assert.deepEqual(expressionRunFindings(fixture), [2, 4, 5, 6, 7]);
});
test('run-expression contract allows trusted static github metadata', () => assert.deepEqual(expressionRunFindings(`steps:\n  - run: echo "${'${{ github.sha }}'}"\n`), []));

test('checkout contract rejects compact-step attacker-controlled refs', () => {
  for (const ref of ['github.event.pull_request.head.ref', 'github.event.pull_request.head.sha', 'github.head_ref']) {
    const fixture = `steps:\n  - uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      ref: ${'${{'} ${ref} ${'}}'}\n`;
    assert.deepEqual(checkoutInputFindings(fixture), [{ line: 4, input: 'ref' }]);
  }
});
test('checkout contract rejects compact-step attacker-controlled repositories', () => {
  const fixture = `steps:\n  - uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      repository: ${'${{ github.event.pull_request.head.repo.full_name }}'}\n`;
  assert.deepEqual(checkoutInputFindings(fixture), [{ line: 4, input: 'repository' }]);
});
test('checkout contract rejects attacker-controlled repository in a named step', () => {
  const fixture = `steps:\n  - name: Checkout candidate\n    uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      repository: ${'${{ github.event.pull_request.head.repo.full_name }}'}\n`;
  assert.deepEqual(checkoutInputFindings(fixture), [{ line: 5, input: 'repository' }]);
});
test('checkout contract allows static reviewed repository and credential hardening sibling', () => {
  const fixture = `steps:\n  - name: Checkout candidate\n    uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      repository: tahafurkanozbay-star/mainyeni\n      persist-credentials: false\n  - name: Next step\n    run: echo ok\n`;
  assert.deepEqual(checkoutInputFindings(fixture), []);
});
test('checkout contract does not bleed with inputs across adjacent named steps', () => {
  const fixture = `steps:\n  - name: Checkout candidate\n    uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      persist-credentials: false\n  - name: Harmless action\n    uses: example/action@0000000000000000000000000000000000000000\n    with:\n      repository: ${'${{ github.event.pull_request.head.repo.full_name }}'}\n`;
  assert.deepEqual(checkoutInputFindings(fixture), []);
});
test('checkout contract allows default event checkout', () => assert.deepEqual(checkoutInputFindings(`steps:\n  - uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      persist-credentials: false\n`), []));
