import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReleaseAdmissionSnapshot } from './release-admission-snapshot.mjs';

const main = 'a'.repeat(40);
const head = 'b'.repeat(40);
const observedAt = '2026-10-05T01:30:00.000Z';
const required = ['Release QA', 'Platform Architecture Audit', 'Platform Typed Test Validation', 'Release Evidence Contract', 'Webclient Quality'];
const snapshot = () => ({
  version: 1,
  main: { ref: 'main', headSha: main },
  pullRequest: { baseRef: 'main', headRef: 'agent/qa-release', baseSha: main, headSha: head, draft: false, mergeable: true, additions: 4000, deletions: 0 },
  compare: { baseSha: main, headSha: head, mergeBaseSha: main, aheadBy: 1, behindBy: 0, status: 'ahead' },
  reviewThreads: [],
  workflowRuns: required.map((name, index) => ({ name, headSha: head, event: 'pull_request', status: 'completed', conclusion: 'success', runId: index + 1, attempt: 1, createdAt: '2026-10-05T01:00:00.000Z', updatedAt: '2026-10-05T01:10:00.000Z' })),
  maxEvidenceAgeMs: 3600000,
  observedAt,
});

for (const [label, policy] of [['null', null], ['array', []], ['string', 'required'], ['number', 1], ['boolean', false]]) {
  test(`fails closed for ${label} admission policy without throwing`, () => {
    const result = evaluateReleaseAdmissionSnapshot(snapshot(), policy);
    assert.equal(result.passed, false);
    assert.equal(result.mergeAllowed, false);
    assert.equal(result.candidate, null);
    assert.equal(result.workflow, null);
    assert.equal(result.summary.errors, 1);
    assert.deepEqual(result.findings.map(item => item.code), ['policy-invalid']);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.findings), true);
    assert.equal(Object.isFrozen(result.findings[0]), true);
  });
}

test('keeps ordinary object policy behavior intact', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot(), {});
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
});
