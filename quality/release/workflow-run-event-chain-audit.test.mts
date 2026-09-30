import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowRunEventChains } from './workflow-run-event-chain-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function workflow(path: string, text: string): FixtureFileInput {
  return { path: `.github/workflows/${path}`, text };
}

function audit(files: readonly FixtureFileInput[]) {
  return auditWorkflowRunEventChains(fixtureInventory(files));
}

const mixedProducer = workflow('ci.yml', `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);

function consumer(jobBody: string, trigger = `  workflow_run:
    workflows: [CI]
    types: [completed]
`) {
  return workflow('promote.yml', `name: Promote
on:
${trigger}permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
${jobBody}`);
}

test('blocks a privileged mixed-trust producer when workflow_run event is unbound', () => {
  const result = audit([
    mixedProducer,
    consumer(`    if: \${{ github.event.workflow_run.conclusion == 'success' }}
    steps:
      - run: npm publish
`),
  ]);

  assert.equal(result.summary.workflowRunJobs, 1);
  assert.equal(result.summary.mixedTrustProducerJobs, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-external-producer-event-unbound' && item.blocking));
});

test('accepts an explicit push event guard for a mixed-trust producer', () => {
  const result = audit([
    mixedProducer,
    consumer(`    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' }}
    steps:
      - run: npm publish
`),
  ]);

  assert.equal(result.summary.mixedTrustProducerJobs, 1);
  assert.deepEqual(result.findings, []);
});

test('accepts reversed literal equality for the producer event guard', () => {
  const result = audit([
    mixedProducer,
    consumer(`    if: \${{ 'push' == github.event.workflow_run.event && github.event.workflow_run.conclusion == 'success' }}
    steps:
      - run: npm publish
`),
  ]);

  assert.deepEqual(result.findings, []);
});

test('does not demand an event guard when the producer is push-only', () => {
  const pushOnly = workflow('ci.yml', `name: CI
on:
  push:
    branches: [main]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  const result = audit([
    pushOnly,
    consumer(`    if: \${{ github.event.workflow_run.conclusion == 'success' }}
    steps:
      - run: npm publish
`),
  ]);

  assert.equal(result.summary.mixedTrustProducerJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('blocks a privileged consumer that is not restricted to completed producer runs', () => {
  const result = audit([
    mixedProducer,
    consumer(`    if: \${{ github.event.workflow_run.event == 'push' }}
    steps:
      - run: npm publish
`, `  workflow_run:
    workflows: [CI]
    types: [requested, completed]
`),
  ]);

  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-privileged-noncompleted-trigger' && item.blocking));
});

test('blocks a privileged consumer with no producer workflow allowlist', () => {
  const result = audit([
    mixedProducer,
    consumer(`    steps:
      - run: npm publish
`, `  workflow_run:
    types: [completed]
`),
  ]);

  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-producer-list-missing' && item.blocking));
});

test('blocks an unresolved producer workflow name', () => {
  const result = audit([
    consumer(`    steps:
      - run: npm publish
`, `  workflow_run:
    workflows: [Missing Producer]
    types: [completed]
`),
  ]);

  assert.equal(result.summary.unresolvedProducerJobs, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-producer-unresolved' && item.blocking));
});

test('blocks duplicate producer names because name-based provenance becomes ambiguous', () => {
  const first = workflow('ci-a.yml', `name: CI
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
`);
  const second = workflow('ci-b.yml', `name: CI
on:
  pull_request:
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`);
  const result = audit([
    first,
    second,
    consumer(`    if: \${{ github.event.workflow_run.event == 'push' }}
    steps:
      - run: npm publish
`),
  ]);

  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-producer-name-ambiguous' && item.blocking));
});

test('flags a mismatched trusted event guard on a mixed push and pull-request producer', () => {
  const result = audit([
    mixedProducer,
    consumer(`    if: \${{ github.event.workflow_run.event == 'workflow_dispatch' }}
    steps:
      - run: npm publish
`),
  ]);

  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-mixed-producer-event-guard-mismatch' && item.blocking));
});

test('surfaces chained workflow_run producers as a review boundary without blocking by itself', () => {
  const chainedProducer = workflow('ci.yml', `name: CI
on:
  workflow_run:
    workflows: [Build]
    types: [completed]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: echo validate
`);
  const result = audit([
    chainedProducer,
    consumer(`    steps:
      - run: npm publish
`),
  ]);

  const chained = result.findings.find(item => item.id === 'ci-workflow-run-chained-privilege-review');
  assert.equal(chained?.severity, 'high');
  assert.notEqual(chained?.blocking, true);
});

test('does not emit privileged findings for a read-only diagnostic consumer', () => {
  const diagnostic = workflow('inspect.yml', `name: Inspect
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - run: echo inspect
`);
  const result = audit([mixedProducer, diagnostic]);

  assert.equal(result.summary.privilegedWorkflowRunJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores non-workflow yaml files', () => {
  const result = audit([
    { path: 'config/workflow.yml', text: `name: CI
on: pull_request
` },
  ]);

  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
