import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowFailureIntegrity } from './workflow-failure-integrity-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowFailureIntegrity(fixtureInventory([
    { path: '.github/workflows/ci.yml', text },
  ] as readonly FixtureFileInput[]));
}

test('accepts a normal fail-closed validation step', () => {
  const result = audit(`name: ci\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Run tests\n        run: npm test\n`);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.gateLikeSteps, 1);
});

test('blocks continue-on-error on a validation step', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Typecheck\n        continue-on-error: true\n        run: npm run typecheck\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-gate-continue-on-error');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.evidence?.metadata?.scope, 'step');
});

test('keeps best-effort cleanup visible without treating it as a release gate', () => {
  const result = audit(`name: cleanup\non: [push]\npermissions:\n  contents: read\njobs:\n  cleanup:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Remove temp files\n        continue-on-error: true\n        run: rm -rf .tmp\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-continue-on-error');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('blocks job-level continue-on-error when the job contains validation', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  quality:\n    continue-on-error: true\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run lint\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-gate-continue-on-error');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.evidence?.metadata?.scope, 'job');
});

test('flags expression-controlled continue policy on externally influenced validation', () => {
  const result = audit(`name: ci\non: [pull_request]\npermissions:\n  contents: read\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        experimental: [false, true]\n    steps:\n      - name: Regression tests\n        continue-on-error: \${{ matrix.experimental }}\n        run: npm test\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-dynamic-continue-policy');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
  assert.equal(finding?.evidence?.metadata?.dynamic, true);
});

test('blocks set plus e inside a test gate', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Test suite\n        run: |\n          set +e\n          npm test\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-errexit-disabled');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('detects set plus o errexit in multiline scripts', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Build\n        run: |\n          set +o errexit\n          npm run build\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-failure-errexit-disabled' && item.blocking));
});

test('blocks shell fallback that swallows test failure', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Unit tests\n        run: npm test || true\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-shell-swallow');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('detects echo fallback that would replace a gate failure status', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Security audit\n        run: npm audit || echo audit-failed\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-failure-shell-swallow' && item.blocking));
});

test('reports non-gating cleanup shell fallback without blocking', () => {
  const result = audit(`name: cleanup\non: [push]\npermissions:\n  contents: read\njobs:\n  cleanup:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Remove cache\n        run: rm -rf .cache || true\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-shell-swallow');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('blocks PowerShell Continue error policy in validation', () => {
  const result = audit(`name: windows\non: [push]\npermissions:\n  contents: read\njobs:\n  verify:\n    runs-on: windows-latest\n    steps:\n      - name: Build verification\n        shell: pwsh\n        run: |\n          $ErrorActionPreference = 'Continue'\n          dotnet build\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-powershell-continue');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('accepts explicit continue-on-error false', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Lint\n        continue-on-error: false\n        run: npm run lint\n`);
  assert.deepEqual(result.findings, []);
});

test('flags ambiguous non-boolean continue policy', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Verify build\n        continue-on-error: yes\n        run: npm run build\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-ambiguous-continue-policy');
  assert.equal(finding?.severity, 'high');
});

test('raises impact when failure masking occurs in a secret-bearing job', () => {
  const result = audit(`name: publish\non: [push]\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Cleanup staging\n        env:\n          TOKEN: \${{ secrets.RELEASE_TOKEN }}\n        run: rm -rf staging || true\n`);
  const finding = result.findings.find(item => item.id === 'ci-failure-shell-swallow');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.evidence?.metadata?.privileged, true);
});

test('summarizes multiple independent mask signals deterministically', () => {
  const result = audit(`name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Lint\n        continue-on-error: true\n        run: npm run lint\n      - name: Tests\n        run: npm test || true\n`);
  assert.equal(result.summary.failureMaskSignals, 2);
  assert.equal(result.summary.gateMaskSignals, 2);
  assert.equal(result.findings.length, 2);
});

test('does not inspect ordinary repository yaml', () => {
  const result = auditWorkflowFailureIntegrity(fixtureInventory([
    { path: 'config/ci.yml', text: 'continue-on-error: true\nrun: npm test || true\n' },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
