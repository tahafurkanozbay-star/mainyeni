import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  MIN_MEANINGFUL_ADDITIONS,
  RELEASE_ADMISSION_VERSION,
  REQUIRED_RELEASE_CHECKS,
  evaluateReleaseAdmissionSnapshot,
  evaluateReleaseCandidate,
  evaluateReleaseEvidenceQuorum,
  evaluateReleasePrLifecycle,
  formatReleaseAdmissionResult,
  parseReleaseAdmissionJson,
} from './release-admission-contracts.mts';

const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const CREATED = '2026-10-05T05:00:00.000Z';
const UPDATED = '2026-10-05T05:05:00.000Z';
const OBSERVED = '2026-10-05T05:10:00.000Z';

function checks(headSha = HEAD) {
  return REQUIRED_RELEASE_CHECKS.map(name => ({
    name,
    status: 'completed',
    conclusion: 'success',
    headSha,
  }));
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    version: RELEASE_ADMISSION_VERSION,
    baseSha: MAIN,
    headSha: HEAD,
    mergeBaseSha: MAIN,
    currentMainSha: MAIN,
    additions: MIN_MEANINGFUL_ADDITIONS,
    deletions: 0,
    aheadBy: 1,
    behindBy: 0,
    unresolvedThreads: 0,
    mergeable: true,
    draft: false,
    checks: checks(),
    ...overrides,
  };
}

function run(
  name: string,
  overrides: Record<string, unknown> = {},
  index = 0,
) {
  return {
    name,
    headSha: HEAD,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    runId: 1000 + index,
    attempt: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...overrides,
  };
}

function runs(overrides: Readonly<Record<string, Record<string, unknown>>> = {}) {
  return REQUIRED_RELEASE_CHECKS.map((name, index) => run(name, overrides[name] ?? {}, index));
}

function quorum(overrides: Record<string, unknown> = {}) {
  return {
    version: RELEASE_ADMISSION_VERSION,
    headSha: HEAD,
    baseSha: MAIN,
    currentMainSha: MAIN,
    runs: runs(),
    maxEvidenceAgeMs: DEFAULT_MAX_EVIDENCE_AGE_MS,
    observedAt: OBSERVED,
    ...overrides,
  };
}

function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    version: RELEASE_ADMISSION_VERSION,
    number: 469,
    state: 'open',
    merged: false,
    draft: false,
    mergeable: true,
    baseSha: MAIN,
    headSha: HEAD,
    createdAt: CREATED,
    updatedAt: UPDATED,
    observedAt: OBSERVED,
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: RELEASE_ADMISSION_VERSION,
    main: { headSha: MAIN, ref: 'main' },
    pullRequest: {
      baseSha: MAIN,
      headSha: HEAD,
      baseRef: 'main',
      headRef: 'agent/qa-release-20261005',
      draft: false,
      mergeable: true,
      additions: MIN_MEANINGFUL_ADDITIONS,
      deletions: 0,
    },
    compare: {
      baseSha: MAIN,
      headSha: HEAD,
      mergeBaseSha: MAIN,
      aheadBy: 2,
      behindBy: 0,
      status: 'ahead',
    },
    reviewThreads: [],
    workflowRuns: runs(),
    maxEvidenceAgeMs: DEFAULT_MAX_EVIDENCE_AGE_MS,
    observedAt: OBSERVED,
    ...overrides,
  };
}

function findingCodes(result: { readonly findings: readonly { readonly code: string }[] }): string[] {
  return result.findings.map(item => item.code);
}

test('accepts a fully valid release candidate', () => {
  const result = evaluateReleaseCandidate(candidate());
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.additionsRequired, MIN_MEANINGFUL_ADDITIONS);
});

test('candidate output is deeply immutable', () => {
  const result = evaluateReleaseCandidate(candidate());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal(Object.isFrozen(result.summary), true);
  assert.equal(Object.isFrozen(result.summary.requiredChecks), true);
});

test('rejects a malformed candidate root without throwing', () => {
  for (const value of [null, [], 'candidate', 42, true]) {
    const result = evaluateReleaseCandidate(value);
    assert.equal(result.passed, false);
    assert.ok(findingCodes(result).includes('candidate-invalid'));
  }
});

test('rejects malformed candidate policy containers without throwing', () => {
  for (const policy of [null, [], 'policy', 42, false]) {
    const result = evaluateReleaseCandidate(candidate(), policy);
    assert.equal(result.passed, false);
    assert.ok(findingCodes(result).includes('policy-invalid'));
  }
});

test('does not allow policy to weaken the 4000-additions floor', () => {
  const result = evaluateReleaseCandidate(candidate(), { minimumAdditions: 1 });
  assert.equal(result.passed, false);
  assert.ok(findingCodes(result).includes('minimum-additions-policy-invalid'));
  assert.equal(result.summary.additionsRequired, MIN_MEANINGFUL_ADDITIONS);
});

test('allows policy to strengthen the additions floor', () => {
  const result = evaluateReleaseCandidate(candidate({ additions: 5_000 }), { minimumAdditions: 5_000 });
  assert.equal(result.passed, true);
  assert.equal(result.summary.additionsRequired, 5_000);
});

test('blocks a candidate below the meaningful additions gate', () => {
  const result = evaluateReleaseCandidate(candidate({ additions: 3_999 }));
  assert.ok(findingCodes(result).includes('additions-gate'));
  assert.equal(result.mergeAllowed, false);
});

test('blocks stale base and merge-base independently', () => {
  const result = evaluateReleaseCandidate(candidate({ baseSha: OTHER, mergeBaseSha: OTHER }));
  assert.ok(findingCodes(result).includes('base-stale'));
  assert.ok(findingCodes(result).includes('merge-base-stale'));
});

test('blocks behind, empty, draft, nonmergeable and unresolved-review states', () => {
  const result = evaluateReleaseCandidate(candidate({
    aheadBy: 0,
    behindBy: 2,
    draft: true,
    mergeable: false,
    unresolvedThreads: 3,
  }));
  const codes = findingCodes(result);
  for (const code of ['branch-behind', 'branch-empty', 'draft', 'not-mergeable', 'review-threads']) assert.ok(codes.includes(code));
});

test('requires every immutable baseline check even when caller specifies only one', () => {
  const custom = 'Security Deep Scan';
  const result = evaluateReleaseCandidate(candidate({
    checks: [...checks(), { name: custom, status: 'completed', conclusion: 'success', headSha: HEAD }],
  }), { requiredChecks: [custom] });
  assert.equal(result.passed, true);
  assert.ok(REQUIRED_RELEASE_CHECKS.every(name => result.summary.requiredChecks.includes(name)));
  assert.ok(result.summary.requiredChecks.includes(custom));
});

test('rejects duplicate caller required checks', () => {
  const result = evaluateReleaseCandidate(candidate(), { requiredChecks: ['Custom', 'Custom'] });
  assert.ok(findingCodes(result).includes('required-name-duplicate'));
});

test('rejects duplicate check evidence identities', () => {
  const result = evaluateReleaseCandidate(candidate({ checks: [...checks(), checks()[0]] }));
  assert.ok(findingCodes(result).includes('duplicate-check'));
});

test('binds every required check to the exact candidate head', () => {
  const broken = checks().map((item, index) => index === 0 ? { ...item, headSha: OTHER } : item);
  const result = evaluateReleaseCandidate(candidate({ checks: broken }));
  assert.ok(findingCodes(result).includes('check-head-mismatch'));
});

test('blocks pending required checks', () => {
  const broken = checks().map((item, index) => index === 1 ? { ...item, status: 'in_progress', conclusion: null } : item);
  const result = evaluateReleaseCandidate(candidate({ checks: broken }));
  assert.ok(findingCodes(result).includes('check-pending'));
});

test('blocks failed required checks', () => {
  const broken = checks().map((item, index) => index === 2 ? { ...item, conclusion: 'failure' } : item);
  const result = evaluateReleaseCandidate(candidate({ checks: broken }));
  assert.ok(findingCodes(result).includes('check-failed'));
});

test('rejects unsafe SHA and negative integer fields', () => {
  const result = evaluateReleaseCandidate(candidate({ headSha: 'short', additions: -1, behindBy: -2 }));
  const codes = findingCodes(result);
  assert.ok(codes.includes('sha-invalid'));
  assert.ok(codes.includes('integer-invalid'));
});

test('accepts a valid exact-head workflow evidence quorum', () => {
  const result = evaluateReleaseEvidenceQuorum(quorum());
  assert.equal(result.passed, true);
  assert.equal(result.summary.errors, 0);
});

test('workflow quorum is immutable', () => {
  const result = evaluateReleaseEvidenceQuorum(quorum());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal(Object.isFrozen(result.summary.required), true);
});

test('rejects malformed workflow evidence root', () => {
  const result = evaluateReleaseEvidenceQuorum([]);
  assert.ok(findingCodes(result).includes('evidence-invalid'));
  assert.equal(result.passed, false);
});

test('rejects malformed workflow policy containers', () => {
  const result = evaluateReleaseEvidenceQuorum(quorum(), []);
  assert.ok(findingCodes(result).includes('policy-invalid'));
});

test('workflow quorum cannot replace immutable baseline names with caller policy', () => {
  const custom = 'Extra Governance';
  const evidence = quorum({ runs: [...runs(), run(custom, {}, 30)] });
  const result = evaluateReleaseEvidenceQuorum(evidence, { required: [custom] });
  assert.equal(result.passed, true);
  assert.ok(REQUIRED_RELEASE_CHECKS.every(name => result.summary.required.includes(name)));
});

test('requires pull_request provenance for candidate-executing workflows', () => {
  const broken = runs({ 'Release QA': { event: 'push' } });
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: broken }));
  assert.ok(findingCodes(result).includes('run-event-untrusted'));
});

test('requires completed success for workflow evidence', () => {
  const broken = runs({
    'Release QA': { status: 'in_progress', conclusion: null },
    'Webclient Quality': { conclusion: 'failure' },
  });
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: broken }));
  const codes = findingCodes(result);
  assert.ok(codes.includes('run-pending'));
  assert.ok(codes.includes('run-not-success'));
});

test('rejects workflow evidence from the future', () => {
  const broken = runs({ 'Release QA': { updatedAt: '2026-10-05T06:00:00.000Z' } });
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: broken }));
  assert.ok(findingCodes(result).includes('run-from-future'));
});

test('rejects workflow evidence older than freshness budget', () => {
  const oldRuns = runs().map(item => ({ ...item, createdAt: '2026-10-05T03:00:00.000Z', updatedAt: '2026-10-05T03:10:00.000Z' }));
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: oldRuns, maxEvidenceAgeMs: 60_000 }));
  assert.ok(findingCodes(result).includes('run-stale'));
});

test('rejects reversed workflow timestamps', () => {
  const broken = runs({ 'Release QA': { createdAt: UPDATED, updatedAt: CREATED } });
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: broken }));
  assert.ok(findingCodes(result).includes('run-time-reversed'));
});

test('rejects reused run id with inconsistent immutable identity', () => {
  const evidence = [...runs(), run('Different Workflow', { runId: 1000 }, 99)];
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: evidence }));
  assert.ok(findingCodes(result).includes('run-id-collision'));
});

test('rejects contradictory evidence for the same run attempt', () => {
  const baseRun = run('Release QA', {}, 0);
  const evidence = [...runs().filter(item => item.name !== 'Release QA'), baseRun, { ...baseRun, conclusion: 'failure' }];
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: evidence }));
  assert.ok(findingCodes(result).includes('run-attempt-conflict'));
});

test('selects the highest workflow attempt for the same identity', () => {
  const first = run('Release QA', { conclusion: 'failure', attempt: 1 }, 0);
  const second = run('Release QA', { conclusion: 'success', attempt: 2, updatedAt: '2026-10-05T05:06:00.000Z' }, 0);
  const evidence = [...runs().filter(item => item.name !== 'Release QA'), first, second];
  const result = evaluateReleaseEvidenceQuorum(quorum({ runs: evidence }));
  assert.equal(result.passed, true);
});

test('rejects invalid workflow age policy outside one-minute to one-day bounds', () => {
  const tooSmall = evaluateReleaseEvidenceQuorum(quorum({ maxEvidenceAgeMs: 1 }));
  const tooLarge = evaluateReleaseEvidenceQuorum(quorum({ maxEvidenceAgeMs: 86_400_001 }));
  assert.ok(findingCodes(tooSmall).includes('age-policy-invalid'));
  assert.ok(findingCodes(tooLarge).includes('age-policy-invalid'));
});

test('accepts valid open PR lifecycle evidence', () => {
  const result = evaluateReleasePrLifecycle(lifecycle(), {
    expectedNumber: 469,
    expectedHeadSha: HEAD,
    expectedBaseSha: MAIN,
  });
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
});

test('rejects malformed lifecycle roots and policies without throwing', () => {
  for (const value of [null, [], 'x', 1, false]) {
    assert.equal(evaluateReleasePrLifecycle(value).passed, false);
    assert.ok(findingCodes(evaluateReleasePrLifecycle(lifecycle(), value)).includes('policy-invalid'));
  }
});

test('blocks closed, merged, draft and nonmergeable PR lifecycle states', () => {
  const result = evaluateReleasePrLifecycle(lifecycle({ state: 'closed', merged: true, draft: true, mergeable: false }));
  const codes = findingCodes(result);
  for (const code of ['pr-closed', 'pr-merged', 'pr-draft', 'pr-not-mergeable']) assert.ok(codes.includes(code));
});

test('binds PR number, head and base to expected identities', () => {
  const result = evaluateReleasePrLifecycle(lifecycle(), {
    expectedNumber: 470,
    expectedHeadSha: OTHER,
    expectedBaseSha: OTHER,
  });
  const codes = findingCodes(result);
  assert.ok(codes.includes('number-mismatch'));
  assert.ok(codes.includes('head-mismatch'));
  assert.ok(codes.includes('base-mismatch'));
});

test('rejects invalid lifecycle policy identities', () => {
  const result = evaluateReleasePrLifecycle(lifecycle(), {
    expectedNumber: 0,
    expectedHeadSha: 'bad',
    expectedBaseSha: 'bad',
    maxMetadataAgeMs: 86_400_001,
  });
  const codes = findingCodes(result);
  for (const code of ['expected-number-invalid', 'expected-head-invalid', 'expected-base-invalid', 'freshness-policy-invalid']) assert.ok(codes.includes(code));
});

test('rejects stale PR metadata', () => {
  const result = evaluateReleasePrLifecycle(lifecycle({ updatedAt: '2026-10-05T04:00:00.000Z' }), { maxMetadataAgeMs: 60_000 });
  assert.ok(findingCodes(result).includes('metadata-stale'));
});

test('rejects future PR metadata and reversed timestamps', () => {
  const future = evaluateReleasePrLifecycle(lifecycle({ updatedAt: '2026-10-05T06:00:00.000Z' }));
  const reversed = evaluateReleasePrLifecycle(lifecycle({ createdAt: UPDATED, updatedAt: CREATED }));
  assert.ok(findingCodes(future).includes('metadata-from-future'));
  assert.ok(findingCodes(reversed).includes('timestamp-order-invalid'));
});

test('accepts a complete release admission snapshot', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot());
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
  assert.equal(result.candidate?.passed, true);
  assert.equal(result.workflow?.passed, true);
});

test('snapshot output is immutable including nested candidate and workflow results', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal(Object.isFrozen(result.candidate), true);
  assert.equal(Object.isFrozen(result.workflow), true);
});

test('snapshot rejects malformed root and policy containers', () => {
  const badRoot = evaluateReleaseAdmissionSnapshot([]);
  const badPolicy = evaluateReleaseAdmissionSnapshot(snapshot(), []);
  assert.ok(findingCodes(badRoot).includes('snapshot-invalid'));
  assert.ok(findingCodes(badPolicy).includes('policy-invalid'));
});

test('snapshot requires main as the branch authority', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot({ main: { headSha: MAIN, ref: 'develop' } }));
  assert.ok(findingCodes(result).includes('main-ref-unexpected'));
});

test('snapshot requires PR base ref main and disallows main as head ref', () => {
  const value = snapshot() as ReturnType<typeof snapshot>;
  const pullRequest = { ...(value.pullRequest as Record<string, unknown>), baseRef: 'develop', headRef: 'main' };
  const result = evaluateReleaseAdmissionSnapshot({ ...value, pullRequest });
  const codes = findingCodes(result);
  assert.ok(codes.includes('pr-base-ref-unexpected'));
  assert.ok(codes.includes('pr-head-ref-main'));
});

test('snapshot cross-validates current main, PR head and compare authority', () => {
  const value = snapshot() as ReturnType<typeof snapshot>;
  const pullRequest = { ...(value.pullRequest as Record<string, unknown>), baseSha: OTHER };
  const compare = { ...(value.compare as Record<string, unknown>), headSha: OTHER, mergeBaseSha: OTHER };
  const result = evaluateReleaseAdmissionSnapshot({ ...value, pullRequest, compare });
  const codes = findingCodes(result);
  assert.ok(codes.includes('pr-base-stale'));
  assert.ok(codes.includes('head-authority-mismatch'));
  assert.ok(codes.includes('merge-base-stale'));
});

test('snapshot blocks branch-behind and non-ahead compare status', () => {
  const value = snapshot() as ReturnType<typeof snapshot>;
  const compare = { ...(value.compare as Record<string, unknown>), behindBy: 1, status: 'diverged' };
  const result = evaluateReleaseAdmissionSnapshot({ ...value, compare });
  const codes = findingCodes(result);
  assert.ok(codes.includes('compare-behind'));
  assert.ok(codes.includes('compare-not-ahead'));
});

test('snapshot converts unresolved review threads into candidate denial', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot({ reviewThreads: [{ id: 'RT_1', resolved: false }] }));
  assert.ok(findingCodes(result).includes('candidate-review-threads'));
  assert.equal(result.mergeAllowed, false);
});

test('snapshot rejects duplicate review thread ids', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot({
    reviewThreads: [
      { id: 'RT_1', resolved: true },
      { id: 'RT_1', resolved: false },
    ],
  }));
  assert.ok(findingCodes(result).includes('review-thread-duplicate'));
});

test('snapshot bounds review thread cardinality', () => {
  const reviewThreads = Array.from({ length: 257 }, (_, index) => ({ id: `RT_${index}`, resolved: true }));
  const result = evaluateReleaseAdmissionSnapshot(snapshot({ reviewThreads }));
  assert.ok(findingCodes(result).includes('review-threads-limit'));
});

test('snapshot propagates failed exact-head workflow evidence', () => {
  const broken = runs({ 'Release QA': { conclusion: 'failure' } });
  const result = evaluateReleaseAdmissionSnapshot(snapshot({ workflowRuns: broken }));
  assert.ok(findingCodes(result).some(code => code === 'workflow-run-not-success'));
  assert.equal(result.mergeAllowed, false);
});

test('snapshot policy can add but not replace required checks and workflows', () => {
  const custom = 'Independent Security Gate';
  const customRun = run(custom, {}, 40);
  const result = evaluateReleaseAdmissionSnapshot(snapshot({ workflowRuns: [...runs(), customRun] }), {
    requiredChecks: [custom],
    requiredWorkflows: [custom],
  });
  assert.ok(result.workflow?.summary.required.includes(custom));
  assert.ok(REQUIRED_RELEASE_CHECKS.every(name => result.workflow?.summary.required.includes(name)));
  assert.equal(result.passed, false);
  assert.ok(findingCodes(result).includes('candidate-required-check-missing'));
});

test('snapshot observes stronger meaningful additions policy', () => {
  const value = snapshot() as ReturnType<typeof snapshot>;
  const pullRequest = { ...(value.pullRequest as Record<string, unknown>), additions: 5_000 };
  const result = evaluateReleaseAdmissionSnapshot({ ...value, pullRequest }, { minimumAdditions: 5_000 });
  assert.equal(result.passed, true);
  assert.equal(result.candidate?.summary.additionsRequired, 5_000);
});

test('snapshot rejects attempts to weaken meaningful additions policy', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot(), { minimumAdditions: 10 });
  assert.ok(findingCodes(result).some(code => code.includes('minimum-additions-policy-invalid')));
  assert.equal(result.mergeAllowed, false);
});

test('parseReleaseAdmissionJson accepts a bounded object document', () => {
  const parsed = parseReleaseAdmissionJson(JSON.stringify({ version: RELEASE_ADMISSION_VERSION }));
  assert.equal(typeof parsed, 'object');
});

test('parseReleaseAdmissionJson rejects arrays', () => {
  let message = '';
  try {
    parseReleaseAdmissionJson('[]');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.includes('root must be an object'));
});

test('parseReleaseAdmissionJson rejects documents over the byte budget', () => {
  let message = '';
  try {
    parseReleaseAdmissionJson(JSON.stringify({ payload: 'x'.repeat(128) }), 32);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.includes('no larger than'));
});

test('formatReleaseAdmissionResult is deterministic and operator-readable', () => {
  const result = evaluateReleaseAdmissionSnapshot(snapshot({ reviewThreads: [{ id: 'RT_1', resolved: false }] }));
  const first = formatReleaseAdmissionResult(result);
  const second = formatReleaseAdmissionResult(result);
  assert.equal(first, second);
  assert.ok(first.startsWith('Release admission snapshot: FAIL'));
  assert.ok(first.includes('candidate-review-threads'));
});

test('finding order is deterministic for the same malformed candidate fields', () => {
  const left = evaluateReleaseCandidate({ version: 0, checks: null });
  const right = evaluateReleaseCandidate({ checks: null, version: 0 });
  assert.deepEqual(left.findings, right.findings);
});

test('candidate baseline is exactly the five repository release-critical checks', () => {
  assert.deepEqual([...REQUIRED_RELEASE_CHECKS], [
    'Release QA',
    'Platform Architecture Audit',
    'Release Evidence Contract',
    'Platform Typed Test Validation',
    'Webclient Quality',
  ]);
});
