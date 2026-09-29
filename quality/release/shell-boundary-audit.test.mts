import assert from 'node:assert/strict';
import test from 'node:test';
import { auditShellBoundaries } from './shell-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/shell.yml') {
  return auditShellBoundaries(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function workflow(
  shell?: string,
  options: {
    readonly trigger?: string;
    readonly permissions?: string;
    readonly env?: string;
    readonly jobDefaults?: string;
    readonly workflowDefaults?: string;
  } = {},
): string {
  const env = options.env ? `    env:\n${options.env}\n` : '';
  const jobDefaults = options.jobDefaults ? `    defaults:\n      run:\n        shell: ${options.jobDefaults}\n` : '';
  const workflowDefaults = options.workflowDefaults ? `defaults:\n  run:\n    shell: ${options.workflowDefaults}\n` : '';
  return `name: shell\non:\n  ${options.trigger ?? 'push'}:\n${workflowDefaults}permissions:\n  ${options.permissions ?? 'contents: read'}\njobs:\n  test:\n${env}${jobDefaults}    runs-on: ubuntu-24.04\n    steps:\n      - name: run\n        run: echo ok\n${shell === undefined ? '' : `        shell: ${shell}\n`}`;
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('default runner shell is outside configured-shell inventory', () => {
  const result = audit(workflow());
  assert.equal(result.summary.runSteps, 1);
  assert.equal(result.summary.configuredShellSteps, 0);
  assert.deepEqual(result.findings, []);
});

for (const shell of ['bash', 'sh', 'pwsh', 'powershell', 'cmd', 'python', 'python3'] as const) {
  test(`accepts standard named shell ${shell}`, () => {
    const result = audit(workflow(shell));
    assert.equal(result.summary.configuredShellSteps, 1);
    assert.deepEqual(result.findings, []);
  });
}

test('accepts standard bash template with placeholder', () => {
  const result = audit(workflow('bash --noprofile --norc -e -o pipefail {0}'));
  assert.deepEqual(result.findings, []);
});

test('dynamic shell is counted but left to expression audit authority', () => {
  const result = audit(workflow('${{ inputs.shell }}'));
  assert.equal(result.summary.configuredShellSteps, 1);
  assert.equal(result.summary.signals[0]?.dynamic, true);
  assert.deepEqual(result.findings, []);
});

test('repository wrapper shell is high on trusted read-only push', () => {
  const issue = finding(workflow('./scripts/ci-shell {0}'), 'ci-shell-repository-wrapper');
  assert.equal(issue?.severity, 'high');
});

test('repository wrapper shell is blocking on pull request', () => {
  const issue = finding(workflow('./scripts/ci-shell {0}', {
    trigger: 'pull_request',
  }), 'ci-shell-repository-wrapper');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('repository wrapper shell is blocking with write authority', () => {
  const issue = finding(workflow('./tools/shell {0}', {
    permissions: 'contents: write',
  }), 'ci-shell-repository-wrapper');
  assert.equal(issue?.severity, 'critical');
});

test('github workspace wrapper is treated as repository controlled', () => {
  const issue = finding(workflow('${{ github.workspace }}/scripts/shell {0}', {
    trigger: 'pull_request',
  }), 'ci-shell-repository-wrapper');
  assert.ok(issue);
});

test('source bootstrap shell is high on trusted push', () => {
  const issue = finding(workflow('bash -c "source /opt/setup.sh; bash {0}"'), 'ci-shell-bootstrap-command');
  assert.equal(issue?.severity, 'high');
});

test('sudo custom shell is critical with secrets', () => {
  const issue = finding(workflow('sudo /opt/company-shell {0}', {
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-shell-bootstrap-command');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('eval custom shell is blocking on external trigger', () => {
  const issue = finding(workflow('eval /opt/runner {0}', {
    trigger: 'pull_request_target',
  }), 'ci-shell-bootstrap-command');
  assert.equal(issue?.severity, 'critical');
});

test('custom shell without placeholder is high severity', () => {
  const issue = finding(workflow('company-shell --strict'), 'ci-shell-placeholder-missing');
  assert.equal(issue?.severity, 'high');
});

test('custom shell with placeholder avoids missing-placeholder finding', () => {
  const result = audit(workflow('company-shell --strict {0}'));
  assert.equal(result.findings.some(item => item.id === 'ci-shell-placeholder-missing'), false);
  assert.ok(result.findings.some(item => item.id === 'ci-shell-custom-command-review'));
});

test('host absolute custom shell is medium review in read-only job', () => {
  const issue = finding(workflow('/opt/company/bin/shell {0}'), 'ci-shell-host-specific-executable');
  assert.equal(issue?.severity, 'medium');
});

test('host absolute custom shell is high with write authority', () => {
  const issue = finding(workflow('/opt/company/bin/shell {0}', {
    permissions: 'contents: write',
  }), 'ci-shell-host-specific-executable');
  assert.equal(issue?.severity, 'high');
});

test('windows absolute custom shell is recognized', () => {
  assert.ok(finding(workflow('C:\\tools\\shell.exe {0}'), 'ci-shell-host-specific-executable'));
});

test('named custom shell command is medium review', () => {
  const issue = finding(workflow('company-shell --strict {0}'), 'ci-shell-custom-command-review');
  assert.equal(issue?.severity, 'medium');
});

test('named custom shell command is high with secrets', () => {
  const issue = finding(workflow('company-shell {0}', {
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-shell-custom-command-review');
  assert.equal(issue?.severity, 'high');
});

test('job default shell applies to run step', () => {
  const result = audit(workflow(undefined, {
    jobDefaults: './scripts/job-shell {0}',
  }));
  assert.equal(result.summary.configuredShellSteps, 1);
  assert.equal(result.summary.signals[0]?.source, 'job-default');
  assert.equal(result.summary.signals[0]?.shell, './scripts/job-shell {0}');
});

test('workflow default shell applies when no narrower override exists', () => {
  const result = audit(workflow(undefined, {
    workflowDefaults: 'company-shell {0}',
  }));
  assert.equal(result.summary.signals[0]?.source, 'workflow-default');
});

test('step shell overrides unsafe job default', () => {
  const result = audit(workflow('bash', {
    jobDefaults: './scripts/unsafe-shell {0}',
  }));
  assert.equal(result.summary.signals[0]?.source, 'step');
  assert.deepEqual(result.findings, []);
});

test('job default overrides workflow default', () => {
  const result = audit(workflow(undefined, {
    workflowDefaults: './scripts/global-shell {0}',
    jobDefaults: 'bash',
  }));
  assert.equal(result.summary.signals[0]?.source, 'job-default');
  assert.equal(result.summary.signals[0]?.shell, 'bash');
  assert.deepEqual(result.findings, []);
});

test('uses-only action does not consume run default shell', () => {
  const source = `name: action\non:\n  push:\ndefaults:\n  run:\n    shell: ./scripts/wrapper {0}\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n`;
  const result = audit(source);
  assert.equal(result.summary.runSteps, 0);
  assert.equal(result.summary.configuredShellSteps, 0);
});

test('sibling job shell default does not leak', () => {
  const source = `name: scoped\non:\n  push:\npermissions:\n  contents: read\njobs:\n  safe:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo safe\n  wrapped:\n    defaults:\n      run:\n        shell: ./scripts/wrapper {0}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo wrapped\n`;
  const result = audit(source);
  assert.equal(result.summary.configuredShellSteps, 1);
  assert.equal(result.summary.signals[0]?.job, 'wrapped');
});

test('nested with shell key does not become run shell', () => {
  const source = `name: nested\non:\n  push:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: vendor/action@0123456789abcdef0123456789abcdef01234567\n        with:\n          shell: ./scripts/not-shell {0}\n      - run: echo safe\n`;
  assert.equal(audit(source).summary.configuredShellSteps, 0);
});

test('non-workflow shell content is ignored', () => {
  const result = audit('shell: ./scripts/wrapper {0}\n', 'docs/example.yml');
  assert.equal(result.summary.workflowFiles, 0);
});

test('summary counts custom and repository-controlled shells', () => {
  const source = workflow('./scripts/wrapper {0}');
  const result = audit(source);
  assert.equal(result.summary.customShellSteps, 1);
  assert.equal(result.summary.repositoryControlledShellSteps, 1);
});

test('finding location remains positive', () => {
  const result = audit(workflow('./scripts/wrapper {0}'));
  assert.ok((result.findings[0]?.location?.line ?? 0) > 0);
});

test('audit remains stable across LF and CRLF', () => {
  const source = workflow('./scripts/wrapper {0}', { trigger: 'pull_request' });
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
