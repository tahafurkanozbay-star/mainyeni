import assert from 'node:assert/strict';
import test from 'node:test';
import { auditConcurrencyBoundaries } from './concurrency-boundary-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

function audit(text: string) {
  return auditConcurrencyBoundaries(fixtureInventory([{ path: '.github/workflows/ci.yml', text }]));
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

const readOnly = `name: CI
on:
  pull_request:
permissions:
  contents: read
`;

const privileged = `name: CI
on:
  pull_request_target:
permissions:
  contents: write
`;

function workflow(options: {
  header?: string;
  concurrency?: string;
  environment?: string;
  jobConcurrency?: string;
  workflowEnv?: string;
}) {
  const header = options.header ?? readOnly;
  const workflowEnv = options.workflowEnv ? `env:\n${options.workflowEnv}\n` : '';
  const concurrency = options.concurrency ? `concurrency:\n${options.concurrency}\n` : '';
  const environment = options.environment ? `    environment: ${options.environment}\n` : '';
  const jobConcurrency = options.jobConcurrency ? `    concurrency:\n${options.jobConcurrency}\n` : '';
  return `${header}${workflowEnv}${concurrency}jobs:
  test:
${environment}${jobConcurrency}    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;
}

test('trusted workflow/ref partition is accepted', () => {
  const result = audit(workflow({ concurrency: '  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true' }));
  assert.deepEqual(result.findings, []);
});

test('attacker-controlled group with cancellation is blocking', () => {
  const current = finding(workflow({ concurrency: '  group: ${{ github.event.pull_request.title }}\n  cancel-in-progress: true' }), 'ci-concurrency-untrusted-group');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('attacker-controlled group without cancellation remains high', () => {
  const current = finding(workflow({ concurrency: '  group: ${{ github.event.pull_request.body }}\n  cancel-in-progress: false' }), 'ci-concurrency-untrusted-group');
  assert.equal(current?.severity, 'high');
  assert.equal(current?.blocking, undefined);
});

for (const source of [
  '${{ github.event.issue.title }}',
  '${{ github.event.comment.body }}',
  '${{ github.event.review.body }}',
  '${{ github.head_ref }}',
  '${{ inputs.group }}',
] as const) {
  test(`untrusted group source ${source} is detected`, () => {
    assert.ok(finding(workflow({ concurrency: `  group: ${source}\n  cancel-in-progress: false` }), 'ci-concurrency-untrusted-group'));
  });
}

test('static external cancellation group exposes collision risk', () => {
  assert.ok(finding(workflow({ concurrency: '  group: ci\n  cancel-in-progress: true' }), 'ci-concurrency-static-cancel-collision'));
});

test('static external group without cancellation avoids cancel-collision finding', () => {
  const result = audit(workflow({ concurrency: '  group: ci\n  cancel-in-progress: false' }));
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-static-cancel-collision'), false);
});

test('dynamic external group without ref discriminator is reviewable', () => {
  const current = finding(workflow({ concurrency: '  group: ${{ github.workflow }}\n  cancel-in-progress: true' }), 'ci-concurrency-external-group-provenance');
  assert.equal(current?.severity, 'medium');
});

test('pull request number is a trusted partition discriminator', () => {
  const result = audit(workflow({ concurrency: '  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}\n  cancel-in-progress: true' }));
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-external-group-provenance'), false);
});

test('untrusted cancellation policy is independently blocking', () => {
  const current = finding(workflow({ concurrency: '  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ inputs.cancel }}' }), 'ci-concurrency-untrusted-cancellation-policy');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('event-controlled cancellation policy is blocking', () => {
  assert.ok(finding(workflow({ concurrency: '  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.event.pull_request.draft }}' }), 'ci-concurrency-untrusted-cancellation-policy'));
});

test('protected deployment cancellation requires high release review', () => {
  const current = finding(workflow({
    header: 'name: Deploy\non: [push]\npermissions:\n  contents: read\n',
    concurrency: '  group: deploy-main\n  cancel-in-progress: true',
    environment: 'production',
  }), 'ci-concurrency-deployment-cancel-review');
  assert.equal(current?.severity, 'high');
  assert.equal(current?.domain, 'release');
});

test('non-cancelling protected deployment avoids cancellation review', () => {
  const result = audit(workflow({
    header: 'name: Deploy\non: [push]\n',
    concurrency: '  group: deploy-main\n  cancel-in-progress: false',
    environment: 'production',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-deployment-cancel-review'), false);
});

test('privileged external job without concurrency is high risk', () => {
  const current = finding(workflow({ header: privileged }), 'ci-concurrency-external-privileged-missing');
  assert.equal(current?.severity, 'high');
});

test('read-only external job may omit concurrency', () => {
  const result = audit(workflow({ header: readOnly }));
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-external-privileged-missing'), false);
});

test('workflow-level secret makes external job privileged', () => {
  assert.ok(finding(workflow({
    workflowEnv: '  TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-concurrency-external-privileged-missing'));
});

test('protected external environment makes job privileged', () => {
  assert.ok(finding(workflow({ environment: 'production' }), 'ci-concurrency-external-privileged-missing'));
});

test('job-level concurrency satisfies privileged external governance', () => {
  const result = audit(workflow({
    header: privileged,
    jobConcurrency: '      group: mutate-${{ github.ref }}\n      cancel-in-progress: false',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-external-privileged-missing'), false);
});

test('job-level concurrency overrides workflow-level concurrency', () => {
  const result = audit(workflow({
    concurrency: '  group: static-workflow\n  cancel-in-progress: true',
    jobConcurrency: '      group: ${{ github.workflow }}-${{ github.ref }}\n      cancel-in-progress: true',
  }));
  assert.equal(result.summary.signals[0]?.scope, 'job');
  assert.equal(result.summary.signals[0]?.group.includes('github.ref'), true);
});

test('workflow-level concurrency is inherited by jobs without override', () => {
  const source = `${readOnly}concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  one:
    runs-on: ubuntu-24.04
    steps:
      - run: echo one
  two:
    runs-on: ubuntu-24.04
    steps:
      - run: echo two
`;
  const result = audit(source);
  assert.equal(result.summary.signals.length, 2);
  assert.equal(result.summary.signals.every(item => item.scope === 'workflow'), true);
});

test('empty workflow concurrency group is visible', () => {
  assert.ok(finding(workflow({ concurrency: '  cancel-in-progress: true' }), 'ci-concurrency-group-empty'));
});

test('empty privileged job concurrency group is high', () => {
  const current = finding(workflow({
    header: privileged,
    jobConcurrency: '      cancel-in-progress: false',
  }), 'ci-concurrency-group-empty');
  assert.equal(current?.severity, 'high');
});

test('ambiguous cancellation scalar is visible', () => {
  assert.ok(finding(workflow({
    header: 'name: CI\non: [push]\n',
    concurrency: '  group: ci-main\n  cancel-in-progress: maybe',
  }), 'ci-concurrency-cancellation-value-review'));
});

test('canonical boolean cancellation values avoid ambiguity finding', () => {
  for (const value of ['true', 'false']) {
    const result = audit(workflow({
      header: 'name: CI\non: [push]\n',
      concurrency: `  group: ci-main\n  cancel-in-progress: ${value}`,
    }));
    assert.equal(result.findings.some(item => item.id === 'ci-concurrency-cancellation-value-review'), false, value);
  }
});

test('privileged global literal group gets namespace review', () => {
  assert.ok(finding(workflow({
    header: 'name: Deploy\non: [push]\npermissions:\n  deployments: write\n',
    concurrency: '  group: deploy\n  cancel-in-progress: false',
  }), 'ci-concurrency-privileged-global-group-review'));
});

test('non-privileged literal group avoids privileged global review', () => {
  const result = audit(workflow({
    header: 'name: CI\non: [push]\npermissions:\n  contents: read\n',
    concurrency: '  group: ci\n  cancel-in-progress: false',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-privileged-global-group-review'), false);
});

test('summary counts dynamic and untrusted groups through public summary shape', () => {
  const source = `${readOnly}concurrency:
  group: ${{ inputs.group }}
  cancel-in-progress: false
jobs:
  one:
    runs-on: ubuntu-24.04
    steps:
      - run: echo one
  two:
    runs-on: ubuntu-24.04
    steps:
      - run: echo two
`;
  const result = audit(source);
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.scopes, 2);
  assert.equal(result.summary.dynamicGroups, 2);
  assert.equal(result.summary.untrustedGroups, 2);
});

test('untrusted job group location anchors to concurrency field', () => {
  const current = finding(workflow({ jobConcurrency: '      group: ${{ inputs.group }}\n      cancel-in-progress: true' }), 'ci-concurrency-untrusted-group');
  assert.ok((current?.location?.line ?? 0) >= 7);
});

test('LF and CRLF preserve finding ids and locations', () => {
  const source = workflow({ concurrency: '  group: ${{ github.event.pull_request.title }}\n  cancel-in-progress: true' });
  const lf = audit(source).findings.map(item => [item.id, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.location?.line]);
  assert.deepEqual(crlf, lf);
});

test('repeated audits are deterministic', () => {
  const source = workflow({ header: privileged });
  const first = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  const second = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  assert.deepEqual(second, first);
});
