import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReusableWorkflowSecretInheritance } from './reusable-workflow-secret-inheritance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditReusableWorkflowSecretInheritance(fixtureInventory([
    { path: '.github/workflows/caller.yml', text },
  ] as readonly FixtureFileInput[]));
}

function workflow(job: string): string {
  return `name: caller\non: [push]\npermissions:\n  contents: read\njobs:\n${job}`;
}

const external = 'vendor/automation/.github/workflows/release.yml@0123456789abcdef0123456789abcdef01234567';

test('accepts an external reusable workflow with explicit named secret mapping', () => {
  const result = audit(workflow(`  release:\n    uses: ${external}\n    secrets:\n      release-token: \${{ secrets.RELEASE_TOKEN }}\n`));
  assert.equal(result.summary.reusableCalls, 1);
  assert.equal(result.summary.inheritedSecretCalls, 0);
  assert.deepEqual(result.findings, []);
});

test('blocks secrets inherit for external reusable workflow', () => {
  const result = audit(workflow(`  release:\n    uses: ${external}\n    secrets: inherit\n`));
  const finding = result.findings.find(item => item.id === 'ci-reusable-external-secrets-inherit');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
  assert.equal(result.summary.inheritedSecretCalls, 1);
});

test('flags local secrets inherit even without other privilege', () => {
  const result = audit(workflow(`  release:\n    uses: ./.github/workflows/release.yml\n    secrets: inherit\n`));
  const finding = result.findings.find(item => item.id === 'ci-reusable-local-secrets-inherit');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, undefined);
});

test('blocks local inheritance when the caller has contents write authority', () => {
  const result = audit(workflow(`  release:\n    permissions:\n      contents: write\n    uses: ./.github/workflows/release.yml\n    secrets: inherit\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-local-secrets-inherit' && item.blocking));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-inherited-secrets-write-authority' && item.blocking));
});

test('blocks local inheritance with write-all authority', () => {
  const result = audit(workflow(`  release:\n    permissions: write-all\n    uses: ./.github/workflows/release.yml\n    secrets: inherit\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-inherited-secrets-write-authority'));
});

test('blocks inherited secrets combined with pull request controlled input', () => {
  const result = audit(workflow(`  release:\n    uses: ./.github/workflows/release.yml\n    with:\n      version: \${{ github.event.pull_request.title }}\n    secrets: inherit\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-inherited-secrets-untrusted-input' && item.blocking));
});

test('blocks inherited secrets combined with workflow input', () => {
  const result = audit(workflow(`  release:\n    uses: ./.github/workflows/release.yml\n    with:\n      channel: \${{ inputs.channel }}\n    secrets: inherit\n`));
  assert.ok(result.findings.some(item => item.id === 'ci-reusable-inherited-secrets-untrusted-input'));
});

test('does not treat literal with values as untrusted', () => {
  const result = audit(workflow(`  release:\n    uses: ./.github/workflows/release.yml\n    with:\n      channel: stable\n    secrets: inherit\n`));
  assert.equal(result.findings.some(item => item.id === 'ci-reusable-inherited-secrets-untrusted-input'), false);
});

test('tracks multiple reusable calls independently', () => {
  const result = audit(workflow(`  verify:\n    uses: ./.github/workflows/verify.yml\n  release:\n    uses: ./.github/workflows/release.yml\n    secrets: inherit\n`));
  assert.equal(result.summary.reusableCalls, 2);
  assert.equal(result.summary.inheritedSecretCalls, 1);
  assert.deepEqual(result.summary.signals.map(item => item.job), ['verify', 'release']);
});

test('ignores ordinary action uses inside step lists', () => {
  const result = audit(workflow(`  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n      - run: npm test\n`));
  assert.equal(result.summary.reusableCalls, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores non-workflow YAML files', () => {
  const result = auditReusableWorkflowSecretInheritance(fixtureInventory([
    { path: 'config/example.yml', text: `jobs:\n  release:\n    uses: ${external}\n    secrets: inherit\n` },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.summary.reusableCalls, 0);
  assert.deepEqual(result.findings, []);
});

test('records external target identity and source line', () => {
  const result = audit(workflow(`  release:\n    uses: ${external}\n    secrets: inherit\n`));
  const signal = result.summary.signals[0];
  assert.equal(signal?.target, external);
  assert.equal(signal?.local, false);
  assert.ok((signal?.line ?? 0) > 0);
});

test('accepts comments after secrets inherit', () => {
  const result = audit(workflow(`  release:\n    uses: ./.github/workflows/release.yml\n    secrets: inherit # intentionally broad but audited\n`));
  assert.equal(result.summary.inheritedSecretCalls, 1);
});

test('does not confuse named secret key inherit with secrets inherit scalar', () => {
  const result = audit(workflow(`  release:\n    uses: ./.github/workflows/release.yml\n    secrets:\n      inherit: \${{ secrets.INHERIT }}\n`));
  assert.equal(result.summary.inheritedSecretCalls, 0);
  assert.deepEqual(result.findings, []);
});
