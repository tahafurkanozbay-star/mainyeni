import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_MEANINGFUL_ADDITIONS,
  REQUIRED_CHECKS,
  evaluateReleaseCandidate,
  formatReleaseCandidateResult,
  parseCandidateJson,
} from './release-candidate-gate.mjs';

const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function candidate(overrides = {}) {
  return {
    version: 1,
    baseSha: MAIN,
    headSha: HEAD,
    mergeBaseSha: MAIN,
    currentMainSha: MAIN,
    additions: MIN_MEANINGFUL_ADDITIONS,
    deletions: 12,
    aheadBy: 4,
    behindBy: 0,
    unresolvedThreads: 0,
    mergeable: true,
    draft: false,
    checks: REQUIRED_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success', headSha: HEAD })),
    ...overrides,
  };
}

function codes(result) {
  return new Set(result.findings.map(item => item.code));
}

function expectCode(input, code) {
  const result = evaluateReleaseCandidate(input);
  assert.equal(result.passed, false);
  assert.equal(result.mergeAllowed, false);
  assert.ok(codes(result).has(code), `expected ${code}: ${formatReleaseCandidateResult(result)}`);
  return result;
}

test('accepts exact-head, fresh-main, successful candidate at additions threshold', () => {
  const result = evaluateReleaseCandidate(candidate());
  assert.equal(result.passed, true);
  assert.equal(result.mergeAllowed, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.additionsRequired, 4000);
  assert.deepEqual(result.summary.requiredChecks, REQUIRED_CHECKS);
});

test('accepts additions above threshold regardless of deletions', () => {
  const result = evaluateReleaseCandidate(candidate({ additions: 8123, deletions: 9999 }));
  assert.equal(result.passed, true);
});

test('rejects 3999 additions even when changed-lines would exceed threshold', () => {
  const result = expectCode(candidate({ additions: 3999, deletions: 9000 }), 'additions-gate');
  assert.match(formatReleaseCandidateResult(result), /observed 3999/);
});

test('rejects stale PR base', () => {
  expectCode(candidate({ baseSha: OTHER }), 'base-stale');
});

test('rejects stale merge base independently of PR base', () => {
  expectCode(candidate({ mergeBaseSha: OTHER }), 'merge-base-stale');
});

test('rejects branch behind current main', () => {
  expectCode(candidate({ behindBy: 1 }), 'branch-behind');
});

test('rejects empty branch', () => {
  expectCode(candidate({ aheadBy: 0 }), 'branch-empty');
});

test('rejects candidate head equal to main', () => {
  expectCode(candidate({ headSha: MAIN, checks: REQUIRED_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success', headSha: MAIN })) }), 'head-equals-main');
});

test('rejects GitHub mergeable false', () => {
  expectCode(candidate({ mergeable: false }), 'not-mergeable');
});

test('rejects draft candidate', () => {
  expectCode(candidate({ draft: true }), 'draft');
});

test('rejects unresolved review threads', () => {
  expectCode(candidate({ unresolvedThreads: 2 }), 'review-threads');
});

test('requires every mandatory check', () => {
  const checks = candidate().checks.slice(0, 1);
  const result = expectCode(candidate({ checks }), 'required-check-missing');
  assert.match(formatReleaseCandidateResult(result), /Required check is missing/);
});

test('rejects check bound to stale head', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, headSha: OTHER } : check);
  expectCode(candidate({ checks }), 'check-head-mismatch');
});

test('rejects queued required check as pending', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, status: 'queued', conclusion: null } : check);
  expectCode(candidate({ checks }), 'check-pending');
});

test('rejects in-progress required check as pending', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, status: 'in_progress', conclusion: null } : check);
  expectCode(candidate({ checks }), 'check-pending');
});

test('rejects completed failure', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'failure' } : check);
  expectCode(candidate({ checks }), 'check-failed');
});

test('rejects completed cancellation', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'cancelled' } : check);
  expectCode(candidate({ checks }), 'check-failed');
});

test('rejects completed check with null conclusion', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: null } : check);
  expectCode(candidate({ checks }), 'check-conclusion');
});

test('rejects duplicate check names because evidence is ambiguous', () => {
  const base = candidate();
  expectCode(candidate({ checks: [...base.checks, base.checks[0]] }), 'duplicate-check');
});

test('custom required check set can strengthen policy', () => {
  const name = 'Webclient Quality';
  const input = candidate({ checks: [...candidate().checks, { name, status: 'completed', conclusion: 'success', headSha: HEAD }] });
  const result = evaluateReleaseCandidate(input, { requiredChecks: [...REQUIRED_CHECKS, name] });
  assert.equal(result.passed, true);
  assert.ok(result.summary.requiredChecks.includes(name));
});

test('custom required check set fails closed when evidence is absent', () => {
  const result = evaluateReleaseCandidate(candidate(), { requiredChecks: [...REQUIRED_CHECKS, 'Webclient Quality'] });
  assert.equal(result.passed, false);
  assert.ok(codes(result).has('required-check-missing'));
});

test('invalid candidate root fails closed', () => {
  for (const value of [null, undefined, [], 'candidate', 42]) expectCode(value, 'candidate-invalid');
});

test('unsupported schema version fails closed', () => {
  expectCode(candidate({ version: 2 }), 'version-unsupported');
});

test('invalid SHAs fail closed', () => {
  for (const value of ['', 'abc', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
    expectCode(candidate({ headSha: value }), 'sha-invalid');
  }
});

test('uppercase hexadecimal SHA is normalized and accepted', () => {
  const upperHead = HEAD.toUpperCase();
  const input = candidate({ headSha: upperHead, checks: REQUIRED_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success', headSha: upperHead })) });
  assert.equal(evaluateReleaseCandidate(input).passed, true);
});

test('unsafe control characters in SHA fail closed', () => {
  expectCode(candidate({ headSha: `${'b'.repeat(39)}\n` }), 'sha-invalid');
});

test('negative numeric evidence fails closed', () => {
  for (const field of ['additions', 'deletions', 'aheadBy', 'behindBy', 'unresolvedThreads']) {
    expectCode(candidate({ [field]: -1 }), 'integer-invalid');
  }
});

test('fractional numeric evidence fails closed', () => {
  for (const field of ['additions', 'deletions', 'aheadBy', 'behindBy', 'unresolvedThreads']) {
    expectCode(candidate({ [field]: 1.5 }), 'integer-invalid');
  }
});

test('unsafe integers fail closed', () => {
  expectCode(candidate({ additions: Number.MAX_SAFE_INTEGER + 1 }), 'integer-invalid');
});

test('NaN and Infinity fail closed', () => {
  expectCode(candidate({ additions: Number.NaN }), 'integer-invalid');
  expectCode(candidate({ additions: Number.POSITIVE_INFINITY }), 'integer-invalid');
});

test('string numeric evidence is not coerced', () => {
  expectCode(candidate({ additions: '4000' }), 'integer-invalid');
});

test('mergeable must be an actual boolean', () => {
  expectCode(candidate({ mergeable: 'true' }), 'mergeable-invalid');
});

test('draft must be an actual boolean', () => {
  expectCode(candidate({ draft: 0 }), 'draft-invalid');
});

test('checks must be an array', () => {
  expectCode(candidate({ checks: {} }), 'checks-invalid');
});

test('malformed check objects are rejected', () => {
  const checks = [...candidate().checks, null];
  expectCode(candidate({ checks }), 'check-invalid');
});

test('check names reject empty values', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, name: '   ' } : check);
  expectCode(candidate({ checks }), 'check-name-invalid');
});

test('check status rejects control characters', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, status: 'completed\nspoof' } : check);
  expectCode(candidate({ checks }), 'check-status-invalid');
});

test('check conclusion rejects control characters', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'success\nspoof' } : check);
  expectCode(candidate({ checks }), 'check-conclusion-invalid');
});

test('check head must be exact SHA', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, headSha: 'b'.repeat(39) } : check);
  expectCode(candidate({ checks }), 'check-head-invalid');
});

test('findings are deterministically sorted', () => {
  const result = evaluateReleaseCandidate(candidate({ additions: 1, behindBy: 3, draft: true, mergeable: false, unresolvedThreads: 4 }));
  const keys = result.findings.map(item => `${item.field}:${item.code}`);
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
});

test('result and nested findings are immutable', () => {
  const result = evaluateReleaseCandidate(candidate({ additions: 1 }));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.findings), true);
  assert.equal(Object.isFrozen(result.findings[0]), true);
  assert.equal(Object.isFrozen(result.summary), true);
});

test('format is stable and does not serialize candidate payload', () => {
  const input = candidate({ additions: 1 });
  input.secret = 'must-not-appear';
  const output = formatReleaseCandidateResult(evaluateReleaseCandidate(input));
  assert.match(output, /^Release candidate gate: FAIL/);
  assert.doesNotMatch(output, /must-not-appear/);
});

test('parseCandidateJson accepts bounded object JSON', () => {
  assert.deepEqual(parseCandidateJson('{"version":1}'), { version: 1 });
});

test('parseCandidateJson rejects arrays and primitive roots', () => {
  for (const text of ['[]', 'null', '42', '"x"']) assert.throws(() => parseCandidateJson(text), /root must be an object/);
});

test('parseCandidateJson rejects invalid JSON', () => {
  assert.throws(() => parseCandidateJson('{'), SyntaxError);
});

test('parseCandidateJson enforces one MiB input bound', () => {
  assert.throws(() => parseCandidateJson(`{"x":"${'a'.repeat(1024 * 1024)}"}`), /no larger than 1 MiB/);
});

test('multiple independent release failures are all reported', () => {
  const result = evaluateReleaseCandidate(candidate({
    baseSha: OTHER,
    mergeBaseSha: OTHER,
    additions: 1,
    behindBy: 2,
    unresolvedThreads: 3,
    mergeable: false,
    draft: true,
  }));
  const observed = codes(result);
  for (const code of ['base-stale', 'merge-base-stale', 'additions-gate', 'branch-behind', 'review-threads', 'not-mergeable', 'draft']) {
    assert.ok(observed.has(code), `missing ${code}`);
  }
});

test('deletions do not offset additions gate', () => {
  const result = evaluateReleaseCandidate(candidate({ additions: 3999, deletions: 0 }));
  assert.ok(codes(result).has('additions-gate'));
  const resultWithDeletion = evaluateReleaseCandidate(candidate({ additions: 3999, deletions: 100000 }));
  assert.ok(codes(resultWithDeletion).has('additions-gate'));
});

test('check evidence for unrelated checks does not satisfy required checks', () => {
  const checks = [{ name: 'Unrelated', status: 'completed', conclusion: 'success', headSha: HEAD }];
  const result = evaluateReleaseCandidate(candidate({ checks }));
  assert.equal(result.passed, false);
  assert.equal(result.findings.filter(item => item.code === 'required-check-missing').length, REQUIRED_CHECKS.length);
});

test('completed neutral is not success', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'neutral' } : check);
  expectCode(candidate({ checks }), 'check-conclusion');
});

test('completed skipped is not success', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'skipped' } : check);
  expectCode(candidate({ checks }), 'check-conclusion');
});

test('requested check state is pending', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, status: 'requested', conclusion: null } : check);
  expectCode(candidate({ checks }), 'check-pending');
});

test('waiting check state is pending', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, status: 'waiting', conclusion: null } : check);
  expectCode(candidate({ checks }), 'check-pending');
});

test('unknown nonterminal check state fails closed', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, status: 'mystery', conclusion: null } : check);
  expectCode(candidate({ checks }), 'check-status');
});

test('timed out conclusion is terminal failure', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'timed_out' } : check);
  expectCode(candidate({ checks }), 'check-failed');
});

test('stale conclusion is terminal failure', () => {
  const checks = candidate().checks.map((check, index) => index === 0 ? { ...check, conclusion: 'stale' } : check);
  expectCode(candidate({ checks }), 'check-failed');
});
