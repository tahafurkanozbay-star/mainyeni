import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRunnerBoundaries } from './runner-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/ci.yml') {
  return auditRunnerBoundaries(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(finding => finding.id);
}

function workflow(job: string, trigger = 'push') {
  return `name: Runner boundary
on:
  ${trigger}:
permissions:
  contents: read
jobs:
  build:
${job}
`;
}

test('accepts a pinned hosted runner for trusted push validation', () => {
  const result = audit(workflow(`    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - run: npm test`));
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.jobs, 1);
  assert.equal(result.summary.selfHostedJobs, 0);
});

test('reports moving latest hosted runner labels', () => {
  assert.ok(ids(workflow(`    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: npm test`)).includes('ci-hosted-runner-latest-image'));
});

test('does not report versioned Windows hosted runner labels', () => {
  assert.equal(ids(workflow(`    runs-on: windows-2025
    timeout-minutes: 20
    steps:
      - run: echo test`)).includes('ci-hosted-runner-latest-image'), false);
});

test('does not report versioned macOS hosted runner labels', () => {
  assert.equal(ids(workflow(`    runs-on: macos-15
    timeout-minutes: 20
    steps:
      - run: echo test`)).includes('ci-hosted-runner-latest-image'), false);
});

test('blocks pull-request execution on a self-hosted runner', () => {
  const result = audit(workflow(`    runs-on: [self-hosted, linux, x64]
    timeout-minutes: 20
    concurrency: pr-validation
    steps:
      - run: npm test`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-self-hosted-external-trigger');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks pull_request_target execution on self-hosted infrastructure', () => {
  assert.ok(ids(workflow(`    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: target
    steps:
      - run: echo metadata`, 'pull_request_target')).includes('ci-self-hosted-external-trigger'));
});

test('blocks issue-comment execution on self-hosted infrastructure', () => {
  assert.ok(ids(workflow(`    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: comments
    steps:
      - run: echo comment`, 'issue_comment')).includes('ci-self-hosted-external-trigger'));
});

test('blocks review-triggered execution on self-hosted infrastructure', () => {
  assert.ok(ids(workflow(`    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: reviews
    steps:
      - run: echo review`, 'pull_request_review')).includes('ci-self-hosted-external-trigger'));
});

test('allows a trusted push on self-hosted infrastructure when bounded', () => {
  const result = audit(workflow(`    runs-on: [self-hosted, linux]
    timeout-minutes: 15
    concurrency: trusted-build
    steps:
      - run: ./build.sh`));
  assert.equal(result.findings.some(item => item.id === 'ci-self-hosted-external-trigger'), false);
  assert.equal(result.findings.some(item => item.id === 'ci-self-hosted-timeout-missing'), false);
  assert.equal(result.findings.some(item => item.id === 'ci-self-hosted-concurrency-missing'), false);
});

test('flags missing timeout on a trusted self-hosted job', () => {
  const finding = audit(workflow(`    runs-on: self-hosted
    concurrency: trusted-build
    steps:
      - run: ./build.sh`)).findings.find(item => item.id === 'ci-self-hosted-timeout-missing');
  assert.equal(finding?.severity, 'medium');
});

test('raises missing timeout severity for externally triggered self-hosted job', () => {
  const finding = audit(workflow(`    runs-on: self-hosted
    concurrency: pr
    steps:
      - run: ./build.sh`, 'pull_request')).findings.find(item => item.id === 'ci-self-hosted-timeout-missing');
  assert.equal(finding?.severity, 'high');
});

test('flags missing concurrency on trusted self-hosted runner', () => {
  const finding = audit(workflow(`    runs-on: self-hosted
    timeout-minutes: 20
    steps:
      - run: ./build.sh`)).findings.find(item => item.id === 'ci-self-hosted-concurrency-missing');
  assert.equal(finding?.severity, 'medium');
});

test('raises missing concurrency severity for external self-hosted workloads', () => {
  const finding = audit(workflow(`    runs-on: self-hosted
    timeout-minutes: 20
    steps:
      - run: ./build.sh`, 'pull_request')).findings.find(item => item.id === 'ci-self-hosted-concurrency-missing');
  assert.equal(finding?.severity, 'high');
});

test('accepts workflow-level concurrency for self-hosted runner governance', () => {
  const text = `name: CI
on:
  push:
concurrency:
  group: trusted-build
  cancel-in-progress: true
jobs:
  build:
    runs-on: self-hosted
    timeout-minutes: 20
    steps:
      - run: ./build.sh
`;
  assert.equal(ids(text).includes('ci-self-hosted-concurrency-missing'), false);
});

test('blocks event-controlled runner selection', () => {
  const result = audit(workflow(`    runs-on: \${{ github.event.pull_request.title }}
    timeout-minutes: 10
    steps:
      - run: echo unsafe`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-runner-untrusted-selection');
  assert.equal(finding?.blocking, true);
  assert.match(String(finding?.message), /github\.event/);
});

test('blocks dispatch-input-controlled runner selection', () => {
  const result = audit(workflow(`    runs-on: \${{ inputs.runner }}
    timeout-minutes: 10
    steps:
      - run: echo unsafe`, 'workflow_dispatch'));
  assert.ok(result.findings.some(item => item.id === 'ci-runner-untrusted-selection'));
});

test('reviews matrix-controlled runner selection even without direct external provenance', () => {
  const result = audit(workflow(`    strategy:
      matrix:
        runner: [ubuntu-24.04, windows-2025]
    runs-on: \${{ matrix.runner }}
    timeout-minutes: 10
    steps:
      - run: echo matrix`));
  assert.ok(result.findings.some(item => item.id === 'ci-runner-dynamic-selection-review'));
  assert.equal(result.findings.some(item => item.id === 'ci-runner-untrusted-selection'), false);
});

test('detects block-style self-hosted runner labels', () => {
  const result = audit(workflow(`    runs-on:
      - self-hosted
      - linux
      - x64
    timeout-minutes: 10
    concurrency: trusted
    steps:
      - run: echo build`));
  assert.equal(result.summary.selfHostedJobs, 1);
});

test('blocks write-authority fanout on external self-hosted runner', () => {
  const text = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  mutate:
    permissions:
      contents: write
    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: mutate
    steps:
      - run: gh api repos/example/example
`;
  const finding = audit(text).findings.find(item => item.id === 'ci-self-hosted-external-write-authority');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks secret exposure on external self-hosted runner', () => {
  const text = `name: CI
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  deploy:
    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: deploy
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
    steps:
      - run: ./deploy.sh
`;
  const finding = audit(text).findings.find(item => item.id === 'ci-self-hosted-external-secret-exposure');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('does not treat secrets in a separate hosted job as self-hosted exposure', () => {
  const text = `name: CI
on:
  push:
permissions:
  contents: read
jobs:
  validate:
    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: validate
    steps:
      - run: npm test
  publish:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
    steps:
      - run: echo publish
`;
  assert.equal(ids(text).includes('ci-self-hosted-external-secret-exposure'), false);
});

test('reports each self-hosted job independently', () => {
  const text = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  linux:
    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: linux
    steps:
      - run: true
  windows:
    runs-on: [self-hosted, windows]
    timeout-minutes: 10
    concurrency: windows
    steps:
      - run: true
`;
  const result = audit(text);
  assert.equal(result.summary.selfHostedJobs, 2);
  assert.equal(result.findings.filter(item => item.id === 'ci-self-hosted-external-trigger').length, 2);
});

test('ignores non-workflow yaml files', () => {
  const result = auditRunnerBoundaries(fixtureInventory([
    { path: 'docs/ci.yml', text: workflow(`    runs-on: self-hosted
    steps:
      - run: true`, 'pull_request') },
  ]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.findings.length, 0);
});

test('supports .yaml workflow extension', () => {
  const result = audit(workflow(`    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: pr
    steps:
      - run: true`, 'pull_request'), '.github/workflows/ci.yaml');
  assert.equal(result.summary.workflowFiles, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-self-hosted-external-trigger'));
});

test('finding order is deterministic by canonical sorter', () => {
  const text = workflow(`    runs-on: self-hosted
    steps:
      - run: true`, 'pull_request');
  const first = audit(text).findings.map(finding => `${finding.severity}:${finding.id}:${finding.location?.line ?? 0}`);
  const second = audit(text).findings.map(finding => `${finding.severity}:${finding.id}:${finding.location?.line ?? 0}`);
  assert.deepEqual(first, second);
});

test('summary includes findings by identity for report consumers', () => {
  const result = audit(workflow(`    runs-on: ubuntu-latest
    steps:
      - run: true`));
  assert.equal(result.summary.findings, result.findings);
});

test('summary counts dynamic and external self-hosted jobs', () => {
  const text = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  external:
    runs-on: self-hosted
    timeout-minutes: 10
    concurrency: external
    steps:
      - run: true
  dynamic:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        runner: [ubuntu-24.04]
    steps:
      - run: true
`;
  const result = audit(text);
  assert.equal(result.summary.jobs, 2);
  assert.equal(result.summary.selfHostedJobs, 1);
  assert.equal(result.summary.dynamicRunnerJobs, 1);
  assert.equal(result.summary.externalSelfHostedJobs, 1);
});

test('CRLF input keeps finding line locations stable', () => {
  const lf = workflow(`    runs-on: self-hosted
    steps:
      - run: true`, 'pull_request');
  const crlf = lf.replace(/\n/g, '\r\n');
  const lfLines = audit(lf).findings.map(finding => finding.location?.line ?? 0);
  const crlfLines = audit(crlf).findings.map(finding => finding.location?.line ?? 0);
  assert.deepEqual(lfLines, crlfLines);
});
