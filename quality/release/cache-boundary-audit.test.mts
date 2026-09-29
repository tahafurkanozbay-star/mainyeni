import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCacheBoundaries } from './cache-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function workflow(
  steps: string,
  options: {
    readonly trigger?: string;
    readonly permissions?: string;
    readonly jobEnv?: string;
    readonly path?: string;
  } = {},
): string {
  const trigger = options.trigger ?? 'push';
  const permissions = options.permissions ?? 'contents: read';
  const jobEnv = options.jobEnv ? `    env:\n${options.jobEnv}\n` : '';
  return `name: cache\non:\n  ${trigger}:\npermissions:\n  ${permissions}\njobs:\n  test:\n${jobEnv}    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    steps:\n${steps}`;
}

function cacheStep(
  overrides = '',
  action = `actions/cache@${sha}`,
): string {
  return `      - name: cache dependencies\n        uses: ${action}\n        with:\n          path: ~/.npm\n          key: npm-\${{ runner.os }}-\${{ hashFiles('**/package-lock.json') }}\n${overrides}`;
}

function setupStep(
  overrides = '',
  action = `actions/setup-node@${sha}`,
): string {
  return `      - name: setup node\n        uses: ${action}\n        with:\n          node-version: 24\n          cache: npm\n          cache-dependency-path: Webclient.app/package-lock.json\n${overrides}`;
}

function audit(text: string, path = '.github/workflows/cache.yml') {
  return auditCacheBoundaries(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

function has(text: string, id: string): boolean {
  return finding(text, id) !== undefined;
}

test('accepts immutable narrow dependency cache on trusted push', () => {
  const result = audit(workflow(cacheStep()));
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.cacheOperations, 1);
  assert.equal(result.summary.saveOperations, 1);
});

test('ordinary pull request cache save remains visible without becoming a blocker', () => {
  const result = audit(workflow(cacheStep(), { trigger: 'pull_request' }));
  const review = result.findings.find(item => item.id === 'ci-cache-external-save-review');
  assert.equal(review?.severity, 'medium');
  assert.notEqual(review?.blocking, true);
  assert.equal(result.findings.some(item => item.severity === 'critical'), false);
});

test('counts combined restore and save operations deterministically', () => {
  const restore = cacheStep('', `actions/cache/restore@${sha}`);
  const save = cacheStep('', `actions/cache/save@${sha}`);
  const result = audit(workflow(`${restore}${save}`));
  assert.equal(result.summary.cacheOperations, 2);
  assert.equal(result.summary.restoreOperations, 1);
  assert.equal(result.summary.saveOperations, 1);
  assert.equal(result.summary.setupCacheOperations, 0);
});

test('ignores cache-looking content outside workflow directory', () => {
  const result = audit(workflow(cacheStep()), 'docs/cache.yml');
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.summary.cacheOperations, 0);
  assert.deepEqual(result.findings, []);
});

test('supports yaml workflow extension', () => {
  const result = audit(workflow(cacheStep()), '.github/workflows/cache.yaml');
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.cacheOperations, 1);
});

test('rejects mutable cache action tag', () => {
  const result = audit(workflow(cacheStep('', 'actions/cache@v4')));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-mutable-action'), true);
});

test('escalates mutable cache action when write authority exists', () => {
  const result = audit(workflow(cacheStep('', 'actions/cache@v4'), {
    permissions: 'contents: write',
  }));
  const issue = result.findings.find(item => item.id === 'ci-cache-mutable-action');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('requires explicit key for direct cache action', () => {
  const step = cacheStep().replace(/\s+key:.*\n/, '\n');
  assert.equal(has(workflow(step), 'ci-cache-key-missing'), true);
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
  test(`reports untrusted cache key ${expression}`, () => {
    const step = cacheStep().replace("${{ hashFiles('**/package-lock.json') }}", expression);
    const issue = finding(workflow(step), 'ci-cache-key-untrusted-input');
    assert.ok(issue);
  });
}

test('untrusted cache key becomes blocking in privileged external workflow', () => {
  const step = cacheStep().replace(
    "${{ hashFiles('**/package-lock.json') }}",
    '${{ github.event.pull_request.head.ref }}',
  );
  const issue = finding(workflow(step, {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }), 'ci-cache-key-untrusted-input');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('reviews needs-derived cache identity as indirect provenance', () => {
  const step = cacheStep().replace(
    "${{ hashFiles('**/package-lock.json') }}",
    '${{ needs.plan.outputs.cache_key }}',
  );
  const issue = finding(workflow(step), 'ci-cache-key-indirect-provenance');
  assert.equal(issue?.severity, 'medium');
});

test('allows lockfile hash and runner platform in direct cache key', () => {
  assert.equal(has(workflow(cacheStep()), 'ci-cache-key-untrusted-input'), false);
  assert.equal(has(workflow(cacheStep()), 'ci-cache-key-indirect-provenance'), false);
});

test('flags restore-key fallback in write-capable workflow', () => {
  const step = cacheStep('          restore-keys: |\n            npm-${{ runner.os }}-\n');
  const issue = finding(workflow(step, {
    permissions: 'contents: write',
  }), 'ci-cache-privileged-prefix-restore');
  assert.equal(issue?.severity, 'high');
});

test('flags restore-key fallback on ordinary external contribution as medium review', () => {
  const step = cacheStep('          restore-keys: |\n            npm-${{ runner.os }}-\n');
  const issue = finding(workflow(step, {
    trigger: 'pull_request',
  }), 'ci-cache-privileged-prefix-restore');
  assert.equal(issue?.severity, 'medium');
  assert.notEqual(issue?.blocking, true);
});

test('allows restore-key fallback on unprivileged trusted push', () => {
  const step = cacheStep('          restore-keys: |\n            npm-${{ runner.os }}-\n');
  assert.equal(has(workflow(step), 'ci-cache-privileged-prefix-restore'), false);
});

test('requires explicit path for direct cache action', () => {
  const step = cacheStep().replace('          path: ~/.npm\n', '');
  assert.equal(has(workflow(step), 'ci-cache-path-missing'), true);
});

for (const path of ['.', './', '${{ github.workspace }}', '~'] as const) {
  test(`blocks broad cache path ${path}`, () => {
    const step = cacheStep().replace('~/.npm', path);
    const issue = finding(workflow(step), 'ci-cache-broad-workspace-path');
    assert.equal(issue?.severity, 'critical');
    assert.equal(issue?.blocking, true);
  });
}

for (const path of [
  'node_modules/.bin',
  './bin',
  './scripts',
  './tools',
  './vendor',
  '~/.cargo/bin',
  '~/.local/bin',
] as const) {
  test(`flags executable cache path ${path}`, () => {
    const step = cacheStep().replace('~/.npm', path);
    assert.equal(has(workflow(step), 'ci-cache-executable-path'), true);
  });
}

test('escalates executable cache path when secret context exists', () => {
  const result = audit(workflow(cacheStep().replace('~/.npm', './tools'), {
    jobEnv: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }));
  const issue = result.findings.find(item => item.id === 'ci-cache-executable-path');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('recognizes setup-node built-in cache as a cache operation', () => {
  const result = audit(workflow(setupStep()));
  assert.equal(result.summary.cacheOperations, 1);
  assert.equal(result.summary.setupCacheOperations, 1);
  assert.equal(result.summary.saveOperations, 1);
  assert.equal(result.summary.signals[0]?.cacheMode, 'npm');
});

test('setup action without cache input is not a cache operation', () => {
  const step = setupStep().replace('          cache: npm\n', '');
  const result = audit(workflow(step));
  assert.equal(result.summary.cacheOperations, 0);
  assert.equal(result.summary.setupCacheOperations, 0);
});

test('mutable setup action with caching is a supply-chain finding', () => {
  const issue = finding(
    workflow(setupStep('', 'actions/setup-node@v6')),
    'ci-cache-mutable-action',
  );
  assert.equal(issue?.severity, 'high');
});

test('blocks setup cache on pull_request_target', () => {
  const result = audit(workflow(setupStep(), {
    trigger: 'pull_request_target',
  }));
  const issue = result.findings.find(item => item.id === 'ci-cache-setup-privileged-trigger');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('blocks setup cache on external write-authority job', () => {
  const result = audit(workflow(setupStep(), {
    trigger: 'pull_request',
    permissions: 'contents: write',
  }));
  const issue = result.findings.find(item => item.id === 'ci-cache-untrusted-privileged-boundary');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('blocks setup cache on external secret-bearing job', () => {
  const result = audit(workflow(setupStep(), {
    trigger: 'pull_request',
    jobEnv: '      TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }));
  const issue = result.findings.find(item => item.id === 'ci-cache-untrusted-privileged-boundary');
  assert.equal(issue?.severity, 'critical');
});

test('reviews setup cache on ordinary pull request without privilege', () => {
  const result = audit(workflow(setupStep(), {
    trigger: 'pull_request',
  }));
  const issue = result.findings.find(item => item.id === 'ci-cache-external-save-review');
  assert.equal(issue?.severity, 'medium');
  assert.equal(result.findings.some(item => item.severity === 'critical'), false);
});

test('blocks event-controlled setup cache dependency path', () => {
  const step = setupStep().replace(
    'Webclient.app/package-lock.json',
    '${{ github.event.pull_request.title }}',
  );
  const issue = finding(workflow(step, {
    trigger: 'pull_request_target',
  }), 'ci-cache-setup-dependency-path-untrusted');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('reviews needs-controlled setup cache dependency path', () => {
  const step = setupStep().replace(
    'Webclient.app/package-lock.json',
    '${{ needs.plan.outputs.lockfile }}',
  );
  const issue = finding(workflow(step), 'ci-cache-setup-dependency-path-indirect');
  assert.equal(issue?.severity, 'medium');
});

test('literal setup cache dependency path remains clean on trusted push', () => {
  const result = audit(workflow(setupStep()));
  assert.equal(
    result.findings.some(item => item.id.startsWith('ci-cache-setup-dependency-path')),
    false,
  );
});

test('restore-only action on privileged external trigger cannot save cache state', () => {
  const restore = cacheStep('', `actions/cache/restore@${sha}`);
  const result = audit(workflow(restore, {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }));
  assert.equal(
    result.findings.some(item => item.id === 'ci-cache-untrusted-privileged-boundary'),
    false,
  );
  assert.equal(result.summary.restoreOperations, 1);
  assert.equal(result.summary.saveOperations, 0);
});

test('save action on privileged external trigger is blocking', () => {
  const save = cacheStep('', `actions/cache/save@${sha}`);
  const issue = finding(workflow(save, {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }), 'ci-cache-untrusted-privileged-boundary');
  assert.equal(issue?.blocking, true);
});

test('job privilege remains scoped and does not leak from sibling job', () => {
  const text = `name: scoped\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  cache:\n    runs-on: ubuntu-24.04\n    steps:\n${cacheStep()}  publish:\n    permissions:\n      contents: write\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo publish\n`;
  const result = audit(text);
  const cacheSignal = result.summary.signals.find(item => item.job === 'cache');
  assert.equal(cacheSignal?.writeAuthority, false);
  assert.equal(
    result.findings.some(item => item.id === 'ci-cache-untrusted-privileged-boundary'),
    false,
  );
});

test('nested application fields named cache do not create cache operations', () => {
  const text = workflow(`      - name: app config\n        run: echo ok\n        env:\n          cache: npm\n          restore-keys: unsafe\n`);
  const result = audit(text);
  assert.equal(result.summary.cacheOperations, 0);
  assert.deepEqual(result.findings, []);
});

test('summary findings shares canonical finding array', () => {
  const result = audit(workflow(cacheStep('', 'actions/cache@v4')));
  assert.equal(result.summary.findings, result.findings);
});

test('summary reports external and privileged cache counts', () => {
  const result = audit(workflow(setupStep(), {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  }));
  assert.equal(result.summary.externalCacheOperations, 1);
  assert.equal(result.summary.privilegedCacheOperations, 1);
});

test('finding source location points to cache-capable action step', () => {
  const result = audit(workflow(cacheStep('', 'actions/cache@v4')));
  const issue = result.findings.find(item => item.id === 'ci-cache-mutable-action');
  assert.equal(issue?.location?.file, '.github/workflows/cache.yml');
  assert.ok((issue?.location?.line ?? 0) > 0);
});

test('cache audit is stable across LF and CRLF input', () => {
  const source = workflow(setupStep(), {
    trigger: 'pull_request_target',
    permissions: 'contents: write',
  });
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
