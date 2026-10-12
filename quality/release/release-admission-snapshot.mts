import fs from 'node:fs';
import process from 'node:process';
import {
  REQUIRED_CHECKS,
  evaluateReleaseCandidate,
  type ReleaseCandidateResult,
} from './release-candidate-gate.mts';
import {
  evaluateReleaseEvidenceQuorum,
  type ReleaseEvidenceQuorumResult,
} from './release-evidence-quorum.mts';

export const RELEASE_ADMISSION_SNAPSHOT_VERSION = 1 as const;
export const MAX_WORKFLOW_RUNS = 256;
export const MAX_REVIEW_THREADS = 256;
export const MAX_REF_LENGTH = 255;

export interface AdmissionFinding {
  readonly code: string;
  readonly field: string;
  readonly message: string;
  readonly severity: 'error';
}

export interface NormalizedMain {
  readonly headSha: string;
  readonly ref: string;
}

export interface NormalizedPullRequest {
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly draft: boolean;
  readonly mergeable: boolean;
  readonly additions: number;
  readonly deletions: number;
}

export interface NormalizedCompare {
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly status: 'ahead' | 'behind' | 'diverged' | 'identical';
}

export interface NormalizedReviewThread {
  readonly id: string;
  readonly resolved: boolean;
}

export type WorkflowRunEvidence = Readonly<Record<string, unknown>>;

export interface ReleaseAdmissionOptions {
  readonly requiredWorkflows?: readonly unknown[];
  readonly requiredChecks?: readonly unknown[];
}

export interface ReleaseAdmissionResult {
  readonly version: typeof RELEASE_ADMISSION_SNAPSHOT_VERSION;
  readonly passed: boolean;
  readonly mergeAllowed: boolean;
  readonly findings: readonly AdmissionFinding[];
  readonly candidate: ReleaseCandidateResult | null;
  readonly workflow: ReleaseEvidenceQuorumResult | null;
  readonly summary: {
    readonly errors: number;
    readonly workflowRuns: number;
    readonly reviewThreads: number;
  };
}

const SHA = /^[0-9a-f]{40}$/;
const COMPARE_STATUS = new Set<NormalizedCompare['status']>(['ahead', 'behind', 'diverged', 'identical']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value) as T;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    return Object.freeze(value);
  }
  return value;
}

function finding(code: string, field: string, message: string): AdmissionFinding {
  return deepFreeze({ code, field, message, severity: 'error' as const });
}

function clean(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

function normalizeSha(value: unknown): string | null {
  const normalized = clean(value, 40)?.toLowerCase() ?? null;
  return normalized && SHA.test(normalized) ? normalized : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function objectValue(
  value: unknown,
  field: string,
  findings: AdmissionFinding[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    findings.push(finding('object-invalid', field, `${field} must be an object.`));
    return null;
  }
  return value;
}

function normalizePullRequest(
  raw: unknown,
  findings: AdmissionFinding[],
): NormalizedPullRequest | null {
  const value = objectValue(raw, 'pullRequest', findings);
  if (!value) return null;
  const baseSha = normalizeSha(value.baseSha);
  const headSha = normalizeSha(value.headSha);
  const baseRef = clean(value.baseRef, MAX_REF_LENGTH);
  const headRef = clean(value.headRef, MAX_REF_LENGTH);
  const draft = booleanValue(value.draft);
  const mergeable = booleanValue(value.mergeable);
  const additions = value.additions;
  const deletions = value.deletions;

  if (!baseSha) findings.push(finding('pr-base-sha-invalid', 'pullRequest.baseSha', 'pullRequest.baseSha must be an exact 40-character SHA.'));
  if (!headSha) findings.push(finding('pr-head-sha-invalid', 'pullRequest.headSha', 'pullRequest.headSha must be an exact 40-character SHA.'));
  if (!baseRef) findings.push(finding('pr-base-ref-invalid', 'pullRequest.baseRef', 'pullRequest.baseRef must be a bounded non-control string.'));
  if (!headRef) findings.push(finding('pr-head-ref-invalid', 'pullRequest.headRef', 'pullRequest.headRef must be a bounded non-control string.'));
  if (draft === null) findings.push(finding('pr-draft-invalid', 'pullRequest.draft', 'pullRequest.draft must be boolean.'));
  if (mergeable === null) findings.push(finding('pr-mergeable-invalid', 'pullRequest.mergeable', 'pullRequest.mergeable must be boolean.'));
  if (!nonNegativeInteger(additions)) findings.push(finding('pr-additions-invalid', 'pullRequest.additions', 'pullRequest.additions must be a non-negative safe integer.'));
  if (!nonNegativeInteger(deletions)) findings.push(finding('pr-deletions-invalid', 'pullRequest.deletions', 'pullRequest.deletions must be a non-negative safe integer.'));

  if (
    !baseSha || !headSha || !baseRef || !headRef
    || draft === null || mergeable === null
    || !nonNegativeInteger(additions) || !nonNegativeInteger(deletions)
  ) return null;

  return deepFreeze({
    baseSha,
    headSha,
    baseRef,
    headRef,
    draft,
    mergeable,
    additions,
    deletions,
  });
}

function normalizeCompare(
  raw: unknown,
  findings: AdmissionFinding[],
): NormalizedCompare | null {
  const value = objectValue(raw, 'compare', findings);
  if (!value) return null;
  const baseSha = normalizeSha(value.baseSha);
  const headSha = normalizeSha(value.headSha);
  const mergeBaseSha = normalizeSha(value.mergeBaseSha);
  const aheadBy = value.aheadBy;
  const behindBy = value.behindBy;
  const rawStatus = clean(value.status, 40)?.toLowerCase() ?? null;
  const status = rawStatus && COMPARE_STATUS.has(rawStatus as NormalizedCompare['status'])
    ? rawStatus as NormalizedCompare['status']
    : null;

  if (!baseSha) findings.push(finding('compare-base-invalid', 'compare.baseSha', 'compare.baseSha must be an exact SHA.'));
  if (!headSha) findings.push(finding('compare-head-invalid', 'compare.headSha', 'compare.headSha must be an exact SHA.'));
  if (!mergeBaseSha) findings.push(finding('compare-merge-base-invalid', 'compare.mergeBaseSha', 'compare.mergeBaseSha must be an exact SHA.'));
  if (!nonNegativeInteger(aheadBy)) findings.push(finding('compare-ahead-invalid', 'compare.aheadBy', 'compare.aheadBy must be a non-negative safe integer.'));
  if (!nonNegativeInteger(behindBy)) findings.push(finding('compare-behind-invalid', 'compare.behindBy', 'compare.behindBy must be a non-negative safe integer.'));
  if (!status) findings.push(finding('compare-status-invalid', 'compare.status', 'compare.status must be ahead, behind, diverged, or identical.'));

  if (
    !baseSha || !headSha || !mergeBaseSha
    || !nonNegativeInteger(aheadBy) || !nonNegativeInteger(behindBy) || !status
  ) return null;
  return deepFreeze({ baseSha, headSha, mergeBaseSha, aheadBy, behindBy, status });
}

function normalizeMain(
  raw: unknown,
  findings: AdmissionFinding[],
): NormalizedMain | null {
  const value = objectValue(raw, 'main', findings);
  if (!value) return null;
  const headSha = normalizeSha(value.headSha);
  const ref = clean(value.ref, MAX_REF_LENGTH);
  if (!headSha) findings.push(finding('main-sha-invalid', 'main.headSha', 'main.headSha must be an exact SHA.'));
  if (!ref) findings.push(finding('main-ref-invalid', 'main.ref', 'main.ref must be a bounded non-control string.'));
  return headSha && ref ? deepFreeze({ headSha, ref }) : null;
}

function normalizeReviewThreads(
  raw: unknown,
  findings: AdmissionFinding[],
): readonly NormalizedReviewThread[] | null {
  if (!Array.isArray(raw)) {
    findings.push(finding('review-threads-invalid', 'reviewThreads', 'reviewThreads must be an array.'));
    return null;
  }
  if (raw.length > MAX_REVIEW_THREADS) {
    findings.push(finding('review-threads-limit', 'reviewThreads', `reviewThreads must contain at most ${MAX_REVIEW_THREADS} entries.`));
    return null;
  }

  const ids = new Set<string>();
  const normalized: NormalizedReviewThread[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      findings.push(finding('review-thread-invalid', `reviewThreads[${index}]`, 'Review thread must be an object.'));
      return;
    }
    const id = clean(item.id, 160);
    const resolved = booleanValue(item.resolved);
    if (!id) findings.push(finding('review-thread-id-invalid', `reviewThreads[${index}].id`, 'Review thread id must be a bounded non-control string.'));
    if (resolved === null) findings.push(finding('review-thread-resolved-invalid', `reviewThreads[${index}].resolved`, 'Review thread resolved must be boolean.'));
    if (id && ids.has(id)) findings.push(finding('review-thread-duplicate', `reviewThreads[${index}].id`, `Duplicate review thread id: ${id}.`));
    if (id && resolved !== null && !ids.has(id)) {
      ids.add(id);
      normalized.push(deepFreeze({ id, resolved }));
    }
  });
  return deepFreeze(normalized);
}

function normalizeWorkflowRuns(
  raw: unknown,
  findings: AdmissionFinding[],
): readonly WorkflowRunEvidence[] | null {
  if (!Array.isArray(raw)) {
    findings.push(finding('workflow-runs-invalid', 'workflowRuns', 'workflowRuns must be an array.'));
    return null;
  }
  if (raw.length > MAX_WORKFLOW_RUNS) {
    findings.push(finding('workflow-runs-limit', 'workflowRuns', `workflowRuns must contain at most ${MAX_WORKFLOW_RUNS} entries.`));
    return null;
  }
  const normalized: WorkflowRunEvidence[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      findings.push(finding('workflow-run-invalid', `workflowRuns[${index}]`, 'Workflow run must be an object.'));
      return;
    }
    normalized.push(deepFreeze({ ...item }));
  });
  return deepFreeze(normalized);
}

function crossValidate(
  main: NormalizedMain | null,
  pullRequest: NormalizedPullRequest | null,
  compare: NormalizedCompare | null,
  findings: AdmissionFinding[],
): void {
  if (!main || !pullRequest || !compare) return;
  if (main.ref !== 'main') findings.push(finding('main-ref-unexpected', 'main.ref', 'Release admission requires the main branch authority.'));
  if (pullRequest.baseRef !== 'main') findings.push(finding('pr-base-ref-unexpected', 'pullRequest.baseRef', 'Release candidate must target main.'));
  if (pullRequest.headRef === 'main') findings.push(finding('pr-head-ref-main', 'pullRequest.headRef', 'Release candidate head ref must not be main.'));
  if (pullRequest.baseSha !== main.headSha) findings.push(finding('pr-base-stale', 'pullRequest.baseSha', 'Pull request base SHA must equal current main.'));
  if (compare.baseSha !== main.headSha) findings.push(finding('compare-base-stale', 'compare.baseSha', 'Compare base SHA must equal current main.'));
  if (pullRequest.headSha !== compare.headSha) findings.push(finding('head-authority-mismatch', 'compare.headSha', 'Compare head SHA must equal pull request head SHA.'));
  if (compare.mergeBaseSha !== main.headSha) findings.push(finding('merge-base-stale', 'compare.mergeBaseSha', 'Compare merge-base must equal current main.'));
  if (compare.behindBy !== 0) findings.push(finding('compare-behind', 'compare.behindBy', 'Candidate must be zero commits behind current main.'));
  if (compare.aheadBy === 0) findings.push(finding('compare-empty', 'compare.aheadBy', 'Candidate must contain commits ahead of current main.'));
  if (compare.status !== 'ahead') findings.push(finding('compare-not-ahead', 'compare.status', `Candidate compare status must be ahead; observed ${compare.status}.`));
}

function runString(run: WorkflowRunEvidence, key: string): string | null {
  const value = run[key];
  return typeof value === 'string' ? value : null;
}

function runNumber(run: WorkflowRunEvidence, key: string): number {
  const value = run[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function candidateChecks(
  runs: readonly WorkflowRunEvidence[],
  headSha: string,
): readonly Readonly<Record<string, unknown>>[] {
  return REQUIRED_CHECKS.map(name => {
    const matches = runs
      .filter(run => runString(run, 'name') === name && runString(run, 'headSha')?.toLowerCase() === headSha)
      .sort((left, right) =>
        runNumber(right, 'attempt') - runNumber(left, 'attempt')
        || (Date.parse(runString(right, 'updatedAt') ?? '') || 0) - (Date.parse(runString(left, 'updatedAt') ?? '') || 0));
    const selected = matches[0];
    if (!selected) return { name, status: 'missing', conclusion: null, headSha };
    return {
      name,
      status: selected.status,
      conclusion: selected.conclusion,
      headSha,
    };
  });
}

function invalidResult(findings: readonly AdmissionFinding[]): ReleaseAdmissionResult {
  return deepFreeze({
    version: RELEASE_ADMISSION_SNAPSHOT_VERSION,
    passed: false,
    mergeAllowed: false,
    findings: [...findings],
    candidate: null,
    workflow: null,
    summary: { errors: findings.length, workflowRuns: 0, reviewThreads: 0 },
  });
}

export function evaluateReleaseAdmissionSnapshot(
  input: unknown,
  options: ReleaseAdmissionOptions = {},
): ReleaseAdmissionResult {
  const findings: AdmissionFinding[] = [];
  if (!isRecord(input)) {
    return invalidResult([finding('snapshot-invalid', '$', 'Release admission snapshot must be an object.')]);
  }
  if (!isRecord(options)) {
    return invalidResult([finding('policy-invalid', 'options', 'Release admission policy must be an object.')]);
  }
  if (input.version !== RELEASE_ADMISSION_SNAPSHOT_VERSION) {
    findings.push(finding('snapshot-version', 'version', `Snapshot version must be ${RELEASE_ADMISSION_SNAPSHOT_VERSION}.`));
  }

  const main = normalizeMain(input.main, findings);
  const pullRequest = normalizePullRequest(input.pullRequest, findings);
  const compare = normalizeCompare(input.compare, findings);
  const reviewThreads = normalizeReviewThreads(input.reviewThreads, findings);
  const workflowRuns = normalizeWorkflowRuns(input.workflowRuns, findings);
  crossValidate(main, pullRequest, compare, findings);

  let workflow: ReleaseEvidenceQuorumResult | null = null;
  let candidate: ReleaseCandidateResult | null = null;
  if (main && pullRequest && compare && reviewThreads && workflowRuns) {
    workflow = evaluateReleaseEvidenceQuorum({
      version: 1,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      currentMainSha: main.headSha,
      runs: workflowRuns,
      maxEvidenceAgeMs: input.maxEvidenceAgeMs,
      observedAt: input.observedAt,
    }, options.requiredWorkflows === undefined ? {} : { required: options.requiredWorkflows });
    for (const item of workflow.findings) {
      findings.push(finding(`workflow-${item.code}`, `workflow.${item.field}`, item.message));
    }

    candidate = evaluateReleaseCandidate({
      version: 1,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      mergeBaseSha: compare.mergeBaseSha,
      currentMainSha: main.headSha,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      aheadBy: compare.aheadBy,
      behindBy: compare.behindBy,
      unresolvedThreads: reviewThreads.filter(thread => !thread.resolved).length,
      mergeable: pullRequest.mergeable,
      draft: pullRequest.draft,
      checks: candidateChecks(workflowRuns, pullRequest.headSha),
    }, options.requiredChecks === undefined ? {} : { requiredChecks: options.requiredChecks });
    for (const item of candidate.findings) {
      findings.push(finding(`candidate-${item.code}`, `candidate.${item.field}`, item.message));
    }
  }

  const sorted = [...findings].sort((left, right) =>
    left.field.localeCompare(right.field, 'en')
    || left.code.localeCompare(right.code, 'en'));

  return deepFreeze({
    version: RELEASE_ADMISSION_SNAPSHOT_VERSION,
    passed: sorted.length === 0,
    mergeAllowed: sorted.length === 0 && candidate?.mergeAllowed === true && workflow?.passed === true,
    findings: sorted,
    candidate,
    workflow,
    summary: {
      errors: sorted.length,
      workflowRuns: workflowRuns?.length ?? 0,
      reviewThreads: reviewThreads?.length ?? 0,
    },
  });
}

export function parseReleaseAdmissionSnapshot(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) {
    throw new Error('Release admission snapshot must be UTF-8 JSON no larger than 2 MiB.');
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Release admission snapshot root must be an object.');
  return parsed;
}

export function formatReleaseAdmissionSnapshot(result: ReleaseAdmissionResult): string {
  return [
    `Release admission snapshot: ${result.passed ? 'PASS' : 'FAIL'} (${result.summary.errors} errors)`,
    ...result.findings.map(item => `ERROR ${item.code} ${item.field} — ${item.message}`),
  ].join('\n');
}

export function runReleaseAdmissionSnapshotCli(args: readonly string[] = process.argv.slice(2)): void {
  const index = args.indexOf('--file');
  const file = index >= 0 ? args[index + 1] : undefined;
  if (!file) throw new Error('Usage: release-admission-snapshot.mjs --file <snapshot.json> [--strict]');
  const result = evaluateReleaseAdmissionSnapshot(
    parseReleaseAdmissionSnapshot(fs.readFileSync(file, 'utf8')),
  );
  process.stdout.write(formatReleaseAdmissionSnapshot(result) + '\n');
  if (args.includes('--strict') && !result.passed) process.exitCode = 1;
}
