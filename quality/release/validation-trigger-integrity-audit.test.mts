import assert from 'node:assert/strict';
import test from 'node:test';
import { auditValidationTriggerIntegrity } from './validation-trigger-integrity-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/release-qa.yml') {
  return auditValidationTriggerIntegrity(fixtureInventory([
    { path, text },
  ] as readonly FixtureFileInput[]));
}

function workflow(on: string, options: { name?: string; command?: string } = {}): string {
  const name = options.name ?? 'Release QA';
  const command = options.command ?? 'node --test quality/release/*.test.mts';
  return `name: ${name}\non:\n${on}\npermissions:\n  contents: read\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;
}

function findingIds(text: string, path?: string): string[] {
  return audit(text, path).findings.map(item => item.id);
}

test('accepts unfiltered pull_request plus main push release validation', () => {
  const result = audit(workflow(`  pull_request:\n  push:\n    branches:\n      - main\n      - 'agent/qa-*'`));
  assert.equal(result.summary.authoritativeWorkflows, 1);
  assert.equal(result.summary.pullRequestWorkflows, 1);
  assert.equal(result.summary.mainPushWorkflows, 1);
  assert.deepEqual(result.findings, []);
});

test('accepts scalar pull_request event for authoritative validation', () => {
  const text = `name: Quality Gate\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
  const result = audit(text, '.github/workflows/quality.yml');
  assert.equal(result.summary.pullRequestWorkflows, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-validation-pr-trigger-missing'), false);
});

test('accepts inline event array with pull_request', () => {
  const text = `name: Build Validation\non: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n`;
  const result = audit(text, '.github/workflows/build-validation.yml');
  assert.equal(result.summary.pullRequestWorkflows, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-validation-pr-trigger-missing'), false);
});

test('blocks authoritative validation missing pull_request coverage', () => {
  const result = audit(workflow(`  push:\n    branches: [main]`));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-trigger-missing');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('blocks pull_request_target-only authoritative validation', () => {
  const result = audit(workflow(`  pull_request_target:`));
  assert.ok(result.findings.some(item => item.id === 'ci-validation-pr-trigger-missing' && item.blocking));
  assert.ok(result.findings.some(item => item.id === 'ci-validation-pull-request-target-only' && item.severity === 'critical'));
});

test('blocks pull request paths filter on authoritative gate', () => {
  const result = audit(workflow(`  pull_request:\n    paths:\n      - 'Webclient.app/**'\n  push:\n    branches: [main]`));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-path-filter');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
  assert.equal(result.summary.filteredPullRequestWorkflows, 1);
  assert.deepEqual(result.summary.signals[0]?.prPaths, ['Webclient.app/**']);
});

test('blocks pull request paths-ignore filter on authoritative gate', () => {
  const result = audit(workflow(`  pull_request:\n    paths-ignore:\n      - 'docs/**'\n      - '*.md'`));
  assert.ok(result.findings.some(item => item.id === 'ci-validation-pr-path-filter' && item.blocking));
  assert.deepEqual(result.summary.signals[0]?.prPathsIgnore, ['docs/**', '*.md']);
});

test('blocks inline pull request paths filter', () => {
  const result = audit(workflow(`  pull_request: { paths: ['src/**'] }`));
  assert.ok(result.findings.some(item => item.id === 'ci-validation-pr-path-filter'));
});

test('blocks pull request branch filters that omit main', () => {
  const result = audit(workflow(`  pull_request:\n    branches:\n      - develop\n      - release/*`));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-main-branch-excluded');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.severity, 'high');
});

test('accepts explicit main in pull request branch filters', () => {
  const result = audit(workflow(`  pull_request:\n    branches:\n      - main\n      - release/*`));
  assert.equal(result.findings.some(item => item.id === 'ci-validation-pr-main-branch-excluded'), false);
});

test('blocks branches-ignore that excludes main', () => {
  const result = audit(workflow(`  pull_request:\n    branches-ignore: [main]`));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-main-branch-ignored');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks wildcard branches-ignore because main is excluded too', () => {
  const result = audit(workflow(`  pull_request:\n    branches-ignore:\n      - '**'`));
  assert.ok(result.findings.some(item => item.id === 'ci-validation-pr-main-branch-ignored'));
});

test('accepts the complete default pull request lifecycle type set', () => {
  const result = audit(workflow(`  pull_request:\n    types: [opened, reopened, synchronize]`));
  assert.equal(result.findings.some(item => item.id === 'ci-validation-pr-types-incomplete'), false);
});

test('blocks custom pull request types missing synchronize', () => {
  const result = audit(workflow(`  pull_request:\n    types:\n      - opened\n      - reopened`));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-types-incomplete');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
  assert.match(finding?.message ?? '', /synchronize/);
});

test('blocks custom pull request types missing opened and reopened', () => {
  const result = audit(workflow(`  pull_request:\n    types: [synchronize, ready_for_review]`));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-types-incomplete');
  assert.match(finding?.message ?? '', /opened/);
  assert.match(finding?.message ?? '', /reopened/);
});

test('flags release-critical push branch filters that omit main', () => {
  const result = audit(workflow(`  pull_request:\n  push:\n    branches:\n      - develop`));
  const finding = result.findings.find(item => item.id === 'ci-validation-main-push-excluded');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('blocks release-critical push branches-ignore main', () => {
  const result = audit(workflow(`  pull_request:\n  push:\n    branches-ignore:\n      - main`));
  const finding = result.findings.find(item => item.id === 'ci-validation-main-push-ignored');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('does not demand push coverage when release-critical workflow has only pull_request', () => {
  const result = audit(workflow(`  pull_request:`));
  assert.deepEqual(result.findings, []);
});

test('ignores ordinary automation without validation commands', () => {
  const text = `name: Issue Labeler\non:\n  issues:\n    types: [opened]\njobs:\n  label:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo label\n`;
  const result = audit(text, '.github/workflows/issue-labeler.yml');
  assert.equal(result.summary.authoritativeWorkflows, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores a validation-like command in a workflow whose identity is not authoritative', () => {
  const text = `name: Developer Utility\non:\n  workflow_dispatch:\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`;
  const result = audit(text, '.github/workflows/developer-utility.yml');
  assert.equal(result.summary.authoritativeWorkflows, 0);
  assert.deepEqual(result.findings, []);
});

test('treats architecture audit as authoritative when it runs a build command', () => {
  const result = audit(workflow(`  pull_request:`, { name: 'Platform Architecture Audit', command: 'dotnet build Api.sln' }), '.github/workflows/platform-architecture-audit.yml');
  assert.equal(result.summary.authoritativeWorkflows, 1);
  assert.deepEqual(result.findings, []);
});

test('treats typecheck workflow as authoritative', () => {
  const result = audit(workflow(`  pull_request:`, { name: 'Typed Source Boundary', command: 'npx tsc -p tsconfig.json' }), '.github/workflows/typed-source-boundary.yml');
  assert.equal(result.summary.authoritativeWorkflows, 1);
});

test('treats lint workflow as authoritative', () => {
  const result = audit(workflow(`  pull_request:`, { name: 'Lint Gate', command: 'npx eslint .' }), '.github/workflows/lint-gate.yml');
  assert.equal(result.summary.authoritativeWorkflows, 1);
});

test('supports inline branches and types filters', () => {
  const result = audit(workflow(`  pull_request:\n    branches: [main, release/*]\n    types: [opened, reopened, synchronize]`));
  assert.deepEqual(result.summary.signals[0]?.prBranches, ['main', 'release/*']);
  assert.deepEqual(result.summary.signals[0]?.prTypes, ['opened', 'reopened', 'synchronize']);
  assert.deepEqual(result.findings, []);
});

test('supports inline push branches list containing main', () => {
  const result = audit(workflow(`  pull_request:\n  push:\n    branches: [main, 'agent/qa-*']`));
  assert.equal(result.summary.mainPushWorkflows, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-validation-main-push-excluded'), false);
});

test('ignores yaml files outside the workflow directory', () => {
  const result = auditValidationTriggerIntegrity(fixtureInventory([
    { path: 'config/release-qa.yml', text: workflow(`  push:\n    branches: [main]`) },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.summary.authoritativeWorkflows, 0);
  assert.deepEqual(result.findings, []);
});

test('sorts findings deterministically across workflow files', () => {
  const result = auditValidationTriggerIntegrity(fixtureInventory([
    { path: '.github/workflows/z-release.yml', text: workflow(`  push:\n    branches: [develop]`, { name: 'Release Validation' }) },
    { path: '.github/workflows/a-quality.yml', text: workflow(`  pull_request:\n    paths: ['src/**']`, { name: 'Quality Gate' }) },
  ] as readonly FixtureFileInput[]));
  assert.ok(result.findings.length >= 2);
  const files = result.findings.map(item => item.location?.file ?? '');
  assert.deepEqual(files, [...files].sort((left, right) => left.localeCompare(right, 'en')));
});

test('summary distinguishes filtered and unfiltered pull request workflows', () => {
  const result = auditValidationTriggerIntegrity(fixtureInventory([
    { path: '.github/workflows/release.yml', text: workflow(`  pull_request:`, { name: 'Release QA' }) },
    { path: '.github/workflows/quality.yml', text: workflow(`  pull_request:\n    paths-ignore: ['docs/**']`, { name: 'Quality Gate' }) },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.authoritativeWorkflows, 2);
  assert.equal(result.summary.pullRequestWorkflows, 2);
  assert.equal(result.summary.filteredPullRequestWorkflows, 1);
});

test('finding metadata keeps workflow identity', () => {
  const result = audit(workflow(`  push:\n    branches: [main]`, { name: 'Release QA' }));
  const finding = result.findings.find(item => item.id === 'ci-validation-pr-trigger-missing');
  assert.equal(finding?.evidence?.metadata?.workflow, 'Release QA');
});

test('principal trigger-integrity finding ids remain stable', () => {
  const result = audit(workflow(`  pull_request:\n    branches-ignore: [main]\n    paths-ignore: ['docs/**']\n    types: [synchronize]\n  push:\n    branches-ignore: [main]`));
  const ids = new Set(result.findings.map(item => item.id));
  assert.equal(ids.has('ci-validation-pr-path-filter'), true);
  assert.equal(ids.has('ci-validation-pr-main-branch-ignored'), true);
  assert.equal(ids.has('ci-validation-pr-types-incomplete'), true);
  assert.equal(ids.has('ci-validation-main-push-ignored'), true);
});
