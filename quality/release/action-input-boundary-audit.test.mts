import assert from 'node:assert/strict';
import test from 'node:test';
import { auditActionInputBoundaries } from './action-input-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditActionInputBoundaries(fixtureInventory([{ path: '.github/workflows/action-input.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(on: string, step: string, permissions = 'contents: read'): string {
  return `name: action-input\non: ${on}\npermissions:\n  ${permissions}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
}

test('accepts ordinary data input to pinned action', () => {
  const result = audit(workflow('[pull_request]', `      - uses: vendor/action@${sha}\n        with:\n          label: \${{ github.event.pull_request.title }}\n`));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.actionSteps, 1);
});

test('blocks event text passed as script input', () => {
  const result = audit(workflow('[pull_request]', `      - uses: vendor/action@${sha}\n        with:\n          script: \${{ github.event.pull_request.body }}\n`));
  const finding = result.findings.find(item => item.id === 'ci-action-input-executable-data');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks manual input passed as command', () => {
  const result = audit(workflow('[workflow_dispatch]', `      - uses: vendor/action@${sha}\n        with:\n          command: \${{ inputs.command }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-executable-data'));
});

test('blocks needs output passed as args', () => {
  const result = audit(workflow('[push]', `      - uses: vendor/action@${sha}\n        with:\n          args: \${{ needs.prepare.outputs.args }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-executable-data'));
});

test('flags event-controlled checkout ref', () => {
  const result = audit(workflow('[pull_request]', `      - uses: actions/checkout@${sha}\n        with:\n          ref: \${{ github.event.pull_request.head.ref }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-identity-selector'));
});

test('flags input-controlled repository identity', () => {
  const result = audit(workflow('[workflow_dispatch]', `      - uses: actions/checkout@${sha}\n        with:\n          repository: \${{ inputs.repository }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-identity-selector'));
});

test('flags output-controlled filesystem path', () => {
  const result = audit(workflow('[push]', `      - uses: vendor/action@${sha}\n        with:\n          path: \${{ needs.prepare.outputs.path }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-filesystem-selector'));
});

test('flags matrix-controlled build context', () => {
  const result = audit(workflow('[push]', `      - uses: docker/build-push-action@${sha}\n        with:\n          context: \${{ matrix.context }}\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-filesystem-selector'));
});

test('blocks privileged action identity selector', () => {
  const result = audit(workflow('[workflow_dispatch]', `      - uses: vendor/deploy@${sha}\n        with:\n          environment: \${{ inputs.environment }}\n`, 'deployments: write'));
  const finding = result.findings.find(item => item.id === 'ci-action-input-privileged-selector');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks privileged action path selector', () => {
  const result = audit(workflow('[push]', `      - uses: vendor/publish@${sha}\n        with:\n          path: \${{ needs.build.outputs.path }}\n`, 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-action-input-privileged-selector'));
});

test('tracks step output as untrusted selector source', () => {
  const result = audit(workflow('[push]', `      - uses: vendor/action@${sha}\n        with:\n          image: \${{ steps.resolve.outputs.image }}\n`));
  assert.deepEqual(result.summary.signals[0]?.sourceKinds, ['step-output']);
});

test('tracks event input compatibility source', () => {
  const result = audit(workflow('[workflow_dispatch]', `      - uses: vendor/action@${sha}\n        with:\n          ref: \${{ github.event.inputs.ref }}\n`));
  assert.ok(result.summary.signals[0]?.sourceKinds.includes('event-inputs'));
});

test('flags publication selector but does not automatically block read-only job', () => {
  const result = audit(workflow('[push]', `      - uses: vendor/package@${sha}\n        with:\n          release-name: \${{ needs.meta.outputs.name }}\n`));
  const finding = result.findings.find(item => item.id === 'ci-action-input-publication-selector');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('ignores fixed sensitive action inputs', () => {
  const result = audit(workflow('[push]', `      - uses: vendor/action@${sha}\n        with:\n          ref: main\n          path: dist\n          command: verify\n`));
  assert.deepEqual(result.findings, []);
});

test('does not inspect local action without expression-controlled sensitive input', () => {
  const result = audit(workflow('[push]', `      - uses: ./actions/local\n        with:\n          mode: safe\n`));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.actionSteps, 1);
});

test('reports deterministic counts', () => {
  const result = audit(workflow('[pull_request]', `      - uses: vendor/action@${sha}\n        with:\n          script: \${{ github.event.pull_request.body }}\n          path: \${{ github.head_ref }}\n`));
  assert.equal(result.summary.sensitiveInputUses, 2);
  assert.equal(result.summary.untrustedSensitiveInputs, 2);
});

test('ignores non-workflow action-like yaml', () => {
  const result = auditActionInputBoundaries(fixtureInventory([{ path: 'config/action.yml', text: `uses: vendor/action@${sha}\nwith:\n  script: \${{ inputs.x }}\n` }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
