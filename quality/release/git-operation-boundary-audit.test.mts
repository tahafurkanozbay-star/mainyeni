import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGitOperationBoundaries } from './git-operation-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditGitOperationBoundaries(fixtureInventory([{ path: '.github/workflows/git.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(on: string, run: string, permissions = 'contents: read', env = ''): string {
  const runBody = run.split('\n').map(line => `          ${line}`).join('\n');
  return `name: git\non: ${on}\npermissions:\n  ${permissions}\njobs:\n  git:\n    runs-on: ubuntu-latest\n    steps:\n      - name: git\n${env}        run: |\n${runBody}\n`;
}

test('accepts static exact-sha fetch on trusted push', () => {
  const result = audit(workflow('[push]', 'git fetch origin 0123456789abcdef0123456789abcdef01234567\ngit checkout --detach 0123456789abcdef0123456789abcdef01234567'));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.gitSteps, 1);
});

test('blocks safe.directory wildcard', () => {
  const result = audit(workflow('[push]', "git config --global --add safe.directory '*'"));
  const finding = result.findings.find(item => item.id === 'ci-git-safe-directory-wildcard');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('flags credential helper store', () => {
  const result = audit(workflow('[push]', 'git config --global credential.helper store'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-persistent-credential-helper'));
});

test('blocks credential helper store in privileged job', () => {
  const result = audit(workflow('[push]', 'git config --global credential.helper store', 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-persistent-credential-helper' && item.blocking));
});

test('flags shell-backed credential helper', () => {
  const result = audit(workflow('[push]', "git config --global credential.helper '!f() { echo password=x; }; f'"));
  assert.ok(result.findings.some(item => item.id === 'ci-git-persistent-credential-helper'));
});

test('blocks secret in git remote URL', () => {
  const env = `        env:\n          TOKEN: \${{ secrets.REPO_TOKEN }}\n`;
  const result = audit(workflow('[push]', 'git remote set-url origin "https://$TOKEN@github.com/owner/repo.git"', 'contents: write', env));
  assert.ok(result.findings.some(item => item.id === 'ci-git-secret-remote-url' && item.blocking));
});

test('blocks direct secret expression in extraheader config', () => {
  const result = audit(workflow('[push]', 'git config http.https://github.com/.extraheader "Authorization: Bearer ${{ secrets.REPO_TOKEN }}"', 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-secret-remote-url'));
});

test('blocks external pull request git push with write authority', () => {
  const result = audit(workflow('[pull_request]', 'git push origin HEAD:refs/heads/generated', 'contents: write'));
  const finding = result.findings.find(item => item.id === 'ci-git-external-event-push');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('does not flag trusted push git push solely because it mutates', () => {
  const result = audit(workflow('[push]', 'git push origin HEAD:refs/heads/generated', 'contents: write'));
  assert.equal(result.findings.some(item => item.id === 'ci-git-external-event-push'), false);
});

test('flags dynamic checkout ref', () => {
  const result = audit(workflow('[workflow_dispatch]', 'git checkout "${{ inputs.ref }}"'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-dynamic-ref-operation'));
});

test('blocks dynamic fetch ref in privileged job', () => {
  const result = audit(workflow('[workflow_dispatch]', 'git fetch origin "${{ inputs.ref }}"', 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-dynamic-ref-operation' && item.blocking));
});

test('flags dynamic clone origin', () => {
  const result = audit(workflow('[workflow_dispatch]', 'git clone "${{ inputs.repository }}" source'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-dynamic-remote-operation'));
});

test('flags dynamic remote set-url', () => {
  const result = audit(workflow('[workflow_dispatch]', 'git remote set-url origin "${{ inputs.url }}"'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-dynamic-remote-operation'));
});

test('flags submodule remote branch update', () => {
  const result = audit(workflow('[push]', 'git submodule update --remote --recursive'));
  assert.ok(result.findings.some(item => item.id === 'ci-git-submodule-remote-update'));
});

test('reports deterministic counts', () => {
  const result = audit(workflow('[pull_request]', "git config --global --add safe.directory '*'\ngit checkout \"${{ github.head_ref }}\"\ngit push origin HEAD:test", 'contents: write'));
  assert.equal(result.summary.gitSteps, 1);
  assert.equal(result.summary.pushes, 1);
  assert.equal(result.summary.dynamicRefs, 1);
  assert.equal(result.summary.unsafeDirectoryBypasses, 1);
});

test('ignores non-workflow git scripts', () => {
  const result = auditGitOperationBoundaries(fixtureInventory([{ path: 'scripts/git.yml', text: 'run: git push origin main' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
