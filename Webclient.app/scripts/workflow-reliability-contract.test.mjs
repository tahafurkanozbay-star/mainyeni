import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOWS = Object.freeze([
  '.github/workflows/webclient-quality.yml',
  '.github/workflows/release-evidence-contract.yml',
]);

function readWorkflow(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function lines(text) {
  return text.split(/\r?\n/);
}

function indentation(line) {
  return line.length - line.trimStart().length;
}

function clean(line) {
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

function topLevelBlock(text, key) {
  const source = lines(text);
  const start = source.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(clean(line)));
  if (start < 0) return null;
  let end = source.length;
  for (let index = start + 1; index < source.length; index += 1) {
    if (!source[index].trim() || /^\s*#/.test(source[index])) continue;
    if (indentation(source[index]) === 0) { end = index; break; }
  }
  return source.slice(start, end);
}

function concurrencyContract(text) {
  const block = topLevelBlock(text, 'concurrency');
  if (!block) return { ok: false, reason: 'missing-concurrency' };
  const group = block.find((line) => /^\s+group:\s*\S/.test(clean(line)));
  const cancel = block.find((line) => /^\s+cancel-in-progress:\s*true\s*$/.test(clean(line)));
  if (!group) return { ok: false, reason: 'missing-group' };
  if (!cancel) return { ok: false, reason: 'missing-cancellation' };
  if (!/github\.(?:event\.pull_request\.number|ref)/.test(group)) {
    return { ok: false, reason: 'group-not-ref-scoped' };
  }
  return { ok: true, reason: null };
}

function jobBlocks(text) {
  const source = lines(text);
  const jobsStart = source.findIndex((line) => /^jobs:\s*$/.test(clean(line)));
  if (jobsStart < 0) return [];
  const jobs = [];
  for (let index = jobsStart + 1; index < source.length; index += 1) {
    const line = clean(source[index]);
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (indentation(line) === 0) break;
    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (!match) continue;
    const start = index;
    let end = source.length;
    for (let cursor = index + 1; cursor < source.length; cursor += 1) {
      const candidate = clean(source[cursor]);
      if (!candidate.trim() || /^\s*#/.test(candidate)) continue;
      if (indentation(candidate) <= 2) { end = cursor; break; }
    }
    jobs.push({ name: match[1], line: start + 1, text: source.slice(start, end).join('\n') });
  }
  return jobs;
}

function timeoutMinutes(job) {
  const match = job.text.match(/^\s{4}timeout-minutes:\s*([^\s#]+)\s*$/m);
  if (!match) return null;
  if (!/^\d+$/.test(match[1])) return Number.NaN;
  return Number(match[1]);
}

function timeoutContract(text, maximum = 120) {
  const jobs = jobBlocks(text);
  if (jobs.length === 0) return { ok: false, reason: 'missing-jobs', findings: [] };
  const findings = [];
  for (const job of jobs) {
    const timeout = timeoutMinutes(job);
    if (timeout === null) findings.push({ job: job.name, line: job.line, reason: 'missing-timeout' });
    else if (!Number.isFinite(timeout)) findings.push({ job: job.name, line: job.line, reason: 'dynamic-timeout' });
    else if (timeout < 1 || timeout > maximum) findings.push({ job: job.name, line: job.line, reason: 'timeout-out-of-range', timeout });
  }
  return { ok: findings.length === 0, reason: findings.length ? 'invalid-timeout' : null, findings };
}

function runnerContract(text) {
  const findings = [];
  for (const job of jobBlocks(text)) {
    const match = job.text.match(/^\s{4}runs-on:\s*(.*?)\s*$/m);
    if (!match) { findings.push({ job: job.name, reason: 'missing-runner' }); continue; }
    const runner = clean(match[1]).trim().replace(/^['"]|['"]$/g, '');
    if (runner !== 'ubuntu-latest') findings.push({ job: job.name, reason: 'unexpected-runner', runner });
  }
  return { ok: findings.length === 0, findings };
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} cancels superseded ref-scoped runs`, () => {
    const result = concurrencyContract(readWorkflow(workflow));
    assert.equal(result.ok, true, `${workflow} concurrency contract failed: ${result.reason}`);
  });

  test(`${workflow} bounds every job with a finite timeout`, () => {
    const result = timeoutContract(readWorkflow(workflow));
    assert.deepEqual(result.findings, [], `${workflow} has unbounded or invalid job timeout evidence`);
  });

  test(`${workflow} keeps QA execution on the reviewed hosted runner`, () => {
    const result = runnerContract(readWorkflow(workflow));
    assert.deepEqual(result.findings, [], `${workflow} changed runner provenance`);
  });
}

test('concurrency contract rejects a workflow without concurrency', () => {
  assert.equal(concurrencyContract('jobs:\n  quality:\n    runs-on: ubuntu-latest\n').reason, 'missing-concurrency');
});

test('concurrency contract rejects missing cancellation', () => {
  const fixture = 'concurrency:\n  group: qa-${{ github.ref }}\njobs: {}\n';
  assert.equal(concurrencyContract(fixture).reason, 'missing-cancellation');
});

test('concurrency contract rejects a global constant group', () => {
  const fixture = 'concurrency:\n  group: global-qa\n  cancel-in-progress: true\njobs: {}\n';
  assert.equal(concurrencyContract(fixture).reason, 'group-not-ref-scoped');
});

test('concurrency contract accepts pull-request/ref fallback grouping', () => {
  const fixture = 'concurrency:\n  group: qa-${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: true\njobs: {}\n';
  assert.equal(concurrencyContract(fixture).ok, true);
});

test('timeout contract rejects missing timeout', () => {
  const fixture = 'jobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps: []\n';
  assert.deepEqual(timeoutContract(fixture).findings, [{ job: 'quality', line: 2, reason: 'missing-timeout' }]);
});

test('timeout contract rejects zero and excessive timeout values', () => {
  for (const timeout of [0, 121, 999]) {
    const fixture = `jobs:\n  quality:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${timeout}\n    steps: []\n`;
    assert.equal(timeoutContract(fixture).ok, false);
  }
});

test('timeout contract rejects expression-driven timeout values', () => {
  const fixture = 'jobs:\n  quality:\n    runs-on: ubuntu-latest\n    timeout-minutes: ${{ inputs.timeout }}\n    steps: []\n';
  assert.equal(timeoutContract(fixture).findings[0].reason, 'dynamic-timeout');
});

test('timeout contract validates every job independently', () => {
  const fixture = 'jobs:\n  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n';
  assert.equal(timeoutContract(fixture).ok, true);
  assert.equal(jobBlocks(fixture).length, 2);
});

test('runner contract rejects self-hosted execution drift', () => {
  const fixture = 'jobs:\n  quality:\n    runs-on: self-hosted\n    timeout-minutes: 10\n';
  assert.deepEqual(runnerContract(fixture).findings, [{ job: 'quality', reason: 'unexpected-runner', runner: 'self-hosted' }]);
});

test('runner contract rejects expression-selected runner provenance', () => {
  const fixture = 'jobs:\n  quality:\n    runs-on: ${{ inputs.runner }}\n    timeout-minutes: 10\n';
  assert.equal(runnerContract(fixture).ok, false);
});

test('runner contract accepts the reviewed GitHub-hosted runner', () => {
  const fixture = 'jobs:\n  quality:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n';
  assert.equal(runnerContract(fixture).ok, true);
});
