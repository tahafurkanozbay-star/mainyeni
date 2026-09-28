import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkingDirectoryBoundaries } from './working-directory-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/workdir.yml') {
  return auditWorkingDirectoryBoundaries(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function workflow(
  step: string,
  options: { readonly trigger?: string; readonly permissions?: string; readonly jobPrefix?: string } = {},
): string {
  return `name: workdir\non:\n  ${options.trigger ?? 'push'}:\npermissions:\n  ${options.permissions ?? 'contents: read'}\njobs:\n  test:\n${options.jobPrefix ?? ''}    runs-on: ubuntu-24.04\n    steps:\n${step}`;
}

function runStep(directory?: string): string {
  return `      - name: run\n        run: npm test\n${directory === undefined ? '' : `        working-directory: ${directory}\n`}`;
}

function issue(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('run step without working-directory override is clean', () => {
  const result = audit(workflow(runStep()));
  assert.equal(result.summary.configuredRunSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('literal repository-relative child directory is clean', () => {
  const result = audit(workflow(runStep('Webclient.app')));
  assert.equal(result.summary.configuredRunSteps, 1);
  assert.deepEqual(result.findings, []);
});

test('github workspace child is accepted as repository execution root', () => {
  const result = audit(workflow(runStep('${{ github.workspace }}/Webclient.app')));
  assert.equal(result.findings.some(item => item.id === 'ci-working-directory-external-root'), false);
});

test('blocks pull request title as working directory', () => {
  const finding = issue(workflow(runStep('${{ github.event.pull_request.title }}'), {
    trigger: 'pull_request',
  }), 'ci-working-directory-untrusted');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks caller input as privileged working directory', () => {
  const finding = issue(workflow(runStep('${{ inputs.directory }}'), {
    trigger: 'workflow_dispatch',
    permissions: 'contents: write',
  }), 'ci-working-directory-untrusted');
  assert.equal(finding?.severity, 'critical');
});

test('reviews needs-derived working directory', () => {
  const finding = issue(workflow(runStep('${{ needs.plan.outputs.directory }}')), 'ci-working-directory-indirect');
  assert.equal(finding?.severity, 'medium');
});

test('raises needs-derived directory with write authority', () => {
  const finding = issue(workflow(runStep('${{ needs.plan.outputs.directory }}'), {
    permissions: 'contents: write',
  }), 'ci-working-directory-indirect');
  assert.equal(finding?.severity, 'high');
});

test('flags direct parent traversal', () => {
  const finding = issue(workflow(runStep('../tools')), 'ci-working-directory-parent-traversal');
  assert.equal(finding?.severity, 'high');
});

test('blocks parent traversal on pull request', () => {
  const finding = issue(workflow(runStep('../../shared'), {
    trigger: 'pull_request',
  }), 'ci-working-directory-parent-traversal');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

for (const directory of ['/', '/tmp/build', '~/build', '$HOME/build', '${{ runner.temp }}/build', 'C:\\build'] as const) {
  test(`flags external working directory ${directory}`, () => {
    assert.ok(issue(workflow(runStep(directory)), 'ci-working-directory-external-root'));
  });
}

test('external root becomes critical for privileged external job', () => {
  const finding = issue(workflow(runStep('/tmp/release'), {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }), 'ci-working-directory-external-root');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('job-level defaults apply to run steps', () => {
  const result = audit(workflow(runStep(), {
    jobPrefix: `    defaults:\n      run:\n        working-directory: Webclient.app\n`,
  }));
  assert.equal(result.summary.configuredRunSteps, 1);
  assert.equal(result.summary.signals[0]?.source, 'job-default');
  assert.equal(result.summary.signals[0]?.value, 'Webclient.app');
});

test('step override takes precedence over unsafe job default', () => {
  const result = audit(workflow(runStep('Webclient.app'), {
    jobPrefix: `    defaults:\n      run:\n        working-directory: ../unsafe\n`,
  }));
  assert.equal(result.summary.signals[0]?.source, 'step');
  assert.equal(result.findings.some(item => item.id === 'ci-working-directory-parent-traversal'), false);
});

test('workflow-level defaults apply when job and step do not override', () => {
  const source = `name: global\non:\n  push:\ndefaults:\n  run:\n    working-directory: Webclient.app\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm test\n`;
  const result = audit(source);
  assert.equal(result.summary.signals[0]?.source, 'workflow-default');
  assert.equal(result.summary.signals[0]?.value, 'Webclient.app');
});

test('job default overrides workflow default', () => {
  const source = `name: defaults\non:\n  push:\ndefaults:\n  run:\n    working-directory: root-app\npermissions:\n  contents: read\njobs:\n  test:\n    defaults:\n      run:\n        working-directory: Webclient.app\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm test\n`;
  const result = audit(source);
  assert.equal(result.summary.signals[0]?.value, 'Webclient.app');
  assert.equal(result.summary.signals[0]?.source, 'job-default');
});

test('step default does not apply to uses-only action steps', () => {
  const source = `name: action\non:\n  push:\ndefaults:\n  run:\n    working-directory: ../unsafe\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n`;
  const result = audit(source);
  assert.equal(result.summary.runSteps, 0);
  assert.equal(result.summary.configuredRunSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('sibling job default does not leak into another job', () => {
  const source = `name: scoped\non:\n  push:\npermissions:\n  contents: read\njobs:\n  safe:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo safe\n  unsafe:\n    defaults:\n      run:\n        working-directory: ../outside\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo unsafe\n`;
  const result = audit(source);
  assert.equal(result.summary.configuredRunSteps, 1);
  assert.equal(result.summary.signals[0]?.job, 'unsafe');
});

test('comments and nested with working-directory keys do not become run directories', () => {
  const source = workflow(`      - name: action\n        uses: vendor/action@0123456789abcdef0123456789abcdef01234567\n        with:\n          working-directory: ../not-a-run-directory\n      - run: echo safe\n`);
  const result = audit(source);
  assert.equal(result.summary.configuredRunSteps, 0);
});

test('non-workflow yaml is ignored', () => {
  const result = audit('working-directory: ../outside\n', 'docs/example.yml');
  assert.equal(result.summary.workflowFiles, 0);
});

test('summary counts run and escaping directories', () => {
  const source = workflow(`${runStep('Webclient.app')}${runStep('../tools')}${runStep('/tmp/run')}`);
  const result = audit(source);
  assert.equal(result.summary.runSteps, 3);
  assert.equal(result.summary.configuredRunSteps, 3);
  assert.equal(result.summary.escapingDirectories, 2);
});

test('source location points to effective working-directory declaration', () => {
  const result = audit(workflow(runStep('../tools')));
  assert.ok((result.findings[0]?.location?.line ?? 0) > 0);
});

test('audit remains stable across LF and CRLF', () => {
  const source = workflow(`${runStep('${{ needs.plan.outputs.directory }}')}${runStep('../tools')}`, {
    permissions: 'contents: write',
  });
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
