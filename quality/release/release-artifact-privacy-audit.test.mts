import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReleaseArtifactPrivacy } from './release-artifact-privacy-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const workflow = '.github/workflows/release-qa.yml';
function inspect(body: string, path = workflow, kind: 'yaml' | 'typescript' = 'yaml') {
  return auditReleaseArtifactPrivacy(fixtureInventory([{ path, kind, text: body }]));
}
function workflowStep(pathDeclaration: string): string {
  return [
    'name: Release QA',
    'jobs:',
    '  release:',
    '    steps:',
    '      - name: Upload typed release evidence',
    '        if: always()',
    '        uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f',
    '        with:',
    '          name: typed-release-qa',
    ...pathDeclaration.split('\n').map(line => '          ' + line),
    '          retention-days: 21',
  ].join('\n');
}
test('reviewed summary glob is an approved artifact path', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/*.md'));
  assert.equal(report.summary.uploadSteps, 1);
  assert.equal(report.summary.releaseUploadSteps, 1);
  assert.equal(report.summary.safeReleasePaths, 1);
  assert.equal(report.findings.length, 0);
});
test('full release directory upload exposes raw inventory and is rejected', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
  assert.ok(report.findings.some(x => x.id === 'qa-release-artifact-sensitive-upload'));
});
test('recursive glob could publish JSON finding keys and is rejected', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/**'));
  assert.equal(report.findings.length, 1);
});
test('explicit release report JSON is never approved for upload', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/release-report.json'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
});
test('raw PR baseline regression JSON cannot be published', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/pr-regression-gate.json'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
});
test('typed release compiler logs in the reviewed release root are denied', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/compiler.log'));
  assert.equal(report.findings.length, 1);
});
test('one explicit reviewed report is approved', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/release-report.md'));
  assert.equal(report.summary.safeReleasePaths, 1);
  assert.equal(report.findings.length, 0);
});
test('the approved exact-base regression summary can be uploaded', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/pr-regression-gate.md'));
  assert.equal(report.findings.length, 0);
});
test('multiline YAML supports two reviewed markdown artifacts', () => {
  const report = inspect(workflowStep([
    'path: |',
    '  qa-artifacts/release/release-report.md',
    '  qa-artifacts/release/pr-regression-gate.md',
  ].join('\n')));
  assert.equal(report.summary.safeReleasePaths, 2);
  assert.equal(report.findings.length, 0);
});
test('a safe path cannot mask unsafe JSON in the same step', () => {
  const report = inspect(workflowStep([
    'path: |',
    '  qa-artifacts/release/release-report.md',
    '  qa-artifacts/release/release-report.json',
  ].join('\n')));
  assert.equal(report.summary.safeReleasePaths, 1);
  assert.equal(report.summary.unsafeReleasePaths, 1);
  assert.equal(report.findings.length, 1);
});
test('path normalization admits a harmless leading current-directory segment', () => {
  const report = inspect(workflowStep('path: ./qa-artifacts/release/*.md'));
  assert.equal(report.findings.length, 0);
});
test('parent traversals inside the release root do not bypass review', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/../secrets.json'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
});
test('uploads of independent diagnostics are not mistaken for release inventory', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release-diagnostics')
    .replace('name: typed-release-qa', 'name: typed-release-compiler-diagnostics'));
  assert.equal(report.summary.releaseUploadSteps, 0);
  assert.equal(report.findings.length, 0);
});
test('source files and test files cannot impersonate workflow evidence', () => {
  const src = inspect(workflowStep('path: qa-artifacts/release'), 'quality/release/example.ts', 'typescript');
  assert.equal(src.summary.workflowFiles, 0);
  assert.equal(src.findings.length, 0);
});
test('workflow comments alone are not upload steps', () => {
  const report = inspect('name: Release\n# uses: actions/upload-artifact@v6\n# path: qa-artifacts/release');
  assert.equal(report.summary.uploadSteps, 0);
});
test('the scanner does not copy sensitive upload path text to finding evidence', () => {
  const raw = 'qa-artifacts/release/private-token.json';
  const report = inspect(workflowStep('path: ' + raw));
  assert.equal(report.findings.length, 1);
  assert.ok(!JSON.stringify(report.findings).includes('private-token'));
});
test('two uploads are evaluated independently in source order', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/*.md') + '\n' +
    '      - name: More raw evidence\n' +
    '        uses: actions/upload-artifact@v6\n' +
    '        with:\n' +
    '          path: qa-artifacts/release/unsafe.json');
  assert.equal(report.summary.uploadSteps, 2);
  assert.equal(report.summary.unsafeReleasePaths, 1);
  assert.equal(report.findings.length, 1);
});

test('absolute runner paths cannot impersonate an approved release summary', () => {
  const report = inspect(workflowStep('path: /home/runner/work/project/qa-artifacts/release/release-report.md'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
  assert.equal(report.findings.length, 1);
});
test('relative parent prefixes cannot impersonate approved summaries', () => {
  const report = inspect(workflowStep('path: ../../qa-artifacts/release/release-report.md'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
});
test('environment-variable artifact path is never assumed safe', () => {
  const report = inspect(workflowStep('path: $' + '{{ env.RELEASE_ARTIFACTS }}'));
  assert.equal(report.summary.releaseUploadSteps, 1);
  assert.equal(report.summary.unsafeReleasePaths, 1);
  assert.equal(report.findings.length, 1);
});
test('a known release artifact uploader with no path fails closed', () => {
  const report = inspect(workflowStep('retention-days: 7'));
  assert.equal(report.summary.releaseUploadSteps, 1);
  assert.equal(report.summary.unsafeReleasePaths, 1);
});
test('an unrelated dynamic artifact upload is not misidentified as release QA', () => {
  const workflow = workflowStep('path: $' + '{{ env.OUTPUT }}')
    .replace('name: typed-release-qa', 'name: standalone-browser-report');
  const report = inspect(workflow);
  assert.equal(report.summary.releaseUploadSteps, 0);
  assert.equal(report.findings.length, 0);
});
test('a dynamic path inside the release root is not approved by the glob allowlist', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/$' + '{{ env.FILE }}'));
  assert.equal(report.summary.unsafeReleasePaths, 1);
});
test('real release uploader remains approved when a reviewed glob is specified', () => {
  const report = inspect(workflowStep('path: qa-artifacts/release/*.md'));
  assert.equal(report.summary.unsafeReleasePaths, 0);
  assert.equal(report.summary.releaseUploadSteps, 1);
});
