import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowEnvironmentApprovals } from './workflow-environment-approval-audit.mts';
import type { RepositoryInventory, SourceFile } from './contracts.mts';

function inventory(text: string): RepositoryInventory {
  const repositoryPath = '.github/workflows/release.yml';
  const lines = text.split(/\r?\n/).length;
  const file: SourceFile = {
    absolutePath: `/repo/${repositoryPath}`,
    repositoryPath,
    text,
    bytes: Buffer.byteLength(text),
    extension: '.yml',
    kind: 'yaml',
    lines,
  };
  return {
    root: '/repo',
    files: [file],
    ignoredDirectories: [],
    languageStats: [{ kind: 'yaml', files: 1, lines, bytes: file.bytes }],
    totalFiles: 1,
    totalLines: lines,
    totalBytes: file.bytes,
    generatedAt: '2026-09-29T00:00:00.000Z',
  };
}
function ids(text: string) { return auditWorkflowEnvironmentApprovals(inventory(text)).findings.map(finding => finding.id); }

test('flags privileged deployment without an environment', () => {
  const result = ids(`on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`);
  assert.ok(result.includes('ci-deployment-missing-environment'));
});

test('accepts literal production environment on trusted push', () => {
  const result = ids(`on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    environment: production\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`);
  assert.deepEqual(result, []);
});

test('flags expression-derived environment identity', () => {
  const result = ids(`on:\n  workflow_dispatch:\n    inputs:\n      target:\n        required: true\njobs:\n  deploy:\n    environment: \${{ inputs.target }}\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`);
  assert.ok(result.includes('ci-deployment-dynamic-environment'));
  assert.ok(result.includes('ci-input-controlled-deployment'));
});

test('flags privileged external-event deployment even with environment', () => {
  const result = ids(`on:\n  pull_request_target:\n    types: [closed]\njobs:\n  deploy:\n    environment: production\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`);
  assert.ok(result.includes('ci-external-deployment-environment'));
});

test('flags workflow_run deployment as external trust boundary', () => {
  const result = ids(`on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\njobs:\n  publish:\n    environment: production\n    permissions:\n      packages: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n`);
  assert.ok(result.includes('ci-external-deployment-environment'));
});

test('flags non-canonical privileged environment', () => {
  const result = ids(`on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    environment: temporary-blue\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`);
  assert.ok(result.includes('ci-unrecognized-deployment-environment'));
});

test('supports mapping-form environment name', () => {
  const result = ids(`on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    environment:\n      name: production\n      url: https://example.invalid\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`);
  assert.deepEqual(result, []);
});

test('does not classify ordinary validation as deployment', () => {
  const result = ids(`on:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
  assert.deepEqual(result, []);
});

test('reports bounded workflow summary', () => {
  const section = auditWorkflowEnvironmentApprovals(inventory(`on:\n  push:\n    branches: [main]\njobs:\n  release:\n    environment: release\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1\n`));
  assert.equal(section.summary.workflows.length, 1);
  assert.equal(section.summary.workflows[0]?.deploymentJobs, 1);
  assert.equal(section.summary.workflows[0]?.protectedEnvironmentJobs, 1);
  assert.equal(section.summary.workflows[0]?.dynamicEnvironmentJobs, 0);
});
