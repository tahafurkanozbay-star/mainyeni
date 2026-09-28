import assert from 'node:assert/strict';
import test from 'node:test';
import { auditMatrixTrust } from './matrix-trust-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string, path = '.github/workflows/matrix.yml') {
  return auditMatrixTrust(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(finding => finding.id);
}

function workflow(strategy: string, trigger = 'push', extra = '') {
  return `name: Matrix
on:
  ${trigger}:
permissions:
  contents: read
jobs:
  test:
${extra}${strategy}
    runs-on: ubuntu-24.04
    steps:
      - run: echo test
`;
}

const boundedStatic = `    strategy:
      max-parallel: 2
      matrix:
        node: [22, 24]
        os: [ubuntu-24.04, windows-2025]
`;

test('accepts a static matrix with literal max-parallel', () => {
  const result = audit(workflow(boundedStatic));
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary.matrixJobs, 1);
  assert.equal(result.summary.dynamicMatrixJobs, 0);
  assert.equal(result.summary.unboundedMatrixJobs, 0);
});

test('counts direct matrix dimensions and inline values', () => {
  const result = audit(workflow(boundedStatic));
  assert.equal(result.summary.signals[0]?.dimensions, 2);
  assert.equal(result.summary.signals[0]?.staticValues, 4);
});

test('blocks matrix constructed directly from workflow input', () => {
  const result = audit(workflow(`    strategy:
      matrix: \${{ fromJSON(inputs.matrix) }}
`));
  const finding = result.findings.find(item => item.id === 'ci-matrix-untrusted-definition');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks matrix constructed from pull-request event data', () => {
  const result = audit(workflow(`    strategy:
      matrix:
        include: \${{ fromJSON(github.event.pull_request.body) }}
`, 'pull_request'));
  assert.ok(result.findings.some(item => item.id === 'ci-matrix-untrusted-definition'));
});

test('blocks issue-comment-derived matrix data', () => {
  const result = audit(workflow(`    strategy:
      matrix: \${{ fromJSON(github.event.comment.body) }}
`, 'issue_comment'));
  assert.ok(result.findings.some(item => item.id === 'ci-matrix-untrusted-definition'));
});

test('reviews matrix generated from upstream needs output', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 2
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
`));
  assert.ok(result.findings.some(item => item.id === 'ci-matrix-dynamic-definition-review'));
  assert.equal(result.findings.some(item => item.id === 'ci-matrix-untrusted-definition'), false);
});

test('blocks untrusted matrix combined with write authority', () => {
  const text = `name: Matrix
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  publish:
    permissions:
      contents: write
    strategy:
      max-parallel: 2
      matrix: \${{ fromJSON(inputs.targets) }}
    runs-on: ubuntu-24.04
    steps:
      - run: echo publish
`;
  const finding = audit(text).findings.find(item => item.id === 'ci-matrix-untrusted-privilege-fanout');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('blocks untrusted matrix combined with secret-bearing job', () => {
  const text = `name: Matrix
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  publish:
    strategy:
      max-parallel: 2
      matrix: \${{ fromJSON(inputs.targets) }}
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
    steps:
      - run: echo publish
`;
  assert.ok(audit(text).findings.some(item => item.id === 'ci-matrix-untrusted-privilege-fanout'));
});

test('blocks untrusted matrix combined with deployment environment', () => {
  const text = `name: Matrix
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  deploy:
    environment: production
    strategy:
      max-parallel: 2
      matrix: \${{ fromJSON(inputs.targets) }}
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`;
  assert.ok(audit(text).findings.some(item => item.id === 'ci-matrix-untrusted-privilege-fanout'));
});

test('flags externally triggered matrix without max-parallel', () => {
  const result = audit(workflow(`    strategy:
      matrix:
        node: [22, 24]
`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-matrix-unbounded-external-fanout');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, undefined);
});

test('makes unbounded untrusted matrix a blocking resource-exhaustion finding', () => {
  const result = audit(workflow(`    strategy:
      matrix: \${{ fromJSON(inputs.matrix) }}
`));
  const finding = result.findings.find(item => item.id === 'ci-matrix-unbounded-external-fanout');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('literal max-parallel removes unbounded fanout finding', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 3
      matrix: \${{ fromJSON(inputs.matrix) }}
`));
  assert.equal(result.findings.some(item => item.id === 'ci-matrix-unbounded-external-fanout'), false);
  assert.ok(result.findings.some(item => item.id === 'ci-matrix-untrusted-definition'));
});

test('flags input-controlled max-parallel', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: \${{ inputs.parallel }}
      matrix:
        node: [22, 24]
`));
  const finding = result.findings.find(item => item.id === 'ci-matrix-dynamic-max-parallel');
  assert.equal(finding?.severity, 'high');
});

test('flags needs-controlled max-parallel at medium severity', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: \${{ needs.plan.outputs.parallel }}
      matrix:
        node: [22, 24]
`));
  const finding = result.findings.find(item => item.id === 'ci-matrix-dynamic-max-parallel');
  assert.equal(finding?.severity, 'medium');
});

test('flags fail-fast false without concurrency ceiling', () => {
  const result = audit(workflow(`    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
`));
  assert.ok(result.findings.some(item => item.id === 'ci-matrix-fail-fast-disabled-unbounded'));
});

test('raises fail-fast unbounded severity on external trigger', () => {
  const result = audit(workflow(`    strategy:
      fail-fast: false
      matrix:
        node: [22, 24]
`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-matrix-fail-fast-disabled-unbounded');
  assert.equal(finding?.severity, 'high');
});

test('bounded fail-fast false matrix avoids the unbounded finding', () => {
  const result = audit(workflow(`    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        node: [22, 24]
`));
  assert.equal(result.findings.some(item => item.id === 'ci-matrix-fail-fast-disabled-unbounded'), false);
});

test('flags unbounded three-dimensional static matrix', () => {
  const result = audit(workflow(`    strategy:
      matrix:
        os: [ubuntu-24.04, windows-2025]
        node: [22, 24]
        locale: [tr, en]
`));
  assert.ok(result.findings.some(item => item.id === 'ci-matrix-multidimensional-unbounded'));
});

test('bounded three-dimensional matrix avoids multidimensional warning', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 2
      matrix:
        os: [ubuntu-24.04, windows-2025]
        node: [22, 24]
        locale: [tr, en]
`));
  assert.equal(result.findings.some(item => item.id === 'ci-matrix-multidimensional-unbounded'), false);
});

test('blocks external matrix containing self-hosted runner values', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 1
      matrix:
        runner: [self-hosted, ubuntu-24.04]
`, 'pull_request'));
  const finding = result.findings.find(item => item.id === 'ci-matrix-external-self-hosted-fanout');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('trusted push may use bounded self-hosted matrix without external finding', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 1
      matrix:
        runner: [self-hosted, ubuntu-24.04]
`));
  assert.equal(result.findings.some(item => item.id === 'ci-matrix-external-self-hosted-fanout'), false);
});

test('include entries do not count as top-level dimensions', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 2
      matrix:
        os: [ubuntu-24.04]
        include:
          - os: ubuntu-24.04
            experimental: true
`));
  assert.equal(result.summary.signals[0]?.dimensions, 1);
});

test('exclude entries do not count as top-level dimensions', () => {
  const result = audit(workflow(`    strategy:
      max-parallel: 2
      matrix:
        os: [ubuntu-24.04, windows-2025]
        exclude:
          - os: windows-2025
`));
  assert.equal(result.summary.signals[0]?.dimensions, 1);
});

test('ignores matrix-looking yaml outside workflows', () => {
  const result = auditMatrixTrust(fixtureInventory([
    { path: 'docs/matrix.yml', text: workflow(boundedStatic) },
  ]));
  assert.equal(result.summary.workflowFiles, 0);
  assert.equal(result.summary.matrixJobs, 0);
});

test('supports .yaml workflow extension', () => {
  const result = audit(workflow(boundedStatic), '.github/workflows/matrix.yaml');
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.matrixJobs, 1);
});

test('does not treat step-level matrix text as strategy matrix', () => {
  const text = `name: Matrix
on:
  push:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "matrix: $VALUE"
`;
  assert.equal(audit(text).summary.matrixJobs, 0);
});

test('summary reports dynamic, untrusted, and unbounded counts', () => {
  const result = audit(workflow(`    strategy:
      matrix: \${{ fromJSON(inputs.matrix) }}
`));
  assert.equal(result.summary.matrixJobs, 1);
  assert.equal(result.summary.dynamicMatrixJobs, 1);
  assert.equal(result.summary.untrustedMatrixJobs, 1);
  assert.equal(result.summary.unboundedMatrixJobs, 1);
});

test('summary findings is the canonical finding array', () => {
  const result = audit(workflow(`    strategy:
      matrix: \${{ fromJSON(inputs.matrix) }}
`));
  assert.equal(result.summary.findings, result.findings);
});

test('finding order is deterministic across repeated audits', () => {
  const text = workflow(`    strategy:
      fail-fast: false
      matrix: \${{ fromJSON(inputs.matrix) }}
`);
  const first = audit(text).findings.map(item => `${item.severity}:${item.id}:${item.location?.line ?? 0}`);
  const second = audit(text).findings.map(item => `${item.severity}:${item.id}:${item.location?.line ?? 0}`);
  assert.deepEqual(first, second);
});

test('CRLF and LF inputs produce the same findings and locations', () => {
  const lf = workflow(`    strategy:
      matrix: \${{ fromJSON(inputs.matrix) }}
`);
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual(
    audit(lf).findings.map(item => [item.id, item.location?.line]),
    audit(crlf).findings.map(item => [item.id, item.location?.line]),
  );
});
