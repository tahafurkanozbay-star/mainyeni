import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowRunSourceProvenance } from './workflow-run-source-provenance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditWorkflowRunSourceProvenance(fixtureInventory([{ path: '.github/workflows/promote.yml', text }] as readonly FixtureFileInput[]));
}

const prefix = `name: promote\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n`;

test('blocks successful promotion that is not bound to repository or ref', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' }}\n    steps:\n      - name: Publish release\n        run: npm publish\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-repository' && item.blocking));
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-fork-not-rejected' && item.blocking));
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-ref' && item.blocking));
});

test('accepts same-repository main-branch promotion provenance', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == 'main' }}\n    steps:\n      - name: Publish release\n        run: npm publish\n`);
  assert.equal(result.summary.promotionSteps, 1);
  assert.equal(result.summary.repositoryBoundPromotions, 1);
  assert.equal(result.summary.refBoundPromotions, 1);
  assert.deepEqual(result.findings, []);
});

test('accepts literal same-repository identity with immutable expected sha', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_repository.full_name == 'example/app' && github.event.workflow_run.head_sha == '0123456789abcdef0123456789abcdef01234567' }}\n    steps:\n      - name: Sign release\n        run: cosign sign image@example.invalid/app@sha256:deadbeef\n`);
  assert.equal(result.summary.repositoryBoundPromotions, 1);
  assert.equal(result.summary.refBoundPromotions, 1);
  assert.ok(!result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-ref'));
});

test('accepts trusted expected sha from prior immutable metadata job', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_sha == needs.resolve.outputs.release_sha }}\n    steps:\n      - name: Deploy release\n        run: kubectl apply -f deploy.yml\n`);
  assert.equal(result.summary.refBoundPromotions, 1);
  assert.deepEqual(result.findings, []);
});

test('does not treat conclusion success as repository provenance', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main' }}\n    steps:\n      - name: Upload release\n        run: gh release upload v1 dist/app.zip\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-repository'));
  assert.ok(!result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-ref'));
});

test('does not treat repository binding as ref provenance', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_repository.full_name == github.repository }}\n    steps:\n      - name: Publish package\n        run: npm publish\n`);
  assert.ok(!result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-repository'));
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-ref'));
});

test('recognizes step-level provenance guards', () => {
  const result = audit(`${prefix}    steps:\n      - name: Publish package\n        if: \${{ github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == 'release' }}\n        run: npm publish\n`);
  assert.deepEqual(result.findings, []);
});

test('requires each promotion step to retain provenance', () => {
  const result = audit(`${prefix}    steps:\n      - name: Inspect\n        if: \${{ github.event.workflow_run.head_repository.full_name == github.repository }}\n        run: echo ok\n      - name: Publish package\n        if: \${{ github.event.workflow_run.conclusion == 'success' }}\n        run: npm publish\n`);
  assert.ok(result.findings.some(item => item.id === 'ci-workflow-run-promotion-unbound-repository'));
});

test('ignores read-only workflow_run diagnostics', () => {
  const result = audit(`name: diagnose\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\npermissions:\n  contents: read\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n`);
  assert.equal(result.summary.promotionSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores push release because workflow_run provenance does not apply', () => {
  const result = audit(`name: release\non:\n  push:\n    branches: [main]\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Publish release\n        run: npm publish\n`);
  assert.equal(result.summary.workflowRunJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('recognizes pinned release action as promotion', () => {
  const result = audit(`${prefix}    if: \${{ github.event.workflow_run.conclusion == 'success' }}\n    steps:\n      - name: Deploy Pages\n        uses: actions/deploy-pages@0123456789abcdef0123456789abcdef01234567\n`);
  assert.equal(result.summary.promotionSteps, 1);
  assert.ok(result.findings.some(item => item.blocking));
});

test('does not inspect non-workflow yaml', () => {
  const result = auditWorkflowRunSourceProvenance(fixtureInventory([{ path: 'config/promote.yml', text: 'workflow_run: true' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
