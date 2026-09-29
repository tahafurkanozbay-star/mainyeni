import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowFailureIntegrity } from './workflow-failure-integrity-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowFailureIntegrity(fixtureInventory([{ path: '.github/workflows/ci.yml', text }] as readonly FixtureFileInput[]));
}

test('accepts a normal fail-closed validation step', () => {
  const result = audit(`name: ci\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Run tests\n        run: npm test\n`);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.gateLikeSteps, 1);
});

test('blocks literal continue-on-error on validation gates', () => {
  const result = audit(`name: ci\non: [push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Typecheck\n        continue-on-error: true\n        run: npm run typecheck\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-gate-continue-on-error');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('keeps best-effort cleanup visible but non-blocking', () => {
  const result = audit(`name: cleanup\non: [push]\njobs:\n  cleanup:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Remove temp files\n        continue-on-error: true\n        run: rm -rf .tmp\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-continue-on-error');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('blocks job-level failure masking when job contains validation', () => {
  const result = audit(`name: ci\non: [push]\njobs:\n  quality:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-failure-gate-continue-on-error' && item.blocking));
});

test('flags expression-controlled failure policy', () => {
  const result = audit(`name: ci\non: [pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Regression tests\n        continue-on-error: \${{ matrix.experimental }}\n        run: npm test\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-dynamic-continue-policy');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('blocks shell fail-fast disablement and swallowed validation failures', () => {
  const result = audit(`name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Test suite\n        run: |\n          set +e\n          npm test || true\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-failure-errexit-disabled' && item.blocking));
  assert.ok(result.findings.some(item => item.id === 'ci-failure-shell-swallow' && item.blocking));
});

test('blocks PowerShell Continue error policy in validation', () => {
  const result = audit(`name: windows\non: [push]\njobs:\n  verify:\n    runs-on: windows-latest\n    steps:\n      - name: Build verification\n        shell: pwsh\n        run: |\n          $ErrorActionPreference = 'Continue'\n          dotnet build\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-failure-powershell-continue' && item.blocking));
});

test('accepts explicit continue-on-error false', () => {
  const result = audit(`name: ci\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Lint\n        continue-on-error: false\n        run: npm run lint\n`);
  assert.deepEqual(result.findings, []);
});

test('raises impact for failure masking in secret-bearing jobs', () => {
  const result = audit(`name: publish\non: [push]\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Cleanup staging\n        env:\n          TOKEN: \${{ secrets.RELEASE_TOKEN }}\n        run: rm -rf staging || true\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-shell-swallow');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.evidence?.metadata?.privileged, true);
});

test('does not inspect ordinary repository yaml', () => {
  const result = auditWorkflowFailureIntegrity(fixtureInventory([{ path: 'config/ci.yml', text: 'continue-on-error: true\nrun: npm test || true\n' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
