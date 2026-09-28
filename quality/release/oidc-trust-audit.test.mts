import assert from 'node:assert/strict';
import test from 'node:test';
import { auditOidcTrust } from './oidc-trust-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';
const aws = `aws-actions/configure-aws-credentials@${sha}`;
const azure = `azure/login@${sha}`;
const google = `google-github-actions/auth@${sha}`;
const attest = `actions/attest-build-provenance@${sha}`;
const checkout = `actions/checkout@${sha}`;

function audit(text: string, path = '.github/workflows/deploy.yml') {
  return auditOidcTrust(fixtureInventory([{ path, text }] as readonly FixtureFileInput[]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

function has(text: string, id: string): boolean {
  return ids(text).includes(id);
}

function workflow(options: {
  trigger?: string;
  permissions?: string;
  environment?: string;
  steps?: string;
} = {}): string {
  const trigger = options.trigger ?? 'push:\n    branches: [main]';
  const permissions = options.permissions ?? 'permissions:\n  contents: read\n  id-token: write';
  const environment = options.environment ? `    environment: ${options.environment}\n` : '';
  const steps = options.steps ?? `      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n          aws-region: eu-central-1\n`;
  return `name: deploy\non:\n  ${trigger}\n${permissions}\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n${environment}    steps:\n${steps}`;
}

const safeAws = workflow({
  environment: 'production',
  steps: `      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n          aws-region: eu-central-1\n`,
});

test('accepts immutable AWS federation on trusted push with fixed environment', () => {
  assert.deepEqual(audit(safeAws).findings, []);
});

test('counts privileged workflow and cloud login deterministically', () => {
  const result = audit(safeAws);
  assert.equal(result.summary.workflowFiles, 1);
  assert.equal(result.summary.privilegedWorkflows, 1);
  assert.equal(result.summary.workflows[0]?.cloudLoginSteps, 1);
  assert.equal(result.summary.workflows[0]?.environmentJobs, 1);
});

test('ignores workflow-looking content outside workflow directory', () => {
  const result = audit(safeAws, 'docs/deploy.yml');
  assert.equal(result.summary.workflowFiles, 0);
  assert.deepEqual(result.findings, []);
});

test('recognizes yaml workflow extension', () => {
  assert.equal(audit(safeAws, '.github/workflows/deploy.yaml').summary.workflowFiles, 1);
});

test('blocks mutable AWS federation action', () => {
  assert.equal(has(safeAws.replace(aws, 'aws-actions/configure-aws-credentials@v5'), 'ci-oidc-cloud-action-mutable'), true);
});

test('blocks mutable Azure federation action', () => {
  const text = safeAws.replace(aws, 'azure/login@v2').replace('role-to-assume: arn:aws:iam::123456789012:role/release', 'client-id: fixed-client');
  assert.equal(has(text, 'ci-oidc-cloud-action-mutable'), true);
});

test('blocks mutable Google federation action', () => {
  const text = safeAws.replace(aws, 'google-github-actions/auth@v2').replace('role-to-assume: arn:aws:iam::123456789012:role/release', 'workload_identity_provider: projects/123/locations/global/workloadIdentityPools/release/providers/github');
  assert.equal(has(text, 'ci-oidc-cloud-action-mutable'), true);
});

test('accepts immutable Azure federation action', () => {
  const text = safeAws.replace(aws, azure).replace('role-to-assume: arn:aws:iam::123456789012:role/release', 'client-id: fixed-client');
  assert.equal(has(text, 'ci-oidc-cloud-action-mutable'), false);
});

test('accepts immutable Google federation action', () => {
  const text = safeAws.replace(aws, google).replace('role-to-assume: arn:aws:iam::123456789012:role/release', 'workload_identity_provider: projects/123/locations/global/workloadIdentityPools/release/providers/github');
  assert.equal(has(text, 'ci-oidc-cloud-action-mutable'), false);
});

test('blocks pull_request_target combined with id-token write', () => {
  const text = workflow({ trigger: 'pull_request_target:', environment: 'production' });
  assert.equal(has(text, 'ci-oidc-pr-target-privilege'), true);
});

test('does not flag ordinary push as pull_request_target privilege', () => {
  assert.equal(has(safeAws, 'ci-oidc-pr-target-privilege'), false);
});

test('flags issue_comment trigger sharing OIDC privilege', () => {
  const text = workflow({ trigger: 'issue_comment:', environment: 'production' });
  assert.equal(has(text, 'ci-oidc-untrusted-event-trigger'), true);
});

test('flags pull_request_review trigger sharing OIDC privilege', () => {
  const text = workflow({ trigger: 'pull_request_review:', environment: 'production' });
  assert.equal(has(text, 'ci-oidc-untrusted-event-trigger'), true);
});

test('flags discussion trigger sharing OIDC privilege', () => {
  const text = workflow({ trigger: 'discussion:', environment: 'production' });
  assert.equal(has(text, 'ci-oidc-untrusted-event-trigger'), true);
});

test('requires fixed environment for externally triggerable cloud login', () => {
  const text = workflow({ trigger: 'pull_request:' });
  assert.equal(has(text, 'ci-oidc-cloud-login-without-environment'), true);
});

test('fixed environment removes missing-environment finding', () => {
  const text = workflow({ trigger: 'pull_request:', environment: 'production' });
  assert.equal(has(text, 'ci-oidc-cloud-login-without-environment'), false);
});

test('blocks dynamic environment in OIDC privileged job', () => {
  const text = workflow({ environment: '${{ inputs.environment }}' });
  assert.equal(has(text, 'ci-oidc-dynamic-environment'), true);
});

test('blocks event-derived dynamic environment', () => {
  const text = workflow({ environment: '${{ github.event.deployment.environment }}' });
  assert.equal(has(text, 'ci-oidc-dynamic-environment'), true);
});

test('blocks PR-head checkout in OIDC privileged job', () => {
  const steps = `      - uses: ${checkout}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n          persist-credentials: false\n      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n`;
  const text = workflow({ trigger: 'pull_request_target:', environment: 'production', steps });
  assert.equal(has(text, 'ci-oidc-untrusted-checkout'), true);
});

test('blocks head_ref checkout in OIDC privileged job', () => {
  const steps = `      - uses: ${checkout}\n        with:\n          ref: \${{ github.head_ref }}\n          persist-credentials: false\n      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n`;
  assert.equal(has(workflow({ trigger: 'pull_request_target:', environment: 'production', steps }), 'ci-oidc-untrusted-checkout'), true);
});

test('accepts immutable trusted checkout ref for OIDC job', () => {
  const steps = `      - uses: ${checkout}\n        with:\n          ref: ${sha}\n          persist-credentials: false\n      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n`;
  const result = audit(workflow({ environment: 'production', steps }));
  assert.equal(result.findings.some(item => item.id === 'ci-oidc-untrusted-checkout'), false);
  assert.equal(result.findings.some(item => item.id === 'ci-oidc-checkout-credentials-persisted'), false);
});

test('requires persist-credentials false for checkout in OIDC job', () => {
  const steps = `      - uses: ${checkout}\n      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n`;
  assert.equal(has(workflow({ environment: 'production', steps }), 'ci-oidc-checkout-credentials-persisted'), true);
});

test('explicit persist-credentials false is accepted', () => {
  const steps = `      - uses: ${checkout}\n        with:\n          persist-credentials: false\n      - uses: ${aws}\n        with:\n          role-to-assume: arn:aws:iam::123456789012:role/release\n`;
  assert.equal(has(workflow({ environment: 'production', steps }), 'ci-oidc-checkout-credentials-persisted'), false);
});

test('blocks PR-controlled AWS role identity', () => {
  const text = safeAws.replace('arn:aws:iam::123456789012:role/release', '${{ github.event.pull_request.title }}');
  assert.equal(has(text, 'ci-oidc-untrusted-cloud-identity'), true);
});

test('blocks dispatch-input AWS role identity', () => {
  const text = safeAws.replace('arn:aws:iam::123456789012:role/release', '${{ inputs.role }}');
  assert.equal(has(text, 'ci-oidc-untrusted-cloud-identity'), true);
});

test('blocks event-derived Azure client identity', () => {
  const text = safeAws.replace(aws, azure).replace('role-to-assume: arn:aws:iam::123456789012:role/release', 'client-id: ${{ github.event.issue.title }}');
  assert.equal(has(text, 'ci-oidc-untrusted-cloud-identity'), true);
});

test('blocks event-derived Google provider identity', () => {
  const text = safeAws.replace(aws, google).replace('role-to-assume: arn:aws:iam::123456789012:role/release', 'workload_identity_provider: ${{ github.event.comment.body }}');
  assert.equal(has(text, 'ci-oidc-untrusted-cloud-identity'), true);
});

test('accepts fixed cloud role identity', () => {
  assert.equal(has(safeAws, 'ci-oidc-untrusted-cloud-identity'), false);
});

test('blocks mutable build provenance attestation action', () => {
  const steps = `      - uses: actions/attest-build-provenance@v2\n        with:\n          subject-path: dist/app.tgz\n`;
  const text = workflow({ permissions: 'permissions:\n  contents: read\n  id-token: write\n  attestations: write', environment: 'production', steps });
  assert.equal(has(text, 'ci-oidc-attestation-action-mutable'), true);
});

test('accepts immutable build provenance attestation action', () => {
  const steps = `      - uses: ${attest}\n        with:\n          subject-path: dist/app.tgz\n`;
  const text = workflow({ permissions: 'permissions:\n  contents: read\n  id-token: write\n  attestations: write', environment: 'production', steps });
  assert.equal(has(text, 'ci-oidc-attestation-action-mutable'), false);
  assert.equal(audit(text).summary.workflows[0]?.provenanceSteps, 1);
});

test('manual dispatch with OIDC and write permission receives review finding', () => {
  const text = `name: deploy\non:\n  workflow_dispatch:\n    inputs:\n      tag:\n        required: true\npermissions:\n  contents: write\n  id-token: write\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: echo "\${{ inputs.tag }}"\n`;
  const result = audit(text);
  const item = result.findings.find(finding => finding.id === 'ci-oidc-dispatch-input-privilege-review');
  assert.equal(item?.severity, 'medium');
  assert.equal(item?.blocking, false);
});

test('manual dispatch without repository/package/attestation write does not get review finding', () => {
  const text = `name: inspect\non:\n  workflow_dispatch:\n    inputs:\n      tag:\n        required: true\npermissions:\n  contents: read\n  id-token: write\njobs:\n  inspect:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: echo "\${{ inputs.tag }}"\n`;
  assert.equal(has(text, 'ci-oidc-dispatch-input-privilege-review'), false);
});

test('non-OIDC workflow is not treated as privileged federation', () => {
  const text = `name: test\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${checkout}\n`;
  const result = audit(text);
  assert.equal(result.summary.privilegedWorkflows, 0);
  assert.equal(result.findings.some(item => item.id.startsWith('ci-oidc-checkout')), false);
});

test('finding ordering is deterministic across multiple risky jobs', () => {
  const text = `name: deploy\non:\n  pull_request_target:\npermissions:\n  contents: write\n  id-token: write\njobs:\n  first:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v5\n        with:\n          role-to-assume: \${{ github.event.pull_request.title }}\n  second:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: azure/login@v2\n        with:\n          client-id: \${{ github.event.pull_request.body }}\n`;
  const first = audit(text).findings.map(item => `${item.location?.line}:${item.id}`);
  const second = audit(text).findings.map(item => `${item.location?.line}:${item.id}`);
  assert.deepEqual(first, second);
});

test('CRLF workflows retain valid line locations', () => {
  const text = workflow({ trigger: 'pull_request_target:', environment: 'production' }).replaceAll('\n', '\r\n');
  const item = audit(text).findings.find(finding => finding.id === 'ci-oidc-pr-target-privilege');
  assert.ok((item?.location?.line ?? 0) >= 1);
});

test('summary findings mirrors section findings', () => {
  const result = audit(workflow({ trigger: 'pull_request_target:', environment: 'production' }));
  assert.deepEqual(result.summary.findings, result.findings);
});
