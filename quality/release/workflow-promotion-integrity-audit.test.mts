import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowPromotionIntegrity } from './workflow-promotion-integrity-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowPromotionIntegrity(fixtureInventory([
    { path: '.github/workflows/promote.yml', text },
  ] as readonly FixtureFileInput[]));
}

test('ignores non-workflow-run release jobs', () => {
  const result = audit(`name: release\non:\n  push:\n    branches: [main]\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish package\n        run: npm publish\n`);
  assert.equal(result.summary.workflowRunJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('blocks privileged workflow_run publish without successful upstream conclusion', () => {
  const result = audit(`name: promote\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish package\n        run: npm publish\n`);
  const finding = result.findings.find(item => item.id === 'ci-workflow-run-promotion-without-success-guard');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('accepts job-level explicit success conclusion guard', () => {
  const result = audit(`name: promote\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: write\njobs:\n  release:\n    if: \${{ github.event.workflow_run.conclusion == 'success' }}\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish package\n        run: npm publish\n`);
  assert.ok(!result.findings.some(item => item.id === 'ci-workflow-run-promotion-without-success-guard'));
  assert.equal(result.summary.guardedPromotionSteps, 1);
});

test('accepts step-level explicit success conclusion guard', () => {
  const result = audit(`name: promote\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  packages: write\njobs:\n  package:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish package\n        if: \${{ 'success' == github.event.workflow_run.conclusion }}\n        run: npm publish\n`);
  assert.ok(!result.findings.some(item => item.id === 'ci-workflow-run-promotion-without-success-guard'));
  assert.equal(result.summary.guardedPromotionSteps, 1);
});

test('blocks failure override on promotion even when the step is privileged', () => {
  const result = audit(`name: deploy\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  deployments: write\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - name: Deploy application\n        if: \${{ always() }}\n        run: kubectl apply -f deploy.yml\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-failure-override' && item.blocking));
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-without-success-guard' && item.blocking));
});

test('recognizes deployment action identity as promotion', () => {
  const result = audit(`name: pages\non:\n  workflow_run:\n    workflows: [Build]\n    types: [completed]\npermissions:\n  pages: write\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Deploy Pages\n        uses: actions/deploy-pages@0123456789abcdef0123456789abcdef01234567\n`);
  assert.equal(result.summary.promotionSteps, 1);
  assert.equal(result.summary.unguardedPromotionSteps, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-without-success-guard'));
});

test('recognizes signing and attestation commands as promotion', () => {
  const result = audit(`name: attest\non:\n  workflow_run:\n    workflows: [Build]\n    types: [completed]\npermissions:\n  id-token: write\n  contents: write\njobs:\n  attest:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Sign release\n        run: cosign sign image@example.invalid/app@sha256:deadbeef\n`);
  assert.equal(result.summary.promotionSteps, 1);
  assert.ok(result.findings.some(item => item.blocking));
});

test('does not require success guard for a read-only diagnostic workflow_run job', () => {
  const result = audit(`name: diagnose\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: read\njobs:\n  diagnose:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Print metadata\n        run: echo done\n`);
  assert.equal(result.summary.privilegedWorkflowRunJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('reviews privileged executable workflow_run jobs even when no promotion keyword is present', () => {
  const result = audit(`name: followup\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  issues: write\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Update metadata\n        run: gh api repos/example/example/issues/1 -X PATCH -f state=closed\n`);
  const finding = result.findings.find(item => item.id === 'ci-workflow-run-privileged-job-success-guard-review');
  assert.equal(finding?.severity, 'high');
});

test('job-level success guard removes generic privileged review finding', () => {
  const result = audit(`name: followup\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  issues: write\njobs:\n  mutate:\n    if: \${{ github.event.workflow_run.conclusion == 'success' }}\n    runs-on: ubuntu-latest\n    steps:\n      - name: Update metadata\n        run: gh api repos/example/example/issues/1 -X PATCH -f state=closed\n`);
  assert.ok(!result.findings.some(item => item.id === 'ci-workflow-run-privileged-job-success-guard-review'));
});

test('summarizes guarded and unguarded promotion steps', () => {
  const result = audit(`name: promote\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish package\n        if: \${{ github.event.workflow_run.conclusion == 'success' }}\n        run: npm publish\n      - name: Upload release\n        run: gh release upload v1 dist/app.tgz\n`);
  assert.equal(result.summary.promotionSteps, 2);
  assert.equal(result.summary.guardedPromotionSteps, 1);
  assert.equal(result.summary.unguardedPromotionSteps, 1);
});

test('does not inspect non-workflow yaml files', () => {
  const result = auditWorkflowPromotionIntegrity(fixtureInventory([
    { path: 'config/promote.yml', text: 'workflow_run:\n  conclusion: failure\n' },
  ] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
