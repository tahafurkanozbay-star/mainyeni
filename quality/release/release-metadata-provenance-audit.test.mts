import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReleaseMetadataProvenance } from './release-metadata-provenance-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function audit(steps: string, extra = '') {
  return auditReleaseMetadataProvenance(fixtureInventory([{
    path: '.github/workflows/release.yml',
    text: `name: Release\non:\n  workflow_dispatch:\npermissions:\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`,
  }]));
}

function ids(result: ReturnType<typeof audit>): string[] {
  return result.findings.map(item => item.id);
}

test('accepts literal release metadata on softprops action', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          name: Kent Rehberi v1\n          body: Reviewed release notes\n          draft: false\n          prerelease: false\n          generate_release_notes: true\n`);

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.releaseMutations, 1);
  assert.deepEqual(result.summary.signals[0]?.metadataFields, ['body', 'draft', 'generate_release_notes', 'name', 'prerelease']);
});

test('accepts trusted step output release body', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          name: Kent Rehberi\n          body: \${{ steps.notes.outputs.body }}\n`);

  assert.deepEqual(result.findings, []);
});

test('accepts trusted needs output release name', () => {
  const result = audit(`      - uses: ncipollo/release-action@${SHA}\n        with:\n          name: \${{ needs.metadata.outputs.release_name }}\n          body: Reviewed\n`);

  assert.deepEqual(result.findings, []);
});

test('blocks input-controlled release name', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          name: \${{ inputs.release_name }}\n          body: Reviewed\n`);

  const finding = result.findings.find(item => item.id === 'ci-release-metadata-untrusted-display');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks event-controlled release body', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          name: Reviewed\n          body: \${{ github.event.pull_request.body }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-display'));
});

test('blocks head_ref in release discussion metadata', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          discussion_category_name: \${{ github.head_ref }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-display'));
});

test('blocks secret-derived release body', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body: \${{ secrets.RELEASE_NOTES }}\n`);

  const finding = result.findings.find(item => item.id === 'ci-release-metadata-secret-exposure');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks secret-derived release title on create-release action', () => {
  const result = audit(`      - uses: actions/create-release@${SHA}\n        with:\n          release_name: \${{ secrets.RELEASE_TITLE }}\n          draft: false\n`);

  assert.ok(ids(result).includes('ci-release-metadata-secret-exposure'));
});

test('blocks input-controlled draft state', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          draft: \${{ inputs.draft }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-state'));
});

test('blocks input-controlled prerelease state', () => {
  const result = audit(`      - uses: ncipollo/release-action@${SHA}\n        with:\n          prerelease: \${{ inputs.prerelease }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-state'));
});

test('blocks input-controlled latest pointer', () => {
  const result = audit(`      - uses: ncipollo/release-action@${SHA}\n        with:\n          makeLatest: \${{ inputs.latest }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-state'));
});

test('blocks input-controlled generated notes behavior', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          generate_release_notes: \${{ inputs.generate_notes }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-state'));
});

test('accepts literal safe body path', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body_path: dist/release-notes.md\n`);

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.bodyPathMutations, 1);
});

test('blocks input-controlled body path', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body_path: \${{ inputs.notes_file }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-body-path'));
});

test('blocks parent traversal in body path', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body_path: ../private/release-notes.md\n`);

  assert.ok(ids(result).includes('ci-release-metadata-body-path-boundary'));
});

test('blocks absolute unix body path', () => {
  const result = audit(`      - uses: ncipollo/release-action@${SHA}\n        with:\n          bodyFile: /tmp/release.md\n`);

  assert.ok(ids(result).includes('ci-release-metadata-body-path-boundary'));
});

test('blocks absolute windows body path', () => {
  const result = audit(`      - uses: ncipollo/release-action@${SHA}\n        with:\n          bodyFile: C:\\temp\\release.md\n`);

  assert.ok(ids(result).includes('ci-release-metadata-body-path-boundary'));
});

test('blocks sensitive dotenv body path', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body_path: .env.production\n`);

  assert.ok(ids(result).includes('ci-release-metadata-sensitive-body-path'));
});

test('blocks git metadata body path', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body_path: .git/config\n`);

  assert.ok(ids(result).includes('ci-release-metadata-sensitive-body-path'));
});

test('blocks credential-shaped body path', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          body_path: build/credentials.json\n`);

  assert.ok(ids(result).includes('ci-release-metadata-sensitive-body-path'));
});

test('supports ncipollo camel-case metadata aliases', () => {
  const result = audit(`      - uses: ncipollo/release-action@${SHA}\n        with:\n          name: \${{ inputs.name }}\n          body: \${{ inputs.body }}\n          bodyFile: \${{ inputs.file }}\n          discussionCategory: \${{ inputs.category }}\n          generateReleaseNotes: \${{ inputs.notes }}\n          makeLatest: \${{ inputs.latest }}\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-display'));
  assert.ok(ids(result).includes('ci-release-metadata-untrusted-body-path'));
  assert.ok(ids(result).includes('ci-release-metadata-untrusted-state'));
});

test('detects github-script createRelease context payload metadata', () => {
  const result = audit(`      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.repos.createRelease({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              tag_name: 'v1',\n              name: context.payload.pull_request.title,\n              body: 'reviewed',\n              draft: false\n            })\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-display'));
  assert.equal(result.summary.releaseMutations, 1);
});

test('detects github-script updateRelease attacker-controlled body', () => {
  const result = audit(`      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.repos.updateRelease({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              release_id: 42,\n              body: context.payload.issue.body\n            })\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-display'));
});

test('tracks github-script untrusted metadata through env', () => {
  const result = audit(`      - uses: actions/github-script@${SHA}\n        env:\n          RELEASE_NAME: \${{ github.event.pull_request.title }}\n        with:\n          script: |\n            await github.rest.repos.createRelease({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              tag_name: 'v1',\n              name: process.env.RELEASE_NAME\n            })\n`);

  assert.ok(ids(result).includes('ci-release-metadata-untrusted-display'));
});

test('tracks github-script secret metadata through env', () => {
  const result = audit(`      - uses: actions/github-script@${SHA}\n        env:\n          RELEASE_BODY: \${{ secrets.RELEASE_BODY }}\n        with:\n          script: |\n            await github.rest.repos.createRelease({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              tag_name: 'v1',\n              body: process.env.RELEASE_BODY\n            })\n`);

  assert.ok(ids(result).includes('ci-release-metadata-secret-exposure'));
});

test('accepts github-script literal release metadata', () => {
  const result = audit(`      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.repos.createRelease({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              tag_name: 'v1',\n              name: 'Kent Rehberi v1',\n              body: 'Reviewed notes',\n              draft: false,\n              prerelease: false\n            })\n`);

  assert.deepEqual(result.findings, []);
});

test('ignores non-release actions', () => {
  const result = audit(`      - uses: actions/upload-artifact@${SHA}\n        with:\n          name: \${{ inputs.name }}\n          path: dist/app.zip\n`);

  assert.equal(result.summary.releaseMutations, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores github-script that does not mutate releases', () => {
  const result = audit(`      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.issues.createComment({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              issue_number: 1,\n              body: context.payload.issue.body\n            })\n`);

  assert.equal(result.summary.releaseMutations, 0);
});

test('summarizes multiple release mutations deterministically', () => {
  const result = audit(`      - uses: softprops/action-gh-release@${SHA}\n        with:\n          name: Reviewed\n      - uses: ncipollo/release-action@${SHA}\n        with:\n          body: \${{ inputs.body }}\n          draft: false\n`);

  assert.equal(result.summary.releaseMutations, 2);
  assert.equal(result.summary.untrustedMutations, 1);
  assert.deepEqual(result.summary.signals.map(item => item.channel), ['release-action', 'release-action']);
});
