import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPrivilegedConditions } from './privileged-condition-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/condition.yml') {
  return auditPrivilegedConditions(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function workflow(
  condition: string,
  options: {
    readonly trigger?: string;
    readonly permissions?: string;
    readonly env?: string;
    readonly environment?: string;
  } = {},
): string {
  const env = options.env ? `    env:\n${options.env}\n` : '';
  const environment = options.environment ? `    environment: ${options.environment}\n` : '';
  return `name: privileged\non:\n  ${options.trigger ?? 'push'}:\npermissions:\n  ${options.permissions ?? 'contents: write'}\njobs:\n  publish:\n${env}${environment}    if: ${condition}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo publish\n`;
}

function stepWorkflow(
  condition: string,
  options: { readonly trigger?: string; readonly permissions?: string; readonly env?: string } = {},
): string {
  const env = options.env ? `    env:\n${options.env}\n` : '';
  return `name: privileged-step\non:\n  ${options.trigger ?? 'push'}:\npermissions:\n  ${options.permissions ?? 'contents: write'}\njobs:\n  publish:\n${env}    runs-on: ubuntu-24.04\n    steps:\n      - name: mutate\n        if: ${condition}\n        run: echo publish\n`;
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('trusted branch equality in privileged job is clean', () => {
  const result = audit(workflow("${{ github.ref == 'refs/heads/main' }}"));
  assert.deepEqual(result.findings, []);
});

test('trusted repository and successful needs result are clean', () => {
  const result = audit(workflow("${{ github.repository == 'owner/repo' && needs.verify.result == 'success' }}"));
  assert.deepEqual(result.findings, []);
});

test('blocks pull request title controlling write job', () => {
  const issue = finding(workflow('${{ github.event.pull_request.title }}', {
    trigger: 'pull_request',
  }), 'ci-privileged-condition-event-controlled');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('blocks head ref controlling secret-bearing job', () => {
  const issue = finding(workflow("${{ github.head_ref == 'release' }}", {
    trigger: 'pull_request_target',
    permissions: 'contents: read',
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-privileged-condition-event-controlled');
  assert.equal(issue?.severity, 'critical');
});

test('reports workflow input controlling write job', () => {
  const issue = finding(workflow('${{ inputs.publish }}', {
    trigger: 'workflow_dispatch',
  }), 'ci-privileged-condition-input-controlled');
  assert.equal(issue?.severity, 'high');
});

test('protected environment does not make free-form input invisible', () => {
  const issue = finding(workflow("${{ inputs.environment == 'production' }}", {
    trigger: 'workflow_dispatch',
    permissions: 'contents: read',
    environment: 'production',
  }), 'ci-privileged-condition-input-controlled');
  assert.equal(issue?.severity, 'medium');
});

test('reports upstream output controlling write job', () => {
  const issue = finding(workflow("${{ needs.plan.outputs.publish == 'yes' }}"), 'ci-privileged-condition-output-controlled');
  assert.equal(issue?.severity, 'high');
});

test('reports step output controlling secret-bearing step', () => {
  const issue = finding(stepWorkflow("${{ steps.plan.outputs.publish == 'yes' }}", {
    permissions: 'contents: read',
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-privileged-condition-output-controlled');
  assert.equal(issue?.severity, 'high');
});

test('matrix condition in write job is visible as indirect policy', () => {
  const issue = finding(workflow("${{ matrix.publish == 'true' }}"), 'ci-privileged-condition-indirect-policy');
  assert.equal(issue?.severity, 'medium');
});

test('vars condition in protected environment is low review without write or secrets', () => {
  const issue = finding(workflow("${{ vars.ENABLE_RELEASE == 'true' }}", {
    permissions: 'contents: read',
    environment: 'production',
  }), 'ci-privileged-condition-indirect-policy');
  assert.equal(issue?.severity, 'low');
});

test('always on write-capable job is high severity', () => {
  const issue = finding(workflow('${{ always() }}'), 'ci-privileged-condition-failure-override');
  assert.equal(issue?.severity, 'high');
});

test('failure on secret-bearing job is high severity', () => {
  const issue = finding(workflow('${{ failure() }}', {
    permissions: 'contents: read',
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-privileged-condition-failure-override');
  assert.equal(issue?.severity, 'high');
});

test('always on external write job is blocking', () => {
  const issue = finding(workflow('${{ always() }}', {
    trigger: 'pull_request_target',
  }), 'ci-privileged-condition-failure-override');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('not-cancelled override is visible for privileged step', () => {
  const issue = finding(stepWorkflow('${{ !cancelled() }}'), 'ci-privileged-condition-failure-override');
  assert.equal(issue?.severity, 'high');
});

test('read-only job condition is outside privileged audit', () => {
  const source = workflow('${{ github.event.pull_request.title }}', {
    trigger: 'pull_request',
    permissions: 'contents: read',
  });
  const result = audit(source);
  assert.equal(result.summary.privilegedJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('step condition is audited only in privileged owning job', () => {
  const source = stepWorkflow('${{ github.event.comment.body }}', {
    trigger: 'issue_comment',
    permissions: 'contents: read',
  });
  const result = audit(source);
  assert.equal(result.summary.privilegedJobs, 0);
});

test('write authority in sibling job does not taint read-only conditioned job', () => {
  const source = `name: scoped\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  inspect:\n    if: \${{ github.event.pull_request.title }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo inspect\n  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo publish\n`;
  const result = audit(source);
  assert.equal(result.summary.privilegedJobs, 1);
  assert.equal(result.summary.conditionedPrivilegedJobs, 0);
});

test('job-level read permission override suppresses inherited workflow write privilege', () => {
  const source = `name: override\non:\n  pull_request:\npermissions:\n  contents: write\njobs:\n  inspect:\n    permissions:\n      contents: read\n    if: \${{ github.event.pull_request.title }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo inspect\n`;
  const result = audit(source);
  assert.equal(result.summary.privilegedJobs, 0);
});

test('protected environment makes read-only job part of privileged-condition inventory', () => {
  const source = workflow("${{ github.ref == 'refs/heads/main' }}", {
    permissions: 'contents: read',
    environment: 'production',
  });
  const result = audit(source);
  assert.equal(result.summary.privilegedJobs, 1);
  assert.equal(result.summary.conditionedPrivilegedJobs, 1);
  assert.deepEqual(result.findings, []);
});

test('mixed trusted and event condition remains event-controlled', () => {
  const issue = finding(workflow("${{ github.ref == 'refs/heads/main' && github.event.pull_request.title != '' }}", {
    trigger: 'pull_request_target',
  }), 'ci-privileged-condition-event-controlled');
  assert.ok(issue);
});

test('mixed successful needs result and output still reports output provenance', () => {
  const issue = finding(workflow("${{ needs.verify.result == 'success' && needs.verify.outputs.release == 'yes' }}"), 'ci-privileged-condition-output-controlled');
  assert.ok(issue);
});

test('summary counts condition categories', () => {
  const source = `name: summary\non:\n  workflow_dispatch:\npermissions:\n  contents: write\njobs:\n  release:\n    if: \${{ inputs.release }}\n    runs-on: ubuntu-24.04\n    steps:\n      - name: publish\n        if: \${{ always() }}\n        run: echo publish\n`;
  const result = audit(source);
  assert.equal(result.summary.privilegedJobs, 1);
  assert.equal(result.summary.conditionedPrivilegedJobs, 1);
  assert.equal(result.summary.conditionedPrivilegedSteps, 1);
  assert.equal(result.summary.externallyControlledConditions, 1);
  assert.equal(result.summary.failureOverrideConditions, 1);
});

test('non-workflow condition is ignored', () => {
  const result = audit('if: ${{ inputs.release }}\n', 'docs/example.yml');
  assert.equal(result.summary.workflowFiles, 0);
});

test('finding locations remain positive', () => {
  const result = audit(workflow('${{ inputs.publish }}'));
  assert.ok((result.findings[0]?.location?.line ?? 0) > 0);
});

test('audit is stable across LF and CRLF', () => {
  const source = workflow("${{ github.event.pull_request.title != '' && always() }}", {
    trigger: 'pull_request_target',
  });
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
