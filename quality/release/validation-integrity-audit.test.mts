import assert from 'node:assert/strict';
import test from 'node:test';
import { auditValidationIntegrity } from './validation-integrity-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind): SourceFile {
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: path.includes('.') ? `.${path.split('.').at(-1) ?? ''}` : '',
    kind,
    bytes: new TextEncoder().encode(text).byteLength,
    lines: text.split(/\r?\n/).length,
    text,
  };
}

function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-09-18T00:00:00.000Z',
  };
}

function workflow(text: string): ReturnType<typeof auditValidationIntegrity> {
  return auditValidationIntegrity(inventory([source('.github/workflows/qa.yml', text, 'yaml')]));
}

function ids(section: ReturnType<typeof auditValidationIntegrity>): string[] {
  return section.findings.map(item => item.id);
}

test('flags workflow jobs without explicit timeout', () => {
  const section = workflow(`name: QA
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`);
  assert.ok(ids(section).includes('validation-job-timeout-missing'));
});

test('accepts bounded workflow job timeout', () => {
  const section = workflow(`name: QA
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: npm test
`);
  assert.ok(!ids(section).includes('validation-job-timeout-missing'));
});

test('flags continue-on-error on validation', () => {
  const section = workflow(`jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm test
        continue-on-error: true
`);
  const item = section.findings.find(candidate => candidate.id === 'validation-continue-on-error');
  assert.ok(item);
  assert.equal(item.severity, 'high');
});

test('flags suppressed npm test failure', () => {
  assert.ok(ids(workflow(`jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm test || true
`)).includes('validation-command-failure-suppressed'));
});

test('does not flag unrelated shell fallback', () => {
  assert.ok(!ids(workflow(`jobs:
  info:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo diagnostics || true
`)).includes('validation-command-failure-suppressed'));
});

test('flags npm install in CI', () => {
  assert.ok(ids(workflow(`jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm install
      - run: npm run build
`)).includes('validation-npm-install-in-ci'));
});

test('accepts npm ci in CI', () => {
  assert.ok(!ids(workflow(`jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run build
`)).includes('validation-npm-install-in-ci'));
});

test('flags dependency install without vulnerability audit', () => {
  assert.ok(ids(workflow(`jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm run build
`)).includes('validation-dependency-audit-missing'));
});

test('accepts npm audit visibility', () => {
  assert.ok(!ids(workflow(`jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run build
`)).includes('validation-dependency-audit-missing'));
});

test('flags baseline diff without history fetch', () => {
  assert.ok(ids(workflow(`jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - run: git diff "$BASE_SHA" HEAD
`)).includes('validation-baseline-history-contract'));
});

test('accepts exact base fetch before regression diff', () => {
  assert.ok(!ids(workflow(`jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - run: git fetch origin "$BASE_SHA"
      - run: git diff "$BASE_SHA" HEAD
`)).includes('validation-baseline-history-contract'));
});

test('flags direct node_modules cache', () => {
  assert.ok(ids(workflow(`jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/cache@v4
        with:
          path: Webclient.app/node_modules
`)).includes('validation-node-modules-cache'));
});

test('flags package with dependencies and no lockfile', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', JSON.stringify({
      scripts: { build: 'vite build', test: 'vitest run' },
      dependencies: { react: '^19.0.0' },
      engines: { node: '>=24' },
    }), 'json'),
  ]));
  assert.ok(ids(section).includes('validation-lockfile-missing'));
});

test('accepts package with lockfile', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', JSON.stringify({
      scripts: { build: 'vite build', test: 'vitest run' },
      dependencies: { react: '^19.0.0' },
      engines: { node: '>=24' },
    }), 'json'),
    source('Webclient.app/package-lock.json', '{}', 'json'),
  ]));
  assert.ok(!ids(section).includes('validation-lockfile-missing'));
});

test('flags missing webclient build script', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', JSON.stringify({
      scripts: { test: 'vitest run' },
      dependencies: {},
      engines: { node: '>=24' },
    }), 'json'),
  ]));
  assert.ok(ids(section).includes('validation-build-script-missing'));
});

test('flags missing canonical webclient test script', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', JSON.stringify({
      scripts: { build: 'vite build' },
      dependencies: {},
      engines: { node: '>=24' },
    }), 'json'),
  ]));
  assert.ok(ids(section).includes('validation-test-script-missing'));
});

test('flags missing Node/package manager version contract', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', JSON.stringify({
      scripts: { build: 'vite build', test: 'vitest run' },
      dependencies: {},
    }), 'json'),
  ]));
  assert.ok(ids(section).includes('validation-node-version-contract-missing'));
});

test('accepts packageManager version contract', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', JSON.stringify({
      scripts: { build: 'vite build', test: 'vitest run' },
      dependencies: {},
      packageManager: 'npm@11.6.0',
    }), 'json'),
  ]));
  assert.ok(!ids(section).includes('validation-node-version-contract-missing'));
});

test('blocks invalid package JSON', () => {
  const section = auditValidationIntegrity(inventory([
    source('Webclient.app/package.json', '{ nope', 'json'),
  ]));
  const item = section.findings.find(candidate => candidate.id === 'validation-package-json-invalid');
  assert.ok(item);
  assert.equal(item.blocking, true);
  assert.equal(item.severity, 'critical');
});

test('blocks non-strict typed release tsconfig', () => {
  const section = auditValidationIntegrity(inventory([
    source('quality/release/tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }), 'json'),
  ]));
  const item = section.findings.find(candidate => candidate.id === 'validation-release-tsconfig-not-strict');
  assert.ok(item);
  assert.equal(item.blocking, true);
});

test('accepts strict typed release tsconfig', () => {
  const section = auditValidationIntegrity(inventory([
    source('quality/release/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }), 'json'),
  ]));
  assert.ok(!ids(section).includes('validation-release-tsconfig-not-strict'));
});

test('flags skipLibCheck in release audit project', () => {
  const section = auditValidationIntegrity(inventory([
    source('quality/release/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true } }), 'json'),
  ]));
  assert.ok(ids(section).includes('validation-release-skip-lib-check'));
});

test('reports workflow signal counts', () => {
  const section = workflow(`jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm ci
      - run: npm test
`);
  assert.equal(section.summary.workflowSignals.length, 1);
  assert.equal(section.summary.workflowSignals[0]?.jobCount, 1);
  assert.equal(section.summary.workflowSignals[0]?.timeoutCount, 1);
  assert.equal(section.summary.workflowSignals[0]?.npmCiCount, 1);
  assert.equal(section.summary.workflowSignals[0]?.validationCommandCount, 1);
});

test('reports deterministic finding counts', () => {
  const section = workflow(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm install
      - run: npm test || true
`);
  assert.equal(section.summary.findingsByRule['validation-job-timeout-missing'], 1);
  assert.equal(section.summary.findingsByRule['validation-npm-install-in-ci'], 1);
  assert.equal(section.summary.findingsByRule['validation-command-failure-suppressed'], 1);
});
