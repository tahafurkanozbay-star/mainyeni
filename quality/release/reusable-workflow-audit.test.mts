import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReusableWorkflows } from './reusable-workflow-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string, path = '.github/workflows/release.yml') {
  return auditReusableWorkflows(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

function callable(job: string): string {
  return `name: reusable\non:\n  workflow_call:\n    inputs:\n      value:\n        type: string\n        required: false\njobs:\n${job}`;
}

test('recognizes canonical reusable workflow', () => {
  const result = audit(callable(`  verify:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`));
  assert.equal(result.summary.callableWorkflows, 1);
  assert.deepEqual(result.findings, []);
});

test('ignores workflow-shaped yaml outside canonical workflow directory', () => {
  const result = audit(callable(`  verify:\n    secrets: inherit\n    uses: org/repo/.github/workflows/build.yml@main\n`), 'docs/example.yml');
  assert.equal(result.summary.workflows.length, 0);
  assert.deepEqual(result.findings, []);
});

test('supports yaml extension', () => {
  assert.equal(audit(callable(`  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`), '.github/workflows/release.yaml').summary.workflows.length, 1);
});

test('blocks secrets inherit on reusable workflow call jobs', () => {
  const result = audit(callable(`  publish:\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    secrets: inherit\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-secrets-inherit'));
  assert.equal(result.summary.inheritedSecretJobs, 1);
});

test('accepts explicit named secret mapping', () => {
  const result = audit(callable(`  publish:\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    secrets:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`));
  assert.equal(result.findings.some(item => item.id === 'ci-reusable-secrets-inherit'), false);
});

test('blocks mutable branch reference for external reusable workflow', () => {
  const result = audit(callable(`  verify:\n    uses: org/repo/.github/workflows/build.yml@main\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-mutable-ref'));
  assert.equal(result.summary.mutableReusableCalls, 1);
});

test('blocks mutable tag reference for external reusable workflow', () => {
  assert.ok(ids(callable(`  verify:\n    uses: org/repo/.github/workflows/build.yml@v4\n`)).includes('ci-reusable-mutable-ref'));
});

test('accepts full SHA reference for external reusable workflow', () => {
  assert.equal(ids(callable(`  verify:\n    uses: org/repo/.github/workflows/build.yml@${sha}\n`)).includes('ci-reusable-mutable-ref'), false);
});

test('accepts local reusable workflow reference without ref', () => {
  assert.deepEqual(audit(callable(`  verify:\n    uses: ./.github/workflows/build.yml\n`)).findings, []);
});

test('blocks expression-derived reusable workflow identity', () => {
  const result = audit(callable(`  verify:\n    uses: org/repo/.github/workflows/build.yml@\${{ inputs.value }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-dynamic-identity'));
  assert.equal(result.summary.dynamicReusableCalls, 1);
});

test('blocks fully expression-derived uses value', () => {
  assert.ok(ids(callable(`  verify:\n    uses: \${{ inputs.value }}\n`)).includes('ci-reusable-dynamic-identity'));
});

test('blocks write permission in callable workflow job', () => {
  const result = audit(callable(`  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n`));
  const finding = result.findings.find(item => item.id === 'ci-reusable-privileged-job');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('blocks inline write-all in callable workflow job', () => {
  assert.ok(ids(callable(`  publish:\n    permissions: write-all\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n`)).includes('ci-reusable-privileged-job'));
});

test('accepts read-only job permissions in callable workflow', () => {
  assert.deepEqual(audit(callable(`  verify:\n    permissions:\n      contents: read\n      pull-requests: read\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`)).findings, []);
});

test('does not confuse step permissions-like data with job permissions', () => {
  assert.deepEqual(audit(callable(`  verify:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - name: text\n        env:\n          permissions: write\n        run: echo "$permissions"\n`)).findings, []);
});

test('blocks pull_request_target checkout of pull request head sha', () => {
  const workflow = `name: dangerous\non:\n  pull_request_target:\n    types: [opened, synchronize]\njobs:\n  verify:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${sha}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: npm test\n`;
  const finding = audit(workflow).findings.find(item => item.id === 'ci-pr-target-untrusted-checkout');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks pull_request_target checkout of pull request head ref', () => {
  const workflow = `on:\n  pull_request_target:\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${sha}\n        with:\n          ref: \${{ github.event.pull_request.head.ref }}\n`;
  assert.ok(ids(workflow).includes('ci-pr-target-untrusted-checkout'));
});

test('does not flag base checkout in pull_request_target solely for checkout presence', () => {
  const workflow = `on:\n  pull_request_target:\njobs:\n  label:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${sha}\n      - run: echo trusted-base\n`;
  assert.equal(ids(workflow).includes('ci-pr-target-untrusted-checkout'), false);
});

test('raises privileged pull_request_target job to critical', () => {
  const workflow = `on:\n  pull_request_target:\njobs:\n  label:\n    permissions:\n      pull-requests: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo label\n`;
  const finding = audit(workflow).findings.find(item => item.id === 'ci-reusable-privileged-job');
  assert.equal(finding?.severity, 'critical');
});

test('tracks multiple independent job risks', () => {
  const workflow = callable(`  first:\n    uses: org/repo/.github/workflows/a.yml@main\n    secrets: inherit\n  second:\n    uses: org/repo/.github/workflows/b.yml@dev\n`);
  const result = audit(workflow);
  assert.equal(result.summary.mutableReusableCalls, 2);
  assert.equal(result.summary.inheritedSecretJobs, 1);
  assert.equal(result.findings.filter(item => item.id === 'ci-reusable-mutable-ref').length, 2);
});

test('preserves deterministic canonical finding order', () => {
  const workflow = callable(`  first:\n    uses: org/repo/.github/workflows/a.yml@main\n    secrets: inherit\n  second:\n    permissions: write-all\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`);
  const first = audit(workflow).findings.map(item => `${item.location?.line}:${item.id}`);
  const second = audit(workflow).findings.map(item => `${item.location?.line}:${item.id}`);
  assert.deepEqual(first, second);
});

test('reports source location for mutable reusable reference', () => {
  const workflow = callable(`  verify:\n    uses: org/repo/.github/workflows/build.yml@main\n`);
  const result = audit(workflow).findings.find(item => item.id === 'ci-reusable-mutable-ref');
  assert.equal(result?.location?.file, '.github/workflows/release.yml');
  assert.ok((result?.location?.line ?? 0) > 1);
});

test('comments containing mutable-looking references are ignored', () => {
  const workflow = callable(`  verify:\n    uses: org/repo/.github/workflows/build.yml@${sha} # @main is forbidden\n`);
  assert.equal(ids(workflow).includes('ci-reusable-mutable-ref'), false);
});

test('quoted full SHA external reference remains accepted', () => {
  assert.deepEqual(audit(callable(`  verify:\n    uses: "org/repo/.github/workflows/build.yml@${sha}"\n`)).findings, []);
});

test('non-callable ordinary workflow read permissions remain clean', () => {
  const workflow = `name: ci\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
  assert.deepEqual(audit(workflow).findings, []);
});
