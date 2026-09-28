import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArtifactProvenance } from './artifact-provenance-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';
const upload = `actions/upload-artifact@${sha}`;
const download = `actions/download-artifact@${sha}`;
const attest = `actions/attest-build-provenance@${sha}`;

function audit(text: string, path = '.github/workflows/release.yml') {
  return auditArtifactProvenance(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

function has(text: string, id: string): boolean {
  return ids(text).includes(id);
}

const workflow = (steps: string, permissions = 'permissions:\n  contents: read') => `name: release\non:\n  pull_request:\n${permissions}\njobs:\n  qa:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

const safeUpload = `      - uses: ${upload}\n        with:\n          name: release-evidence\n          path: qa-artifacts/release\n          if-no-files-found: error\n          retention-days: 14\n`;

const safeDownload = `      - uses: ${download}\n        with:\n          name: release-evidence\n          path: qa-artifacts/release\n`;

test('accepts narrow immutable fail-closed artifact upload', () => {
  assert.deepEqual(audit(workflow(safeUpload)).findings, []);
});

test('counts workflow artifact operations deterministically', () => {
  const result = audit(workflow(`${safeUpload}${safeDownload}`));
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.uploads, 1);
  assert.equal(result.summary.downloads, 1);
  assert.equal(result.summary.attestations, 0);
  assert.equal(result.summary.releasePublishes, 0);
});

test('ignores artifact-looking text outside workflow directory', () => {
  const result = audit(workflow(safeUpload), 'docs/release.yml');
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('recognizes yaml workflow extension', () => {
  assert.equal(audit(workflow(safeUpload), '.github/workflows/release.yaml').summary.uploads, 1);
});

test('blocks mutable upload-artifact action', () => {
  assert.equal(has(workflow(safeUpload.replace(upload, 'actions/upload-artifact@v4')), 'ci-artifact-upload-mutable-action'), true);
});

test('blocks mutable download-artifact action', () => {
  assert.equal(has(workflow(safeDownload.replace(download, 'actions/download-artifact@v4')), 'ci-artifact-download-mutable-action'), true);
});

test('requires explicit artifact upload name', () => {
  assert.equal(has(workflow(safeUpload.replace('          name: release-evidence\n', '')), 'ci-artifact-name-implicit'), true);
});

for (const expression of [
  '${{ github.event.pull_request.title }}',
  '${{ github.event.pull_request.body }}',
  '${{ github.event.issue.title }}',
  '${{ github.event.comment.body }}',
  '${{ github.head_ref }}',
  '${{ inputs.artifact }}',
] as const) {
  test(`blocks untrusted upload artifact name ${expression}`, () => {
    assert.equal(has(workflow(safeUpload.replace('release-evidence', expression)), 'ci-artifact-name-untrusted'), true);
  });
}

test('allows trusted immutable commit in artifact name', () => {
  const text = safeUpload.replace('release-evidence', 'release-${{ github.sha }}');
  assert.equal(has(workflow(text), 'ci-artifact-name-untrusted'), false);
});

test('requires explicit upload path', () => {
  const text = safeUpload.replace('          path: qa-artifacts/release\n', '');
  assert.equal(has(workflow(text), 'ci-artifact-path-missing'), true);
});

for (const path of ['.', './', '*', '**', './**', '${{ github.workspace }}', '${{ github.workspace }}/**'] as const) {
  test(`blocks broad workspace upload path ${path}`, () => {
    const text = safeUpload.replace('qa-artifacts/release', path);
    assert.equal(has(workflow(text), 'ci-artifact-path-broad'), true);
  });
}

for (const path of ['.env', '.env.production', '.git/config', 'secrets/token', 'credentials/aws', 'id_rsa'] as const) {
  test(`blocks sensitive artifact path ${path}`, () => {
    const text = safeUpload.replace('qa-artifacts/release', path);
    assert.equal(has(workflow(text), 'ci-artifact-path-sensitive'), true);
  });
}

test('missing if-no-files-found is blocking', () => {
  const text = safeUpload.replace('          if-no-files-found: error\n', '');
  assert.equal(has(workflow(text), 'ci-artifact-missing-not-fatal'), true);
});

test('warn mode is blocking for release evidence', () => {
  const text = safeUpload.replace('if-no-files-found: error', 'if-no-files-found: warn');
  assert.equal(has(workflow(text), 'ci-artifact-missing-not-fatal'), true);
});

test('ignore mode is blocking for release evidence', () => {
  const text = safeUpload.replace('if-no-files-found: error', 'if-no-files-found: ignore');
  assert.equal(has(workflow(text), 'ci-artifact-missing-not-fatal'), true);
});

test('long artifact retention is reported', () => {
  const text = safeUpload.replace('retention-days: 14', 'retention-days: 120');
  assert.equal(has(workflow(text), 'ci-artifact-retention-excessive'), true);
});

test('90 day retention does not trigger excessive retention finding', () => {
  const text = safeUpload.replace('retention-days: 14', 'retention-days: 90');
  assert.equal(has(workflow(text), 'ci-artifact-retention-excessive'), false);
});

test('hidden file inclusion is blocking', () => {
  const text = safeUpload.replace('          retention-days: 14\n', '          retention-days: 14\n          include-hidden-files: true\n');
  assert.equal(has(workflow(text), 'ci-artifact-hidden-files'), true);
});

test('artifact overwrite is reported', () => {
  const text = safeUpload.replace('          retention-days: 14\n', '          retention-days: 14\n          overwrite: true\n');
  assert.equal(has(workflow(text), 'ci-artifact-overwrite'), true);
});

test('scoped artifact download is accepted', () => {
  assert.deepEqual(audit(workflow(safeDownload)).findings, []);
});

test('download without name or pattern is blocking', () => {
  const text = safeDownload.replace('          name: release-evidence\n', '');
  assert.equal(has(workflow(text), 'ci-artifact-download-unscoped'), true);
});

test('literal download pattern is accepted', () => {
  const text = safeDownload.replace('name: release-evidence', 'pattern: release-evidence-*');
  assert.equal(has(workflow(text), 'ci-artifact-download-unscoped'), false);
});

for (const selector of ['${{ github.head_ref }}', '${{ github.event.pull_request.title }}', '${{ inputs.name }}'] as const) {
  test(`blocks untrusted download selector ${selector}`, () => {
    const text = safeDownload.replace('release-evidence', selector);
    assert.equal(has(workflow(text), 'ci-artifact-download-untrusted-selector'), true);
  });
}

test('cross-run download requires explicit repository', () => {
  const text = safeDownload.replace('          path: qa-artifacts/release\n', '          path: qa-artifacts/release\n          run-id: ${{ needs.resolve.outputs.run_id }}\n');
  assert.equal(has(workflow(text), 'ci-artifact-cross-run-repository-implicit'), true);
});

test('cross-run download with explicit repository clears repository finding', () => {
  const text = safeDownload.replace('          path: qa-artifacts/release\n', '          path: qa-artifacts/release\n          run-id: ${{ needs.resolve.outputs.run_id }}\n          repository: trusted/project\n');
  assert.equal(has(workflow(text), 'ci-artifact-cross-run-repository-implicit'), false);
});

test('cross-run PR head provenance is blocking', () => {
  const text = safeDownload.replace('          path: qa-artifacts/release\n', '          path: qa-artifacts/release\n          run-id: ${{ github.event.pull_request.head.sha }}\n          repository: trusted/project\n');
  assert.equal(has(workflow(text), 'ci-artifact-cross-run-pr-ref'), true);
});

test('cross-run merge commit provenance is blocking', () => {
  const text = safeDownload.replace('          path: qa-artifacts/release\n', '          path: qa-artifacts/release\n          run-id: ${{ github.event.pull_request.merge_commit_sha }}\n          repository: trusted/project\n');
  assert.equal(has(workflow(text), 'ci-artifact-cross-run-pr-ref'), true);
});

test('immutable attestation with explicit subject and permissions is accepted', () => {
  const step = `      - uses: ${attest}\n        with:\n          subject-path: dist/app.tar.gz\n`;
  const permissions = 'permissions:\n  contents: read\n  attestations: write\n  id-token: write';
  assert.deepEqual(audit(workflow(step, permissions)).findings, []);
});

test('mutable attestation action is blocking', () => {
  const step = `      - uses: actions/attest-build-provenance@v2\n        with:\n          subject-path: dist/app.tar.gz\n`;
  const permissions = 'permissions:\n  contents: read\n  attestations: write\n  id-token: write';
  assert.equal(has(workflow(step, permissions), 'ci-attestation-mutable-action'), true);
});

test('attestation requires explicit permissions', () => {
  const step = `      - uses: ${attest}\n        with:\n          subject-path: dist/app.tar.gz\n`;
  assert.equal(has(workflow(step), 'ci-attestation-permissions-incomplete'), true);
});

test('attestation requires explicit subject', () => {
  const step = `      - uses: ${attest}\n`;
  const permissions = 'permissions:\n  contents: read\n  attestations: write\n  id-token: write';
  assert.equal(has(workflow(step, permissions), 'ci-attestation-subject-missing'), true);
});

test('subject digest satisfies explicit attestation subject', () => {
  const step = `      - uses: ${attest}\n        with:\n          subject-digest: sha256:abc123\n`;
  const permissions = 'permissions:\n  contents: read\n  attestations: write\n  id-token: write';
  assert.equal(has(workflow(step, permissions), 'ci-attestation-subject-missing'), false);
});

test('gh release publication requires explicit contents write permission', () => {
  const step = `      - run: gh release upload v1 dist/app.tar.gz\n`;
  assert.equal(has(workflow(step), 'ci-release-publish-permission-implicit'), true);
});

test('gh release publication requires digest or attestation evidence', () => {
  const step = `      - run: gh release upload v1 dist/app.tar.gz\n`;
  const permissions = 'permissions:\n  contents: write';
  assert.equal(has(workflow(step, permissions), 'ci-release-publish-without-provenance'), true);
});

test('gh release publication with digest evidence is accepted', () => {
  const step = `      - run: |\n          sha256sum dist/app.tar.gz > dist/app.tar.gz.sha256\n          gh release upload v1 dist/app.tar.gz dist/app.tar.gz.sha256\n`;
  const permissions = 'permissions:\n  contents: write';
  assert.deepEqual(audit(workflow(step, permissions)).findings, []);
});

test('release action publication requires provenance', () => {
  const step = `      - uses: softprops/action-gh-release@${sha}\n        with:\n          files: dist/app.tar.gz\n`;
  const permissions = 'permissions:\n  contents: write';
  assert.equal(has(workflow(step, permissions), 'ci-release-publish-without-provenance'), true);
});

test('release action publication accepts workflow attestation boundary', () => {
  const step = `      - uses: ${attest}\n        with:\n          subject-path: dist/app.tar.gz\n      - uses: softprops/action-gh-release@${sha}\n        with:\n          files: dist/app.tar.gz\n`;
  const permissions = 'permissions:\n  contents: write\n  attestations: write\n  id-token: write';
  assert.equal(has(workflow(step, permissions), 'ci-release-publish-without-provenance'), false);
});

test('multiple unsafe artifact operations produce stable sorted findings', () => {
  const text = workflow(`      - uses: actions/upload-artifact@v4\n        with:\n          path: .\n      - uses: actions/download-artifact@v4\n`);
  const first = audit(text).findings.map(item => `${item.id}:${item.location?.line ?? 0}`);
  const second = audit(text).findings.map(item => `${item.id}:${item.location?.line ?? 0}`);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 5);
});

test('finding locations point at the unsafe artifact step', () => {
  const text = workflow(`      - name: safe\n        run: echo ok\n      - uses: actions/upload-artifact@v4\n        with:\n          name: evidence\n          path: .\n`);
  const result = audit(text).findings.find(item => item.id === 'ci-artifact-path-broad');
  assert.equal(result?.location?.file, '.github/workflows/release.yml');
  assert.ok((result?.location?.line ?? 0) > 1);
});

test('summary separates independent workflow files', () => {
  const inventory = fixtureInventory([
    { path: '.github/workflows/a.yml', text: workflow(safeUpload) },
    { path: '.github/workflows/b.yml', text: workflow(safeDownload) },
  ] as readonly FixtureFileInput[]);
  const result = auditArtifactProvenance(inventory);
  assert.equal(result.summary.workflowFiles, 2);
  assert.equal(result.summary.uploads, 1);
  assert.equal(result.summary.downloads, 1);
});
