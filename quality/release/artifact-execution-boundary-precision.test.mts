import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArtifactExecutionBoundaries } from './artifact-execution-boundary-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';
const header = `name: Precision
on: [push]
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
`;

function audit(run: string) {
  return auditArtifactExecutionBoundaries(fixtureInventory([{
    path: '.github/workflows/precision.yml',
    text: `${header}      - uses: actions/download-artifact@${sha}\n        with:\n          name: report\n          path: artifacts/report\n      - run: ${run}\n`,
  }]));
}

test('reading downloaded JavaScript as data is not execution evidence', () => {
  const result = audit('cat artifacts/report/check.js');
  assert.equal(result.summary.executedDownloads, 0);
  assert.deepEqual(result.findings, []);
});

test('grepping downloaded shell source as data is not execution evidence', () => {
  const result = audit('grep -n TODO artifacts/report/check.sh');
  assert.equal(result.summary.executedDownloads, 0);
  assert.deepEqual(result.findings, []);
});

test('hashing downloaded Python source without execution is not execution evidence', () => {
  const result = audit('sha256sum artifacts/report/check.py');
  assert.equal(result.summary.executedDownloads, 0);
  assert.deepEqual(result.findings, []);
});

test('Node interpreter invocation remains execution evidence', () => {
  const result = audit('node artifacts/report/check.js');
  assert.equal(result.summary.executedDownloads, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});

test('Python interpreter invocation remains execution evidence', () => {
  const result = audit('python3 artifacts/report/check.py');
  assert.equal(result.summary.executedDownloads, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});

test('Bash interpreter invocation remains execution evidence', () => {
  const result = audit('bash artifacts/report/check.sh');
  assert.equal(result.summary.executedDownloads, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});

test('direct relative execution remains execution evidence', () => {
  const result = audit('./artifacts/report/tool');
  assert.equal(result.summary.executedDownloads, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});

test('chmod executable promotion remains execution evidence', () => {
  const result = audit('chmod +x artifacts/report/tool');
  assert.equal(result.summary.executedDownloads, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});
