import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReleaseAssetMutations } from './release-asset-mutation-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const ATTEST_SHA = '0123456789abcdef0123456789abcdef01234567';
const RELEASE_SHA = '1111111111111111111111111111111111111111';

function audit(steps: string) {
  return auditReleaseAssetMutations(fixtureInventory([
    {
      path: '.github/workflows/release.yml',
      text: `name: release
on: push
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
${steps}`,
    },
  ] as readonly FixtureFileInput[]));
}

test('blocks overwrite after attestation and before publication', () => {
  const result = audit(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/app.zip
      - run: cp rebuilt/app.zip dist/app.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-integrity-stale-after-mutation' && item.blocking));
});

test('accepts mutation before the final attestation', () => {
  const result = audit(`      - run: cp rebuilt/app.zip dist/app.zip
      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/app.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.deepEqual(result.findings, []);
});

test('blocks redirection after gh attestation verification', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: printf corrupt > dist/app.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.equal(result.summary.mutationRecords, 1);
  assert.ok(result.findings.some(item => item.message.includes('printf corrupt > dist/app.zip')));
});

test('blocks truncate of the exact verified asset', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: truncate -s 0 dist/app.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.ok(result.findings.some(item => item.id === 'ci-release-asset-integrity-stale-after-mutation'));
});

test('blocks zip regeneration after verification', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: zip -r dist/app.zip build/
      - run: gh release upload v1 dist/app.zip
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('blocks tar regeneration after verification', () => {
  const result = audit(`      - run: gh attestation verify dist/app.tar --repo example/app
      - run: tar -cf dist/app.tar build/
      - run: gh release upload v1 dist/app.tar
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('blocks 7z regeneration after verification', () => {
  const result = audit(`      - run: gh attestation verify dist/app.7z --repo example/app
      - run: 7z a dist/app.7z build/
      - run: gh release upload v1 dist/app.7z
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('blocks in-place sed mutation after verification', () => {
  const result = audit(`      - run: gh attestation verify dist/manifest.json --repo example/app
      - run: sed -i 's/dev/prod/' dist/manifest.json
      - run: gh release upload v1 dist/manifest.json
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('ignores mutation of an unrelated neighboring file', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: cp rebuilt/other.zip dist/other.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.deepEqual(result.findings, []);
});

test('uses the most recent verification so re-verification clears earlier stale evidence', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: cp rebuilt/app.zip dist/app.zip
      - run: gh attestation verify dist/app.zip --repo example/app
      - run: gh release upload v1 dist/app.zip
`);

  assert.deepEqual(result.findings, []);
});

test('detects mutation between verification and publication in the same run step', () => {
  const result = audit(`      - name: verify mutate publish
        run: |
          gh attestation verify dist/app.zip --repo example/app
          cp rebuilt/app.zip dist/app.zip
          gh release upload v1 dist/app.zip
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('accepts same-step mutate then verify then publish ordering', () => {
  const result = audit(`      - name: mutate verify publish
        run: |
          cp rebuilt/app.zip dist/app.zip
          gh attestation verify dist/app.zip --repo example/app
          gh release upload v1 dist/app.zip
`);

  assert.deepEqual(result.findings, []);
});

test('blocks mutation before softprops publication', () => {
  const result = audit(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: dist/app.zip
      - run: mv staged/app.zip dist/app.zip
      - uses: softprops/action-gh-release@${RELEASE_SHA}
        with:
          files: dist/app.zip
`);

  assert.equal(result.summary.publishedAssets, 1);
  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('blocks mutation before ncipollo publication', () => {
  const result = audit(`      - run: cosign verify-blob --signature dist/app.sig dist/app.zip
      - run: touch dist/app.zip
      - uses: ncipollo/release-action@${RELEASE_SHA}
        with:
          artifacts: dist/app.zip
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('blocks mutation before upload-release-asset publication', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: rm dist/app.zip
      - uses: actions/upload-release-asset@${RELEASE_SHA}
        with:
          asset_path: dist/app.zip
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('normalizes trusted github.workspace subject before mutation comparison', () => {
  const result = audit(`      - uses: actions/attest-build-provenance@${ATTEST_SHA}
        with:
          subject-path: \${{ github.workspace }}/dist/app.zip
      - run: cp rebuilt/app.zip ./dist/app.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.equal(result.summary.staleIntegrityBindings, 1);
});

test('does not create stale-binding findings without prior integrity evidence', () => {
  const result = audit(`      - run: cp rebuilt/app.zip dist/app.zip
      - run: gh release upload v1 dist/app.zip
`);

  assert.equal(result.summary.integritySubjects, 0);
  assert.deepEqual(result.findings, []);
});

test('does not treat a verification after publication as a mutation-order finding', () => {
  const result = audit(`      - run: gh release upload v1 dist/app.zip
      - run: cp rebuilt/app.zip dist/app.zip
      - run: gh attestation verify dist/app.zip --repo example/app
`);

  assert.deepEqual(result.findings, []);
});

test('supports multiple exact release assets independently', () => {
  const result = audit(`      - run: gh attestation verify dist/app.zip --repo example/app
      - run: gh attestation verify dist/checksums.txt --repo example/app
      - run: cp rebuilt/app.zip dist/app.zip
      - run: gh release upload v1 dist/app.zip dist/checksums.txt
`);

  assert.equal(result.summary.publishedAssets, 2);
  assert.equal(result.summary.staleIntegrityBindings, 1);
  assert.equal(result.summary.signals[0]?.asset, 'dist/app.zip');
});

test('ignores non-workflow configuration files', () => {
  const result = auditReleaseAssetMutations(fixtureInventory([
    { path: 'config/release.yml', text: 'run: cp rebuilt/app.zip dist/app.zip' },
  ] as readonly FixtureFileInput[]));

  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});
