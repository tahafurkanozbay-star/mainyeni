import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCheckStatusProvenance } from './check-status-provenance-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function audit(script: string, trigger = 'push:\n    branches: [main]', permissions = 'checks: write') {
  return auditCheckStatusProvenance(fixtureInventory([{
    path: '.github/workflows/checks.yml',
    text: `name: Checks\non:\n  ${trigger}\npermissions:\n  contents: read\n  ${permissions}\njobs:\n  report:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n${script.split('\n').map(line => `            ${line}`).join('\n')}\n`,
  }]));
}

function ids(result: ReturnType<typeof audit>): string[] {
  return result.findings.map(item => item.id);
}

test('accepts a literal successful check run on github sha', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'Release QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'completed',\n  conclusion: 'success',\n  details_url: 'https://ci.example.test/runs/42',\n  output: { title: 'Release QA', summary: 'All gates passed' }\n})`);

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.checkRunMutations, 1);
});

test('accepts a literal pending commit status on github sha', () => {
  const result = audit(`await github.rest.repos.createCommitStatus({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  sha: '\${{ github.sha }}',\n  state: 'pending',\n  context: 'release/qa',\n  target_url: 'https://ci.example.test/runs/42',\n  description: 'Release QA running'\n})`, 'push:', 'statuses: write');

  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.commitStatusMutations, 1);
});

test('blocks input-controlled check target sha', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'Release QA',\n  head_sha: '\${{ inputs.sha }}',\n  status: 'completed',\n  conclusion: 'success'\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-check-status-untrusted-target'));
});

test('blocks pull request payload check target sha', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'Release QA',\n  head_sha: context.payload.pull_request.head.sha,\n  status: 'completed',\n  conclusion: 'success'\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-check-status-untrusted-target'));
});

test('blocks input-controlled check conclusion', () => {
  const result = audit(`await github.rest.checks.update({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  check_run_id: 42,\n  status: 'completed',\n  conclusion: '\${{ inputs.conclusion }}'\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-check-status-untrusted-state'));
});

test('blocks event-controlled commit status state', () => {
  const result = audit(`await github.rest.repos.createCommitStatus({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  sha: '\${{ github.sha }}',\n  state: context.payload.issue.title,\n  context: 'release/qa'\n})`, 'issues:', 'statuses: write');

  assert.ok(ids(result).includes('ci-check-status-untrusted-state'));
});

test('reviews indirect check conclusion output', () => {
  const result = audit(`await github.rest.checks.update({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  check_run_id: 42,\n  status: 'completed',\n  conclusion: '\${{ needs.validate.outputs.conclusion }}'\n})`);

  const finding = result.findings.find(item => item.id === 'ci-check-status-indirect-state-review');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('flags noncanonical literal check status', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'green'\n})`);

  assert.ok(ids(result).includes('ci-check-status-noncanonical-state'));
});

test('flags noncanonical literal check conclusion', () => {
  const result = audit(`await github.rest.checks.update({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  check_run_id: 42,\n  conclusion: 'passed'\n})`);

  assert.ok(ids(result).includes('ci-check-status-noncanonical-state'));
});

test('flags noncanonical literal commit status state', () => {
  const result = audit(`await github.rest.repos.createCommitStatus({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  sha: '\${{ github.sha }}',\n  state: 'complete',\n  context: 'qa'\n})`, 'push:', 'statuses: write');

  assert.ok(ids(result).includes('ci-check-status-noncanonical-state'));
});

test('blocks untrusted check name', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: context.payload.pull_request.title,\n  head_sha: '\${{ github.sha }}',\n  status: 'queued'\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-check-status-untrusted-display'));
});

test('blocks untrusted commit status context', () => {
  const result = audit(`await github.rest.repos.createCommitStatus({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  sha: '\${{ github.sha }}',\n  state: 'success',\n  context: '\${{ inputs.context }}'\n})`, 'workflow_dispatch:', 'statuses: write');

  assert.ok(ids(result).includes('ci-check-status-untrusted-display'));
});

test('blocks untrusted check output summary', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'completed',\n  conclusion: 'failure',\n  output: { title: 'QA', summary: context.payload.pull_request.body }\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-check-status-untrusted-display'));
});

test('blocks untrusted details url', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'queued',\n  details_url: '\${{ inputs.url }}'\n})`, 'workflow_dispatch:');

  assert.ok(ids(result).includes('ci-check-status-untrusted-url'));
});

test('blocks untrusted commit target url', () => {
  const result = audit(`await github.rest.repos.createCommitStatus({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  sha: '\${{ github.sha }}',\n  state: 'success',\n  context: 'qa',\n  target_url: context.payload.issue.body\n})`, 'issues:', 'statuses: write');

  assert.ok(ids(result).includes('ci-check-status-untrusted-url'));
});

test('blocks dangerous status url schemes', () => {
  const result = audit(`await github.rest.repos.createCommitStatus({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  sha: '\${{ github.sha }}',\n  state: 'success',\n  context: 'qa',\n  target_url: 'javascript:alert(1)'\n})`, 'push:', 'statuses: write');

  assert.ok(ids(result).includes('ci-check-status-unsafe-url'));
});

test('blocks credential-bearing check details urls', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'queued',\n  details_url: 'https://user:pass@ci.example.test/run'\n})`);

  assert.ok(ids(result).includes('ci-check-status-unsafe-url'));
});

test('flags plaintext status urls as blocking with write authority', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'queued',\n  details_url: 'http://ci.example.test/run'\n})`);

  const finding = result.findings.find(item => item.id === 'ci-check-status-plaintext-url');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('blocks secret-derived status metadata', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'queued',\n  details_url: '\${{ secrets.PRIVATE_URL }}'\n})`);

  assert.ok(ids(result).includes('ci-check-status-secret-metadata'));
});

test('tracks attacker metadata through step env', () => {
  const inventory = fixtureInventory([{
    path: '.github/workflows/checks.yml',
    text: `name: Checks\non:\n  pull_request:\npermissions:\n  contents: read\n  checks: write\njobs:\n  report:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@${SHA}\n        env:\n          CHECK_NAME: \${{ github.event.pull_request.title }}\n        with:\n          script: |\n            await github.rest.checks.create({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              name: process.env.CHECK_NAME,\n              head_sha: '\${{ github.sha }}',\n              status: 'queued'\n            })\n`,
  }]);
  const result = auditCheckStatusProvenance(inventory);

  assert.ok(ids(result).includes('ci-check-status-untrusted-display'));
});

test('tracks secret metadata through step env', () => {
  const inventory = fixtureInventory([{
    path: '.github/workflows/checks.yml',
    text: `name: Checks\non:\n  push:\npermissions:\n  checks: write\njobs:\n  report:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@${SHA}\n        env:\n          CHECK_SUMMARY: \${{ secrets.CHECK_SUMMARY }}\n        with:\n          script: |\n            await github.rest.checks.create({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              name: 'QA',\n              head_sha: '\${{ github.sha }}',\n              status: 'completed',\n              conclusion: 'success',\n              output: { title: 'QA', summary: process.env.CHECK_SUMMARY }\n            })\n`,
  }]);
  const result = auditCheckStatusProvenance(inventory);

  assert.ok(ids(result).includes('ci-check-status-secret-metadata'));
});

test('blocks external contribution workflow with explicit checks write authority', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'queued'\n})`, 'pull_request:');

  assert.ok(ids(result).includes('ci-check-status-external-write-authority'));
});

test('does not invent external authority finding on trusted push', () => {
  const result = audit(`await github.rest.checks.create({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  name: 'QA',\n  head_sha: '\${{ github.sha }}',\n  status: 'queued'\n})`);

  assert.ok(!ids(result).includes('ci-check-status-external-write-authority'));
});

test('ignores unrelated github-script mutations', () => {
  const result = audit(`await github.rest.issues.createComment({\n  owner: context.repo.owner,\n  repo: context.repo.repo,\n  issue_number: 1,\n  body: context.payload.issue.body\n})`);

  assert.equal(result.summary.mutations, 0);
  assert.deepEqual(result.findings, []);
});

test('summarizes check and commit status mutations', () => {
  const inventory = fixtureInventory([{
    path: '.github/workflows/checks.yml',
    text: `name: Checks\non: push\npermissions:\n  checks: write\n  statuses: write\njobs:\n  report:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.checks.create({ name: 'QA', head_sha: '\${{ github.sha }}', status: 'queued' })\n      - uses: actions/github-script@${SHA}\n        with:\n          script: |\n            await github.rest.repos.createCommitStatus({ sha: '\${{ github.sha }}', state: 'success', context: 'qa' })\n`,
  }]);
  const result = auditCheckStatusProvenance(inventory);

  assert.equal(result.summary.mutations, 2);
  assert.equal(result.summary.checkRunMutations, 1);
  assert.equal(result.summary.commitStatusMutations, 1);
});
