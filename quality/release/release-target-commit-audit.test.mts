import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReleaseTargetCommits } from './release-target-commit-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const ACTION_SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMIT_SHA = '1111111111111111111111111111111111111111';

function audit(text: string) {
  return auditReleaseTargetCommits(fixtureInventory([
    { path: '.github/workflows/release.yml', text },
  ] as readonly FixtureFileInput[]));
}

function workflow(on: string, steps: string) {
  return `name: release
on:
${on}permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
${steps}`;
}

test('accepts workflow_run release creation bound to producer head_sha', () => {
  const result = audit(workflow(`  workflow_run:
    workflows: [CI]
    types: [completed]
`, `      - run: gh release create v1 --target \${{ github.event.workflow_run.head_sha }} --title v1
`));

  assert.equal(result.summary.workflowRunCreations, 1);
  assert.equal(result.summary.producerBoundTargets, 1);
  assert.deepEqual(result.findings, []);
});

test('blocks workflow_run release creation with implicit target', () => {
  const result = audit(workflow(`  workflow_run:
    workflows: [CI]
    types: [completed]
`, `      - run: gh release create v1 --title v1
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-not-producer-sha' && item.blocking));
});

test('blocks github.sha in workflow_run because it identifies the consumer revision', () => {
  const result = audit(workflow(`  workflow_run:
    workflows: [CI]
    types: [completed]
`, `      - run: gh release create v1 --target \${{ github.sha }}
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-not-producer-sha'));
});

test('accepts explicit github.sha for a trusted manual release', () => {
  const result = audit(workflow(`  workflow_dispatch:
`, `      - run: gh release create v1 --target \${{ github.sha }}
`));

  assert.equal(result.summary.manualOrCallableCreations, 1);
  assert.deepEqual(result.findings, []);
});

test('blocks a manual release with implicit default target', () => {
  const result = audit(workflow(`  workflow_dispatch:
`, `      - run: gh release create v1 --title release
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-implicit' && item.blocking));
});

test('blocks a branch push release with implicit target', () => {
  const result = audit(workflow(`  push:
    branches: [main]
`, `      - run: gh release create v1 --title release
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-implicit'));
});

test('allows implicit target on an existing tag-triggered push release', () => {
  const result = audit(workflow(`  push:
    tags: ['v*']
`, `      - run: gh release create \${{ github.ref_name }} --title release
`));

  assert.deepEqual(result.findings, []);
});

test('accepts a literal immutable commit target', () => {
  const result = audit(workflow(`  push:
    branches: [main]
`, `      - run: gh release create v1 --target=${COMMIT_SHA}
`));

  assert.deepEqual(result.findings, []);
});

test('blocks caller input as release target', () => {
  const result = audit(workflow(`  workflow_dispatch:
    inputs:
      target:
        required: true
`, `      - run: gh release create v1 --target \${{ inputs.target }}
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-untrusted-selector' && item.blocking));
});

test('blocks mutable branch/ref target selection', () => {
  const result = audit(workflow(`  workflow_dispatch:
`, `      - run: gh release create v1 --target \${{ github.ref_name }}
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-mutable-ref'));
});

test('blocks indirect output target pending independent immutable-source validation', () => {
  const result = audit(workflow(`  workflow_dispatch:
`, `      - run: gh release create v1 --target \${{ needs.resolve.outputs.sha }}
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-indirect-selector'));
});

test('accepts softprops target_commitish github.sha in manual context', () => {
  const result = audit(workflow(`  workflow_dispatch:
`, `      - uses: softprops/action-gh-release@${ACTION_SHA}
        with:
          tag_name: v1
          target_commitish: \${{ github.sha }}
`));

  assert.equal(result.summary.releaseCreationSteps, 1);
  assert.deepEqual(result.findings, []);
});

test('requires softprops workflow_run target_commitish to use producer head_sha', () => {
  const result = audit(workflow(`  workflow_run:
    workflows: [CI]
    types: [completed]
`, `      - uses: softprops/action-gh-release@${ACTION_SHA}
        with:
          tag_name: v1
          target_commitish: \${{ github.sha }}
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-target-not-producer-sha'));
});

test('accepts ncipollo commit bound to workflow_run producer head_sha', () => {
  const result = audit(workflow(`  workflow_run:
    workflows: [CI]
    types: [completed]
`, `      - uses: ncipollo/release-action@${ACTION_SHA}
        with:
          tag: v1
          commit: \${{ github.event.workflow_run.head_sha }}
`));

  assert.deepEqual(result.findings, []);
});

test('ignores gh release upload because it does not create or retarget the release commit', () => {
  const result = audit(workflow(`  workflow_dispatch:
`, `      - run: gh release upload v1 dist/app.zip
`));

  assert.equal(result.summary.releaseCreationSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores non-workflow yaml files', () => {
  const result = auditReleaseTargetCommits(fixtureInventory([
    { path: 'config/release.yml', text: 'run: gh release create v1' },
  ] as readonly FixtureFileInput[]));

  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
