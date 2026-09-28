import assert from 'node:assert/strict';
import test from 'node:test';
import type { RepositoryInventory, SourceFile } from './contracts.mts';
import { auditRunnerTrustBoundaries } from './runner-trust-boundary-audit.mts';

function inventory(text: string, path = '.github/workflows/ci.yml'): RepositoryInventory {
  const lines = text.split('\n').length;
  const bytes = Buffer.byteLength(text);
  const file: SourceFile = { repositoryPath: path, absolutePath: `/repo/${path}`, extension: '.yml', kind: 'yaml', bytes, lines, text };
  return { root: '/repo', files: [file], ignoredDirectories: [], languageStats: [{ kind: 'yaml', files: 1, lines, bytes }], totalFiles: 1, totalLines: lines, totalBytes: bytes, generatedAt: '2026-09-28T00:00:00.000Z' };
}
function audit(text: string) { return auditRunnerTrustBoundaries(inventory(text)); }
function ids(text: string): string[] { return audit(text).findings.map(item => item.id); }
const PIN = '0123456789012345678901234567890123456789';

test('blocks fork-influenced pull request execution on self-hosted runner', () => {
  const finding = audit(`on: pull_request\njobs:\n  test:\n    runs-on: [self-hosted, linux]\n    steps:\n      - uses: actions/checkout@${PIN}\n      - run: npm test\n`).findings.find(item => item.id === 'ci-runner-self-hosted-external-contribution');
  assert.ok(finding); assert.equal(finding.blocking, true); assert.equal(finding.severity, 'critical');
});

test('blocks pull_request_target execution on self-hosted runner', () => {
  assert.ok(ids(`on: pull_request_target\njobs:\n  inspect:\n    runs-on: self-hosted\n    steps:\n      - run: echo inspect\n`).includes('ci-runner-self-hosted-external-contribution'));
});

test('does not classify ordinary GitHub-hosted pull request job as self-hosted', () => {
  const result = audit(`on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
  assert.equal(result.summary.selfHostedJobs, 0);
  assert.equal(result.findings.some(item => item.id.includes('self-hosted')), false);
});

test('blocks expression-derived runner identity independently of self-hosted literal', () => {
  const finding = audit(`on: workflow_dispatch\njobs:\n  build:\n    runs-on: \${{ inputs.runner }}\n    steps:\n      - run: npm test\n`).findings.find(item => item.id === 'ci-runner-dynamic-selection');
  assert.ok(finding); assert.equal(finding.blocking, true); assert.equal(finding.severity, 'critical');
});

test('blocks matrix-derived runner identity', () => {
  assert.ok(ids(`on: push\njobs:\n  build:\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: npm test\n`).includes('ci-runner-dynamic-selection'));
});

test('reports privileged self-hosted job without protected environment', () => {
  assert.ok(ids(`on: push\njobs:\n  release:\n    permissions:\n      contents: write\n    runs-on: [self-hosted, release]\n    steps:\n      - run: gh release create v1\n`).includes('ci-runner-self-hosted-privilege-without-environment'));
});

test('accepts protected self-hosted privileged job without host mutation', () => {
  const result = audit(`on:\n  push:\n    branches: [main]\njobs:\n  release:\n    permissions:\n      contents: write\n    environment: production\n    runs-on: [self-hosted, ephemeral, release]\n    steps:\n      - run: gh release create v1\n`);
  assert.equal(result.findings.some(item => item.id === 'ci-runner-self-hosted-privilege-without-environment'), false);
});

test('reports self-hosted global apt mutation', () => {
  assert.ok(ids(`on: push\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - run: sudo apt-get install ninja-build\n`).includes('ci-runner-self-hosted-host-tool-mutation'));
});

test('reports self-hosted global npm mutation', () => {
  assert.ok(ids(`on: push\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - run: npm install -g pnpm\n`).includes('ci-runner-self-hosted-host-tool-mutation'));
});

test('reports self-hosted global pip mutation', () => {
  assert.ok(ids(`on: push\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - run: pip install build\n`).includes('ci-runner-self-hosted-host-tool-mutation'));
});

test('does not report host mutation for local package install', () => {
  assert.equal(ids(`on: push\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - run: npm ci\n`).includes('ci-runner-self-hosted-host-tool-mutation'), false);
});

test('reports Docker daemon command on self-hosted runner', () => {
  assert.ok(ids(`on: push\njobs:\n  image:\n    runs-on: self-hosted\n    steps:\n      - run: docker build -t app .\n`).includes('ci-runner-self-hosted-container-daemon-authority'));
});

test('reports explicit Docker socket reference on self-hosted runner', () => {
  assert.ok(ids(`on: push\njobs:\n  image:\n    runs-on: self-hosted\n    steps:\n      - run: test -S /var/run/docker.sock\n`).includes('ci-runner-self-hosted-container-daemon-authority'));
});

test('Docker daemon finding becomes blocking for external contribution', () => {
  const finding = audit(`on: pull_request\njobs:\n  image:\n    runs-on: self-hosted\n    steps:\n      - run: docker build .\n`).findings.find(item => item.id === 'ci-runner-self-hosted-container-daemon-authority');
  assert.ok(finding); assert.equal(finding.blocking, true); assert.equal(finding.severity, 'critical');
});

test('does not report Docker authority on GitHub-hosted runner in this boundary audit', () => {
  assert.equal(ids(`on: push\njobs:\n  image:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker build .\n`).includes('ci-runner-self-hosted-container-daemon-authority'), false);
});

test('reports broad git cleanup on persistent runner', () => {
  assert.ok(ids(`on: push\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - run: git clean -xffd\n`).includes('ci-runner-self-hosted-persistent-workspace-mutation'));
});

test('reports recursive workspace permission mutation', () => {
  assert.ok(ids(`on: push\njobs:\n  build:\n    runs-on: self-hosted\n    steps:\n      - run: chmod -R 777 .\n`).includes('ci-runner-self-hosted-persistent-workspace-mutation'));
});

test('reports privileged checkout directly on persistent host', () => {
  assert.ok(ids(`on: push\njobs:\n  release:\n    permissions:\n      contents: write\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@${PIN}\n      - run: ./release.sh\n`).includes('ci-runner-self-hosted-privileged-checkout-isolation'));
});

test('protected environment suppresses privileged checkout isolation finding', () => {
  assert.equal(ids(`on: push\njobs:\n  release:\n    permissions:\n      contents: write\n    environment: production\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@${PIN}\n      - run: ./release.sh\n`).includes('ci-runner-self-hosted-privileged-checkout-isolation'), false);
});

test('job container suppresses privileged checkout isolation finding', () => {
  assert.equal(ids(`on: push\njobs:\n  release:\n    permissions:\n      contents: write\n    runs-on: self-hosted\n    container: node:24\n    steps:\n      - uses: actions/checkout@${PIN}\n      - run: ./release.sh\n`).includes('ci-runner-self-hosted-privileged-checkout-isolation'), false);
});

test('summary counts runner trust classes deterministically', () => {
  const result = audit(`on: pull_request\njobs:\n  external:\n    runs-on: self-hosted\n    steps:\n      - run: npm test\n  hosted:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  privileged:\n    permissions:\n      contents: write\n    runs-on: [self-hosted, release]\n    steps:\n      - run: gh release create v1\n`);
  assert.equal(result.summary.jobs, 3);
  assert.equal(result.summary.selfHostedJobs, 2);
  assert.equal(result.summary.externalSelfHostedJobs, 2);
  assert.equal(result.summary.privilegedSelfHostedJobs, 1);
});

test('signals retain reviewed runner facts', () => {
  const result = audit(`on: push\njobs:\n  release:\n    permissions:\n      contents: write\n    environment: production\n    runs-on: [self-hosted, linux, x64]\n    container: node:24\n    services:\n      db:\n        image: postgres:17\n    steps:\n      - uses: actions/checkout@${PIN}\n`);
  const current = result.summary.signals[0];
  assert.ok(current); assert.equal(current.selfHosted, true); assert.equal(current.repositoryWrite, true); assert.equal(current.protectedEnvironment, true); assert.equal(current.checkout, true); assert.equal(current.containerized, true); assert.equal(current.serviceContainers, true);
});

test('finding order is deterministic across repeated audits', () => {
  const workflow = `on: pull_request\njobs:\n  unsafe:\n    permissions:\n      contents: write\n    runs-on: self-hosted\n    steps:\n      - uses: actions/checkout@${PIN}\n      - run: |\n          sudo apt-get install jq\n          docker build .\n          git clean -xffd\n`;
  const first = audit(workflow).findings.map(item => item.id);
  const second = audit(workflow).findings.map(item => item.id);
  assert.deepEqual(first, second);
  assert.ok(first.includes('ci-runner-self-hosted-external-contribution'));
  assert.ok(first.includes('ci-runner-self-hosted-container-daemon-authority'));
});
