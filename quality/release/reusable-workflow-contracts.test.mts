import assert from 'node:assert/strict';
import test from 'node:test';
import { reusableWorkflowContractFindings } from './reusable-workflow-contracts.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string, path = '.github/workflows/reusable.yml') {
  return reusableWorkflowContractFindings(
    fixtureInventory([{ path, text }] as readonly FixtureFileInput[]),
  );
}

function callable(contract: string, jobs = `  verify:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n`): string {
  return `name: reusable\non:\n  workflow_call:\n${contract}permissions:\n  contents: read\njobs:\n${jobs}`;
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('non-sensitive typed input contract is clean', () => {
  const source = callable(`    inputs:\n      environment:\n        type: string\n        required: true\n`);
  const result = audit(source);
  assert.equal(result.summary.callableWorkflows, 1);
  assert.equal(result.summary.declaredInputs, 1);
  assert.deepEqual(result.findings, []);
});

test('credential-shaped ordinary input is high severity', () => {
  const issue = finding(callable(`    inputs:\n      api-token:\n        type: string\n        required: true\n`), 'ci-reusable-sensitive-input-channel');
  assert.equal(issue?.severity, 'high');
});

test('password input is treated as sensitive ordinary channel', () => {
  assert.ok(finding(callable(`    inputs:\n      deploy_password:\n        type: string\n        required: true\n`), 'ci-reusable-sensitive-input-channel'));
});

test('named secret contract avoids sensitive input finding', () => {
  const source = callable(`    secrets:\n      deploy-token:\n        required: true\n`);
  assert.equal(audit(source).findings.some(item => item.id === 'ci-reusable-sensitive-input-channel'), false);
  assert.equal(audit(source).summary.declaredSecrets, 1);
});

test('generic secret name is low review', () => {
  const issue = finding(callable(`    secrets:\n      value:\n        required: true\n`), 'ci-reusable-secret-contract-review');
  assert.equal(issue?.severity, 'low');
});

test('purpose-specific token secret name is accepted', () => {
  const source = callable(`    secrets:\n      registry-token:\n        required: true\n`);
  assert.equal(audit(source).findings.some(item => item.id === 'ci-reusable-secret-contract-review'), false);
});

test('dynamic input default is reviewable', () => {
  const issue = finding(callable(`    inputs:\n      environment:\n        type: string\n        required: false\n        default: \${{ vars.DEFAULT_ENV }}\n`), 'ci-reusable-dynamic-input-default');
  assert.equal(issue?.severity, 'medium');
});

test('literal input default is clean', () => {
  const source = callable(`    inputs:\n      environment:\n        type: string\n        required: false\n        default: staging\n`);
  assert.equal(audit(source).findings.some(item => item.id === 'ci-reusable-dynamic-input-default'), false);
});

test('credential-shaped workflow output is blocking', () => {
  const source = callable(`    outputs:\n      access-token:\n        value: \${{ jobs.build.outputs.value }}\n`, `  build:\n    runs-on: ubuntu-24.04\n    outputs:\n      value: \${{ steps.value.outputs.result }}\n    steps:\n      - id: value\n        run: echo ok\n`);
  const issue = finding(source, 'ci-reusable-sensitive-output');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('direct secret expression in workflow output is blocking', () => {
  const source = callable(`    outputs:\n      result:\n        value: \${{ secrets.RELEASE_TOKEN }}\n`);
  assert.equal(finding(source, 'ci-reusable-sensitive-output')?.blocking, true);
});

test('explicit job output provenance is accepted', () => {
  const source = callable(`    outputs:\n      artifact-id:\n        value: \${{ jobs.build.outputs.artifact_id }}\n`, `  build:\n    runs-on: ubuntu-24.04\n    outputs:\n      artifact_id: \${{ steps.build.outputs.artifact_id }}\n    steps:\n      - id: build\n        run: echo ok\n`);
  assert.equal(audit(source).findings.some(item => item.id === 'ci-reusable-output-provenance-review'), false);
});

test('output without job-output provenance is medium review', () => {
  const issue = finding(callable(`    outputs:\n      result:\n        value: static\n`), 'ci-reusable-output-provenance-review');
  assert.equal(issue?.severity, 'medium');
});

test('secret passed through with input is critical for external call', () => {
  const source = `name: caller\non:\n  push:\npermissions:\n  contents: read\njobs:\n  publish:\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    with:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`;
  const issue = finding(source, 'ci-reusable-secret-through-input');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('secret passed through with input is high for local reviewed call', () => {
  const source = `name: caller\non:\n  push:\npermissions:\n  contents: read\njobs:\n  publish:\n    uses: ./.github/workflows/publish.yml\n    with:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`;
  const issue = finding(source, 'ci-reusable-secret-through-input');
  assert.equal(issue?.severity, 'high');
  assert.notEqual(issue?.blocking, true);
});

test('explicit named secrets channel does not create secret-through-input finding', () => {
  const source = `name: caller\non:\n  push:\npermissions:\n  contents: read\njobs:\n  publish:\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    secrets:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`;
  assert.equal(audit(source).findings.some(item => item.id === 'ci-reusable-secret-through-input'), false);
});

test('external call combining PR title input and secret is blocking', () => {
  const source = `name: caller\non:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  publish:\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    with:\n      label: \${{ github.event.pull_request.title }}\n    secrets:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`;
  const issue = finding(source, 'ci-reusable-untrusted-input-secret-context');
  assert.equal(issue?.severity, 'critical');
  assert.equal(issue?.blocking, true);
});

test('local call combining untrusted input and secret is high review', () => {
  const source = `name: caller\non:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  publish:\n    uses: ./.github/workflows/publish.yml\n    with:\n      label: \${{ github.event.pull_request.title }}\n    secrets:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`;
  assert.equal(finding(source, 'ci-reusable-untrusted-input-secret-context')?.severity, 'high');
});

test('external call combining input and write authority is blocking', () => {
  const source = `name: caller\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      contents: write\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    with:\n      target: \${{ inputs.target }}\n`;
  const issue = finding(source, 'ci-reusable-untrusted-input-write-context');
  assert.equal(issue?.severity, 'critical');
});

test('literal input plus secret does not create mixed-trust finding', () => {
  const source = `name: caller\non:\n  push:\npermissions:\n  contents: read\njobs:\n  publish:\n    uses: org/repo/.github/workflows/publish.yml@${sha}\n    with:\n      environment: production\n    secrets:\n      token: \${{ secrets.RELEASE_TOKEN }}\n`;
  assert.equal(audit(source).findings.some(item => item.id === 'ci-reusable-untrusted-input-secret-context'), false);
});

test('summary counts reusable call jobs and secret input mappings', () => {
  const source = `name: caller\non:\n  push:\npermissions:\n  contents: read\njobs:\n  one:\n    uses: org/repo/.github/workflows/a.yml@${sha}\n    with:\n      token: \${{ secrets.ONE }}\n  two:\n    uses: org/repo/.github/workflows/b.yml@${sha}\n    with:\n      value: safe\n`;
  const result = audit(source);
  assert.equal(result.summary.reusableCallJobs, 2);
  assert.equal(result.summary.secretInputMappings, 1);
});

test('summary counts mixed trust call job', () => {
  const source = `name: caller\non:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  call:\n    uses: org/repo/.github/workflows/a.yml@${sha}\n    with:\n      title: \${{ github.event.pull_request.title }}\n    secrets:\n      token: \${{ secrets.TOKEN }}\n`;
  assert.equal(audit(source).summary.mixedTrustCallJobs, 1);
});

test('ordinary non-reusable workflow is outside contract audit', () => {
  const source = `name: ci\non:\n  push:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm test\n`;
  const result = audit(source);
  assert.equal(result.summary.callableWorkflows, 0);
  assert.equal(result.summary.reusableCallJobs, 0);
  assert.deepEqual(result.findings, []);
});

test('non-workflow yaml is ignored', () => {
  const result = audit('on:\n  workflow_call:\n', 'docs/example.yml');
  assert.equal(result.summary.callableWorkflows, 0);
});

test('source locations are positive', () => {
  const source = callable(`    inputs:\n      api-token:\n        type: string\n`);
  assert.ok((audit(source).findings[0]?.location?.line ?? 0) > 0);
});

test('contract audit is stable across LF and CRLF', () => {
  const source = callable(`    inputs:\n      api-token:\n        type: string\n    outputs:\n      access-token:\n        value: \${{ jobs.build.outputs.value }}\n`);
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.location?.line]);
  assert.deepEqual(crlf, lf);
});
