import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditWorkflowSource, evaluateWorkflowSupplyChain, renderWorkflowSupplyChainMarkdown,
} from './github-workflow-supply-chain.mts';

const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const node = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const workflow = ({ checkoutRef = checkout, nodeRef = node, persist = true,
  permissions = 'contents: read', trigger = 'pull_request' } = {}) => `name: Quality
on:
  ${trigger}:
permissions:
  ${permissions}
jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: ${checkoutRef}
        with:
${persist ? '          persist-credentials: false\n' : ''}      - name: Setup Node
        uses: ${nodeRef}
      - name: Test
        run: node --test
`;
const evaluate = (source = workflow()) =>
  evaluateWorkflowSupplyChain([{ file: '.github/workflows/test.yml', source }]);
const codes = report => report.findings.map(item => item.code);

test('immutable checkout and setup actions pass the contract', () => {
  const report = evaluate();
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.deepEqual(report.summary, { workflows: 1, actions: 2, violations: 0 });
});
test('unpinned checkout major tag is rejected', () => {
  assert.ok(codes(evaluate(workflow({ checkoutRef: 'actions/checkout@v7' })))
    .includes('workflow-action-unpinned'));
});
test('unpinned setup-node major tag is rejected', () => {
  assert.ok(codes(evaluate(workflow({ nodeRef: 'actions/setup-node@v7' })))
    .includes('workflow-action-unpinned'));
});
test('short SHA action references are rejected', () => {
  assert.ok(codes(evaluate(workflow({ nodeRef: 'actions/setup-node@82076278' })))
    .includes('workflow-action-unpinned'));
});
test('mixed-case SHA is rejected to maintain canonical pinning', () => {
  assert.ok(codes(evaluate(workflow({ nodeRef: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe502A' })))
    .includes('workflow-action-unpinned'));
});
test('branch and floating latest action references are rejected', () => {
  for (const ref of ['actions/setup-node@main', 'actions/setup-node@latest']) {
    assert.ok(codes(evaluate(workflow({ nodeRef: ref }))).includes('workflow-action-unpinned'));
  }
});
test('Docker action reference is rejected without a commit SHA', () => {
  assert.ok(codes(evaluate(workflow({ nodeRef: 'docker://alpine:latest' })))
    .includes('workflow-action-unpinned'));
});
test('remote reusable action URLs are rejected', () => {
  assert.ok(codes(evaluate(workflow({ nodeRef: 'https://example.com/action@abc' })))
    .includes('workflow-action-unpinned'));
});
test('checkout must disable persisted credentials', () => {
  assert.ok(codes(evaluate(workflow({ persist: false })))
    .includes('workflow-checkout-credentials'));
});
test('checkout true cannot satisfy the credential policy', () => {
  const source = workflow().replace('persist-credentials: false', 'persist-credentials: true');
  assert.ok(codes(evaluate(source)).includes('workflow-checkout-credentials'));
});
test('checkout credential setting cannot be borrowed from a later step', () => {
  const source = workflow({ persist: false }).replace('        uses: ' + node,
    '        uses: ' + node + '\n        with:\n          persist-credentials: false');
  assert.ok(codes(evaluate(source)).includes('workflow-checkout-credentials'));
});
test('checkout credential setting cannot be borrowed from an earlier step', () => {
  const source = workflow().replace('        uses: ' + node,
    '        uses: ' + checkout);
  assert.ok(codes(evaluate(source)).includes('workflow-checkout-credentials'));
});
test('a commented credential setting does not satisfy the contract', () => {
  const source = workflow({ persist: false }).replace('      - name: Setup Node',
    '          # persist-credentials: false\n      - name: Setup Node');
  assert.ok(codes(evaluate(source)).includes('workflow-checkout-credentials'));
});
test('missing permissions block fails closed', () => {
  const source = workflow().replace('permissions:\n  contents: read\n', '');
  assert.ok(codes(evaluate(source)).includes('workflow-permissions-missing'));
});
test('workflow token permissions require read-only contents', () => {
  assert.ok(codes(evaluate(workflow({ permissions: 'issues: read' })))
    .includes('workflow-permissions-contents'));
});
test('write-all permission is rejected', () => {
  assert.ok(codes(evaluate(workflow({ permissions: 'contents: read\n  actions: write' })))
    .includes('workflow-permissions-elevated'));
});
test('contents write is rejected', () => {
  const report = evaluate(workflow({ permissions: 'contents: write' }));
  assert.ok(codes(report).includes('workflow-permissions-elevated'));
  assert.ok(codes(report).includes('workflow-permissions-contents'));
});
test('pull_request_target trigger is rejected for quality workflows', () => {
  assert.ok(codes(evaluate(workflow({ trigger: 'pull_request_target' })))
    .includes('workflow-untrusted-trigger'));
});
test('workflow_run trigger is rejected for quality workflows', () => {
  assert.ok(codes(evaluate(workflow({ trigger: 'workflow_run' })))
    .includes('workflow-untrusted-trigger'));
});
test('ordinary push and pull_request triggers are accepted', () => {
  for (const trigger of ['push', 'pull_request']) assert.equal(evaluate(workflow({ trigger })).ok, true);
});
test('missing bounded job timeout is rejected', () => {
  assert.ok(codes(evaluate(workflow().replace('    timeout-minutes: 10\n', '')))
    .includes('workflow-timeout-missing'));
});
test('comments cannot supply a missing action', () => {
  const source = workflow().replace(/        uses: actions\/[^\n]+\n/g, '');
  assert.ok(codes(evaluate(source)).includes('workflow-actions-missing'));
});
test('commented unpinned action is not counted as a real action', () => {
  const source = workflow() + '        # uses: actions/checkout@v1\n';
  assert.equal(evaluate(source).ok, true);
});
test('action pin with a human-readable version comment remains valid', () => {
  const source = workflow().replace('uses: ' + checkout, 'uses: ' + checkout + ' # v7');
  assert.equal(evaluate(source).ok, true);
});
test('invalid workflow path cannot be used to bypass policy', () => {
  const report = evaluateWorkflowSupplyChain([{ file: '../outside.yml', source: workflow() }]);
  assert.ok(codes(report).includes('workflow-file-invalid'));
});
test('duplicate workflow inventory entries fail', () => {
  const entry = { file: '.github/workflows/test.yml', source: workflow() };
  assert.ok(codes(evaluateWorkflowSupplyChain([entry, entry])).includes('workflow-file-duplicate'));
});
test('empty workflow inventory fails closed', () => {
  assert.ok(codes(evaluateWorkflowSupplyChain([])).includes('workflow-inventory-empty'));
});
test('findings are stable independent of workflow input ordering', () => {
  const one = { file: '.github/workflows/one.yml', source: workflow({ nodeRef: 'actions/setup-node@v7' }) };
  const two = { file: '.github/workflows/two.yml', source: workflow({ persist: false }) };
  const first = evaluateWorkflowSupplyChain([one, two]);
  const second = evaluateWorkflowSupplyChain([two, one]);
  assert.deepEqual(first.findings, second.findings);
  assert.equal(first.fingerprint, second.fingerprint);
});
test('workflow report does not retain shell commands or environment secrets', () => {
  const source = workflow().replace('run: node --test', 'run: echo secret-should-not-be-reported');
  const report = evaluate(source);
  assert.equal(JSON.stringify(report).includes('secret-should-not-be-reported'), false);
});
test('fingerprint changes when action provenance changes', () => {
  const before = evaluate().fingerprint;
  const anotherPinnedNode = 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444';
  assert.notEqual(before, evaluate(workflow({ nodeRef: anotherPinnedNode })).fingerprint);
});
test('markdown reports gate, inventory and findings', () => {
  const passing = renderWorkflowSupplyChainMarkdown(evaluate());
  assert.match(passing, /Gate: \*\*PASS\*\*/);
  assert.match(passing, /Workflows: \*\*1\*\*/);
  const failing = renderWorkflowSupplyChainMarkdown(evaluate(workflow({ persist: false })));
  assert.match(failing, /Gate: \*\*FAIL\*\*/);
  assert.match(failing, /workflow-checkout-credentials/);
});
test('finding line numbers refer to source lines', () => {
  const report = auditWorkflowSource('.github/workflows/test.yml',
    workflow({ checkoutRef: 'actions/checkout@v7' }));
  const item = report.findings.find(x => x.code === 'workflow-action-unpinned');
  assert.ok(item.line > 0);
  assert.equal(workflow().split('\n')[item.line - 1].includes('uses:'), true);
});

test('shell interpolation of untrusted PR title is rejected', () => {
  const source = workflow().replace('run: node --test',
    'run: echo "${{ github.event.pull_request.title }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-expression'));
});
test('shell interpolation of untrusted branch name is rejected', () => {
  const source = workflow().replace('run: node --test',
    'run: echo "${{ github.head_ref }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-expression'));
});
test('multi-line shell expression is rejected even under a block scalar', () => {
  const source = workflow().replace('run: node --test',
    'run: |\n          echo safe\n          echo "${{ github.event.issue.title }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-expression'));
});
test('safe environment variable use is permitted in a shell command', () => {
  const source = workflow().replace('run: node --test',
    'env:\n          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n        run: echo "$BASE_SHA"');
  assert.equal(evaluate(source).ok, true);
});
test('a shell comment containing a GitHub expression is also rejected', () => {
  const source = workflow().replace('run: node --test',
    'run: |\n          # do not interpolate ${{ github.event.pull_request.title }}\n          node --test');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-expression'));
});
test('each job must have its own bounded timeout', () => {
  const source = workflow() + '  extra-job:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Test\n        run: echo ok\n';
  assert.ok(codes(evaluate(source)).includes('workflow-job-timeout-invalid'));
});
test('timeout above two hours is rejected for every job', () => {
  const source = workflow().replace('timeout-minutes: 10', 'timeout-minutes: 180');
  assert.ok(codes(evaluate(source)).includes('workflow-job-timeout-invalid'));
});
test('zero job timeout is rejected', () => {
  const source = workflow().replace('timeout-minutes: 10', 'timeout-minutes: 0');
  assert.ok(codes(evaluate(source)).includes('workflow-job-timeout-invalid'));
});
test('multiple timeouts in one job are rejected', () => {
  const source = workflow().replace('timeout-minutes: 10',
    'timeout-minutes: 10\n    timeout-minutes: 20');
  assert.ok(codes(evaluate(source)).includes('workflow-job-timeout-invalid'));
});
test('multiple independently bounded jobs are accepted', () => {
  const source = workflow() + '  extra-job:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - name: Test\n        run: echo ok\n';
  assert.equal(evaluate(source).ok, true);
});


test('job-level write permission cannot override workflow read-only token', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: write\n    timeout-minutes: 10');
  const report = evaluate(source);
  assert.ok(codes(report).includes('workflow-job-permissions-elevated'));
  assert.ok(codes(report).includes('workflow-job-permissions-contents'));
});
test('job-level id-token write is rejected despite contents read', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: read\n      id-token: write\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-permissions-elevated'));
});
test('job-level scalar write-all is rejected', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions: write-all\n    timeout-minutes: 10');
  const report = evaluate(source);
  assert.ok(codes(report).includes('workflow-job-permissions-format'));
  assert.ok(codes(report).includes('workflow-job-permissions-elevated'));
});
test('job-level read-only permission mapping is permitted', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: read\n    timeout-minutes: 10');
  assert.equal(evaluate(source).ok, true);
});
test('top-level scalar permissions are rejected', () => {
  const source = workflow().replace('permissions:\n  contents: read', 'permissions: write-all');
  assert.ok(codes(evaluate(source)).includes('workflow-permissions-scalar'));
});

test('duplicate top-level permission blocks cannot shadow read-only contents', () => {
  const source = workflow().replace('jobs:\n',
    'permissions:\n  contents: write\njobs:\n');
  const report = evaluate(source);
  assert.ok(codes(report).includes('workflow-permissions-duplicate'));
});
test('duplicate top-level read-only permission blocks also fail closed', () => {
  const source = workflow().replace('jobs:\n',
    'permissions:\n  contents: read\njobs:\n');
  assert.ok(codes(evaluate(source)).includes('workflow-permissions-duplicate'));
});

test('duplicate job permission overrides fail closed', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: read\n    permissions:\n      contents: write\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-permissions-duplicate'));
});

test('inline privileged workflow trigger list fails closed', () => {
  const source = workflow().replace('on:\n  pull_request:', 'on: [pull_request, workflow_run]');
  assert.ok(codes(evaluate(source)).includes('workflow-untrusted-trigger'));
});
test('scalar privileged trigger fails closed', () => {
  const source = workflow().replace('on:\n  pull_request:', 'on: "pull_request_target"');
  assert.ok(codes(evaluate(source)).includes('workflow-untrusted-trigger'));
});
test('quoted nested privileged trigger fails closed', () => {
  const source = workflow().replace('  pull_request:', '  "workflow_run":');
  assert.ok(codes(evaluate(source)).includes('workflow-untrusted-trigger'));
});
test('reusable workflow job cannot bypass action provenance checks', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    uses: another/repository/.github/workflows/release.yml@main\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-reusable-unreviewed'));
});
test('missing workflow trigger is rejected', () => {
  const source = workflow().replace('on:\n  pull_request:\n', '');
  assert.ok(codes(evaluate(source)).includes('workflow-trigger-missing'));
});
test('duplicate workflow event keys cannot shadow a safe trigger', () => {
  const source = workflow().replace('permissions:\n',
    'on:\n  workflow_run:\npermissions:\n');
  const report = evaluate(source);
  assert.ok(codes(report).includes('workflow-trigger-duplicate'));
  assert.ok(codes(report).includes('workflow-untrusted-trigger'));
});
test('quoted duplicate workflow event key is rejected', () => {
  const source = workflow().replace('permissions:\n',
    '"on":\n  push:\npermissions:\n');
  assert.ok(codes(evaluate(source)).includes('workflow-trigger-duplicate'));
});
test('whitespace before a privileged event colon cannot bypass admission', () => {
  const source = workflow().replace('  pull_request:', '  workflow_run :');
  assert.ok(codes(evaluate(source)).includes('workflow-untrusted-trigger'));
});
test('scalar workflow event alias is rejected', () => {
  const source = workflow().replace('on:\n  pull_request:', 'on: *shared_events');
  assert.ok(codes(evaluate(source)).includes('workflow-trigger-alias'));
});
test('merged workflow event alias is rejected', () => {
  const source = workflow().replace('  pull_request:', '  <<: *shared_events');
  assert.ok(codes(evaluate(source)).includes('workflow-trigger-merge-alias'));
});

test('ordinary triggers and step actions retain passing baseline', () => {
  assert.equal(evaluate(workflow({ trigger: 'push' })).ok, true);
  assert.equal(evaluate(workflow({ trigger: 'pull_request' })).ok, true);
});


test('quoted workflow permissions cannot shadow the canonical read-only map', () => {
  const source = workflow().replace('jobs:\n',
    '"permissions":\n  contents: write\njobs:\n');
  const report = evaluate(source);
  assert.ok(codes(report).includes('workflow-permissions-format'));
  assert.ok(codes(report).includes('workflow-permissions-duplicate'));
});
test('whitespace before workflow permissions colon cannot shadow policy', () => {
  const source = workflow().replace('jobs:\n',
    'permissions :\n  contents: write\njobs:\n');
  assert.ok(codes(evaluate(source)).includes('workflow-permissions-duplicate'));
});
test('quoted job permissions cannot silently override read-only workflow permissions', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    "permissions":\n      contents: write\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-permissions-format'));
});
test('whitespace before job permissions colon cannot bypass override audit', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions :\n      contents: write\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-permissions-format'));
});
test('duplicate job names cannot shadow reviewed timeout and permissions', () => {
  const source = workflow() +
    '  audit:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: echo shadow\n';
  assert.ok(codes(evaluate(source)).includes('workflow-job-duplicate'));
});
test('duplicate jobs mappings cannot shadow a reviewed job graph', () => {
  const source = workflow() +
    'jobs:\n  shadow:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n';
  assert.ok(codes(evaluate(source)).includes('workflow-jobs-duplicate'));
});
test('quoted jobs key cannot bypass the bounded job audit', () => {
  const source = workflow().replace('jobs:\n', '"jobs":\n');
  assert.ok(codes(evaluate(source)).includes('workflow-jobs-format'));
});
test('quoted step uses cannot bypass immutable action pinning', () => {
  const source = workflow().replace('        uses: ' + node,
    '        "uses": actions/setup-node@main');
  assert.ok(codes(evaluate(source)).includes('workflow-action-key-noncanonical'));
});
test('whitespace before uses colon cannot bypass action pinning', () => {
  const source = workflow().replace('        uses: ' + node,
    '        uses : actions/setup-node@main');
  assert.ok(codes(evaluate(source)).includes('workflow-action-key-noncanonical'));
});
test('quoted reusable job uses cannot bypass job-level provenance', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    "uses": another/repo/.github/workflows/release.yml@main\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-action-key-noncanonical'));
});

test('quoted job ID cannot bypass per-job timeout admission', () => {
  const source = workflow() + '  "shadow":\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bypass\n';
  assert.ok(codes(evaluate(source)).includes('workflow-job-key-noncanonical'));
});
test('whitespace-separated job ID cannot bypass job governance', () => {
  const source = workflow() + '  shadow :\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bypass\n';
  assert.ok(codes(evaluate(source)).includes('workflow-job-key-noncanonical'));
});
test('YAML job merge alias cannot import an unreviewed job graph', () => {
  const source = workflow() + '  <<: *shadow_jobs\n';
  assert.ok(codes(evaluate(source)).includes('workflow-job-key-noncanonical'));
});
test('inline run step cannot interpolate untrusted GitHub expressions', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - run: echo "${{ github.event.pull_request.title }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-expression'));
});
test('inline run block scalar is scanned for shell expressions', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - run: |\n          echo "${{ github.event.pull_request.title }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-expression'));
});
test('quoted inline run key cannot bypass injection admission', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - "run": echo "${{ github.event.pull_request.title }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-key-noncanonical'));
});
test('whitespace-separated mapping run key is rejected', () => {
  const source = workflow().replace('        run: node --test',
    '        run : echo "${{ github.event.pull_request.title }}"');
  assert.ok(codes(evaluate(source)).includes('workflow-shell-key-noncanonical'));
});
test('privileged workflow event sequence cannot bypass trigger review', () => {
  const source = workflow().replace('on:\n  pull_request:', 'on:\n  - workflow_run');
  assert.ok(codes(evaluate(source)).includes('workflow-untrusted-trigger'));
});
test('safe canonical inline run retains a passing workflow baseline', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - run: echo safe');
  assert.equal(evaluate(source).ok, true);
});

test('flow-mapping action steps cannot bypass immutable provenance', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - { uses: actions/setup-node@main }');
  assert.ok(codes(evaluate(source)).includes('workflow-step-structure-unreviewed'));
});
test('flow-mapping shell steps cannot bypass expression review', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - { run: echo "${{ github.event.pull_request.title }}" }');
  assert.ok(codes(evaluate(source)).includes('workflow-step-structure-unreviewed'));
});
test('step sequence aliases cannot inject unreviewed executable actions', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - *external_step');
  assert.ok(codes(evaluate(source)).includes('workflow-step-structure-unreviewed'));
});
test('step anchors cannot conceal a noncanonical executable mapping', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - &external_step run: echo unsafe');
  assert.ok(codes(evaluate(source)).includes('workflow-step-structure-unreviewed'));
});
test('step YAML merge keys cannot import unreviewed execution fields', () => {
  const source = workflow().replace('        run: node --test',
    '        <<: *external_step');
  assert.ok(codes(evaluate(source)).includes('workflow-step-structure-unreviewed'));
});
test('duplicate steps mappings cannot shadow an audited step sequence', () => {
  const source = workflow().replace('      - name: Test',
    '    steps:\n      - name: Test');
  assert.ok(codes(evaluate(source)).includes('workflow-steps-duplicate'));
});
test('quoted steps mapping cannot bypass canonical step inspection', () => {
  const source = workflow().replace('    steps:', "    'steps':");
  assert.ok(codes(evaluate(source)).includes('workflow-steps-format'));
});
test('aliased steps sequence cannot bypass step provenance', () => {
  const source = workflow().replace('    steps:', '    steps: *shared');
  assert.ok(codes(evaluate(source)).includes('workflow-steps-format'));
});
test('shell scalar aliases are rejected before execution', () => {
  const source = workflow().replace('        run: node --test', '        run: *shared_script');
  assert.ok(codes(evaluate(source)).includes('workflow-step-structure-unreviewed'));
});
test('canonical inline shell steps retain passing workflow behavior', () => {
  const source = workflow().replace('      - name: Test\n        run: node --test',
    '      - run: echo safe');
  assert.equal(evaluate(source).ok, true);
});

test('workflow permission merge alias cannot import elevated token grants', () => {
  const source = workflow().replace('  contents: read\njobs:',
    '  contents: read\n  <<: *extra_grants\njobs:');
  assert.ok(codes(evaluate(source)).includes('workflow-permissions-alias'));
});
test('workflow permission scalar alias cannot hide a write grant', () => {
  const source = workflow().replace('  contents: read\njobs:',
    '  contents: read\n  actions: *hidden_grant\njobs:');
  assert.ok(codes(evaluate(source)).includes('workflow-permissions-alias'));
});
test('job permission merge alias cannot import elevated token grants', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: read\n      <<: *extra_grants\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-permissions-alias'));
});
test('job permission scalar alias cannot hide a write grant', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: read\n      actions: *hidden_grant\n    timeout-minutes: 10');
  assert.ok(codes(evaluate(source)).includes('workflow-job-permissions-alias'));
});
test('canonical read-only job permissions remain supported', () => {
  const source = workflow().replace('    timeout-minutes: 10',
    '    permissions:\n      contents: read\n    timeout-minutes: 10');
  assert.equal(evaluate(source).ok, true);
});
