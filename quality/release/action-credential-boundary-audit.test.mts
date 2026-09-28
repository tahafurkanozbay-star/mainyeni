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

function trusted(action: string, body = 'with:\n          token: ${{ secrets.RELEASE_TOKEN }}') {
  return `name: Release
on: [push]
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${action}
        ${body}
`;
}

function external(action: string, body = 'with:\n          token: ${{ secrets.RELEASE_TOKEN }}') {
  return `name: PR
on: [pull_request_target]
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${action}
        ${body}
`;
}

test('pinned third-party action with secret input is high review', () => {
  const current = finding(trusted(`vendor/release@${sha}`), 'ci-action-third-party-credential-review');
  assert.equal(current?.severity, 'high');
  assert.equal(current?.blocking, undefined);
});

test('mutable third-party action with secret input is blocking', () => {
  const current = finding(trusted('vendor/release@v2'), 'ci-action-mutable-credential-exposure');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('mutable third-party branch with GitHub token is blocking', () => {
  assert.ok(finding(trusted('vendor/release@main', 'with:\n          github-token: ${{ github.token }}'), 'ci-action-mutable-credential-exposure'));
});

test('external pinned third-party action with secret input is blocking', () => {
  const current = finding(external(`vendor/release@${sha}`), 'ci-action-external-third-party-credential');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('external mutable third-party action produces both supply-chain and event findings', () => {
  const ids = audit(external('vendor/release@v2')).findings.map(item => item.id);
  assert.ok(ids.includes('ci-action-mutable-credential-exposure'));
  assert.ok(ids.includes('ci-action-external-third-party-credential'));
});

test('pinned third-party action without credentials is clean', () => {
  const result = audit(trusted(`vendor/read-only@${sha}`, 'with:\n          mode: inspect'));
  assert.equal(result.findings.length, 0);
});

test('mutable third-party action without credentials is left to generic provenance audit', () => {
  const result = audit(trusted('vendor/read-only@v1', 'with:\n          mode: inspect'));
  assert.equal(result.findings.some(item => item.id === 'ci-action-mutable-credential-exposure'), false);
});

test('official pinned checkout does not trigger third-party review', () => {
  const result = audit(`name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${sha}
        with:
          token: ${{ secrets.CHECKOUT_TOKEN }}
          persist-credentials: false
`);
  assert.equal(result.findings.some(item => item.id === 'ci-action-third-party-credential-review'), false);
});

test('official mutable credential-bearing action is high review', () => {
  const current = finding(`name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          token: ${{ secrets.CHECKOUT_TOKEN }}
`, 'ci-action-official-credential-mutable-ref');
  assert.equal(current?.severity, 'high');
});

test('github-owned pinned action is classified first party', () => {
  const result = audit(`name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: github/codeql-action/analyze@${sha}
        env:
          TOKEN: ${{ secrets.CODEQL_TOKEN }}
`);
  assert.equal(result.summary.signals[0]?.firstParty, true);
  assert.equal(result.findings.some(item => item.id === 'ci-action-third-party-credential-review'), false);
});

test('workflow-level secret env is inherited by third-party action', () => {
  const current = finding(`name: Release
on: [push]
env:
  RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/release@${sha}
        with:
          mode: publish
`, 'ci-action-third-party-inherited-secret-env');
  assert.equal(current?.severity, 'high');
});

test('job-level secret env is inherited by third-party action', () => {
  assert.ok(finding(`name: Release
on: [push]
jobs:
  release:
    env:
      RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/release@${sha}
        with:
          mode: publish
`, 'ci-action-third-party-inherited-secret-env'));
});

test('external inherited secret env escalates to blocking', () => {
  const current = finding(`name: PR
on: [pull_request_target]
env:
  RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/inspect@${sha}
`, 'ci-action-third-party-inherited-secret-env');
  assert.equal(current?.severity, 'critical');
  assert.equal(current?.blocking, true);
});

test('external first-party action with inherited secret env remains visible', () => {
  const current = finding(`name: PR
on: [pull_request_target]
env:
  TOKEN: ${{ secrets.CHECKOUT_TOKEN }}
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
`, 'ci-action-external-inherited-secret-env');
  assert.equal(current?.severity, 'high');
});

test('job secret used only in a shell step does not mark unrelated action as direct secret input', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/read-only@${sha}
        with:
          mode: inspect
      - run: echo "$TOKEN"
        env:
          TOKEN: ${{ secrets.RELEASE_TOKEN }}
`);
  assert.equal(result.summary.signals[0]?.directSecretInputs, 0);
  assert.equal(result.summary.signals[0]?.inheritedSecretEnv, false);
  assert.equal(result.findings.length, 0);
});

test('step env secret is direct credential exposure to action process', () => {
  const current = finding(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/release@${sha}
        env:
          RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}
`, 'ci-action-third-party-credential-review');
  assert.equal(current?.severity, 'high');
});

test('GitHub token expression is counted as a direct token input', () => {
  const result = audit(trusted(`vendor/release@${sha}`, 'with:\n          github-token: ${{ github.token }}'));
  assert.equal(result.summary.signals[0]?.directTokenInputs, 1);
});

test('secrets.GITHUB_TOKEN is counted as token and secret input', () => {
  const result = audit(trusted(`vendor/release@${sha}`, 'with:\n          token: ${{ secrets.GITHUB_TOKEN }}'));
  assert.equal(result.summary.signals[0]?.directTokenInputs, 1);
  assert.equal(result.summary.signals[0]?.directSecretInputs, 1);
});

test('multiple secret inputs are counted deterministically', () => {
  const result = audit(trusted(`vendor/release@${sha}`, `with:
          token: ${{ secrets.RELEASE_TOKEN }}
          api-key: ${{ secrets.RELEASE_KEY }}
          mode: publish`));
  assert.equal(result.summary.signals[0]?.directSecretInputs, 2);
});

test('credential-shaped input sourced from workflow input is high risk', () => {
  const current = finding(trusted(`vendor/release@${sha}`, 'with:\n          token: ${{ inputs.token }}'), 'ci-action-credential-shaped-untrusted-input');
  assert.equal(current?.severity, 'high');
});

test('credential-shaped input sourced from vars is high risk', () => {
  assert.ok(finding(trusted(`vendor/release@${sha}`, 'with:\n          api-key: ${{ vars.API_KEY }}'), 'ci-action-credential-shaped-untrusted-input'));
});

test('credential-shaped input sourced from event data is high risk', () => {
  assert.ok(finding(external(`vendor/release@${sha}`, 'with:\n          access-token: ${{ github.event.pull_request.title }}'), 'ci-action-credential-shaped-untrusted-input'));
});

test('ordinary non-credential input from workflow input is not credential finding', () => {
  const result = audit(trusted(`vendor/release@${sha}`, 'with:\n          release-name: ${{ inputs.name }}'));
  assert.equal(result.findings.some(item => item.id === 'ci-action-credential-shaped-untrusted-input'), false);
});

test('password-shaped key with literal placeholder is treated as credential-bearing review', () => {
  const result = audit(trusted(`vendor/release@${sha}`, 'with:\n          password: placeholder'));
  assert.equal(result.summary.signals[0]?.customTokenInput, true);
  assert.ok(result.findings.some(item => item.id === 'ci-action-third-party-credential-review'));
});

test('local action with secret input is outside third-party action audit', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/release
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
`);
  assert.equal(result.summary.remoteActionSteps, 0);
  assert.equal(result.findings.length, 0);
});

test('docker action is handled by container provenance audit instead', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: docker://alpine@sha256:${'a'.repeat(64)}
        env:
          TOKEN: ${{ secrets.RELEASE_TOKEN }}
`);
  assert.equal(result.summary.remoteActionSteps, 0);
});

test('nested with mapping action-looking value does not create extra action signal', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/wrapper@${sha}
        with:
          nested-action: evil/action@v1
          mode: inspect
`);
  assert.equal(result.summary.remoteActionSteps, 1);
  assert.equal(result.summary.signals[0]?.action, `vendor/wrapper@${sha}`);
});

test('quoted SHA pinned action identity remains immutable', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: "vendor/release@${sha}"
        with:
          token: ${{ secrets.RELEASE_TOKEN }}
`);
  assert.equal(result.summary.signals[0]?.immutable, true);
});

test('summary partitions first-party and third-party action counts', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - uses: vendor/release@${sha}
        with:
          mode: inspect
`);
  assert.equal(result.summary.remoteActionSteps, 2);
  assert.equal(result.summary.thirdPartyActionSteps, 1);
});

test('summary counts credential-bearing action steps', () => {
  const result = audit(`name: Release
on: [push]
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: vendor/one@${sha}
        with:
          token: ${{ secrets.ONE }}
      - uses: vendor/two@${sha}
        with:
          mode: inspect
`);
  assert.equal(result.summary.credentialBearingActionSteps, 1);
});

test('summary counts external credential-bearing steps', () => {
  const result = audit(external(`vendor/release@${sha}`));
  assert.equal(result.summary.externalCredentialBearingSteps, 1);
});

test('finding source location points at uses line', () => {
  const current = finding(trusted(`vendor/release@${sha}`), 'ci-action-third-party-credential-review');
  assert.ok((current?.location?.line ?? 0) >= 7);
});

test('LF and CRLF retain identical finding ids and source lines', () => {
  const source = external(`vendor/release@${sha}`);
  const lf = audit(source).findings.map(item => [item.id, item.location?.line]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.location?.line]);
  assert.deepEqual(crlf, lf);
});

test('findings are stable across repeated audits', () => {
  const source = external('vendor/release@v2');
  const first = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  const second = audit(source).findings.map(item => `${item.severity}:${item.id}:${item.location?.line}`);
  assert.deepEqual(second, first);
});
