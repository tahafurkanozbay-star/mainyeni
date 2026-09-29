import assert from 'node:assert/strict';
import test from 'node:test';
import { auditTokenPermissionBoundaries } from './token-permission-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditTokenPermissionBoundaries(fixtureInventory([{ path: '.github/workflows/permissions.yml', text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

const readOnly = `name: read-only
on: [push]
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

test('accepts explicit read-only validation', () => {
  const result = audit(readOnly);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.writeCapableJobs, 0);
  assert.equal(result.summary.explicitJobs, 1);
});

test('reports implicit job authority in summary without duplicating ci-integrity finding', () => {
  const result = audit(`name: implicit\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
  assert.equal(result.summary.implicitJobs, 1);
  assert.deepEqual(result.findings, []);
});

test('blocks workflow write-all', () => {
  const result = audit(`name: broad\non: [push]\npermissions: write-all\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo release\n`);
  const finding = result.findings.find(item => item.id === 'ci-permission-write-all-job');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks job-scoped write-all', () => {
  const result = audit(`name: broad\non: [workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  release:\n    permissions: write-all\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo release\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-permission-write-all-job'));
  assert.equal(result.summary.writeCapableJobs, 1);
});

test('blocks explicit write permission on pull_request', () => {
  const result = audit(`name: pr\non: [pull_request]\npermissions:\n  contents: write\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo mutate\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-permission-external-write-authority' && item.blocking));
});

test('blocks workflow-level write inherited by executable external job', () => {
  const result = audit(`name: pr\non: [pull_request]\npermissions:\n  contents: write\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./local-action\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-permission-inherited-write-execution'));
});

test('job read-only override prevents workflow-level write inheritance', () => {
  const result = audit(`name: pr\non: [pull_request]\npermissions:\n  contents: write\njobs:\n  validate:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
  assert.equal(result.findings.some(item => item.id === 'ci-permission-external-write-authority'), false);
  assert.equal(result.summary.writeCapableJobs, 0);
});

test('flags broad named write scope surface', () => {
  const result = audit(`name: publish\non: [push]\npermissions:\n  contents: write\n  packages: write\n  deployments: write\njobs:\n  publish:\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-permission-broad-write-surface'));
});

test('flags actions write on trusted workflow', () => {
  const result = audit(`name: cleanup\non: [workflow_dispatch]\npermissions:\n  actions: write\n  contents: read\njobs:\n  cleanup:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh run delete 1\n`);
  const finding = result.findings.find(item => item.id === 'ci-permission-actions-write');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, undefined);
});

test('blocks actions write on external contribution workflow', () => {
  const result = audit(`name: cleanup\non: [issue_comment]\npermissions:\n  actions: write\n  contents: read\njobs:\n  cleanup:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo cleanup\n`);
  const finding = result.findings.find(item => item.id === 'ci-permission-actions-write');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks external security-events write', () => {
  const result = audit(`name: scan\non: [pull_request]\npermissions:\n  contents: read\n  security-events: write\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo sarif\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-permission-external-security-events-write' && item.blocking));
});

test('flags deployment write without environment binding', () => {
  const result = audit(`name: deploy\non: [push]\npermissions:\n  contents: read\n  deployments: write\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-permission-deployment-write-without-environment'));
});

test('accepts deployment write with fixed environment binding', () => {
  const result = audit(`name: deploy\non: [push]\npermissions:\n  contents: read\n  deployments: write\njobs:\n  deploy:\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n`);
  assert.equal(result.findings.some(item => item.id === 'ci-permission-deployment-write-without-environment'), false);
});

test('parses compact empty permissions as explicit no authority', () => {
  const result = audit(`name: none\non: [pull_request]\npermissions: {}\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
  assert.equal(result.summary.explicitJobs, 1);
  assert.equal(result.summary.writeCapableJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('reports deterministic sorted write scopes', () => {
  const result = audit(`name: order\non: [push]\npermissions:\n  packages: write\n  contents: write\n  issues: read\njobs:\n  publish:\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`);
  assert.deepEqual(result.summary.signals[0]?.writeScopes, ['contents', 'packages']);
  assert.deepEqual(result.summary.signals[0]?.readScopes, ['issues']);
});

test('handles quoted comments and ordinary read scopes without false positives', () => {
  const result = audit(`name: readonly\non: [push]\npermissions:\n  contents: read # source\n  actions: read # metadata\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.signals[0]?.source, 'workflow');
});

test('workflow_call read-only reusable workflow stays non-blocking', () => {
  const result = audit(`name: reusable\non:\n  workflow_call:\npermissions:\n  contents: read\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`);
  assert.deepEqual(result.findings, []);
});

test('different jobs compute effective permission source independently', () => {
  const result = audit(`name: mixed\non: [push]\npermissions:\n  contents: read\njobs:\n  read:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo read\n  release:\n    permissions:\n      contents: write\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo release\n`);
  assert.equal(result.summary.jobs, 2);
  assert.equal(result.summary.signals.find(item => item.job === 'read')?.source, 'workflow');
  assert.equal(result.summary.signals.find(item => item.job === 'release')?.source, 'job');
  assert.deepEqual(result.summary.signals.find(item => item.job === 'release')?.writeScopes, ['contents']);
});

test('permission finding IDs remain stable and unique for focused read-only case', () => {
  assert.deepEqual(ids(readOnly), []);
});
