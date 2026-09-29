import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDependencyLifecycle } from './dependency-lifecycle-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/deps.yml') {
  return auditDependencyLifecycle(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function workflow(
  run: string,
  options: {
    readonly trigger?: string;
    readonly permissions?: string;
    readonly env?: string;
    readonly environment?: string;
  } = {},
): string {
  const env = options.env ? `    env:\n${options.env}\n` : '';
  const environment = options.environment ? `    environment: ${options.environment}\n` : '';
  return `name: deps\non:\n  ${options.trigger ?? 'push'}:\npermissions:\n  ${options.permissions ?? 'contents: read'}\njobs:\n  test:\n${env}${environment}    runs-on: ubuntu-24.04\n    steps:\n      - name: install\n        run: ${run}\n`;
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('npm ci with ignore-scripts is clean on trusted push', () => {
  const result = audit(workflow('npm ci --ignore-scripts --no-audit --no-fund'));
  assert.equal(result.summary.dependencyCommands, 1);
  assert.equal(result.summary.lifecycleEnabledInstalls, 0);
  assert.deepEqual(result.findings, []);
});

test('npm install without ignore-scripts is visible', () => {
  const issue = finding(workflow('npm install'), 'ci-dependency-lifecycle-enabled');
  assert.equal(issue?.severity, 'low');
});

test('ordinary pull request lifecycle install is medium review', () => {
  const issue = finding(workflow('npm ci', { trigger: 'pull_request' }), 'ci-dependency-lifecycle-enabled');
  assert.equal(issue?.severity, 'medium');
  assert.notEqual(issue?.blocking, true);
});

test('write-capable lifecycle install is high severity', () => {
  const issue = finding(workflow('npm ci', { permissions: 'contents: write' }), 'ci-dependency-lifecycle-enabled');
  assert.equal(issue?.severity, 'high');
});

test('external write-capable lifecycle install is blocking', () => {
  const issue = finding(workflow('npm ci', {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }), 'ci-dependency-lifecycle-enabled');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('external secret-bearing lifecycle install is blocking', () => {
  const issue = finding(workflow('npm ci', {
    trigger: 'pull_request',
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-dependency-lifecycle-enabled');
  assert.equal(issue?.severity, 'critical');
});

test('protected environment lifecycle install is high on trusted push', () => {
  const issue = finding(workflow('npm ci', {
    environment: 'production',
  }), 'ci-dependency-lifecycle-enabled');
  assert.equal(issue?.severity, 'high');
});

for (const command of [
  'pnpm install --ignore-scripts',
  'yarn install --ignore-scripts',
  'bun install --ignore-scripts',
] as const) {
  test(`accepts disabled lifecycle scripts for ${command.split(' ')[0]}`, () => {
    const result = audit(workflow(command));
    assert.equal(result.summary.dependencyCommands, 1);
    assert.equal(result.summary.lifecycleEnabledInstalls, 0);
    assert.equal(result.findings.some(item => item.id === 'ci-dependency-lifecycle-enabled'), false);
  });
}

for (const command of ['pnpm install', 'yarn install', 'bun install'] as const) {
  test(`detects enabled lifecycle scripts for ${command.split(' ')[0]}`, () => {
    assert.ok(finding(workflow(command), 'ci-dependency-lifecycle-enabled'));
  });
}

test('step environment can disable npm lifecycle scripts', () => {
  const source = `name: step-env\non:\n  push:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: install\n        env:\n          NPM_CONFIG_IGNORE_SCRIPTS: 'true'\n        run: npm ci\n`;
  const result = audit(source);
  assert.equal(result.summary.lifecycleEnabledInstalls, 0);
});

test('job environment can disable npm lifecycle scripts', () => {
  const result = audit(workflow('npm ci', {
    env: "      NPM_CONFIG_IGNORE_SCRIPTS: 'true'",
  }));
  assert.equal(result.summary.lifecycleEnabledInstalls, 0);
});

test('explicit false ignore-scripts enables lifecycle execution', () => {
  const result = audit(workflow('npm ci --ignore-scripts=false'));
  assert.ok(result.findings.some(item => item.id === 'ci-dependency-lifecycle-enabled'));
  assert.ok(result.findings.some(item => item.id === 'ci-dependency-lifecycle-explicit-enable'));
});

test('foreground scripts is explicit lifecycle enable', () => {
  const issue = finding(workflow('npm ci --foreground-scripts'), 'ci-dependency-lifecycle-explicit-enable');
  assert.equal(issue?.severity, 'high');
});

test('explicit enable becomes blocking in external context', () => {
  const issue = finding(workflow('npm ci --foreground-scripts', {
    trigger: 'pull_request',
  }), 'ci-dependency-lifecycle-explicit-enable');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('remote URL install is high severity on trusted read-only job', () => {
  const issue = finding(workflow('npm install https://example.invalid/pkg.tgz --ignore-scripts'), 'ci-dependency-remote-install');
  assert.equal(issue?.severity, 'high');
});

test('remote VCS install is blocking in privileged context', () => {
  const issue = finding(workflow('npm install git+https://github.com/example/pkg.git --ignore-scripts', {
    permissions: 'contents: write',
  }), 'ci-dependency-remote-install');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('github shorthand install is classified as remote install', () => {
  assert.ok(finding(workflow('npm install github:example/pkg --ignore-scripts'), 'ci-dependency-remote-install'));
});

test('global install is visible even with scripts disabled', () => {
  const issue = finding(workflow('npm install -g typescript --ignore-scripts'), 'ci-dependency-global-install');
  assert.equal(issue?.severity, 'medium');
});

test('global install is high in secret-bearing job', () => {
  const issue = finding(workflow('npm install --global typescript --ignore-scripts', {
    env: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-dependency-global-install');
  assert.equal(issue?.severity, 'high');
});

test('npm rebuild is lifecycle execution even after safe install', () => {
  const source = workflow('npm rebuild sharp');
  const rebuild = finding(source, 'ci-dependency-rebuild-lifecycle');
  assert.equal(rebuild?.severity, 'medium');
  assert.ok(finding(source, 'ci-dependency-lifecycle-explicit-enable'));
});

test('external privileged npm rebuild is blocking', () => {
  const issue = finding(workflow('npm rebuild', {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }), 'ci-dependency-rebuild-lifecycle');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('npm run build is not classified as dependency installation', () => {
  const result = audit(workflow('npm run build'));
  assert.equal(result.summary.dependencyCommands, 0);
  assert.deepEqual(result.findings, []);
});

test('npx invocation is outside lifecycle install audit', () => {
  const result = audit(workflow('npx --no-install tsc --noEmit'));
  assert.equal(result.summary.dependencyCommands, 0);
});

test('multiple package manager commands in block scalar are all inventoried', () => {
  const source = `name: multiple\non:\n  push:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: install\n        run: |\n          npm ci --ignore-scripts\n          pnpm install --ignore-scripts\n          yarn install --ignore-scripts\n`;
  const result = audit(source);
  assert.equal(result.summary.dependencyCommands, 3);
  assert.equal(result.summary.lifecycleEnabledInstalls, 0);
});

test('commands separated by && are inventoried', () => {
  const result = audit(workflow('npm ci --ignore-scripts && npm rebuild sharp'));
  assert.equal(result.summary.dependencyCommands, 2);
  assert.ok(result.findings.some(item => item.id === 'ci-dependency-rebuild-lifecycle'));
});

test('similar words in echo are not parsed as dependency command', () => {
  const result = audit(workflow("echo 'npm install'"));
  assert.equal(result.summary.dependencyCommands, 0);
});

test('non-workflow file is ignored', () => {
  const result = audit('run: npm install\n', 'docs/example.yml');
  assert.equal(result.summary.workflowFiles, 0);
});

test('summary counts privileged and external lifecycle installs', () => {
  const result = audit(workflow('npm ci', {
    trigger: 'pull_request',
    permissions: 'contents: write',
  }));
  assert.equal(result.summary.dependencyCommands, 1);
  assert.equal(result.summary.lifecycleEnabledInstalls, 1);
  assert.equal(result.summary.privilegedLifecycleInstalls, 1);
  assert.equal(result.summary.externalLifecycleInstalls, 1);
});

test('finding locations point to owning run step', () => {
  const result = audit(workflow('npm ci'));
  assert.ok((result.findings[0]?.location?.line ?? 0) > 0);
});

test('audit remains stable across LF and CRLF', () => {
  const source = workflow('npm ci --foreground-scripts', {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  });
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
