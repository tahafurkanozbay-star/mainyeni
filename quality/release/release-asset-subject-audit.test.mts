import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReleaseAssetSubjects } from './release-asset-subject-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const ATTEST_SHA = '0123456789abcdef0123456789abcdef01234567';
const RELEASE_SHA = '1111111111111111111111111111111111111111';

function audit(text: string) {
  return auditReleaseAssetSubjects(fixtureInventory([
    { path: '.github/workflows/release.yml', text },
  ] as readonly FixtureFileInput[]));
}

function workflow(steps: string) {
  return `name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
  attestations: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
${steps}`;
}

test('accepts exact build-provenance subject before gh release upload', () => {
  const result = audit(workflow(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/app.zip
      - name: Publish
        run: gh release upload v1 dist/app.zip --clobber
`));

  assert.equal(result.summary.publishedAssets, 1);
  assert.equal(result.summary.exactSubjectBindings, 1);
  assert.deepEqual(result.findings, []);
});

test('normalizes workspace-qualified attestation subject to the published relative path', () => {
  const result = audit(workflow(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: \${{ github.workspace }}/dist/app.zip
      - run: gh release upload v1 ./dist/app.zip
`));

  assert.equal(result.summary.exactSubjectBindings, 1);
  assert.deepEqual(result.findings, []);
});

test('blocks publication when prior integrity evidence covers a different exact subject', () => {
  const result = audit(workflow(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/other.zip
      - run: gh release upload v1 dist/app.zip
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-subject-mismatch' && item.blocking));
});

test('blocks exact verification that happens only after publication', () => {
  const result = audit(workflow(`      - run: gh release upload v1 dist/app.zip
      - run: gh attestation verify dist/app.zip --repo example/app
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-verification-too-late' && item.blocking));
});

test('blocks an unverified literal release asset', () => {
  const result = audit(workflow(`      - run: gh release upload v1 dist/app.zip
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-subject-unverified' && item.blocking));
});

test('blocks expression-derived release asset selectors', () => {
  const result = audit(workflow(`      - run: gh release upload v1 \${{ inputs.asset }}
`));

  assert.equal(result.summary.dynamicAssetSelectors, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-subject-dynamic' && item.blocking));
});

test('blocks wildcard release asset selectors', () => {
  const result = audit(workflow(`      - run: gh release upload v1 'dist/*.zip'
`));

  assert.equal(result.summary.broadAssetSelectors, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-subject-broad' && item.blocking));
});

test('binds softprops files block entries to exact prior subjects', () => {
  const result = audit(workflow(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/app.zip
      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/checksums.txt
      - name: Publish assets
        uses: softprops/action-gh-release@${RELEASE_SHA}
        with:
          files: |
            dist/app.zip
            dist/checksums.txt
`));

  assert.equal(result.summary.publishedAssets, 2);
  assert.equal(result.summary.exactSubjectBindings, 2);
  assert.deepEqual(result.findings, []);
});

test('binds ncipollo comma-separated artifacts independently', () => {
  const result = audit(workflow(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: cosign verify-blob --signature dist/checksums.sig dist/checksums.txt
      - uses: ncipollo/release-action@${RELEASE_SHA}
        with:
          artifacts: dist/app.zip, dist/checksums.txt
`));

  assert.equal(result.summary.publishedAssets, 2);
  assert.equal(result.summary.exactSubjectBindings, 2);
  assert.deepEqual(result.findings, []);
});

test('recognizes the legacy upload-release-asset exact asset_path contract', () => {
  const result = audit(workflow(`      - run: gh attestation verify dist/app.zip --repo example/app
      - uses: actions/upload-release-asset@${RELEASE_SHA}
        with:
          asset_path: dist/app.zip
`));

  assert.equal(result.summary.publishedAssets, 1);
  assert.deepEqual(result.findings, []);
});

test('allows verification and publication in one run step only when verification occurs first', () => {
  const result = audit(workflow(`      - name: Verify then publish
        run: |
          gh attestation verify dist/app.zip --repo example/app
          gh release upload v1 dist/app.zip
`));

  assert.equal(result.summary.exactSubjectBindings, 1);
  assert.deepEqual(result.findings, []);
});

test('blocks publication before verification inside the same run step', () => {
  const result = audit(workflow(`      - name: Publish then verify
        run: |
          gh release upload v1 dist/app.zip
          gh attestation verify dist/app.zip --repo example/app
`));

  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-verification-too-late'));
});

test('does not treat metadata-only release creation as an asset publication', () => {
  const result = audit(workflow(`      - run: gh release create v1 --title 'Release v1' --notes 'metadata only'
`));

  assert.equal(result.summary.publishedAssets, 0);
  assert.deepEqual(result.findings, []);
});

test('does not inspect similarly named commands outside workflow files', () => {
  const result = auditReleaseAssetSubjects(fixtureInventory([
    { path: 'scripts/release.yml', text: 'run: gh release upload v1 dist/app.zip' },
  ] as readonly FixtureFileInput[]));

  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
