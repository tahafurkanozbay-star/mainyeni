import assert from 'node:assert/strict';
import test from 'node:test';
import { auditActionCredentialBoundaries } from './action-credential-boundary-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const sha = '0123456789abcdef0123456789abcdef01234567';

function audit(text: string) {
  return auditActionCredentialBoundaries(fixtureInventory([{ path: '.github/workflows/ci.yml', text }]));
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

function workflow(options: {
  action: string;
  event?: string;
  workflowEnv?: string;
  jobEnv?: string;
  stepBody?: string;
}) {
  const event = options.event ?? 'push';
  const workflowEnv = options.workflowEnv ? `env:\n${options.workflowEnv}\n` : '';
  const jobEnv = options.jobEnv ? `    env:\n${options.jobEnv}\n` : '';
  const stepBody = options.stepBody ? `\n${options.stepBody}` : '';
  return `name: Credential boundary
on: [${event}]
permissions:
  contents: read
${workflowEnv}jobs:
  verify:
${jobEnv}    runs-on: ubuntu-24.04
    steps:
      - uses: ${options.action}${stepBody}
`;
}

const secretInput = '        with:\n          token: ${{ secrets.RELEASE_TOKEN }}';
const githubTokenInput = '        with:\n          github-token: ${{ github.token }}';
const safeInput = '        with:\n          mode: inspect';

test('pinned third-party action with secret input requires high review', () => {
  const current = finding(workflow({ action: `vendor/release@${sha}`, stepBody: secretInput }), 'ci-action-third-party-credential-review');
  assert.equal(current?.severity, 'high');
  assert.equal(current?.blocking, undefined);
});

test('mutable third-party action with secret input is blocking', () => {
  const current = finding(workflow({ action: 'vendor/release@v2', stepBody: secretInput }), 'ci-action-mutable-credential-exposure');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('mutable third-party branch with github token is blocking', () => {
  assert.ok(finding(workflow({ action: 'vendor/release@main', stepBody: githubTokenInput }), 'ci-action-mutable-credential-exposure'));
});

test('external pinned third-party action receiving secret is blocking', () => {
  const current = finding(workflow({ action: `vendor/release@${sha}`, event: 'pull_request_target', stepBody: secretInput }), 'ci-action-external-third-party-credential');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('external mutable credential action emits both independent blockers', () => {
  const ids = audit(workflow({ action: 'vendor/release@v2', event: 'pull_request_target', stepBody: secretInput })).findings.map(item => item.id);
  assert.ok(ids.includes('ci-action-mutable-credential-exposure'));
  assert.ok(ids.includes('ci-action-external-third-party-credential'));
});

test('pinned credential-free third-party action is clean in this audit', () => {
  assert.deepEqual(audit(workflow({ action: `vendor/read-only@${sha}`, stepBody: safeInput })).findings, []);
});

test('mutable credential-free action is delegated to generic provenance audit', () => {
  const result = audit(workflow({ action: 'vendor/read-only@v1', stepBody: safeInput }));
  assert.equal(result.findings.some(item => item.id === 'ci-action-mutable-credential-exposure'), false);
});

test('pinned actions checkout is classified first party', () => {
  const result = audit(workflow({
    action: `actions/checkout@${sha}`,
    stepBody: '        with:\n          token: ${{ secrets.CHECKOUT_TOKEN }}\n          persist-credentials: false',
  }));
  assert.equal(result.summary.signals[0]?.firstParty, true);
  assert.equal(result.findings.some(item => item.id === 'ci-action-third-party-credential-review'), false);
});

test('mutable official credential action remains high supply-chain review', () => {
  const current = finding(workflow({ action: 'actions/checkout@v7', stepBody: secretInput }), 'ci-action-official-credential-mutable-ref');
  assert.equal(current?.severity, 'high');
});

test('github-owned pinned action is first party', () => {
  const result = audit(workflow({ action: `github/codeql-action/analyze@${sha}`, stepBody: secretInput }));
  assert.equal(result.summary.signals[0]?.firstParty, true);
});

test('workflow-level secret environment reaches third-party action', () => {
  const current = finding(workflow({
    action: `vendor/release@${sha}`,
    workflowEnv: '  RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}',
    stepBody: safeInput,
  }), 'ci-action-third-party-inherited-secret-env');
  assert.equal(current?.severity, 'high');
});

test('job-level secret environment reaches third-party action', () => {
  assert.ok(finding(workflow({
    action: `vendor/release@${sha}`,
    jobEnv: '      RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}',
    stepBody: safeInput,
  }), 'ci-action-third-party-inherited-secret-env'));
});

test('external inherited secret environment escalates to blocking', () => {
  const current = finding(workflow({
    action: `vendor/inspect@${sha}`,
    event: 'pull_request_target',
    workflowEnv: '  RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-action-third-party-inherited-secret-env');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('external first-party action still exposes inherited secret environment risk', () => {
  const current = finding(workflow({
    action: `actions/checkout@${sha}`,
    event: 'pull_request_target',
    workflowEnv: '  TOKEN: ${{ secrets.CHECKOUT_TOKEN }}',
    stepBody: '        with:\n          persist-credentials: false',
  }), 'ci-action-external-inherited-secret-env');
  assert.equal(current?.severity, 'high');
});

test('step-level env secret is direct credential exposure', () => {
  const current = finding(workflow({
    action: `vendor/release@${sha}`,
    stepBody: '        env:\n          RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}',
  }), 'ci-action-third-party-credential-review');
  assert.equal(current?.severity, 'high');
});

test('github token expression is counted separately', () => {
  const result = audit(workflow({ action: `vendor/release@${sha}`, stepBody: githubTokenInput }));
  assert.equal(result.summary.signals[0]?.directTokenInputs, 1);
});

test('secrets GITHUB_TOKEN counts as token and secret', () => {
  const result = audit(workflow({
    action: `vendor/release@${sha}`,
    stepBody: '        with:\n          token: ${{ secrets.GITHUB_TOKEN }}',
  }));
  assert.equal(result.summary.signals[0]?.directTokenInputs, 1);
  assert.equal(result.summary.signals[0]?.directSecretInputs, 1);
});

test('multiple secret inputs are counted deterministically', () => {
  const result = audit(workflow({
    action: `vendor/release@${sha}`,
    stepBody: '        with:\n          token: ${{ secrets.RELEASE_TOKEN }}\n          api-key: ${{ secrets.RELEASE_KEY }}',
  }));
  assert.equal(result.summary.signals[0]?.directSecretInputs, 2);
});

for (const [name, body] of [
  ['inputs token', '        with:\n          token: ${{ inputs.token }}'],
  ['vars api key', '        with:\n          api-key: ${{ vars.API_KEY }}'],
  ['event access token', '        with:\n          access-token: ${{ github.event.pull_request.title }}'],
] as const) {
  test(`credential-shaped ${name} is high-risk non-secret input`, () => {
    const current = finding(workflow({ action: `vendor/release@${sha}`, event: 'pull_request_target', stepBody: body }), 'ci-action-credential-shaped-untrusted-input');
    assert.equal(current?.severity, 'high');
  });
}

test('ordinary caller input does not become credential-shaped finding', () => {
  const result = audit(workflow({
    action: `vendor/release@${sha}`,
    stepBody: '        with:\n          release-name: ${{ inputs.name }}',
  }));
  assert.equal(result.findings.some(item => item.id === 'ci-action-credential-shaped-untrusted-input'), false);
});

test('password-shaped literal is still credential-bearing review', () => {
  const result = audit(workflow({
    action: `vendor/release@${sha}`,
    stepBody: '        with:\n          password: placeholder',
  }));
  assert.equal(result.summary.signals[0]?.customTokenInput, true);
  assert.ok(result.findings.some(item => item.id === 'ci-action-third-party-credential-review'));
});

test('local action is outside remote third-party boundary', () => {
  const result = audit(workflow({ action: './.github/actions/release', stepBody: secretInput }));
  assert.equal(result.summary.remoteActionSteps, 0);
});

test('docker action remains delegated to container boundary audit', () => {
  const result = audit(workflow({ action: `docker://alpine@sha256:${'a'.repeat(64)}`, stepBody: secretInput }));
  assert.equal(result.summary.remoteActionSteps, 0);
});

test('nested action-looking input does not create a second action signal', () => {
  const result = audit(workflow({
    action: `vendor/wrapper@${sha}`,
    stepBody: '        with:\n          nested-action: evil/action@v1\n          mode: inspect',
  }));
  assert.equal(result.summary.remoteActionSteps, 1);
  assert.equal(result.summary.signals[0]?.action, `vendor/wrapper@${sha}`);
});

test('quoted pinned action remains immutable', () => {
  const result = audit(workflow({ action: `"vendor/release@${sha}"`, stepBody: secretInput }));
  assert.equal(result.summary.signals[0]?.immutable, true);
});

test('summary partitions first-party and third-party action steps', () => {
  const source = `name: Summary
on: [push]
jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - uses: vendor/read-only@${sha}
        with:
          mode: inspect
`;
  const result = audit(source);
  assert.equal(result.summary.remoteActionSteps, 2);
  assert.equal(result.summary.thirdPartyActionSteps, 1);
});

test('summary counts credential-bearing and external credential-bearing steps', () => {
  const result = audit(workflow({ action: `vendor/release@${sha}`, event: 'pull_request_target', stepBody: secretInput }));
  assert.equal(result.summary.credentialBearingActionSteps, 1);
  assert.equal(result.summary.externalCredentialBearingSteps, 1);
});

test('finding location anchors to uses line', () => {
  const current = finding(workflow({ action: `vendor/release@${sha}`, stepBody: secretInput }), 'ci-action-third-party-credential-review');
  assert.ok((current?.location?.line ?? 0) >= 7);
});

test('LF and CRLF preserve finding ids and locations', () => {
  const source = workflow({ action: `vendor/release@${sha}`, event: 'pull_request_target', stepBody: secretInput });
  const lf = audit(source).findings.map(item => [item.id, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.location?.line]);
  assert.deepEqual(crlf, lf);
});

test('repeated audits are deterministic', () => {
  const source = workflow({ action: 'vendor/release@v2', event: 'pull_request_target', stepBody: secretInput });
  const first = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  const second = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  assert.deepEqual(second, first);
});
