import assert from 'node:assert/strict';
import test from 'node:test';
import { auditProcessEnvironmentBoundaries } from './process-env-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/env.yml') {
  return auditProcessEnvironmentBoundaries(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function workflow(
  body: string,
  trigger = 'push',
  permissions = 'contents: read',
): string {
  return `name: env\non:\n  ${trigger}:\npermissions:\n  ${permissions}\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n${body}`;
}

function issue(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('ordinary workflow without dangerous env assignments is clean', () => {
  const result = audit(workflow(`    env:\n      NODE_ENV: test\n    steps:\n      - run: npm test\n`));
  assert.equal(result.summary.dangerousAssignments, 0);
  assert.deepEqual(result.findings, []);
});

test('blocks event-controlled NODE_OPTIONS', () => {
  const result = audit(workflow(`    env:\n      NODE_OPTIONS: \${{ github.event.pull_request.title }}\n    steps:\n      - run: node test.mjs\n`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-process-env-untrusted-control');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks input-controlled BASH_ENV', () => {
  const finding = issue(workflow(`    env:\n      BASH_ENV: \${{ inputs.bootstrap }}\n    steps:\n      - run: echo ok\n`, 'workflow_dispatch'), 'ci-process-env-untrusted-control');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks event-controlled LD_PRELOAD in privileged job', () => {
  const finding = issue(workflow(`    env:\n      LD_PRELOAD: \${{ github.event.pull_request.body }}\n    steps:\n      - run: ./release\n`, 'pull_request_target', 'contents: write'), 'ci-process-env-untrusted-control');
  assert.equal(finding?.severity, 'critical');
});

test('reviews needs-controlled PYTHONPATH as indirect provenance', () => {
  const finding = issue(workflow(`    env:\n      PYTHONPATH: \${{ needs.plan.outputs.module_path }}\n    steps:\n      - run: python -m pytest\n`), 'ci-process-env-indirect-control');
  assert.equal(finding?.severity, 'medium');
});

test('raises indirect process env severity in write-capable job', () => {
  const finding = issue(workflow(`    env:\n      NODE_OPTIONS: \${{ needs.plan.outputs.node_options }}\n    steps:\n      - run: node publish.mjs\n`, 'push', 'contents: write'), 'ci-process-env-indirect-control');
  assert.equal(finding?.severity, 'high');
});

test('flags literal NODE_OPTIONS require hook', () => {
  const finding = issue(workflow(`    env:\n      NODE_OPTIONS: --require ./scripts/register.cjs\n    steps:\n      - run: node test.mjs\n`), 'ci-process-env-bootstrap-hook');
  assert.equal(finding?.severity, 'high');
});

test('escalates literal bootstrap hook on external trigger', () => {
  const finding = issue(workflow(`    env:\n      BASH_ENV: ./scripts/bootstrap.sh\n    steps:\n      - run: bash ./validate.sh\n`, 'pull_request'), 'ci-process-env-bootstrap-hook');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('flags literal LD_PRELOAD hook', () => {
  const finding = issue(workflow(`    env:\n      LD_PRELOAD: ./native/hook.so\n    steps:\n      - run: ./test\n`), 'ci-process-env-bootstrap-hook');
  assert.ok(finding);
});

test('flags nonzero GIT_CONFIG_COUNT', () => {
  const finding = issue(workflow(`    env:\n      GIT_CONFIG_COUNT: 1\n      GIT_CONFIG_KEY_0: url.https://example.invalid/.insteadOf\n      GIT_CONFIG_VALUE_0: https://github.com/\n    steps:\n      - run: git fetch\n`), 'ci-process-env-git-config-injection');
  assert.equal(finding?.severity, 'high');
});

test('escalates Git config environment injection with secrets', () => {
  const finding = issue(workflow(`    env:\n      TOKEN: \${{ secrets.RELEASE_TOKEN }}\n      GIT_CONFIG_COUNT: 1\n      GIT_CONFIG_KEY_0: core.sshCommand\n      GIT_CONFIG_VALUE_0: ssh -i ./key\n    steps:\n      - run: git push\n`), 'ci-process-env-git-config-injection');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('allows explicit zero GIT_CONFIG_COUNT without injection finding', () => {
  const result = audit(workflow(`    env:\n      GIT_CONFIG_COUNT: 0\n    steps:\n      - run: git status\n`));
  assert.equal(result.findings.some(item => item.id === 'ci-process-env-git-config-injection'), false);
});

test('reviews repository-relative PYTHONPATH', () => {
  const finding = issue(workflow(`    env:\n      PYTHONPATH: ./src\n    steps:\n      - run: python -m pytest\n`), 'ci-process-env-search-path-override');
  assert.equal(finding?.severity, 'medium');
});

test('raises repository-relative module path in secret-bearing job', () => {
  const finding = issue(workflow(`    env:\n      TOKEN: \${{ secrets.RELEASE_TOKEN }}\n      NODE_PATH: ./packages\n    steps:\n      - run: node publish.mjs\n`), 'ci-process-env-search-path-override');
  assert.equal(finding?.severity, 'high');
});

test('workflow-level dangerous env is inherited into every job analysis', () => {
  const source = `name: global\non:\n  pull_request:\nenv:\n  NODE_OPTIONS: \${{ github.event.pull_request.title }}\npermissions:\n  contents: read\njobs:\n  one:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node one.mjs\n  two:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node two.mjs\n`;
  const result = audit(source);
  assert.equal(result.summary.untrustedAssignments, 2);
  assert.equal(result.findings.filter(item => item.id === 'ci-process-env-untrusted-control').length, 2);
});

test('job env remains scoped to the owning job', () => {
  const source = `name: scoped\non:\n  push:\npermissions:\n  contents: read\njobs:\n  safe:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node safe.mjs\n  hooked:\n    env:\n      NODE_OPTIONS: --require ./hook.cjs\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node hooked.mjs\n`;
  const result = audit(source);
  assert.equal(result.summary.signals.filter(item => item.name === 'NODE_OPTIONS').length, 1);
  assert.equal(result.summary.signals[0]?.job, 'hooked');
});

test('step env is discovered without leaking to sibling steps', () => {
  const source = workflow(`    steps:\n      - name: safe\n        run: node safe.mjs\n      - name: hooked\n        env:\n          NODE_OPTIONS: --require ./hook.cjs\n        run: node hooked.mjs\n`);
  const result = audit(source);
  assert.equal(result.summary.dangerousAssignments, 1);
  assert.equal(result.summary.signals[0]?.scope, 'step');
  assert.equal(result.summary.signals[0]?.step, 1);
});

test('workflow and job assignments are deduplicated per effective source', () => {
  const source = `name: duplicate-name\non:\n  push:\nenv:\n  PYTHONPATH: ./global\npermissions:\n  contents: read\njobs:\n  test:\n    env:\n      PYTHONPATH: ./job\n    runs-on: ubuntu-24.04\n    steps:\n      - run: python -m pytest\n`;
  const result = audit(source);
  assert.equal(result.summary.signals.filter(item => item.name === 'PYTHONPATH').length, 2);
});

test('unrelated env keys do not create false positives', () => {
  const result = audit(workflow(`    env:\n      PATH_HINT: ./bin\n      NODE_ENV: production\n      PYTHONUNBUFFERED: '1'\n    steps:\n      - run: echo ok\n`));
  assert.equal(result.summary.dangerousAssignments, 0);
  assert.deepEqual(result.findings, []);
});

test('non-workflow files are ignored', () => {
  const result = audit('env:\n  NODE_OPTIONS: --require ./hook.cjs\n', 'docs/example.yml');
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('summary counts privileged dangerous assignments', () => {
  const result = audit(workflow(`    env:\n      NODE_PATH: ./packages\n      PYTHONPATH: ./python\n    steps:\n      - run: ./publish\n`, 'push', 'contents: write'));
  assert.equal(result.summary.dangerousAssignments, 2);
  assert.equal(result.summary.privilegedAssignments, 2);
});

test('source locations remain positive', () => {
  const result = audit(workflow(`    env:\n      NODE_OPTIONS: --require ./hook.cjs\n    steps:\n      - run: node app.mjs\n`));
  assert.ok((result.findings[0]?.location?.line ?? 0) > 0);
});

test('audit is stable across LF and CRLF', () => {
  const source = workflow(`    env:\n      NODE_OPTIONS: \${{ github.event.pull_request.title }}\n      PYTHONPATH: ./src\n    steps:\n      - run: node app.mjs\n`, 'pull_request');
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
