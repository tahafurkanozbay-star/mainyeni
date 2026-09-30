import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowControlMutations } from './workflow-control-mutation-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function audit(script: string, trigger = 'push:\n    branches: [main]', env = '') {
  return auditWorkflowControlMutations(fixtureInventory([{
    path: '.github/workflows/control.yml',
    text: `name: Control\non:\n  ${trigger}\npermissions:\n  contents: read\n  actions: write\njobs:\n  control:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@${SHA}\n${env}        with:\n          script: |\n${script.split('\n').map(line => `            ${line}`).join('\n')}\n`,
  }]));
}

function ids(result: ReturnType<typeof audit>): string[] {
  return result.findings.map(item => item.id);
}

test('accepts a literal workflow dispatch on main', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: 'main',\n  inputs: { channel: 'stable' }\n})`);

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.dispatches, 1);
});

test('accepts dispatch bound to current github ref', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: '\${{ github.ref }}'\n})`);

  assert.deepEqual(result.findings, []);
});

test('accepts dispatch bound to current github ref_name', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 123,\n  ref: '\${{ github.ref_name }}'\n})`);

  assert.deepEqual(result.findings, []);
});

test('blocks input-controlled workflow identity', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: '\${{ inputs.workflow }}',\n  ref: 'main'\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-workflow-control-untrusted-target'));
});

test('blocks pull request controlled dispatch ref', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: '\${{ github.head_ref }}'\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-workflow-control-untrusted-target'));
});

test('blocks event payload dispatch ref', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: context.payload.pull_request.head.ref\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-workflow-control-untrusted-target'));
});

test('reviews needs-derived workflow identity', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: '\${{ needs.plan.outputs.workflow }}',\n  ref: 'main'\n})`);

  const finding = result.findings.find(item => item.id === 'ci-workflow-control-indirect-target-review');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('flags missing workflow identity on dispatch', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  ref: 'main'\n})`);

  assert.ok(ids(result).includes('ci-workflow-dispatch-missing-workflow-identity'));
});

test('flags nonliteral workflow identity', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: selectedWorkflow,\n  ref: 'main'\n})`);

  assert.ok(ids(result).includes('ci-workflow-dispatch-dynamic-workflow-identity'));
});

test('flags missing dispatch ref', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml'\n})`);

  assert.ok(ids(result).includes('ci-workflow-dispatch-missing-ref-binding'));
});

test('flags opaque dispatch ref', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: selectedRef\n})`);

  assert.ok(ids(result).includes('ci-workflow-dispatch-opaque-ref'));
});

test('blocks secret transport through dispatch inputs', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: 'main',\n  inputs: { token: '\${{ secrets.DEPLOY_TOKEN }}' }\n})`);

  assert.ok(ids(result).includes('ci-workflow-dispatch-secret-input'));
});

test('blocks attacker-controlled dispatch inputs', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: 'main',\n  inputs: { channel: '\${{ inputs.channel }}' }\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-workflow-dispatch-untrusted-input'));
});

test('blocks pull request text forwarded into dispatch inputs', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: 'main',\n  inputs: { note: context.payload.pull_request.body }\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-workflow-dispatch-untrusted-input'));
});

test('accepts rerun of current github run id', () => {
  const result = audit(`await github.rest.actions.reRunWorkflow({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: github.context.runId ?? Number('\${{ github.run_id }}')\n})`);

  assert.ok(!ids(result).includes('ci-workflow-control-untrusted-target'));
  assert.ok(!ids(result).includes('ci-workflow-control-missing-run-binding'));
});

test('blocks input-controlled rerun id', () => {
  const result = audit(`await github.rest.actions.reRunWorkflow({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: '\${{ inputs.run_id }}'\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-workflow-control-untrusted-target'));
});

test('reviews step-output rerun selector', () => {
  const result = audit(`await github.rest.actions.reRunWorkflow({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: '\${{ steps.lookup.outputs.run_id }}'\n})`);

  assert.ok(ids(result).includes('ci-workflow-control-indirect-target-review'));
});

test('flags missing cancellation run binding', () => {
  const result = audit(`await github.rest.actions.cancelWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo\n})`);

  assert.ok(ids(result).includes('ci-workflow-control-missing-run-binding'));
});

test('flags opaque cancellation run selector', () => {
  const result = audit(`await github.rest.actions.cancelWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: selectedRun\n})`);

  assert.ok(ids(result).includes('ci-workflow-control-opaque-run-selector'));
});

test('accepts literal cancellation run selector', () => {
  const result = audit(`await github.rest.actions.cancelWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: 42\n})`);

  assert.deepEqual(result.findings, []);
});

test('detects failed-job rerun mutation', () => {
  const result = audit(`await github.rest.actions.reRunWorkflowFailedJobs({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: 42\n})`);

  assert.equal(result.summary.runMutations, 1);
});

test('detects job rerun mutation', () => {
  const result = audit(`await github.rest.actions.reRunJobForWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  job_id: 42\n})`);

  assert.equal(result.summary.runMutations, 1);
});

test('detects workflow log deletion', () => {
  const result = audit(`await github.rest.actions.deleteWorkflowRunLogs({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: 42\n})`);

  assert.equal(result.summary.runMutations, 1);
});

test('blocks input-controlled workflow disable target', () => {
  const result = audit(`await github.rest.actions.disableWorkflow({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: '\${{ inputs.workflow }}'\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-workflow-control-untrusted-target'));
  assert.equal(result.summary.workflowStateMutations, 1);
});

test('accepts literal workflow enable target', () => {
  const result = audit(`await github.rest.actions.enableWorkflow({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml'\n})`);

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.workflowStateMutations, 1);
});

test('tracks attacker selectors through process env', () => {
  const result = audit(`await github.rest.actions.cancelWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: process.env.RUN_ID\n})`, 'pull_request:', `        env:\n          RUN_ID: \${{ github.event.pull_request.number }}\n`);

  assert.ok(ids(result).includes('ci-workflow-control-untrusted-target'));
});

test('tracks secrets through process env in dispatch input object', () => {
  const result = audit(`await github.rest.actions.createWorkflowDispatch({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  workflow_id: 'release.yml',\n  ref: 'main',\n  inputs: process.env.DISPATCH_SECRET\n})`, 'push:', `        env:\n          DISPATCH_SECRET: \${{ secrets.DISPATCH_SECRET }}\n`);

  assert.ok(ids(result).includes('ci-workflow-dispatch-secret-input'));
});

test('blocks external contribution workflows with actions write mutation authority', () => {
  const result = audit(`await github.rest.actions.cancelWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: 42\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-workflow-control-external-write-authority'));
});

test('does not invent external authority finding on push', () => {
  const result = audit(`await github.rest.actions.cancelWorkflowRun({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  run_id: 42\n})`);

  assert.ok(!ids(result).includes('ci-workflow-control-external-write-authority'));
});

test('ignores unrelated github-script calls', () => {
  const result = audit(`await github.rest.issues.createComment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  issue_number: 1,\n  body: 'ok'\n})`);

  assert.equal(result.summary.mutations, 0);
  assert.deepEqual(result.findings, []);
});

test('summarizes dispatch, run, and workflow-state mutations', () => {
  const inventory = fixtureInventory([{
    path: '.github/workflows/control.yml',
    text: `name: Control\non: push\npermissions:\n  actions: write\njobs:\n  control:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.actions.createWorkflowDispatch({ workflow_id: 'release.yml', ref: 'main' })\n      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.actions.cancelWorkflowRun({ run_id: 42 })\n      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.actions.disableWorkflow({ workflow_id: 'release.yml' })\n`,
  }]);
  const result = auditWorkflowControlMutations(inventory);

  assert.equal(result.summary.mutations, 3);
  assert.equal(result.summary.dispatches, 1);
  assert.equal(result.summary.runMutations, 1);
  assert.equal(result.summary.workflowStateMutations, 1);
});
