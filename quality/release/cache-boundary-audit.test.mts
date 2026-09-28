import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCacheBoundaries } from './cache-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function workflow(step: string, trigger = 'pull_request', permissions = 'contents: read'): string {
  return `name: cache\non:\n  ${trigger}:\npermissions:\n  ${permissions}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
}

function cacheStep(overrides = ''): string {
  return `      - uses: actions/cache@${sha}\n        with:\n          path: ~/.npm\n          key: npm-${'${{ runner.os }}'}-${'${{ hashFiles(\'**/package-lock.json\') }}'}\n${overrides}`;
}

function audit(text: string, path = '.github/workflows/cache.yml') {
  return auditCacheBoundaries(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(finding => finding.id);
}

function has(text: string, id: string): boolean {
  return ids(text).includes(id);
}

test('accepts immutable narrow dependency cache on ordinary pull request', () => {
  assert.deepEqual(audit(workflow(cacheStep())).findings, []);
});

test('counts cache operations deterministically', () => {
  const restore = `      - uses: actions/cache/restore@${sha}\n        with:\n          path: ~/.npm\n          key: npm-lock\n`;
  const save = `      - uses: actions/cache/save@${sha}\n        with:\n          path: ~/.npm\n          key: npm-lock\n`;
  const result = audit(workflow(`${restore}${save}`));
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.cacheOperations, 2);
  assert.equal(result.summary.restoreOperations, 1);
  assert.equal(result.summary.saveOperations, 1);
});

test('ignores cache-looking text outside workflows', () => {
  const result = audit(workflow(cacheStep()), 'docs/cache.yml');
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('supports yaml workflow extension', () => {
  assert.equal(audit(workflow(cacheStep()), '.github/workflows/cache.yaml').summary.cacheOperations, 1);
});

test('rejects mutable cache action tag', () => {
  assert.equal(has(workflow(cacheStep().replace(`actions/cache@${sha}`, 'actions/cache@v4')), 'ci-cache-mutable-action'), true);
});

test('rejects mutable cache branch', () => {
  assert.equal(has(workflow(cacheStep().replace(`actions/cache@${sha}`, 'actions/cache@main')), 'ci-cache-mutable-action'), true);
});

test('requires explicit cache key', () => {
  assert.equal(has(workflow(cacheStep().replace(/\s+key:.*\n/, '\n')), 'ci-cache-key-missing'), true);
});

for (const expression of [
  '${{ github.head_ref }}',
  '${{ github.event.pull_request.head.sha }}',
  '${{ github.event.pull_request.head.ref }}',
  '${{ github.event.issue.title }}',
  '${{ github.event.comment.body }}',
  '${{ github.event.review.body }}',
  '${{ github.event.discussion.title }}',
  '${{ inputs.cache_key }}',
  '${{ github.event.inputs.cache_key }}',
] as const) {
  test(`rejects attacker-controlled cache key ${expression}`, () => {
    const text = cacheStep().replace("${{ hashFiles('**/package-lock.json') }}", expression);
    assert.equal(has(workflow(text), 'ci-cache-key-untrusted-input'), true);
  });
}

test('allows immutable repository hash in cache key', () => {
  assert.equal(has(workflow(cacheStep()), 'ci-cache-key-untrusted-input'), false);
});

test('flags restore-key fallback in privileged workflow', () => {
  const step = cacheStep('          restore-keys: |\n            npm-${{ runner.os }}-\n');
  assert.equal(has(workflow(step, 'push', 'contents: write'), 'ci-cache-privileged-prefix-restore'), true);
});

test('allows restore-key fallback in unprivileged trusted push workflow', () => {
  const step = cacheStep('          restore-keys: |\n            npm-${{ runner.os }}-\n');
  assert.equal(has(workflow(step, 'push'), 'ci-cache-privileged-prefix-restore'), false);
});

test('requires explicit cache path', () => {
  assert.equal(has(workflow(cacheStep().replace('          path: ~/.npm\n', '')), 'ci-cache-path-missing'), true);
});

for (const path of ['.', './', '${{ github.workspace }}', '~'] as const) {
  test(`blocks broad cache path ${path}`, () => {
    const step = cacheStep().replace('~/.npm', path);
    assert.equal(has(workflow(step), 'ci-cache-broad-workspace-path'), true);
  });
}

for (const path of ['node_modules/.bin', './bin', './scripts', './tools', './vendor', '~/.cargo/bin', '~/.local/bin'] as const) {
  test(`flags executable cache path ${path}`, () => {
    const step = cacheStep().replace('~/.npm', path);
    assert.equal(has(workflow(step), 'ci-cache-executable-path'), true);
  });
}

test('escalates executable cache path in privileged workflow', () => {
  const result = audit(workflow(cacheStep().replace('~/.npm', './tools'), 'push', 'contents: write'));
  const finding = result.findings.find(item => item.id === 'ci-cache-executable-path');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

for (const trigger of ['pull_request_target', 'issue_comment', 'pull_request_review', 'discussion_comment'] as const) {
  test(`blocks writable cache from untrusted trigger ${trigger}`, () => {
    assert.equal(has(workflow(cacheStep(), trigger), 'ci-cache-untrusted-event-can-save'), true);
  });
}

test('allows explicit restore action from untrusted trigger when otherwise narrow', () => {
  const restore = cacheStep().replace('actions/cache@', 'actions/cache/restore@');
  assert.equal(has(workflow(restore, 'pull_request_target'), 'ci-cache-untrusted-event-can-save'), false);
});

test('blocks untrusted trigger combined with workflow privilege', () => {
  const text = workflow(cacheStep(), 'pull_request_target', 'contents: write');
  assert.equal(has(text, 'ci-cache-untrusted-privileged-boundary'), true);
});

test('does not report privileged boundary on trusted push', () => {
  const text = workflow(cacheStep(), 'push', 'contents: write');
  assert.equal(has(text, 'ci-cache-untrusted-privileged-boundary'), false);
});

test('findings preserve source location', () => {
  const text = workflow(cacheStep().replace(`actions/cache@${sha}`, 'actions/cache@v4'));
  const finding = audit(text).findings.find(item => item.id === 'ci-cache-mutable-action');
  assert.equal(finding?.location?.file, '.github/workflows/cache.yml');
  assert.equal(typeof finding?.location?.line, 'number');
  assert.ok((finding?.location?.line ?? 0) > 0);
});

test('summary includes findings for reporting', () => {
  const result = audit(workflow(cacheStep().replace(`actions/cache@${sha}`, 'actions/cache@v4')));
  assert.equal(result.summary.findings, result.findings);
});
