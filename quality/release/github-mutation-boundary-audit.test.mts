import assert from 'node:assert/strict';
import test from 'node:test';
import { auditGitHubMutationBoundaries } from './github-mutation-boundary-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(text: string) {
  return auditGitHubMutationBoundaries(fixtureInventory([{ path: '.github/workflows/mutation.yml', text }] as readonly FixtureFileInput[]));
}

function workflow(on: string, run: string, permissions = 'contents: read', env = ''): string {
  const body = run.split('\n').map(line => `          ${line}`).join('\n');
  return `name: mutation\non: ${on}\npermissions:\n  ${permissions}\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - name: mutate\n${env}        run: |\n${body}\n`;
}

test('accepts trusted static gh api mutation target', () => {
  const result = audit(workflow('[workflow_dispatch]', 'gh api -X POST repos/${{ github.repository }}/dispatches -f event_type=refresh', 'contents: write'));
  assert.equal(result.summary.mutationSteps, 1);
  assert.equal(result.summary.dynamicTargets, 0);
});

test('blocks external trigger repository mutation with write authority', () => {
  const result = audit(workflow('[issue_comment]', 'gh issue comment 1 --body "ack"', 'issues: write'));
  const finding = result.findings.find(item => item.id === 'ci-github-mutation-external-trigger');
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.blocking, true);
});

test('flags external mutation without explicit write authority', () => {
  const result = audit(workflow('[pull_request]', 'gh pr comment 1 --body "check"'));
  assert.ok(result.findings.some(item => item.id === 'ci-github-mutation-external-trigger'));
});

test('blocks input-controlled gh api path in privileged job', () => {
  const result = audit(workflow('[workflow_dispatch]', 'gh api -X PATCH "${{ inputs.endpoint }}" -f state=open', 'issues: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-github-mutation-dynamic-target' && item.blocking));
});

test('blocks input-controlled repository target', () => {
  const result = audit(workflow('[workflow_dispatch]', 'gh issue edit 12 --repo "${{ inputs.repo }}" --add-label ready', 'issues: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-github-mutation-dynamic-target'));
});

test('detects untrusted env variable steering target', () => {
  const env = `        env:\n          TARGET_REPO: \${{ inputs.repo }}\n`;
  const result = audit(workflow('[workflow_dispatch]', 'gh issue edit 12 --repo "$TARGET_REPO" --add-label ready', 'issues: write', env));
  assert.equal(result.summary.dynamicTargets, 1);
});

test('flags event-controlled body payload', () => {
  const result = audit(workflow('[issue_comment]', 'gh issue comment 12 --body "${{ github.event.comment.body }}"', 'issues: write'));
  assert.ok(result.findings.some(item => item.id === 'ci-github-mutation-dynamic-payload'));
});

test('flags untrusted env variable in mutation payload', () => {
  const env = `        env:\n          BODY: \${{ github.event.comment.body }}\n`;
  const result = audit(workflow('[issue_comment]', 'gh issue comment 12 --body "$BODY"', 'issues: write', env));
  assert.equal(result.summary.dynamicPayloads, 1);
});

test('detects gh pr merge mutation', () => {
  const result = audit(workflow('[workflow_dispatch]', 'gh pr merge 42 --squash', 'pull-requests: write'));
  assert.equal(result.summary.mutationCommands, 1);
});

test('detects gh run cancellation mutation', () => {
  const result = audit(workflow('[workflow_dispatch]', 'gh run cancel 123', 'actions: write'));
  assert.equal(result.summary.mutationCommands, 1);
});

test('detects curl GitHub API mutation', () => {
  const result = audit(workflow('[workflow_dispatch]', 'curl -X PATCH https://api.github.com/repos/owner/repo/issues/1 -d "{}"', 'issues: write'));
  assert.equal(result.summary.mutationCommands, 1);
});

test('ignores read-only gh api request', () => {
  const result = audit(workflow('[push]', 'gh api repos/${{ github.repository }}'));
  assert.equal(result.summary.mutationSteps, 0);
  assert.deepEqual(result.findings, []);
});

test('ignores gh issue view', () => {
  const result = audit(workflow('[push]', 'gh issue view 12'));
  assert.equal(result.summary.mutationCommands, 0);
});

test('reports deterministic dynamic target and payload counts', () => {
  const result = audit(workflow('[workflow_dispatch]', 'gh api -X PATCH "${{ inputs.endpoint }}" -f body="${{ inputs.body }}"', 'issues: write'));
  assert.equal(result.summary.dynamicTargets, 1);
  assert.equal(result.summary.dynamicPayloads, 1);
});

test('ignores non workflow files', () => {
  const result = auditGitHubMutationBoundaries(fixtureInventory([{ path: 'scripts/mutation.yml', text: 'run: gh issue close 1' }] as readonly FixtureFileInput[]));
  assert.equal(result.summary.workflowFiles, 0);
});
