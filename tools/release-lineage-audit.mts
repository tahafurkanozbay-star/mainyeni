#!/usr/bin/env node
export type PullRequestSnapshot = Readonly<{
  baseRef: string; baseSha: string; headSha: string; mergeBaseSha: string;
  additions: number; deletions: number; changedFiles: number;
  aheadBy: number; behindBy: number; mergeable: boolean | null; draft: boolean;
}>;
export type CheckSnapshot = Readonly<{ name: string; status: string; conclusion: string | null; headSha: string }>;
export type ReleaseLineagePolicy = Readonly<{
  requiredBaseRef: string; minimumAdditions: number; requiredChecks: readonly string[];
  requireExactMergeBase: boolean; requireZeroBehind: boolean; requireMergeable: boolean; forbidDraftMerge: boolean;
}>;
export type LineageFinding = Readonly<{
  severity: 'error' | 'warning' | 'info'; code: string; message: string; detail?: Readonly<Record<string, unknown>>;
}>;
export type ReleaseLineageReport = Readonly<{
  passed: boolean; findings: readonly LineageFinding[];
  summary: Readonly<{ errors: number; warnings: number; infos: number; exactMergeBase: boolean; zeroBehind: boolean; additionsSatisfied: boolean; requiredChecksSatisfied: boolean }>;
}>;
export const DEFAULT_RELEASE_LINEAGE_POLICY: ReleaseLineagePolicy = Object.freeze({
  requiredBaseRef: 'main', minimumAdditions: 4000,
  requiredChecks: Object.freeze(['Release QA', 'QA Typed Release Diagnostics']),
  requireExactMergeBase: true, requireZeroBehind: true, requireMergeable: true, forbidDraftMerge: true,
});
const finding = (severity: LineageFinding['severity'], code: string, message: string, detail?: Readonly<Record<string, unknown>>): LineageFinding => Object.freeze(detail === undefined ? { severity, code, message } : { severity, code, message, detail });
const normalized = (value: string) => value.trim().toLowerCase();
const successfulCheckForHead = (checks: readonly CheckSnapshot[], requiredName: string, headSha: string): boolean => checks.some((check) =>
  normalized(check.name) === normalized(requiredName) && check.headSha === headSha
  && normalized(check.status) === 'completed' && normalized(check.conclusion ?? '') === 'success');
export const auditReleaseLineage = (
  pullRequest: PullRequestSnapshot, currentMainSha: string, checks: readonly CheckSnapshot[],
  policy: ReleaseLineagePolicy = DEFAULT_RELEASE_LINEAGE_POLICY,
): ReleaseLineageReport => {
  const findings: LineageFinding[] = [];
  const exactMergeBase = pullRequest.mergeBaseSha === currentMainSha;
  const zeroBehind = pullRequest.behindBy === 0;
  const additionsSatisfied = pullRequest.additions >= policy.minimumAdditions;
  if (pullRequest.baseRef !== policy.requiredBaseRef) findings.push(finding('error', 'wrong-base-ref', 'Release candidate targets an unexpected base branch.', { expected: policy.requiredBaseRef, actual: pullRequest.baseRef }));
  if (pullRequest.baseSha !== currentMainSha) findings.push(finding('error', 'stale-base-sha', 'PR base SHA is not current main.', { currentMainSha, baseSha: pullRequest.baseSha }));
  if (policy.requireExactMergeBase && !exactMergeBase) findings.push(finding('error', 'stale-merge-base', 'PR merge-base is not current main.', { currentMainSha, mergeBaseSha: pullRequest.mergeBaseSha }));
  if (policy.requireZeroBehind && !zeroBehind) findings.push(finding('error', 'branch-behind-main', 'Release candidate is behind current main.', { behindBy: pullRequest.behindBy }));
  if (pullRequest.aheadBy <= 0) findings.push(finding('error', 'empty-release-candidate', 'Release candidate has no commits ahead of main.'));
  if (!additionsSatisfied) findings.push(finding('error', 'minimum-additions-not-met', 'Meaningful additions gate is not satisfied.', { minimum: policy.minimumAdditions, actual: pullRequest.additions, deletions: pullRequest.deletions, changedFiles: pullRequest.changedFiles }));
  if (policy.requireMergeable && pullRequest.mergeable !== true) findings.push(finding('error', 'not-mergeable', 'GitHub does not report the release candidate as mergeable.', { mergeable: pullRequest.mergeable }));
  if (policy.forbidDraftMerge && pullRequest.draft) findings.push(finding('error', 'draft-release-candidate', 'Draft PR cannot pass the final merge gate.'));
  const missingChecks = policy.requiredChecks.filter((required) => !successfulCheckForHead(checks, required, pullRequest.headSha));
  if (missingChecks.length > 0) findings.push(finding('error', 'required-check-not-green-on-head', 'Required checks are not successful on the exact PR head.', { headSha: pullRequest.headSha, missingChecks }));
  const staleSuccesses = checks.filter((check) => check.headSha !== pullRequest.headSha && normalized(check.status) === 'completed' && normalized(check.conclusion ?? '') === 'success' && policy.requiredChecks.some((required) => normalized(required) === normalized(check.name)));
  if (staleSuccesses.length > 0) findings.push(finding('warning', 'stale-successful-checks-ignored', 'Successful checks from another SHA were ignored.', { count: staleSuccesses.length }));
  const errors = findings.filter((item) => item.severity === 'error').length;
  const warnings = findings.filter((item) => item.severity === 'warning').length;
  const infos = findings.filter((item) => item.severity === 'info').length;
  return Object.freeze({ passed: errors === 0, findings: Object.freeze(findings), summary: Object.freeze({ errors, warnings, infos, exactMergeBase, zeroBehind, additionsSatisfied, requiredChecksSatisfied: missingChecks.length === 0 }) });
};
export const formatReleaseLineageMarkdown = (report: ReleaseLineageReport): string => [
  '# Release Lineage Audit', '', `Gate: **${report.passed ? 'PASS' : 'FAIL'}**`, '',
  `- Errors / warnings / info: **${report.summary.errors} / ${report.summary.warnings} / ${report.summary.infos}**`,
  `- Exact current-main merge-base: **${report.summary.exactMergeBase ? 'yes' : 'no'}**`,
  `- Zero commits behind main: **${report.summary.zeroBehind ? 'yes' : 'no'}**`,
  `- Additions threshold satisfied: **${report.summary.additionsSatisfied ? 'yes' : 'no'}**`,
  `- Exact-head required checks green: **${report.summary.requiredChecksSatisfied ? 'yes' : 'no'}**`, '', '## Findings', '',
  ...(report.findings.length ? report.findings.map((item) => `- **${item.severity.toUpperCase()} ${item.code}** — ${item.message}`) : ['- none']), '',
].join('\n');
