import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCiIntegrity } from './ci-integrity-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function source(path: string, text: string, kind: FileKind = 'yaml'): SourceFile {
  return { absolutePath: `/repo/${path}`, repositoryPath: path, extension: '.yml', kind, bytes: new TextEncoder().encode(text).byteLength, lines: text.split(/\r?\n/).length, text };
}
function inventory(files: readonly SourceFile[]): RepositoryInventory {
  return { root: '/repo', files, ignoredDirectories: [], languageStats: [], totalFiles: files.length, totalLines: files.reduce((sum, file) => sum + file.lines, 0), totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), generatedAt: '2026-09-17T00:00:00.000Z' };
}
function ids(text: string): string[] { return auditCiIntegrity(inventory([source('.github/workflows/release-qa.yml', text)])).findings.map(item => item.id); }
const complete = `name: Release QA
on:
  pull_request:
permissions:
  contents: read
jobs:
  qa:
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npm audit --omit=dev
      - run: npx tsc --noEmit
      - run: node --test quality/*.test.mts
      - run: npm run build
      - uses: actions/upload-artifact@v6
`;

test('accepts a bounded pull-request release workflow with dependency, test and build evidence', () => {
  assert.deepEqual(ids(complete), []);
});
test('blocks release workflow without pull-request execution', () => {
  const findings = auditCiIntegrity(inventory([source('.github/workflows/release.yml', complete.replace('  pull_request:\n', '  push:\n'))])).findings;
  const item = findings.find(candidate => candidate.id === 'ci-pr-validation-missing');
  assert.ok(item);
  assert.equal(item.severity, 'high');
  assert.equal(item.blocking, true);
});
test('flags implicit workflow permissions', () => {
  assert.ok(ids(complete.replace('permissions:\n  contents: read\n', '')).includes('ci-permissions-implicit'));
});
test('flags missing release timeout contract', () => {
  assert.ok(ids(complete.replace('    timeout-minutes: 20\n', '')).includes('ci-timeout-contract-missing'));
});
test('flags missing dependency verification', () => {
  assert.ok(ids(complete.replace('      - run: npm audit --omit=dev\n', '')).includes('ci-dependency-check-missing'));
});
test('flags missing production build evidence', () => {
  assert.ok(ids(complete.replace('      - run: npm run build\n', '')).includes('ci-build-evidence-missing'));
});
test('flags missing executable test evidence', () => {
  assert.ok(ids(complete.replace('      - run: node --test quality/*.test.mts\n', '')).includes('ci-test-evidence-missing'));
});
test('ignores non-workflow yaml files', () => {
  const section = auditCiIntegrity(inventory([source('config/release.yml', 'name: release') ]));
  assert.equal(section.summary.workflowFiles, 0);
  assert.equal(section.findings.length, 0);
});
test('reports deterministic workflow evidence counters', () => {
  const section = auditCiIntegrity(inventory([source('.github/workflows/release-qa.yml', complete)]));
  assert.equal(section.summary.workflowFiles, 1);
  assert.equal(section.summary.releaseWorkflowFiles, 1);
  const item = section.summary.signals[0];
  assert.ok(item);
  assert.equal(item.pullRequestTrigger, true);
  assert.equal(item.explicitPermissions, true);
  assert.equal(item.jobTimeouts, 1);
  assert.equal(item.actionReferences, 2);
  assert.equal(item.npmCiCommands, 1);
  assert.equal(item.dependencyChecks, 1);
  assert.equal(item.buildChecks, 1);
  assert.equal(item.testChecks, 1);
  assert.equal(item.typeChecks, 1);
  assert.equal(item.artifactUploads, 1);
});
test('audits multiple workflow files independently', () => {
  const section = auditCiIntegrity(inventory([
    source('.github/workflows/release-qa.yml', complete),
    source('.github/workflows/security-audit.yml', complete.replace('name: Release QA', 'name: Security Audit')),
  ]));
  assert.equal(section.summary.workflowFiles, 2);
  assert.equal(section.summary.releaseWorkflowFiles, 2);
  assert.equal(section.findings.length, 0);
});
