import assert from 'node:assert/strict';
import test from 'node:test';
import { auditWorkflowAuthority } from './workflow-authority-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const DOWNLOAD_SHA = '95815c38cf2ff2164869cbab79da8d1f422bc89e';

function audit(text: string) {
  return auditWorkflowAuthority(fixtureInventory([
    { path: '.github/workflows/security.yml', text },
  ]));
}

function ids(text: string): string[] {
  return audit(text).findings.map(finding => finding.id);
}

function finding(text: string, id: string) {
  return audit(text).findings.find(item => item.id === id);
}

test('pull request checkout with inherited write permission is blocking', () => {
  const result = finding(`on:
  pull_request:
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
      - run: npm test
`, 'ci-external-checkout-write-authority');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('job-level read-only permissions suppress inherited write authority', () => {
  const result = ids(`on:
  pull_request:
permissions:
  contents: write
jobs:
  test:
    permissions:
      contents: read
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
      - run: npm test
`);
  assert.equal(result.includes('ci-external-checkout-write-authority'), false);
  assert.equal(result.includes('ci-external-write-authority-review'), false);
});

test('pull request metadata-only write job is reviewable rather than a checkout blocker', () => {
  const result = finding(`on:
  pull_request:
permissions:
  pull-requests: write
jobs:
  label:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/github-script@0123456789012345678901234567890123456789
`, 'ci-external-write-authority-review');
  assert.ok(result);
  assert.equal(result?.blocking, undefined);
});

test('protected environment downgrades external checkout write finding from blocker to high review', () => {
  const result = finding(`on:
  pull_request:
permissions:
  contents: write
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
`, 'ci-external-checkout-write-authority');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('workflow-level secret env makes external shell job a critical secret context', () => {
  const result = finding(`on:
  issue_comment:
env:
  RELEASE_TOKEN: \${{ secrets.RELEASE_TOKEN }}
jobs:
  command:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ github.event.comment.body }}
`, 'ci-external-secret-context');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('secret-bearing metadata-only external job remains a high review finding', () => {
  const result = finding(`on:
  issues:
jobs:
  notify:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.NOTIFY_TOKEN }}
    steps:
      - uses: owner/metadata-action@0123456789012345678901234567890123456789
`, 'ci-external-secret-context');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('trusted push workflow does not trigger external contribution authority findings', () => {
  const result = ids(`on:
  push:
    branches: [main]
permissions:
  contents: write
jobs:
  publish:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.RELEASE_TOKEN }}
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
      - run: echo publish
`);
  assert.equal(result.includes('ci-external-checkout-write-authority'), false);
  assert.equal(result.includes('ci-external-secret-context'), false);
});

test('privileged workflow_run head checkout is always blocking', () => {
  const result = finding(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: write
jobs:
  promote:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
      - run: npm run publish
`, 'ci-workflow-run-privileged-head-checkout');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('workflow_run head checkout without privilege does not produce privileged-head finding', () => {
  const result = ids(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
      - run: npm test
`);
  assert.equal(result.includes('ci-workflow-run-privileged-head-checkout'), false);
});

test('privileged workflow_run artifact consumption without provenance guard blocks', () => {
  const result = finding(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: write
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          run-id: \${{ github.event.workflow_run.id }}
      - run: ./artifact/publish.sh
`, 'ci-workflow-run-privileged-artifact-consumption');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('workflow_run artifact consumption with repository and branch guards remains high review', () => {
  const result = finding(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  contents: write
jobs:
  publish:
    if: github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == 'main'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@${DOWNLOAD_SHA}
        with:
          run-id: \${{ github.event.workflow_run.id }}
      - run: ./artifact/publish.sh
`, 'ci-workflow-run-privileged-artifact-consumption');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('guarded privileged workflow_run does not emit missing-trust-guard finding', () => {
  const result = ids(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  deployments: write
jobs:
  deploy:
    if: github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == 'main'
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - run: echo trusted
`);
  assert.equal(result.includes('ci-workflow-run-privilege-trust-guard-missing'), false);
});

test('unguarded privileged workflow_run emits trust guard review', () => {
  const result = finding(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  deployments: write
jobs:
  deploy:
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`, 'ci-workflow-run-privilege-trust-guard-missing');
  assert.ok(result);
});

test('fork false plus literal branch comparison satisfies workflow_run provenance guards', () => {
  const result = ids(`on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  deployments: write
jobs:
  deploy:
    if: github.event.workflow_run.head_repository.fork == false && github.event.workflow_run.head_branch == 'release'
    environment: production
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`);
  assert.equal(result.includes('ci-workflow-run-privilege-trust-guard-missing'), false);
});

test('repository dispatch payload in checkout ref blocks privileged job', () => {
  const result = finding(`on:
  repository_dispatch:
    types: [promote]
permissions:
  contents: write
jobs:
  promote:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
        with:
          ref: \${{ github.event.client_payload.ref }}
`, 'ci-repository-dispatch-payload-privilege');
  assert.equal(result?.severity, 'critical');
  assert.equal(result?.blocking, true);
});

test('repository dispatch payload without privilege is not an authority finding', () => {
  const result = ids(`on:
  repository_dispatch:
    types: [inspect]
permissions:
  contents: read
jobs:
  inspect:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ github.event.client_payload.name }}
`);
  assert.equal(result.includes('ci-repository-dispatch-payload-privilege'), false);
  assert.equal(result.includes('ci-repository-dispatch-payload-review'), false);
});

test('repository dispatch payload with privileged non-executable use is a high review finding', () => {
  const result = finding(`on:
  repository_dispatch:
    types: [notify]
permissions:
  issues: write
jobs:
  notify:
    runs-on: ubuntu-24.04
    env:
      REQUEST_ID: \${{ github.event.client_payload.request_id }}
    steps:
      - uses: owner/notify-action@0123456789012345678901234567890123456789
`, 'ci-repository-dispatch-payload-review');
  assert.equal(result?.severity, 'high');
  assert.equal(result?.blocking, undefined);
});

test('workflow call privilege alone is not treated as an external trigger', () => {
  const result = ids(`on:
  workflow_call:
    secrets:
      TOKEN:
        required: true
permissions:
  contents: write
jobs:
  publish:
    runs-on: ubuntu-24.04
    env:
      TOKEN: \${{ secrets.TOKEN }}
    steps:
      - run: echo publish
`);
  assert.equal(result.length, 0);
});

test('summary counts effective inherited privilege', () => {
  const section = audit(`on:
  pull_request:
permissions:
  contents: write
jobs:
  one:
    runs-on: ubuntu-24.04
  two:
    permissions:
      contents: read
    runs-on: ubuntu-24.04
`);
  assert.equal(section.summary.jobs, 2);
  assert.equal(section.summary.privilegedJobs, 1);
  assert.equal(section.summary.externalPrivilegedJobs, 1);
});

test('audit is stable across LF and CRLF workflow text', () => {
  const source = `on:
  pull_request:
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA}
`;
  const lf = audit(source).findings.map(item => [item.id, item.severity, item.blocking ?? false]);
  const crlf = audit(source.replace(/\n/g, '\r\n')).findings.map(item => [item.id, item.severity, item.blocking ?? false]);
  assert.deepEqual(lf, crlf);
});
