import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowCacheBoundaries } from './workflow-cache-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const PIN = '0123456789abcdef0123456789abcdef01234567';
function audit(text: string) {
  return auditWorkflowCacheBoundaries(fixtureInventory([{ path: '.github/workflows/cache.yml', text }] as readonly FixtureFileInput[]));
}
function workflow(step: string, permissions = 'contents: read'): string {
  return `name: cache\non: [push]\npermissions:\n  ${permissions}\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${step.split('\n').map(line => `      ${line}`).join('\n')}\n`;
}
function cache(body: string, ref = PIN): string { return `- uses: actions/cache@${ref}\n  with:\n${body.split('\n').map(line => `    ${line}`).join('\n')}`; }

test('accepts pinned cache with trusted content-addressed key', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles(\'**/package-lock.json\') }}')));
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.cacheSteps, 1);
  assert.equal(result.summary.dynamicKeys, 1);
});

test('blocks mutable actions/cache ref', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-lock', 'v4')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-action-mutable-ref' && item.blocking));
});

test('blocks attacker-controlled cache key', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-${{ github.event.pull_request.title }}')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-key-untrusted-input' && item.severity === 'critical'));
});

test('blocks workflow input in cache key', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-${{ inputs.cache_namespace }}')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-key-untrusted-input'));
});

test('blocks attacker-controlled cache path', () => {
  const result = audit(workflow(cache('path: ${{ github.event.pull_request.head.ref }}\nkey: npm-lock')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-path-untrusted-input'));
  assert.equal(result.summary.dynamicPaths, 1);
});

test('blocks git metadata cache', () => {
  const result = audit(workflow(cache('path: .git\nkey: repository-state')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-sensitive-path'));
});

test('blocks ssh credential cache', () => {
  const result = audit(workflow(cache('path: ~/.ssh\nkey: ssh-state')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-sensitive-path'));
});

test('blocks npm credential configuration cache', () => {
  const result = audit(workflow(cache('path: |\n  ~/.npm\n  ~/.npmrc\nkey: npm-lock')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-sensitive-path'));
  assert.equal(result.summary.sensitivePaths, 1);
});

test('blocks environment file cache', () => {
  const result = audit(workflow(cache('path: .env.production\nkey: env')));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-sensitive-path'));
});

test('missing key is blocking in privileged workflow', () => {
  const result = audit(workflow(cache('path: ~/.npm'), 'contents: write'));
  const finding = result.findings.find(item => item.id === 'ci-cache-key-missing');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.severity, 'critical');
});

test('missing key is high review finding in read-only workflow', () => {
  const result = audit(workflow(cache('path: ~/.npm')));
  const finding = result.findings.find(item => item.id === 'ci-cache-key-missing');
  assert.equal(finding?.blocking, false);
  assert.equal(finding?.severity, 'high');
});

test('blocks broad executable restore prefix in privileged workflow', () => {
  const result = audit(workflow(cache('path: node_modules\nkey: npm-${{ hashFiles(\'package-lock.json\') }}\nrestore-keys: |\n  npm-'), 'contents: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-privileged-broad-executable-restore' && item.blocking));
});

test('allows exact cache key for executable content in privileged workflow', () => {
  const result = audit(workflow(cache('path: node_modules\nkey: npm-${{ runner.os }}-${{ hashFiles(\'package-lock.json\') }}'), 'contents: write'));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-privileged-broad-executable-restore'), false);
});

test('blocks attacker-controlled restore prefix in privileged workflow', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-lock\nrestore-keys: |\n  npm-${{ inputs.channel }}-'), 'packages: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-privileged-untrusted-restore-prefix'));
});

test('read-only workflow may use a reviewed broad restore prefix for non-executable package tarballs', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles(\'package-lock.json\') }}\nrestore-keys: |\n  npm-${{ runner.os }}-')));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-privileged-broad-executable-restore'), false);
});

test('counts broad prefixes deterministically', () => {
  const result = audit(workflow(cache('path: ~/.npm\nkey: npm-lock\nrestore-keys: |\n  npm-\n  build-')));
  assert.equal(result.summary.broadRestorePrefixes, 2);
});

test('inspects cache restore subaction', () => {
  const result = audit(workflow(`- uses: actions/cache/restore@${PIN}\n  with:\n    path: .git\n    key: repo`));
  assert.equal(result.summary.cacheSteps, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-cache-sensitive-path'));
});

test('inspects cache save subaction', () => {
  const result = audit(workflow(`- uses: actions/cache/save@${PIN}\n  with:\n    path: ~/.ssh\n    key: ssh`));
  assert.equal(result.summary.cacheSteps, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-cache-sensitive-path'));
});

test('does not inspect non-workflow YAML', () => {
  const result = auditWorkflowCacheBoundaries(fixtureInventory([{ path: 'config/cache.yml', text: `uses: actions/cache@${PIN}` }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('reports multiple cache steps independently', () => {
  const text = workflow(`${cache('path: ~/.npm\nkey: npm-lock')}\n- name: separator\n  run: echo ok\n${cache('path: .git\nkey: git-state')}`);
  const result = audit(text);
  assert.equal(result.summary.cacheSteps, 2);
  assert.equal(result.summary.sensitivePaths, 1);
});
