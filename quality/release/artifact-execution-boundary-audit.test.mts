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

const header = `name: CI
on: [push]
permissions:
  contents: read
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
`;

test('ordinary artifact download without execution is clean', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: report
          path: artifacts/report
      - run: cat artifacts/report/summary.txt
`);
  assert.equal(result.findings.length, 0);
});

test('directly executing downloaded shell script is high risk', () => {
  const current = finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: tools
          path: artifacts/tools
      - run: bash artifacts/tools/run.sh
`, 'ci-artifact-execution-unverified');
  assert.equal(current?.severity, 'high');
});

test('executing downloaded script with relative invocation is high risk', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: tools
          path: artifacts/tools
      - run: ./artifacts/tools/run.sh
`, 'ci-artifact-execution-unverified'));
});

test('chmod executable promotion is treated as execution evidence', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: chmod +x dist/cli/tool
`, 'ci-artifact-execution-unverified'));
});

test('adding downloaded directory to GITHUB_PATH is high risk', () => {
  const current = finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: echo "$PWD/dist/cli" >> "$GITHUB_PATH"
`, 'ci-artifact-path-injection');
  assert.equal(current?.severity, 'high');
});

test('external workflow path injection becomes blocking', () => {
  const source = `name: PR
on: [pull_request]
permissions:
  contents: read
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: echo "$PWD/dist/cli" >> "$GITHUB_PATH"
`;
  const current = finding(source, 'ci-artifact-path-injection');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('cross-run artifact execution is always blocking without verification', () => {
  const source = `name: Followup
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}
      - run: bash dist/cli/run.sh
`;
  const current = finding(source, 'ci-artifact-cross-run-execution');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('cross-run selector through input is recognized', () => {
  const result = audit(`name: Manual
on:
  workflow_dispatch:
    inputs:
      run_id:
        required: true
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
          run-id: ${{ inputs.run_id }}
      - run: node dist/cli/index.mjs
`);
  assert.equal(result.summary.crossRunDownloads, 1);
});

test('verified artifact before execution avoids unverified blocker', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: sha256sum -c dist/cli/SHA256SUMS
      - run: bash dist/cli/run.sh
`);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
  assert.equal(result.summary.verifiedBeforeExecution, 1);
});

test('gh attestation verify is recognized as integrity evidence', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: gh attestation verify dist/cli/tool --repo owner/repo
      - run: ./dist/cli/tool
`);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
});

test('cosign verify-blob is recognized as integrity evidence', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: cosign verify-blob dist/cli/tool --signature dist/cli/tool.sig
      - run: ./dist/cli/tool
`);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-execution-unverified'), false);
});

test('verification of unrelated path does not satisfy artifact boundary', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: sha256sum -c safe/SHA256SUMS
      - run: ./dist/cli/tool
`, 'ci-artifact-execution-unverified'));
});

test('cross-run verified execution remains medium review', () => {
  const source = `name: Followup
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
          run-id: ${{ github.event.workflow_run.id }}
      - run: sha256sum -c dist/cli/SHA256SUMS
      - run: ./dist/cli/tool
`;
  const current = finding(source, 'ci-artifact-cross-run-verified-execution-review');
  assert.equal(current?.severity, 'medium');
});

test('archive extract then execution is separately visible', () => {
  const current = finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: package
          path: dist/package
      - run: tar -xf dist/package/tool.tar -C dist/package
      - run: ./dist/package/tool
`, 'ci-artifact-extract-execute-chain');
  assert.equal(current?.severity, 'high');
});

test('privileged extract-execute chain is blocking', () => {
  const source = `name: Deploy
on: [push]
permissions:
  deployments: write
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: release
          path: dist/release
      - run: unzip dist/release/release.zip -d dist/release
      - run: bash dist/release/deploy.sh
`;
  const current = finding(source, 'ci-artifact-extract-execute-chain');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('verification before extraction and execution avoids extract-execute blocker', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: package
          path: dist/package
      - run: sha256sum -c dist/package/SHA256SUMS
      - run: tar -xf dist/package/tool.tar -C dist/package
      - run: ./dist/package/tool
`);
  assert.equal(result.findings.some(item => item.id === 'ci-artifact-extract-execute-chain'), false);
});

test('download after an earlier verification does not inherit stale verification', () => {
  const source = `${header}      - run: sha256sum -c dist/old/SHA256SUMS
      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: ./dist/cli/tool
`;
  assert.ok(finding(source, 'ci-artifact-execution-unverified'));
});

test('execution before download is irrelevant to later artifact', () => {
  const result = audit(`${header}      - run: ./dist/cli/tool
      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
`);
  assert.equal(result.findings.length, 0);
});

test('downloaded documentation read is not executable use', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: docs
          path: artifacts/docs
      - run: grep -R "TODO" artifacts/docs
`);
  assert.equal(result.findings.length, 0);
});

test('default download path is conservatively associated with later execution', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
      - run: ./cli/tool
`, 'ci-artifact-execution-unverified'));
});

test('PowerShell execution from artifact path is detected', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: scripts
          path: dist/scripts
      - run: pwsh -File dist/scripts/release.ps1
`, 'ci-artifact-execution-unverified'));
});

test('Python execution from artifact path is detected', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: scripts
          path: dist/scripts
      - run: python3 dist/scripts/release.py
`, 'ci-artifact-execution-unverified'));
});

test('Java jar execution from artifact path is detected', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: tools
          path: dist/tools
      - run: java -jar dist/tools/tool.jar
`, 'ci-artifact-execution-unverified'));
});

test('dotnet execution from artifact path is detected', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: tools
          path: dist/tools
      - run: dotnet dist/tools/Tool.dll
`, 'ci-artifact-execution-unverified'));
});

test('source command from downloaded path is detected', () => {
  assert.ok(finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: env
          path: artifacts/env
      - run: source artifacts/env/setup.sh
`, 'ci-artifact-execution-unverified'));
});

test('ordinary repository script execution does not associate with narrow artifact path', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: report
          path: artifacts/report
      - run: bash scripts/publish.sh
`);
  assert.equal(result.findings.length, 0);
});

test('multiple artifact downloads are independently summarized', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: one
          path: artifacts/one
      - run: cat artifacts/one/data.txt
      - uses: actions/download-artifact@${sha}
        with:
          name: two
          path: artifacts/two
      - run: bash artifacts/two/run.sh
`);
  assert.equal(result.summary.artifactDownloads, 2);
  assert.equal(result.summary.executedDownloads, 1);
});

test('summary counts cross-run downloads', () => {
  const result = audit(`name: Followup
on: [workflow_run]
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: result
          run-id: ${{ github.event.workflow_run.id }}
`);
  assert.equal(result.summary.crossRunDownloads, 1);
});

test('mutable download action is outside this audit and handled by artifact provenance audit', () => {
  const result = audit(`${header}      - uses: actions/download-artifact@v5
        with:
          name: cli
          path: dist/cli
      - run: ./dist/cli/tool
`);
  assert.equal(result.summary.artifactDownloads, 0);
});

test('nested action-looking with value is not a download step', () => {
  const result = audit(`${header}      - uses: vendor/wrapper@${sha}
        with:
          action: actions/download-artifact@${sha}
          path: dist/cli
      - run: ./dist/cli/tool
`);
  assert.equal(result.summary.artifactDownloads, 0);
});

test('finding location anchors to download action', () => {
  const current = finding(`${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: ./dist/cli/tool
`, 'ci-artifact-execution-unverified');
  assert.ok((current?.location?.line ?? 0) >= 8);
});

test('LF and CRLF produce identical findings and locations', () => {
  const source = `${header}      - uses: actions/download-artifact@${sha}
        with:
          name: cli
          path: dist/cli
      - run: ./dist/cli/tool
`;
  const lf = audit(source).findings.map(item => [item.id, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.location?.line]);
  assert.deepEqual(crlf, lf);
});

test('finding order is stable across repeated audits', () => {
  const source = `name: Followup
on: [workflow_run]
permissions:
  contents: write
jobs:
  consume:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${sha}
        with:
          name: package
          path: dist/package
          run-id: ${{ github.event.workflow_run.id }}
      - run: unzip dist/package/tool.zip -d dist/package
      - run: echo "$PWD/dist/package" >> "$GITHUB_PATH"
      - run: ./dist/package/tool
`;
  const first = audit(source).findings.map(item => `${item.severity}:${item.id}`);
  const second = audit(source).findings.map(item => `${item.severity}:${item.id}`);
  assert.deepEqual(second, first);
});
