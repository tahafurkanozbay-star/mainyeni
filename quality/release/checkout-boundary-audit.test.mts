import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCheckoutBoundaries } from './checkout-boundary-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

function audit(text: string) {
  return auditCheckoutBoundaries(fixtureInventory([
    { path: '.github/workflows/checkout.yml', text },
  ]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(item => item.id);
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('trusted push checkout with default source selection is not a provenance finding', () => {
  const result = ids(`on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
`);
  assert.equal(result.length, 0);
});

test('pull request checkout must disable persisted credentials', () => {
  const result = finding(`on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
`, 'ci-checkout-external-credentials-persist');
  assert.equal(result?.severity, 'high');
});

test('pull request checkout with persist-credentials false clears persistence finding', () => {
  const result = ids(`on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          persist-credentials: false
`);
  assert.equal(result.includes('ci-checkout-external-credentials-persist'), false);
});

test('event-controlled repository identity is blocking', () => {
  const result = finding(`on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          persist-credentials: false
`, 'ci-checkout-dynamic-repository');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('github.repository is accepted as trusted repository identity', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          repository: \${{ github.repository }}
`);
  assert.equal(result.includes('ci-checkout-dynamic-repository'), false);
});

test('github.sha is accepted as trusted immutable checkout ref', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ github.sha }}
`);
  assert.equal(result.includes('ci-checkout-untrusted-ref'), false);
  assert.equal(result.includes('ci-checkout-upstream-ref-review'), false);
});

test('event-controlled ref with secret credential is blocking', () => {
  const result = finding(`on:
  pull_request_target:
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          token: \${{ secrets.RELEASE_TOKEN }}
          persist-credentials: false
`, 'ci-checkout-untrusted-ref');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('caller input ref without privilege remains high review', () => {
  const result = finding(`on:
  workflow_dispatch:
    inputs:
      ref:
        required: true
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ inputs.ref }}
          persist-credentials: false
`, 'ci-checkout-untrusted-ref');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('upstream-computed ref is visible as provenance review', () => {
  const result = finding(`on: push
jobs:
  plan:
    runs-on: ubuntu-24.04
    outputs:
      ref: \${{ steps.plan.outputs.ref }}
    steps:
      - id: plan
        run: echo "ref=abc" >> "$GITHUB_OUTPUT"
  build:
    needs: plan
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ needs.plan.outputs.ref }}
`, 'ci-checkout-upstream-ref-review');
  assert.equal(result?.severity, 'medium');
});

test('event-controlled checkout path is high severity', () => {
  const result = finding(`on:
  issue_comment:
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          path: \${{ github.event.comment.id }}
          persist-credentials: false
`, 'ci-checkout-dynamic-path');
  assert.equal(result?.severity, 'high');
});

test('explicit secret token on external checkout is blocking', () => {
  const result = finding(`on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          token: \${{ secrets.RELEASE_TOKEN }}
          persist-credentials: false
`, 'ci-checkout-external-secret-credential');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('explicit ssh key on external checkout is blocking', () => {
  const result = finding(`on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ssh-key: \${{ secrets.DEPLOY_KEY }}
          persist-credentials: false
`, 'ci-checkout-external-secret-credential');
  assert.equal(result?.severity, 'critical');
});

test('external recursive submodules are high without privilege', () => {
  const result = finding(`on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          submodules: recursive
          persist-credentials: false
`, 'ci-checkout-external-submodules');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('external recursive submodules with secret credential are blocking', () => {
  const result = finding(`on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          submodules: true
          token: \${{ secrets.SUBMODULE_TOKEN }}
          persist-credentials: false
`, 'ci-checkout-external-submodules');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('self-hosted external checkout cannot disable clean', () => {
  const result = finding(`on:
  pull_request:
jobs:
  test:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          clean: false
          persist-credentials: false
`, 'ci-checkout-self-hosted-clean-disabled');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('trusted self-hosted checkout with clean false is high review', () => {
  const result = finding(`on:
  workflow_dispatch:
jobs:
  deploy:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          clean: false
`, 'ci-checkout-self-hosted-clean-disabled');
  assert.equal(result?.severity, 'high');
});

test('ambiguous literal branch ref is visible as reproducibility finding', () => {
  const result = finding(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: main
`, 'ci-checkout-mutable-literal-ref');
  assert.equal(result?.severity, 'low');
});

test('full commit SHA literal is accepted', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: 0123456789012345678901234567890123456789
`);
  assert.equal(result.includes('ci-checkout-mutable-literal-ref'), false);
});

test('checkout parser keeps fields scoped to with block', () => {
  const result = ids(`on: push
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ github.sha }}
        env:
          REF: \${{ github.event.issue.title }}
`);
  assert.equal(result.includes('ci-checkout-untrusted-ref'), false);
});

test('checkout summary reports dynamic and credentialed counts', () => {
  const section = audit(`on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          ref: \${{ github.event.pull_request.head.sha }}
`);
  assert.equal(section.summary.checkoutSteps, 1);
  assert.equal(section.summary.dynamicRepositorySteps, 1);
  assert.equal(section.summary.dynamicRefSteps, 1);
  assert.equal(section.summary.credentialedExternalSteps, 1);
});

test('checkout audit is stable across LF and CRLF', () => {
  const source = `on:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          persist-credentials: false
          ref: \${{ github.event.pull_request.head.sha }}
`;
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.blocking ?? false]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.blocking ?? false]);
  assert.deepEqual(lf, crlf);
});
