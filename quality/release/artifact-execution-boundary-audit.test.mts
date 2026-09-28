import assert from 'node:assert/strict';
import test from 'node:test';
import { auditArtifactExecutionBoundaries } from './artifact-execution-boundary-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditArtifactExecutionBoundaries(fixtureInventory([{ path: '.github/workflows/ci.yml', text }]));
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

function workflow(options: {
  event?: string;
  permissions?: string;
  environment?: string;
  name?: string;
  path?: string;
  extraDownloadWith?: string;
  after?: string;
}) {
  const event = options.event ?? 'push';
  const permissions = options.permissions ?? 'contents: read';
  const environment = options.environment ? `    environment: ${options.environment}\n` : '';
  const name = options.name ?? 'package';
  const path = options.path === undefined ? 'dist/package' : options.path;
  const pathField = path ? `          path: ${path}\n` : '';
  const extra = options.extraDownloadWith ? `${options.extraDownloadWith}\n` : '';
  const after = options.after ?? '      - run: cat dist/package/report.txt';
  return `name: Artifact boundary
on: [${event}]
permissions:
  ${permissions}
jobs:
  consume:
${environment}    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: ${name}
${pathField}${extra}${after}
`;
}

const workflowRunFields = '          run-id: ${{ github.event.workflow_run.id }}\n          github-token: ${{ github.token }}';
const inputRunField = '          run-id: ${{ inputs.run_id }}';

test('ordinary artifact data read is clean', () => {
  assert.deepEqual(audit(workflow({ after: '      - run: cat dist/package/report.txt' })).findings, []);
});

test('grep over downloaded source is data use, not execution', () => {
  const result = audit(workflow({ after: '      - run: grep -R TODO dist/package/check.sh' }));
  assert.equal(result.summary.executedDownloads, 0);
});

test('direct relative execution is high risk without verification', () => {
  const current = finding(workflow({ after: '      - run: ./dist/package/tool' }), 'ci-artifact-execution-unverified');
  assert.equal(current?.severity, 'high');
});

test('bash interpreter execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: bash dist/package/run.sh' }), 'ci-artifact-execution-unverified'));
});

test('node interpreter execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: node dist/package/check.mjs' }), 'ci-artifact-execution-unverified'));
});

test('python interpreter execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: python3 dist/package/check.py' }), 'ci-artifact-execution-unverified'));
});

test('PowerShell execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: pwsh -File dist/package/release.ps1' }), 'ci-artifact-execution-unverified'));
});

test('dotnet assembly execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: dotnet dist/package/Tool.dll' }), 'ci-artifact-execution-unverified'));
});

test('java jar execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: java -jar dist/package/tool.jar' }), 'ci-artifact-execution-unverified'));
});

test('source command execution is detected', () => {
  assert.ok(finding(workflow({ after: '      - run: source dist/package/setup.sh' }), 'ci-artifact-execution-unverified'));
});

test('chmod executable promotion is execution evidence', () => {
  assert.ok(finding(workflow({ after: '      - run: chmod +x dist/package/tool' }), 'ci-artifact-execution-unverified'));
});

test('adding artifact directory to GITHUB_PATH is a separate path-injection finding', () => {
  const current = finding(workflow({ after: '      - run: echo "$PWD/dist/package" >> "$GITHUB_PATH"' }), 'ci-artifact-path-injection');
  assert.equal(current?.severity, 'high');
});

test('pull request path injection becomes blocking', () => {
  const current = finding(workflow({
    event: 'pull_request',
    after: '      - run: echo "$PWD/dist/package" >> "$GITHUB_PATH"',
  }), 'ci-artifact-path-injection');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('cross-run artifact execution is blocking', () => {
  const current = finding(workflow({
    event: 'workflow_run',
    extraDownloadWith: workflowRunFields,
    after: '      - run: bash dist/package/run.sh',
  }), 'ci-artifact-cross-run-execution');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('explicit run-id input marks a download as cross-run', () => {
  const result = audit(workflow({
    event: 'workflow_dispatch',
    extraDownloadWith: inputRunField,
    after: '      - run: cat dist/package/report.txt',
  }));
  assert.equal(result.summary.crossRunDownloads, 1);
});

test('sha256 verification before execution clears unverified execution finding', () => {
  const result = audit(workflow({
    after: '      - run: sha256sum -c dist/package/SHA256SUMS\n      - run: bash dist/package/run.sh',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
  assert.equal(result.summary.verifiedBeforeExecution, 1);
});

test('GitHub attestation verification is recognized', () => {
  const result = audit(workflow({
    after: '      - run: gh attestation verify dist/package/tool --repo owner/repo\n      - run: ./dist/package/tool',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
});

test('cosign blob verification is recognized', () => {
  const result = audit(workflow({
    after: '      - run: cosign verify-blob dist/package/tool --signature dist/package/tool.sig\n      - run: ./dist/package/tool',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
});

test('verification of unrelated path does not satisfy artifact integrity', () => {
  assert.ok(finding(workflow({
    after: '      - run: sha256sum -c safe/SHA256SUMS\n      - run: ./dist/package/tool',
  }), 'ci-artifact-execution-unverified'));
});

test('verification before a later download does not carry forward', () => {
  const source = `name: Ordering
on: [push]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - run: sha256sum -c dist/old/SHA256SUMS
      - uses: actions/download-artifact@${sha}
        with:
          name: package
          path: dist/package
      - run: ./dist/package/tool
`;
  assert.ok(finding(source, 'ci-artifact-execution-unverified'));
});

test('execution before download is irrelevant to downloaded artifact', () => {
  const source = `name: Ordering
on: [push]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - run: ./dist/package/tool
      - uses: actions/download-artifact@${sha}
        with:
          name: package
          path: dist/package
`;
  assert.deepEqual(audit(source).findings, []);
});

test('cross-run verified execution remains medium trust-boundary review', () => {
  const current = finding(workflow({
    event: 'workflow_run',
    extraDownloadWith: workflowRunFields,
    after: '      - run: sha256sum -c dist/package/SHA256SUMS\n      - run: ./dist/package/tool',
  }), 'ci-artifact-cross-run-verified-execution-review');
  assert.equal(current?.severity, 'medium');
});

test('extract then execute chain is visible', () => {
  const current = finding(workflow({
    after: '      - run: tar -xf dist/package/tool.tar -C dist/package\n      - run: ./dist/package/tool',
  }), 'ci-artifact-extract-execute-chain');
  assert.equal(current?.severity, 'high');
});

test('privileged extract then execute chain is blocking', () => {
  const current = finding(workflow({
    permissions: 'deployments: write',
    environment: 'production',
    after: '      - run: unzip dist/package/release.zip -d dist/package\n      - run: bash dist/package/deploy.sh',
  }), 'ci-artifact-extract-execute-chain');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('verified archive chain avoids unverified extract-execute finding', () => {
  const result = audit(workflow({
    after: '      - run: sha256sum -c dist/package/SHA256SUMS\n      - run: tar -xf dist/package/tool.tar -C dist/package\n      - run: ./dist/package/tool',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-extract-execute-chain'), false);
});

test('repository-owned script execution does not associate with narrow artifact path', () => {
  assert.deepEqual(audit(workflow({ after: '      - run: bash scripts/publish.sh' })).findings, []);
});

test('default artifact path is conservatively associated with direct execution', () => {
  const current = finding(workflow({ path: '', after: '      - run: ./tool' }), 'ci-artifact-execution-unverified');
  assert.ok(current);
});

test('multiple downloads are summarized independently', () => {
  const source = `name: Multi
on: [push]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: one
          path: artifacts/one
      - run: cat artifacts/one/data.txt
      - uses: actions/download-artifact@${sha}
        with:
          name: two
          path: artifacts/two
      - run: bash artifacts/two/run.sh
`;
  const result = audit(source);
  assert.equal(result.summary.artifactDownloads, 2);
  assert.equal(result.summary.executedDownloads, 1);
});

test('mutable download-artifact action is delegated to generic provenance audit', () => {
  const source = `name: Mutable
on: [push]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v5
        with:
          name: package
          path: dist/package
      - run: ./dist/package/tool
`;
  assert.equal(audit(source).summary.artifactDownloads, 0);
});

test('nested action-looking input is not parsed as download step', () => {
  const source = `name: Nested
on: [push]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/wrapper@${sha}
        with:
          action: actions/download-artifact@${sha}
          path: dist/package
      - run: ./dist/package/tool
`;
  assert.equal(audit(source).summary.artifactDownloads, 0);
});

test('finding location anchors to download step', () => {
  const current = finding(workflow({ after: '      - run: ./dist/package/tool' }), 'ci-artifact-execution-unverified');
  assert.ok((current?.location?.line ?? 0) >= 8);
});

test('LF and CRLF preserve findings and source lines', () => {
  const source = workflow({
    event: 'workflow_run',
    extraDownloadWith: workflowRunFields,
    after: '      - run: ./dist/package/tool',
  });
  const lf = audit(source).findings.map(item => [item.id, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.location?.line]);
  assert.deepEqual(crlf, lf);
});

test('repeated audit ordering is deterministic', () => {
  const source = workflow({
    event: 'workflow_run',
    permissions: 'contents: write',
    extraDownloadWith: workflowRunFields,
    after: '      - run: unzip dist/package/tool.zip -d dist/package\n      - run: echo "$PWD/dist/package" >> "$GITHUB_PATH"\n      - run: ./dist/package/tool',
  });
  const first = audit(source).findings.map(item => `${item.severity}:${item.id}`);
  const second = audit(source).findings.map(item => `${item.severity}:${item.id}`);
  assert.deepEqual(second, first);
});
