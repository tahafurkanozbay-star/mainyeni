import assert from 'node:assert/strict';
import test from 'node:test';
import { auditReleaseLineage, DEFAULT_RELEASE_LINEAGE_POLICY, type CheckSnapshot, type PullRequestSnapshot } from '../../tools/release-lineage-audit.mts';
const MAIN = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const basePr = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  baseRef: 'main', baseSha: MAIN, headSha: HEAD, mergeBaseSha: MAIN,
  additions: 4100, deletions: 25, changedFiles: 20, aheadBy: 8, behindBy: 0,
  mergeable: true, draft: false, ...overrides,
});
const greenChecks = (headSha = HEAD): readonly CheckSnapshot[] => [
  { name: 'Release QA', status: 'completed', conclusion: 'success', headSha },
  { name: 'QA Typed Release Diagnostics', status: 'completed', conclusion: 'success', headSha },
];
const codes = (report: ReturnType<typeof auditReleaseLineage>) => report.findings.map((item) => item.code);
test('passes only a current-main exact-head release candidate', () => {
  const report = auditReleaseLineage(basePr(), MAIN, greenChecks());
  assert.equal(report.passed, true); assert.equal(report.summary.errors, 0);
});
test('rejects a stale base SHA', () => {
  const report = auditReleaseLineage(basePr({ baseSha: 'old' }), MAIN, greenChecks());
  assert.equal(report.passed, false); assert.ok(codes(report).includes('stale-base-sha'));
});
test('rejects a stale merge base independently of base SHA', () => {
  const report = auditReleaseLineage(basePr({ mergeBaseSha: 'old' }), MAIN, greenChecks());
  assert.ok(codes(report).includes('stale-merge-base'));
});
test('rejects a branch behind main', () => {
  const report = auditReleaseLineage(basePr({ behindBy: 1 }), MAIN, greenChecks());
  assert.ok(codes(report).includes('branch-behind-main'));
});
test('rejects an empty candidate', () => {
  const report = auditReleaseLineage(basePr({ aheadBy: 0 }), MAIN, greenChecks());
  assert.ok(codes(report).includes('empty-release-candidate'));
});
test('counts additions only for the minimum gate', () => {
  const report = auditReleaseLineage(basePr({ additions: 3999, deletions: 9000 }), MAIN, greenChecks());
  assert.ok(codes(report).includes('minimum-additions-not-met'));
  assert.equal(report.summary.additionsSatisfied, false);
});
test('accepts the additions threshold exactly', () => {
  const report = auditReleaseLineage(basePr({ additions: 4000 }), MAIN, greenChecks());
  assert.equal(report.summary.additionsSatisfied, true);
});
test('rejects mergeable false', () => {
  const report = auditReleaseLineage(basePr({ mergeable: false }), MAIN, greenChecks());
  assert.ok(codes(report).includes('not-mergeable'));
});
test('rejects unknown mergeability fail closed', () => {
  const report = auditReleaseLineage(basePr({ mergeable: null }), MAIN, greenChecks());
  assert.ok(codes(report).includes('not-mergeable'));
});
test('rejects draft at final merge gate', () => {
  const report = auditReleaseLineage(basePr({ draft: true }), MAIN, greenChecks());
  assert.ok(codes(report).includes('draft-release-candidate'));
});
test('rejects successful checks from stale SHA', () => {
  const report = auditReleaseLineage(basePr(), MAIN, greenChecks('stale'));
  assert.ok(codes(report).includes('required-check-not-green-on-head'));
  assert.ok(codes(report).includes('stale-successful-checks-ignored'));
});
test('rejects pending required check', () => {
  const checks: CheckSnapshot[] = [...greenChecks()];
  checks[0] = { ...checks[0]!, status: 'in_progress', conclusion: null };
  const report = auditReleaseLineage(basePr(), MAIN, checks);
  assert.ok(codes(report).includes('required-check-not-green-on-head'));
});
test('rejects failed required check', () => {
  const checks: CheckSnapshot[] = [...greenChecks()];
  checks[1] = { ...checks[1]!, conclusion: 'failure' };
  const report = auditReleaseLineage(basePr(), MAIN, checks);
  assert.ok(codes(report).includes('required-check-not-green-on-head'));
});
test('required check names are case-insensitive but not substring matches', () => {
  const checks: CheckSnapshot[] = [
    { name: 'release qa', status: 'completed', conclusion: 'success', headSha: HEAD },
    { name: 'qa typed release diagnostics', status: 'completed', conclusion: 'success', headSha: HEAD },
  ];
  assert.equal(auditReleaseLineage(basePr(), MAIN, checks).summary.requiredChecksSatisfied, true);
  const bad = checks.map((item) => ({ ...item, name: `${item.name} extra` }));
  assert.equal(auditReleaseLineage(basePr(), MAIN, bad).summary.requiredChecksSatisfied, false);
});
test('wrong target branch is blocking', () => {
  const report = auditReleaseLineage(basePr({ baseRef: 'develop' }), MAIN, greenChecks());
  assert.ok(codes(report).includes('wrong-base-ref'));
});
test('custom policy can raise additions threshold and required checks', () => {
  const policy = { ...DEFAULT_RELEASE_LINEAGE_POLICY, minimumAdditions: 5000, requiredChecks: ['Release QA', 'Security Gate'] };
  const report = auditReleaseLineage(basePr({ additions: 4500 }), MAIN, greenChecks(), policy);
  assert.ok(codes(report).includes('minimum-additions-not-met'));
  assert.ok(codes(report).includes('required-check-not-green-on-head'));
});
test('unrelated successful checks do not satisfy required checks', () => {
  const checks: CheckSnapshot[] = [{ name: 'Unrelated', status: 'completed', conclusion: 'success', headSha: HEAD }];
  const report = auditReleaseLineage(basePr(), MAIN, checks);
  assert.equal(report.summary.requiredChecksSatisfied, false);
});
test('duplicate green required checks are harmless', () => {
  const checks = [...greenChecks(), ...greenChecks()];
  const report = auditReleaseLineage(basePr(), MAIN, checks);
  assert.equal(report.passed, true);
});
test('a foreign-head success is warning-only when exact-head checks are green', () => {
  const checks = [...greenChecks(), ...greenChecks('old-head')];
  const report = auditReleaseLineage(basePr(), MAIN, checks);
  assert.equal(report.passed, true);
  assert.ok(codes(report).includes('stale-successful-checks-ignored'));
  assert.equal(report.summary.warnings, 1);
});
