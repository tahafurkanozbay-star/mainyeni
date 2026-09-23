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

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}
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
function topLevelBlock(text, key) {
  const source = lines(text);
  const start = source.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (start < 0) return null;
  let end = source.length;
  for (let index = start + 1; index < source.length; index += 1) {
    const line = source[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentation(line) === 0) { end = index; break; }
  }
  return source.slice(start, end);
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
  const block = topLevelBlock(text, 'permissions');
  if (!block) return { ok: false, reason: 'missing-permissions', entries: [] };
  const header = stripComment(block[0]).trim();
  if (/^permissions:\s*(?:write-all|read-all)\s*$/i.test(header)) return { ok: false, reason: 'aggregate-permission', entries: [] };
  const entries = permissionEntries(text);
  if (!entries.some((entry) => entry.scope === 'contents' && entry.level === 'read')) return { ok: false, reason: 'contents-not-read', entries };
  const writable = entries.filter((entry) => WRITE_LEVELS.has(entry.level));
  if (writable.length > 0) return { ok: false, reason: 'write-permission', entries };
  return { ok: true, reason: null, entries };
}
function triggerNames(text) {
  const block = topLevelBlock(text, 'on');
  if (!block) return [];
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
  let inRunBlock = false;
  let runIndent = -1;
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const indent = indentation(line);
    const runMatch = line.match(/^\s*-?\s*run:\s*(.*)$/);
    if (runMatch) {
      inRunBlock = true;
      runIndent = indent;
      if (UNTRUSTED_EVENT_EXPRESSION.test(runMatch[1])) findings.push(index + 1);
      continue;
    }
    if (!inRunBlock) continue;
    if (line.trim() && indent <= runIndent) { inRunBlock = false; continue; }
    if (UNTRUSTED_EVENT_EXPRESSION.test(line)) findings.push(index + 1);
  }
  return findings;
}
function checkoutRefFindings(text) {
  const source = lines(text);
  const findings = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!/^\s*-?\s*uses:\s*actions\/checkout@/.test(source[index])) continue;
    const usesIndent = indentation(source[index]);
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const line = source[cursor];
      if (!line.trim()) continue;
      if (indentation(line) <= usesIndent) break;
      if (/^\s*ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(?:ref|label)\s*\}\}/.test(line)) findings.push(cursor + 1);
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
  test(`${workflow} does not checkout an untrusted PR head ref explicitly`, () => assert.deepEqual(checkoutRefFindings(readWorkflow(workflow)), []));
}

test('permission contract rejects a non-contents write scope', () => {
  const result = permissionContract(`permissions:\n  contents: read\n  issues: write\njobs: {}\n`);
  assert.equal(result.ok, false); assert.equal(result.reason, 'write-permission');
});
test('permission contract rejects actions write access', () => assert.equal(permissionContract(`permissions:\n  contents: read\n  actions: write\njobs: {}\n`).ok, false));
test('permission contract rejects missing contents read', () => {
  const result = permissionContract(`permissions:\n  checks: read\njobs: {}\n`);
  assert.equal(result.ok, false); assert.equal(result.reason, 'contents-not-read');
});
test('permission contract accepts additional explicit read scopes', () => assert.equal(permissionContract(`permissions:\n  contents: read\n  checks: read\n  pull-requests: read\njobs: {}\n`).ok, true));
test('trigger contract detects pull_request_target', () => assert.deepEqual(dangerousTriggers(`on:\n  pull_request_target:\n    branches: [main]\njobs: {}\n`), ['pull_request_target']));
test('trigger contract detects workflow_run', () => assert.deepEqual(dangerousTriggers(`on:\n  workflow_run:\n    workflows: [CI]\njobs: {}\n`), ['workflow_run']));
test('trigger contract allows ordinary pull_request and push', () => assert.deepEqual(dangerousTriggers(`on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\njobs: {}\n`), []));
test('run-expression contract rejects pull request title interpolation', () => {
  const fixture = `steps:\n  - run: echo "${'${{ github.event.pull_request.title }}'}"\n`;
  assert.deepEqual(expressionRunFindings(fixture), [2]);
});
test('run-expression contract rejects multiline pull request body interpolation', () => {
  const fixture = `steps:\n  - run: |\n      printf '%s' "${'${{ github.event.pull_request.body }}'}"\n`;
  assert.deepEqual(expressionRunFindings(fixture), [3]);
});
test('run-expression contract rejects issue comment interpolation', () => {
  const fixture = `steps:\n  - run: echo "${'${{ github.event.comment.body }}'}"\n`;
  assert.deepEqual(expressionRunFindings(fixture), [2]);
});
test('run-expression contract rejects issue title and commit message interpolation', () => {
  const fixture = `steps:\n  - run: echo "${'${{ github.event.issue.title }}'}"\n  - run: echo "${'${{ github.event.head_commit.message }}'}"\n`;
  assert.deepEqual(expressionRunFindings(fixture), [2, 3]);
});
test('run-expression contract allows trusted static github metadata', () => assert.deepEqual(expressionRunFindings(`steps:\n  - run: echo "${'${{ github.sha }}'}"\n`), []));
test('checkout contract rejects explicit untrusted head ref', () => assert.deepEqual(checkoutRefFindings(`steps:\n  - uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      ref: ${'${{ github.event.pull_request.head.ref }}'}\n`), [4]));
test('checkout contract allows default event checkout', () => assert.deepEqual(checkoutRefFindings(`steps:\n  - uses: actions/checkout@0000000000000000000000000000000000000000\n    with:\n      persist-credentials: false\n`), []));
