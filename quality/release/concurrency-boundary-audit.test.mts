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

const readOnlyHeader = `name: CI
on:
  pull_request:
permissions:
  contents: read
`;

const privilegedHeader = `name: CI
on:
  pull_request_target:
permissions:
  contents: write
`;

test('accepts trusted workflow/ref-partitioned cancellation group', () => {
  const result = audit(`${readOnlyHeader}concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - run: echo ok
`);
  assert.equal(result.findings.length, 0);
});

test('blocks attacker-controlled pull request title in group with cancellation', () => {
  const current = finding(`${readOnlyHeader}concurrency:
  group: \${{ github.event.pull_request.title }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-untrusted-group');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('reports untrusted group even when cancellation is disabled', () => {
  const current = finding(`${readOnlyHeader}concurrency:
  group: \${{ github.event.pull_request.body }}
  cancel-in-progress: false
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-untrusted-group');
  assert.equal(current?.severity, 'high');
  assert.equal(current?.blocking, undefined);
});

for (const expression of [
  'github.event.issue.title',
  'github.event.comment.body',
  'github.event.review.body',
  'github.head_ref',
  'inputs.group',
] as const) {
  test(`detects untrusted concurrency source ${expression}`, () => {
    assert.ok(finding(`${readOnlyHeader}concurrency:
  group: \${{ ${expression} }}
  cancel-in-progress: false
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-untrusted-group'));
  });
}

test('static external cancellation group is collision-prone', () => {
  assert.ok(finding(`${readOnlyHeader}concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-static-cancel-collision'));
});

test('static external group without cancellation avoids collision finding', () => {
  const result = audit(`${readOnlyHeader}concurrency:
  group: ci
  cancel-in-progress: false
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`);
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-static-cancel-collision'), false);
});

test('external dynamic group without ref discriminator is reviewable', () => {
  const current = finding(`${readOnlyHeader}concurrency:
  group: \${{ github.workflow }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-external-group-provenance');
  assert.equal(current?.severity, 'medium');
});

test('trusted pull request number is an acceptable partition', () => {
  const result = audit(`${readOnlyHeader}concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`);
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-external-group-provenance'), false);
});

test('untrusted cancellation expression blocks independently of safe group', () => {
  const current = finding(`${readOnlyHeader}concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ inputs.cancel }}
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-untrusted-cancellation-policy');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('event-controlled cancellation expression blocks', () => {
  assert.ok(finding(`${readOnlyHeader}concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event.pull_request.draft }}
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`, 'ci-concurrency-untrusted-cancellation-policy'));
});

test('protected deployment cancellation is high release review', () => {
  const current = finding(`name: Deploy
on: [push]
permissions:
  contents: read
concurrency:
  group: deploy-main
  cancel-in-progress: true
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`, 'ci-concurrency-deployment-cancel-review');
  assert.equal(current?.severity, 'high');
  assert.equal(current?.domain, 'release');
});

test('non-cancelling protected deployment avoids cancellation review', () => {
  const result = audit(`name: Deploy
on: [push]
concurrency:
  group: deploy-main
  cancel-in-progress: false
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`);
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-deployment-cancel-review'), false);
});

test('privileged external job without any concurrency is high risk', () => {
  const current = finding(`${privilegedHeader}jobs:
  mutate:
    runs-on: ubuntu-24.04
    steps:
      - run: echo mutate
`, 'ci-concurrency-external-privileged-missing');
  assert.equal(current?.severity, 'high');
});

test('read-only external job may omit concurrency without privileged finding', () => {
  const result = audit(`${readOnlyHeader}jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`);
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-external-privileged-missing'), false);
});

test('secret-bearing external job without concurrency is high risk', () => {
  assert.ok(finding(`${readOnlyHeader}env:
  TOKEN: \${{ secrets.RELEASE_TOKEN }}
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`, 'ci-concurrency-external-privileged-missing'));
});

test('protected external deployment without concurrency is high risk', () => {
  assert.ok(finding(`${readOnlyHeader}jobs:
  deploy:
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`, 'ci-concurrency-external-privileged-missing'));
});

test('job-level concurrency satisfies privileged job governance', () => {
  const result = audit(`${privilegedHeader}jobs:
  mutate:
    concurrency:
      group: mutate-\${{ github.ref }}
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    steps:
      - run: echo mutate
`);
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-external-privileged-missing'), false);
});

test('job-level group overrides workflow-level group for that job', () => {
  const result = audit(`${readOnlyHeader}concurrency:
  group: static-workflow
  cancel-in-progress: true
jobs:
  test:
    concurrency:
      group: \${{ github.workflow }}-\${{ github.ref }}
      cancel-in-progress: true
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`);
  assert.equal(result.signals[0]?.scope, 'job');
  assert.equal(result.signals[0]?.group.includes('github.ref'), true);
});

test('workflow-level group is inherited when job has no override', () => {
  const result = audit(`${readOnlyHeader}concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
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
`);
  assert.equal(result.signals.length, 2);
  assert.equal(result.signals.every(item => item.scope === 'workflow'), true);
});

test('empty workflow concurrency group is visible', () => {
  assert.ok(finding(`${readOnlyHeader}concurrency:
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`, 'ci-concurrency-group-empty'));
});

test('empty privileged job group raises high severity', () => {
  const current = finding(`${privilegedHeader}jobs:
  mutate:
    concurrency:
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    steps:
      - run: echo mutate
`, 'ci-concurrency-group-empty');
  assert.equal(current?.severity, 'high');
});

test('ambiguous cancellation scalar is visible', () => {
  assert.ok(finding(`name: CI
on: [push]
concurrency:
  group: ci-main
  cancel-in-progress: maybe
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`, 'ci-concurrency-cancellation-value-review'));
});

test('canonical true and false cancellation values avoid ambiguity finding', () => {
  for (const value of ['true', 'false']) {
    const result = audit(`name: CI
on: [push]
concurrency:
  group: ci-main
  cancel-in-progress: ${value}
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`);
    assert.equal(result.findings.some(item => item.id === 'ci-concurrency-cancellation-value-review'), false, value);
  }
});

test('privileged literal workflow group receives collision review', () => {
  assert.ok(finding(`name: Deploy
on: [push]
permissions:
  deployments: write
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`, 'ci-concurrency-privileged-global-group-review'));
});

test('non-privileged literal workflow group avoids privileged global review', () => {
  const result = audit(`name: CI
on: [push]
permissions:
  contents: read
concurrency:
  group: ci
  cancel-in-progress: false
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`);
  assert.equal(result.findings.some(item => item.id === 'ci-concurrency-privileged-global-group-review'), false);
});

test('job-level untrusted group location is anchored to concurrency field', () => {
  const current = finding(`${readOnlyHeader}jobs:
  test:
    concurrency:
      group: \${{ inputs.group }}
      cancel-in-progress: true
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`, 'ci-concurrency-untrusted-group');
  assert.ok((current?.location?.line ?? 0) >= 8);
});

test('summary counts dynamic and untrusted groups deterministically', () => {
  const result = audit(`${readOnlyHeader}concurrency:
  group: \${{ inputs.group }}
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
`);
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.scopes, 2);
  assert.equal(result.summary.dynamicGroups, 2);
  assert.equal(result.summary.untrustedGroups, 2);
});

test('findings are stable across LF and CRLF workflow inputs', () => {
  const source = `${readOnlyHeader}concurrency:
  group: \${{ github.event.pull_request.title }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`;
  const lf = audit(source).findings.map(item => [item.id, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.location?.line]);
  assert.deepEqual(crlf, lf);
});

test('findings remain canonically sorted across multiple jobs', () => {
  const source = `${privilegedHeader}jobs:
  one:
    runs-on: ubuntu-24.04
    steps:
      - run: echo one
  two:
    runs-on: ubuntu-24.04
    steps:
      - run: echo two
`;
  const first = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  const second = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  assert.deepEqual(second, first);
});
