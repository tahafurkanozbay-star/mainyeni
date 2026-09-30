import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowCacheProvenance } from './workflow-cache-provenance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const PIN = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditWorkflowCacheProvenance(fixtureInventory([
    { path: '.github/workflows/cache-provenance.yml', text },
  ] as readonly FixtureFileInput[]));
}

function workflow(event: string, steps: string): string {
  return [
    'name: cache provenance',
    event,
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...steps.split('\n').map(line => `      ${line}`),
    '',
  ].join('\n');
}

function cache(body: string, subaction = ''): string {
  return [
    `- uses: actions/cache${subaction}@${PIN}`,
    '  with:',
    ...body.split('\n').map(line => `    ${line}`),
  ].join('\n');
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

test('blocks pull request writer sharing a literal namespace', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  ));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-untrusted-writer-shared-namespace' && item.blocking));
  assert.equal(result.summary.untrustedTriggerWorkflows, 1);
  assert.equal(result.summary.saveCapableSteps, 1);
});

test('blocks pull_request_target writer sharing a literal namespace', () => {
  assert.ok(ids(workflow(
    'on:\n  pull_request_target:',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  )).includes('ci-cache-untrusted-writer-shared-namespace'));
});

test('blocks issue comment writer sharing a namespace', () => {
  assert.ok(ids(workflow(
    'on:\n  issue_comment:\n    types: [created]',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  )).includes('ci-cache-untrusted-writer-shared-namespace'));
});

test('blocks review comment writer sharing a namespace', () => {
  assert.ok(ids(workflow(
    'on:\n  pull_request_review_comment:\n    types: [created]',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  )).includes('ci-cache-untrusted-writer-shared-namespace'));
});

test('blocks discussion writer sharing a namespace', () => {
  assert.ok(ids(workflow(
    'on:\n  discussion:\n    types: [created]',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  )).includes('ci-cache-untrusted-writer-shared-namespace'));
});

test('allows pull request cache writer isolated by immutable head sha', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache("path: ~/.npm\nkey: npm-${{ github.event.pull_request.head.sha }}-${{ hashFiles('package-lock.json') }}"),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-untrusted-writer-shared-namespace'), false);
  assert.equal(result.summary.workflows[0]?.refIsolatedKeys, 1);
});

test('allows pull request cache writer isolated by event number', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache("path: ~/.npm\nkey: npm-pr-${{ github.event.pull_request.number }}-${{ hashFiles('package-lock.json') }}"),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-untrusted-writer-shared-namespace'), false);
  assert.equal(result.summary.workflows[0]?.eventIsolatedKeys, 1);
});

test('restore subaction is not treated as a cache writer', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache('path: ~/.npm\nkey: npm-linux-lock', '/restore'),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-untrusted-writer-shared-namespace'), false);
  assert.equal(result.summary.restoreOnlySteps, 1);
  assert.equal(result.summary.saveCapableSteps, 0);
});

test('save subaction is treated as a cache writer', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache('path: ~/.npm\nkey: npm-linux-lock', '/save'),
  ));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-untrusted-writer-shared-namespace'));
  assert.equal(result.summary.saveCapableSteps, 1);
});

test('lookup-only main cache action is restore-only', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache('path: ~/.npm\nkey: npm-linux-lock\nlookup-only: true'),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-untrusted-writer-shared-namespace'), false);
  assert.equal(result.summary.restoreOnlySteps, 1);
});

test('untrusted writer with restore prefixes is always blocking', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache("path: ~/.npm\nkey: npm-${{ github.event.pull_request.head.sha }}\nrestore-keys: |\n  npm-linux-"),
  ));
  const finding = result.findings.find(item => item.id === 'ci-cache-untrusted-writer-fallback-namespace');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.severity, 'critical');
});

test('protected push writer without content hash is review finding', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache('path: ~/.npm\nkey: npm-linux-main'),
  ));
  const finding = result.findings.find(item => item.id === 'ci-cache-protected-writer-not-content-addressed');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, false);
});

test('protected release writer without content hash is review finding', () => {
  assert.ok(ids(workflow(
    'on:\n  release:\n    types: [published]',
    cache('path: ~/.npm\nkey: npm-linux-release'),
  )).includes('ci-cache-protected-writer-not-content-addressed'));
});

test('workflow_run cache writer without content hash is review finding', () => {
  assert.ok(ids(workflow(
    'on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]',
    cache('path: ~/.npm\nkey: npm-linux-workflow-run'),
  )).includes('ci-cache-protected-writer-not-content-addressed'));
});

test('manual cache writer without content hash is review finding', () => {
  assert.ok(ids(workflow(
    'on:\n  workflow_dispatch:',
    cache('path: ~/.npm\nkey: npm-linux-manual'),
  )).includes('ci-cache-protected-writer-not-content-addressed'));
});

test('content-addressed protected writer avoids mutable-key finding', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache("path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}"),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-protected-writer-not-content-addressed'), false);
  assert.equal(result.summary.workflows[0]?.contentAddressedKeys, 1);
});

test('protected fallback without content address is review finding', () => {
  assert.ok(ids(workflow(
    'on:\n  push:\n    branches: [main]',
    cache('path: ~/.npm\nkey: npm-linux-main\nrestore-keys: |\n  npm-linux-'),
  )).includes('ci-cache-protected-fallback-without-content-address'));
});

test('content-addressed protected fallback avoids mutable-primary finding', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache("path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}\nrestore-keys: |\n  npm-${{ runner.os }}-"),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-protected-fallback-without-content-address'), false);
});

test('protected writer missing platform identity is reported', () => {
  assert.ok(ids(workflow(
    'on:\n  push:\n    branches: [main]',
    cache("path: ~/.npm\nkey: npm-${{ hashFiles('package-lock.json') }}"),
  )).includes('ci-cache-platform-identity-missing'));
});

test('runner os satisfies platform isolation baseline', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache("path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}"),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-platform-identity-missing'), false);
});

test('required cache hit with fallback is provenance review finding', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache("path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}\nrestore-keys: |\n  npm-${{ runner.os }}-\nfail-on-cache-miss: true", '/restore'),
  ));
  assert.ok(result.findings.some(item => item.id === 'ci-cache-required-hit-with-fallback'));
});

test('exact required cache hit has no fallback finding', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache("path: ~/.npm\nkey: npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}\nfail-on-cache-miss: true", '/restore'),
  ));
  assert.equal(result.findings.some(item => item.id === 'ci-cache-required-hit-with-fallback'), false);
});

test('restore subaction lookup-only redundancy is low severity', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    cache('path: ~/.npm\nkey: npm-linux-lock\nlookup-only: true', '/restore'),
  ));
  const finding = result.findings.find(item => item.id === 'ci-cache-restore-lookup-only-redundant');
  assert.equal(finding?.severity, 'low');
  assert.equal(finding?.blocking, false);
});

test('array pull_request trigger is recognized', () => {
  assert.ok(ids(workflow(
    'on: [push, pull_request]',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  )).includes('ci-cache-untrusted-writer-shared-namespace'));
});

test('scalar pull_request trigger is recognized', () => {
  assert.ok(ids(workflow(
    'on: pull_request',
    cache('path: ~/.npm\nkey: npm-linux-lock'),
  )).includes('ci-cache-untrusted-writer-shared-namespace'));
});

test('array push trigger is recognized as protected path', () => {
  assert.ok(ids(workflow(
    'on: [push]',
    cache('path: ~/.npm\nkey: npm-linux-main'),
  )).includes('ci-cache-protected-writer-not-content-addressed'));
});

test('non-workflow yaml is ignored', () => {
  const result = auditWorkflowCacheProvenance(fixtureInventory([
    { path: 'config/cache.yml', text: `on: pull_request\nuses: actions/cache@${PIN}` },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('multiple cache steps are counted independently', () => {
  const result = audit(workflow(
    'on:\n  pull_request:',
    [
      cache('path: ~/.npm\nkey: npm-linux-lock', '/restore'),
      '- name: build',
      '  run: npm test',
      cache('path: ~/.cache/tool\nkey: tool-linux-lock', '/save'),
    ].join('\n'),
  ));
  assert.equal(result.summary.cacheSteps, 2);
  assert.equal(result.summary.restoreOnlySteps, 1);
  assert.equal(result.summary.saveCapableSteps, 1);
  assert.equal(result.findings.filter(item => item.id === 'ci-cache-untrusted-writer-shared-namespace').length, 1);
});

test('findings are deterministically sorted', () => {
  const result = audit(workflow(
    'on:\n  push:\n    branches: [main]',
    cache('path: ~/.npm\nkey: npm-main\nrestore-keys: |\n  npm-\nfail-on-cache-miss: true'),
  ));
  const ordered = [...result.findings].map(item => {
    const location = item.location;
    return location === undefined ? `<unknown>:0:${item.id}` : `${location.file}:${location.line}:${item.id}`;
  });
  assert.deepEqual(ordered, [...ordered].sort());
});
