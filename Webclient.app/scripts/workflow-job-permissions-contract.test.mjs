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

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function lines(text) {
  return text.split(/\r?\n/);
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (char === '#' && !quote) return line.slice(0, index);
  }
  return line;
}

function scalar(value) {
  return stripComment(value).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function jobBlocks(text) {
  const source = lines(text);
  const jobsIndex = source.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsIndex < 0) return [];
  const blocks = [];
  for (let index = jobsIndex + 1; index < source.length; index += 1) {
    const line = source[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentation(line) === 0) break;
    const match = stripComment(line).match(/^  ([A-Za-z_][\w-]*):\s*$/);
    if (!match) continue;
    const start = index;
    let end = source.length;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const candidate = source[cursor];
      if (!candidate.trim() || /^\s*#/.test(candidate)) continue;
      if (indentation(candidate) === 0 || /^  [A-Za-z_][\w-]*:\s*(?:#.*)?$/.test(candidate)) {
        end = cursor;
        break;
      }
    }
    blocks.push(Object.freeze({ name: match[1], start: start + 1, lines: source.slice(start, end) }));
  }
  return blocks;
}

function permissionHeader(blockLines) {
  for (let index = 1; index < blockLines.length; index += 1) {
    const line = blockLines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentation(line) <= 2) break;
    const match = stripComment(line).match(/^    permissions:\s*(.*)$/);
    if (match) return { index, value: scalar(match[1]) };
  }
  return null;
}

function permissionEntries(blockLines, headerIndex) {
  const entries = [];
  for (let index = headerIndex + 1; index < blockLines.length; index += 1) {
    const line = blockLines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentation(line) <= 4) break;
    const match = stripComment(line).match(/^\s{6}([a-z-]+):\s*([^\s]+)\s*$/i);
    if (match) entries.push(Object.freeze({ scope: match[1], level: scalar(match[2]) }));
  }
  return entries;
}

function jobPermissionFindings(text) {
  const findings = [];
  for (const job of jobBlocks(text)) {
    const header = permissionHeader(job.lines);
    if (!header) continue;
    if (header.value === 'write-all' || header.value === 'read-all') {
      findings.push(Object.freeze({ job: job.name, reason: 'aggregate-permission', line: job.start + header.index }));
      continue;
    }
    if (header.value && header.value !== '{}') {
      findings.push(Object.freeze({ job: job.name, reason: 'unexpected-permission-scalar', line: job.start + header.index }));
      continue;
    }
    for (const entry of permissionEntries(job.lines, header.index)) {
      if (WRITE_LEVELS.has(entry.level)) {
        findings.push(Object.freeze({ job: job.name, reason: `write-permission:${entry.scope}`, line: job.start + header.index }));
      }
    }
  }
  return findings;
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} cannot widen token permissions at job scope`, () => {
    assert.deepEqual(jobPermissionFindings(readWorkflow(workflow)), []);
  });
}

test('detects contents write on a job despite top-level contents read', () => {
  const fixture = `permissions:\n  contents: read\njobs:\n  quality:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n`;
  assert.deepEqual(jobPermissionFindings(fixture).map(({ job, reason }) => ({ job, reason })), [
    { job: 'quality', reason: 'write-permission:contents' },
  ]);
});

test('detects issues write on a job', () => {
  const fixture = `jobs:\n  audit:\n    permissions:\n      contents: read\n      issues: write\n    runs-on: ubuntu-latest\n`;
  assert.equal(jobPermissionFindings(fixture)[0]?.reason, 'write-permission:issues');
});

test('detects actions write on a job', () => {
  const fixture = `jobs:\n  audit:\n    permissions:\n      actions: write\n    runs-on: ubuntu-latest\n`;
  assert.equal(jobPermissionFindings(fixture)[0]?.reason, 'write-permission:actions');
});

test('detects write-all at job scope', () => {
  const fixture = `jobs:\n  audit:\n    permissions: write-all\n    runs-on: ubuntu-latest\n`;
  assert.equal(jobPermissionFindings(fixture)[0]?.reason, 'aggregate-permission');
});

test('rejects read-all so least privilege remains explicit', () => {
  const fixture = `jobs:\n  audit:\n    permissions: read-all\n    runs-on: ubuntu-latest\n`;
  assert.equal(jobPermissionFindings(fixture)[0]?.reason, 'aggregate-permission');
});

test('accepts explicit job-level read-only scopes', () => {
  const fixture = `jobs:\n  audit:\n    permissions:\n      contents: read\n      checks: read\n    runs-on: ubuntu-latest\n`;
  assert.deepEqual(jobPermissionFindings(fixture), []);
});

test('accepts an explicitly empty job token permission map', () => {
  const fixture = `jobs:\n  audit:\n    permissions: {}\n    runs-on: ubuntu-latest\n`;
  assert.deepEqual(jobPermissionFindings(fixture), []);
});

test('ignores permission-looking text inside a run block', () => {
  const fixture = `jobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo 'permissions:'\n          echo 'contents: write'\n`;
  assert.deepEqual(jobPermissionFindings(fixture), []);
});

test('checks multiple jobs independently', () => {
  const fixture = `jobs:\n  quality:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n  release:\n    permissions:\n      packages: write\n    runs-on: ubuntu-latest\n`;
  const findings = jobPermissionFindings(fixture);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].job, 'release');
  assert.equal(findings[0].reason, 'write-permission:packages');
});

test('comments cannot hide a job-level write grant', () => {
  const fixture = `jobs:\n  audit:\n    permissions:\n      contents: read # expected\n      security-events: write # forbidden\n    runs-on: ubuntu-latest\n`;
  assert.equal(jobPermissionFindings(fixture)[0]?.reason, 'write-permission:security-events');
});

test('quoted permission levels are normalized', () => {
  const fixture = `jobs:\n  audit:\n    permissions:\n      contents: 'write'\n    runs-on: ubuntu-latest\n`;
  assert.equal(jobPermissionFindings(fixture)[0]?.reason, 'write-permission:contents');
});

test('job without an override inherits the already-audited workflow permission', () => {
  const fixture = `permissions:\n  contents: read\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
  assert.deepEqual(jobPermissionFindings(fixture), []);
});
