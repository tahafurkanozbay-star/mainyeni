import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCiIntegrity } from './ci-integrity-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/qa.yml') {
  return auditCiIntegrity(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(finding => finding.id);
}

const sha = '0123456789abcdef0123456789abcdef01234567';

test('accepts SHA-pinned actions with explicit read permissions', () => {
  const result = audit(`name: QA
on: [pull_request]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - uses: actions/setup-node@${sha}
      - run: npm ci
      - run: npm test
`);
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.shaPinnedActionReferences, 2);
  assert.equal(result.summary.mutableActionReferences, 0);
  assert.deepEqual(result.findings, []);
});

test('flags mutable action tags as supply-chain review findings', () => {
  const result = audit(`name: QA
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: vendor/security-scan@main
`);
  assert.equal(result.summary.mutableActionReferences, 2);
  assert.equal(result.findings.filter(f => f.id === 'ci-action-mutable-ref').length, 2);
});

test('does not treat local actions as mutable remote dependencies', () => {
  const result = audit(`name: QA
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/local-check
`);
  assert.equal(result.summary.mutableActionReferences, 0);
  assert.equal(result.findings.some(f => f.id === 'ci-action-mutable-ref'), false);
});

test('does not treat docker uses syntax as a GitHub action ref', () => {
  const result = audit(`name: QA
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    container: alpine:3.22
    steps:
      - uses: docker://alpine:3.22
`);
  assert.equal(result.summary.mutableActionReferences, 0);
});

test('flags missing explicit workflow permissions', () => {
  assert.ok(ids(`name: QA
on: [push]
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`).includes('ci-permissions-implicit'));
});

test('blocks write-all workflow token authority', () => {
  const finding = audit(`name: Deploy
on: [push]
permissions: write-all
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`).findings.find(item => item.id === 'ci-permissions-write-all');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('inventories narrowly declared write permissions for review', () => {
  const finding = audit(`name: Publish
on: [push]
permissions:
  contents: read
  packages: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo publish
`).findings.find(item => item.id === 'ci-write-permission-review');
  assert.equal(finding?.severity, 'low');
});

test('blocks pull_request_target checkout of attacker-controlled head', () => {
  const result = audit(`name: Unsafe
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - run: npm test
`);
  const finding = result.findings.find(item => item.id === 'ci-pr-target-untrusted-checkout');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('flags secrets referenced from pull_request_target workflow', () => {
  const result = audit(`name: Privileged
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  metadata:
    runs-on: ubuntu-latest
    steps:
      - run: echo metadata
        env:
          API_TOKEN: \${{ secrets.API_TOKEN }}
`);
  assert.ok(result.findings.some(item => item.id === 'ci-pr-target-secret-review'));
});

test('does not apply pull_request_target findings to ordinary pull_request', () => {
  const result = audit(`name: PR
on:
  pull_request:
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.NOT_AVAILABLE }}
`);
  assert.equal(result.findings.some(item => item.id.startsWith('ci-pr-target-')), false);
});

test('flags curl piped directly to shell', () => {
  const result = audit(`name: Install
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsSL https://example.invalid/install.sh | bash
`);
  assert.ok(result.findings.some(item => item.id === 'ci-download-pipe-shell'));
});

test('flags wget piped to sh', () => {
  const result = audit(`name: Install
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - run: wget -qO- https://example.invalid/install.sh | sh
`);
  assert.ok(result.findings.some(item => item.id === 'ci-download-pipe-shell'));
});

test('does not flag ordinary artifact download without shell pipe', () => {
  const result = audit(`name: Install
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsSLo tool.tgz https://example.invalid/tool.tgz
      - run: sha256sum -c tool.sha256
`);
  assert.equal(result.findings.some(item => item.id === 'ci-download-pipe-shell'), false);
});

test('reviews persisted checkout credentials when repository code executes', () => {
  const result = audit(`name: QA
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
      - run: npm ci
      - run: npm test
`);
  assert.ok(result.findings.some(item => item.id === 'ci-checkout-credentials-persist'));
});

test('accepts disabled checkout credential persistence for validation', () => {
  const result = audit(`name: QA
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - run: npm ci
      - run: npm test
`);
  assert.equal(result.findings.some(item => item.id === 'ci-checkout-credentials-persist'), false);
});

test('ignores non-workflow yaml files', () => {
  const result = auditCiIntegrity(fixtureInventory([{ path: 'config/application.yml', text: 'uses: vendor/action@main\n' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('reports workflow signal counts deterministically', () => {
  const result = audit(`name: QA
on: [push]
permissions:
  contents: read
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
      - run: node --version
`);
  assert.equal(result.summary.workflows[0]?.actions, 2);
  assert.equal(result.summary.workflows[0]?.shaPinnedActions, 1);
  assert.equal(result.summary.workflows[0]?.mutableActions, 1);
  assert.equal(result.summary.workflows[0]?.checkoutCount, 1);
});
