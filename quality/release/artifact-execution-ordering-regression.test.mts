import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArtifactExecutionBoundaries } from './artifact-execution-boundary-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(after: string, event = 'push') {
  const crossRun = event === 'workflow_run' ? '          run-id: ${{ github.event.workflow_run.id }}\n          github-token: ${{ github.token }}\n' : '';
  const source = `name: Artifact ordering regression
on: [${event}]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: package
          path: dist/package
${crossRun}${after}
`;
  return auditArtifactExecutionBoundaries(fixtureInventory([{ path: '.github/workflows/ordering.yml', text: source }]));
}

function ids(after: string, event = 'push') { return audit(after, event).findings.map(item => item.id); }

test('execute then verify remains unverified and reports late verification', () => {
  const result = audit('      - run: ./dist/package/tool\n      - run: sha256sum -c dist/package/SHA256SUMS');
  assert.equal(result.summary.verifiedBeforeExecution, 0);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'));
});

test('verify then execute grants integrity credit', () => {
  const result = audit('      - run: sha256sum -c dist/package/SHA256SUMS\n      - run: ./dist/package/tool');
  assert.equal(result.summary.verifiedBeforeExecution, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'), false);
});

test('same-step execute before verify cannot gain integrity credit', () => {
  const result = audit('      - run: ./dist/package/tool && sha256sum -c dist/package/SHA256SUMS');
  assert.equal(result.summary.verifiedBeforeExecution, 0);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'));
});

test('same-step verify and execute is conservatively rejected because command ordering is ambiguous', () => {
  const result = audit('      - run: sha256sum -c dist/package/SHA256SUMS && ./dist/package/tool');
  assert.equal(result.summary.verifiedBeforeExecution, 0);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});

test('PATH promotion before verification is not retroactively authorized', () => {
  const result = audit('      - run: echo "$PWD/dist/package" >> "$GITHUB_PATH"\n      - run: sha256sum -c dist/package/SHA256SUMS');
  assert.equal(result.summary.verifiedBeforeExecution, 0);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-path-injection'));
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'));
});

test('verification before PATH promotion is credited', () => {
  const result = audit('      - run: sha256sum -c dist/package/SHA256SUMS\n      - run: echo "$PWD/dist/package" >> "$GITHUB_PATH"');
  assert.equal(result.summary.verifiedBeforeExecution, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-path-injection'), false);
});

test('unrelated-path verification after execution cannot authorize artifact', () => {
  const result = audit('      - run: ./dist/package/tool\n      - run: sha256sum -c safe/SHA256SUMS');
  assert.equal(result.summary.verifiedBeforeExecution, 0);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'), false);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'));
});

test('cross-run execute then verify remains a blocking cross-run execution', () => {
  const result = audit('      - run: ./dist/package/tool\n      - run: gh attestation verify dist/package/tool --repo owner/repo', 'workflow_run');
  const crossRun = result.findings.find(item => item.id === 'ci-artifact-cross-run-execution');
  assert.equal(crossRun?.severity, 'critical');
  assert.equal(crossRun?.blocking, true);
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'));
});

test('extract execute verify remains an untrusted chain', () => {
  const result = audit('      - run: tar -xf dist/package/tool.tar -C dist/package\n      - run: ./dist/package/tool\n      - run: sha256sum -c dist/package/SHA256SUMS');
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-extract-execute-chain'));
  assert.ok(result.findings.some(item => item.id === 'ci-artifact-verification-too-late'));
});

test('verify extract execute preserves the trusted ordering', () => {
  const result = audit('      - run: sha256sum -c dist/package/SHA256SUMS\n      - run: tar -xf dist/package/tool.tar -C dist/package\n      - run: ./dist/package/tool');
  assert.equal(result.summary.verifiedBeforeExecution, 1);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-extract-execute-chain'), false);
});

test('late verification signal is deterministic across repeated audits', () => {
  const after = '      - run: ./dist/package/tool\n      - run: cosign verify-blob dist/package/tool --signature dist/package/tool.sig';
  assert.deepEqual(ids(after), ids(after));
});
