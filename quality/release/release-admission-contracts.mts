export const RELEASE_ADMISSION_VERSION = 2 as const;
export const MIN_MEANINGFUL_ADDITIONS = 4_000;
export const MAX_CHECK_EVIDENCE = 64;
export const MAX_WORKFLOW_RUNS = 256;
export const MAX_REVIEW_THREADS = 256;
export const MAX_REF_LENGTH = 255;
export const DEFAULT_MAX_EVIDENCE_AGE_MS = 30 * 60 * 1_000;
export const DEFAULT_MAX_PR_METADATA_AGE_MS = 15 * 60 * 1_000;

export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  'Release QA',
  'Platform Architecture Audit',
  'Release Evidence Contract',
  'Platform Typed Test Validation',
  'Webclient Quality',
] as const);

export type ReleaseCheckName = string;
export type ReleaseFindingSeverity = 'error';
export type PullRequestState = 'open' | 'closed';
export type CompareStatus = 'ahead' | 'behind' | 'diverged' | 'identical';
export type WorkflowStatus = 'queued' | 'in_progress' | 'pending' | 'requested' | 'waiting' | 'completed';
export type WorkflowConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'startup_failure' | 'stale' | 'neutral' | 'skipped' | null;

export interface ReleaseFinding {
  readonly code: string;
  readonly field: string;
  readonly message: string;
  readonly severity: ReleaseFindingSeverity;
}

export interface ReleaseCheckEvidence {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
}

export interface ReleaseCandidateEvidence {
  readonly version: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly currentMainSha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly unresolvedThreads: number;
  readonly mergeable: boolean;
  readonly draft: boolean;
  readonly checks: readonly ReleaseCheckEvidence[];
}

export interface ReleaseCandidatePolicy {
  readonly requiredChecks?: readonly string[];
  readonly minimumAdditions?: number;
}

export interface ReleaseCandidateResult {
  readonly version: typeof RELEASE_ADMISSION_VERSION;
  readonly passed: boolean;
  readonly mergeAllowed: boolean;
  readonly findings: readonly ReleaseFinding[];
  readonly summary: Readonly<{
    errors: number;
    total: number;
    additionsRequired: number;
    requiredChecks: readonly string[];
  }>;
}

export interface WorkflowRunEvidence {
  readonly name: string;
  readonly headSha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runId: number;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface NormalizedWorkflowRun extends WorkflowRunEvidence {
  readonly created: number;
  readonly updated: number;
}

export interface WorkflowEvidenceInput {
  readonly version: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly currentMainSha: string;
  readonly runs: readonly WorkflowRunEvidence[];
  readonly maxEvidenceAgeMs: number;
  readonly observedAt: string;
}

export interface WorkflowEvidencePolicy {
  readonly required?: readonly string[];
}

export interface WorkflowEvidenceResult {
  readonly version: typeof RELEASE_ADMISSION_VERSION;
  readonly passed: boolean;
  readonly findings: readonly ReleaseFinding[];
  readonly summary: Readonly<{
    errors: number;
    total: number;
    required: readonly string[];
  }>;
}

export interface PullRequestLifecycleInput {
  readonly version: number;
  readonly number: number;
  readonly state: PullRequestState;
  readonly merged: boolean;
  readonly draft: boolean;
  readonly mergeable: boolean;
  readonly baseSha: string;
  readonly headSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly observedAt: string;
}

export interface PullRequestLifecyclePolicy {
  readonly expectedNumber?: number;
  readonly expectedHeadSha?: string;
  readonly expectedBaseSha?: string;
  readonly maxMetadataAgeMs?: number;
}

export interface PullRequestLifecycleResult {
  readonly version: typeof RELEASE_ADMISSION_VERSION;
  readonly passed: boolean;
  readonly mergeAllowed: boolean;
  readonly findings: readonly ReleaseFinding[];
  readonly summary: Readonly<{ errors: number }>;
}

export interface ReviewThreadEvidence {
  readonly id: string;
  readonly resolved: boolean;
}

export interface ReleaseAdmissionSnapshotInput {
  readonly version: number;
  readonly main: Readonly<{ headSha: string; ref: string }>;
  readonly pullRequest: Readonly<{
    baseSha: string;
    headSha: string;
    baseRef: string;
    headRef: string;
    draft: boolean;
    mergeable: boolean;
    additions: number;
    deletions: number;
  }>;
  readonly compare: Readonly<{
    baseSha: string;
    headSha: string;
    mergeBaseSha: string;
    aheadBy: number;
    behindBy: number;
    status: CompareStatus;
  }>;
  readonly reviewThreads: readonly ReviewThreadEvidence[];
  readonly workflowRuns: readonly WorkflowRunEvidence[];
  readonly maxEvidenceAgeMs: number;
  readonly observedAt: string;
}

export interface ReleaseAdmissionSnapshotPolicy {
  readonly requiredChecks?: readonly string[];
  readonly requiredWorkflows?: readonly string[];
  readonly minimumAdditions?: number;
}

export interface ReleaseAdmissionSnapshotResult {
  readonly version: typeof RELEASE_ADMISSION_VERSION;
  readonly passed: boolean;
  readonly mergeAllowed: boolean;
  readonly findings: readonly ReleaseFinding[];
  readonly candidate: ReleaseCandidateResult | null;
  readonly workflow: WorkflowEvidenceResult | null;
  readonly summary: Readonly<{
    errors: number;
    workflowRuns: number;
    reviewThreads: number;
  }>;
}

type UnknownRecord = Record<string, unknown>;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/()\-]{0,119}$/;
const SAFE_REF = /^[^\u0000-\u001f\u007f]{1,255}$/;
const CANONICAL_UTC = /^(?:\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const SUCCESS = new Set(['success']);
const FAILURE = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const PENDING = new Set(['queued', 'in_progress', 'pending', 'requested', 'waiting']);
const COMPARE_STATUSES = new Set<CompareStatus>(['ahead', 'behind', 'diverged', 'identical']);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as UnknownRecord)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function finding(code: string, field: string, message: string): ReleaseFinding {
  return Object.freeze({ code, field, message, severity: 'error' as const });
}

function cleanText(value: unknown, maximum = 160): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function exactText(value: unknown, maximum = 160): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function exactSha(value: unknown): string | null {
  const normalized = cleanText(value, 40)?.toLowerCase();
  return normalized && SHA_PATTERN.test(normalized) ? normalized : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0;
}

function boolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function timestamp(value: unknown): { text: string; millis: number } | null {
  const text = exactText(value, 64);
  if (!text || !CANONICAL_UTC.test(text)) return null;
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== text) return null;
  return { text, millis };
}

function normalizedRequiredNames(
  value: unknown,
  field: string,
  findings: ReleaseFinding[],
): readonly string[] {
  if (value === undefined) return freezeArray(REQUIRED_RELEASE_CHECKS);
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECK_EVIDENCE) {
    findings.push(finding('required-list-invalid', field, `${field} must contain 1-${MAX_CHECK_EVIDENCE} workflow/check names.`));
    return freezeArray(REQUIRED_RELEASE_CHECKS);
  }
  const effective = new Set<string>(REQUIRED_RELEASE_CHECKS);
  const caller = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const name = exactText(value[index], 120);
    if (!name || !SAFE_NAME.test(name)) {
      findings.push(finding('required-name-invalid', `${field}[${index}]`, 'Required workflow/check name is invalid.'));
      continue;
    }
    if (caller.has(name)) {
      findings.push(finding('required-name-duplicate', field, `Required workflow/check is duplicated: ${name}.`));
      continue;
    }
    caller.add(name);
    effective.add(name);
  }
  if (effective.size > MAX_CHECK_EVIDENCE) {
    findings.push(finding('required-list-expanded-limit', field, `Effective required policy exceeds ${MAX_CHECK_EVIDENCE} names.`));
  }
  return freezeArray([...effective].slice(0, MAX_CHECK_EVIDENCE));
}

function normalizedMinimumAdditions(value: unknown, findings: ReleaseFinding[]): number {
  if (value === undefined) return MIN_MEANINGFUL_ADDITIONS;
  if (!nonNegativeInteger(value) || value < MIN_MEANINGFUL_ADDITIONS) {
    findings.push(finding(
      'minimum-additions-policy-invalid',
      'policy.minimumAdditions',
      `minimumAdditions cannot weaken the mandatory ${MIN_MEANINGFUL_ADDITIONS} additions gate.`,
    ));
    return MIN_MEANINGFUL_ADDITIONS;
  }
  return value;
}

function normalizeCheck(raw: unknown, index: number, findings: ReleaseFinding[]): ReleaseCheckEvidence | null {
  if (!isRecord(raw)) {
    findings.push(finding('check-invalid', `checks[${index}]`, 'Check evidence must be an object.'));
    return null;
  }
  const name = exactText(raw.name, 120);
  const status = cleanText(raw.status, 40)?.toLowerCase() ?? null;
  const conclusion = raw.conclusion === null || raw.conclusion === undefined
    ? null
    : cleanText(raw.conclusion, 40)?.toLowerCase() ?? null;
  const headSha = exactSha(raw.headSha);
  if (!name || !SAFE_NAME.test(name)) findings.push(finding('check-name-invalid', `checks[${index}].name`, 'Check name is invalid.'));
  if (!status) findings.push(finding('check-status-invalid', `checks[${index}].status`, 'Check status is invalid.'));
  if (raw.conclusion !== null && raw.conclusion !== undefined && !conclusion) {
    findings.push(finding('check-conclusion-invalid', `checks[${index}].conclusion`, 'Check conclusion is invalid.'));
  }
  if (!headSha) findings.push(finding('check-head-invalid', `checks[${index}].headSha`, 'Check must be bound to an exact 40-character SHA.'));
  if (!name || !SAFE_NAME.test(name) || !status || !headSha) return null;
  return deepFreeze({ name, status, conclusion, headSha });
}

function normalizeCandidate(raw: unknown, findings: ReleaseFinding[]): ReleaseCandidateEvidence | null {
  if (!isRecord(raw)) {
    findings.push(finding('candidate-invalid', '$', 'Release candidate must be an object.'));
    return null;
  }
  if (raw.version !== RELEASE_ADMISSION_VERSION) {
    findings.push(finding('version-unsupported', 'version', `Release admission version must be ${RELEASE_ADMISSION_VERSION}.`));
  }
  const baseSha = exactSha(raw.baseSha);
  const headSha = exactSha(raw.headSha);
  const mergeBaseSha = exactSha(raw.mergeBaseSha);
  const currentMainSha = exactSha(raw.currentMainSha);
  const mergeable = boolean(raw.mergeable);
  const draft = boolean(raw.draft);
  for (const [field, value] of Object.entries({ baseSha, headSha, mergeBaseSha, currentMainSha })) {
    if (!value) findings.push(finding('sha-invalid', field, `${field} must be an exact 40-character Git SHA.`));
  }
  for (const field of ['additions', 'deletions', 'aheadBy', 'behindBy', 'unresolvedThreads'] as const) {
    if (!nonNegativeInteger(raw[field])) findings.push(finding('integer-invalid', field, `${field} must be a non-negative safe integer.`));
  }
  if (mergeable === null) findings.push(finding('mergeable-invalid', 'mergeable', 'mergeable must be boolean.'));
  if (draft === null) findings.push(finding('draft-invalid', 'draft', 'draft must be boolean.'));
  if (!Array.isArray(raw.checks)) findings.push(finding('checks-invalid', 'checks', 'checks must be an array.'));
  else if (raw.checks.length > MAX_CHECK_EVIDENCE) findings.push(finding('checks-limit', 'checks', `checks must contain at most ${MAX_CHECK_EVIDENCE} entries.`));
  const checks = Array.isArray(raw.checks) && raw.checks.length <= MAX_CHECK_EVIDENCE
    ? raw.checks.map((item, index) => normalizeCheck(item, index, findings)).filter((item): item is ReleaseCheckEvidence => item !== null)
    : [];
  if (!baseSha || !headSha || !mergeBaseSha || !currentMainSha || mergeable === null || draft === null) return null;
  if (!nonNegativeInteger(raw.additions) || !nonNegativeInteger(raw.deletions) || !nonNegativeInteger(raw.aheadBy) || !nonNegativeInteger(raw.behindBy) || !nonNegativeInteger(raw.unresolvedThreads)) return null;
  return deepFreeze({
    version: RELEASE_ADMISSION_VERSION,
    baseSha,
    headSha,
    mergeBaseSha,
    currentMainSha,
    additions: raw.additions,
    deletions: raw.deletions,
    aheadBy: raw.aheadBy,
    behindBy: raw.behindBy,
    unresolvedThreads: raw.unresolvedThreads,
    mergeable,
    draft,
    checks,
  });
}

export function evaluateReleaseCandidate(
  input: unknown,
  policy: unknown = {},
): ReleaseCandidateResult {
  const findings: ReleaseFinding[] = [];
  const policyRecord = isRecord(policy) ? policy : null;
  if (!policyRecord) findings.push(finding('policy-invalid', 'policy', 'Release candidate policy must be an object.'));
  const candidate = normalizeCandidate(input, findings);
  const requiredChecks = normalizedRequiredNames(policyRecord?.requiredChecks, 'policy.requiredChecks', findings);
  const minimumAdditions = normalizedMinimumAdditions(policyRecord?.minimumAdditions, findings);
  if (candidate) {
    if (candidate.baseSha !== candidate.currentMainSha) findings.push(finding('base-stale', 'baseSha', 'PR base SHA is not current main.'));
    if (candidate.mergeBaseSha !== candidate.currentMainSha) findings.push(finding('merge-base-stale', 'mergeBaseSha', 'Merge-base must equal current main.'));
    if (candidate.behindBy !== 0) findings.push(finding('branch-behind', 'behindBy', 'Candidate branch must be zero commits behind current main.'));
    if (candidate.aheadBy === 0) findings.push(finding('branch-empty', 'aheadBy', 'Candidate must contain at least one commit ahead of main.'));
    if (candidate.headSha === candidate.currentMainSha) findings.push(finding('head-equals-main', 'headSha', 'Candidate head must differ from current main.'));
    if (candidate.additions < minimumAdditions) findings.push(finding('additions-gate', 'additions', `Candidate requires at least ${minimumAdditions} meaningful additions; observed ${candidate.additions}.`));
    if (!candidate.mergeable) findings.push(finding('not-mergeable', 'mergeable', 'GitHub must report mergeable=true.'));
    if (candidate.draft) findings.push(finding('draft', 'draft', 'Candidate must be ready for review before merge.'));
    if (candidate.unresolvedThreads !== 0) findings.push(finding('review-threads', 'unresolvedThreads', 'All review threads must be resolved before merge.'));
    const byName = new Map<string, ReleaseCheckEvidence>();
    for (const check of candidate.checks) {
      if (byName.has(check.name)) {
        findings.push(finding('duplicate-check', 'checks', `Duplicate check evidence is ambiguous: ${check.name}.`));
        continue;
      }
      byName.set(check.name, check);
    }
    for (const name of requiredChecks) {
      const check = byName.get(name);
      if (!check) {
        findings.push(finding('required-check-missing', 'checks', `Required check is missing: ${name}.`));
        continue;
      }
      if (check.headSha !== candidate.headSha) findings.push(finding('check-head-mismatch', 'checks', `${name} is not bound to the exact candidate head.`));
      if (check.status !== 'completed') {
        findings.push(finding(PENDING.has(check.status) ? 'check-pending' : 'check-status', 'checks', `${name} must be completed; observed ${check.status}.`));
        continue;
      }
      if (!SUCCESS.has(check.conclusion ?? '')) {
        findings.push(finding(FAILURE.has(check.conclusion ?? '') ? 'check-failed' : 'check-conclusion', 'checks', `${name} must conclude success; observed ${check.conclusion ?? 'null'}.`));
      }
    }
  }
  const ordered = freezeArray([...findings].sort((left, right) => left.field.localeCompare(right.field) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)));
  return deepFreeze({
    version: RELEASE_ADMISSION_VERSION,
    passed: ordered.length === 0,
    mergeAllowed: ordered.length === 0,
    findings: ordered,
    summary: {
      errors: ordered.length,
      total: ordered.length,
      additionsRequired: minimumAdditions,
      requiredChecks,
    },
  });
}

function normalizeWorkflowRun(raw: unknown, index: number, findings: ReleaseFinding[]): NormalizedWorkflowRun | null {
  if (!isRecord(raw)) {
    findings.push(finding('run-invalid', `runs[${index}]`, 'Workflow evidence must be an object.'));
    return null;
  }
  const name = exactText(raw.name, 120);
  const headSha = exactSha(raw.headSha);
  const event = exactText(raw.event, 32);
  const status = exactText(raw.status, 32)?.toLowerCase() ?? null;
  const conclusion = raw.conclusion === null || raw.conclusion === undefined ? null : exactText(raw.conclusion, 32)?.toLowerCase() ?? null;
  const created = timestamp(raw.createdAt);
  const updated = timestamp(raw.updatedAt);
  if (!name || !SAFE_NAME.test(name)) findings.push(finding('run-name-invalid', `runs[${index}].name`, 'Workflow name is invalid.'));
  if (!headSha) findings.push(finding('run-head-invalid', `runs[${index}].headSha`, 'Workflow evidence requires an exact head SHA.'));
  if (!event) findings.push(finding('run-event-invalid', `runs[${index}].event`, 'Workflow event is required.'));
  if (!status) findings.push(finding('run-status-invalid', `runs[${index}].status`, 'Workflow status is required.'));
  if (raw.conclusion !== null && raw.conclusion !== undefined && !conclusion) findings.push(finding('run-conclusion-invalid', `runs[${index}].conclusion`, 'Workflow conclusion is invalid.'));
  if (!positiveInteger(raw.runId)) findings.push(finding('run-id-invalid', `runs[${index}].runId`, 'runId must be a positive safe integer.'));
  if (!positiveInteger(raw.attempt)) findings.push(finding('run-attempt-invalid', `runs[${index}].attempt`, 'attempt must be a positive safe integer.'));
  if (!created) findings.push(finding('run-created-invalid', `runs[${index}].createdAt`, 'createdAt must be canonical UTC ISO-8601.'));
  if (!updated) findings.push(finding('run-updated-invalid', `runs[${index}].updatedAt`, 'updatedAt must be canonical UTC ISO-8601.'));
  if (created && updated && updated.millis < created.millis) findings.push(finding('run-time-reversed', `runs[${index}].updatedAt`, 'updatedAt cannot precede createdAt.'));
  if (!name || !SAFE_NAME.test(name) || !headSha || !event || !status || !positiveInteger(raw.runId) || !positiveInteger(raw.attempt) || !created || !updated) return null;
  return deepFreeze({
    name,
    headSha,
    event,
    status,
    conclusion,
    runId: raw.runId,
    attempt: raw.attempt,
    createdAt: created.text,
    updatedAt: updated.text,
    created: created.millis,
    updated: updated.millis,
  });
}

function normalizeWorkflowEvidence(input: unknown, findings: ReleaseFinding[]): { readonly headSha: string; readonly baseSha: string; readonly currentMainSha: string; readonly runs: readonly NormalizedWorkflowRun[]; readonly maxEvidenceAgeMs: number; readonly observedAt: string; readonly observed: number } | null {
  if (!isRecord(input)) {
    findings.push(finding('evidence-invalid', '$', 'Release workflow evidence must be an object.'));
    return null;
  }
  if (input.version !== RELEASE_ADMISSION_VERSION) findings.push(finding('version-invalid', 'version', `Evidence version must be ${RELEASE_ADMISSION_VERSION}.`));
  const headSha = exactSha(input.headSha);
  const baseSha = exactSha(input.baseSha);
  const currentMainSha = exactSha(input.currentMainSha);
  if (!headSha) findings.push(finding('sha-invalid', 'headSha', 'headSha must be an exact SHA.'));
  if (!baseSha) findings.push(finding('sha-invalid', 'baseSha', 'baseSha must be an exact SHA.'));
  if (!currentMainSha) findings.push(finding('sha-invalid', 'currentMainSha', 'currentMainSha must be an exact SHA.'));
  if (!Array.isArray(input.runs)) findings.push(finding('runs-invalid', 'runs', 'runs must be an array.'));
  else if (input.runs.length > MAX_WORKFLOW_RUNS) findings.push(finding('runs-limit', 'runs', `runs must contain at most ${MAX_WORKFLOW_RUNS} entries.`));
  if (!nonNegativeInteger(input.maxEvidenceAgeMs) || input.maxEvidenceAgeMs < 60_000 || input.maxEvidenceAgeMs > 86_400_000) {
    findings.push(finding('age-policy-invalid', 'maxEvidenceAgeMs', 'Evidence age must be between one minute and one day.'));
  }
  const observed = timestamp(input.observedAt);
  if (!observed) findings.push(finding('observed-at-invalid', 'observedAt', 'observedAt must be canonical UTC ISO-8601.'));
  const runs = Array.isArray(input.runs) && input.runs.length <= MAX_WORKFLOW_RUNS
    ? input.runs.map((run, index) => normalizeWorkflowRun(run, index, findings)).filter((run): run is NormalizedWorkflowRun => run !== null)
    : [];
  if (!headSha || !baseSha || !currentMainSha || !observed || !nonNegativeInteger(input.maxEvidenceAgeMs) || input.maxEvidenceAgeMs < 60_000 || input.maxEvidenceAgeMs > 86_400_000) return null;
  return deepFreeze({ headSha, baseSha, currentMainSha, runs, maxEvidenceAgeMs: input.maxEvidenceAgeMs, observedAt: observed.text, observed: observed.millis });
}

function sameRunIdentity(left: NormalizedWorkflowRun, right: NormalizedWorkflowRun): boolean {
  return left.name === right.name && left.headSha === right.headSha && left.event === right.event && left.createdAt === right.createdAt;
}

function sameAttempt(left: NormalizedWorkflowRun, right: NormalizedWorkflowRun): boolean {
  return sameRunIdentity(left, right) && left.status === right.status && left.conclusion === right.conclusion && left.updatedAt === right.updatedAt;
}

function latestWorkflowRuns(runs: readonly NormalizedWorkflowRun[], findings: ReleaseFinding[]): Map<string, NormalizedWorkflowRun> {
  const byKey = new Map<string, NormalizedWorkflowRun>();
  const byId = new Map<number, NormalizedWorkflowRun>();
  const attempts = new Map<string, NormalizedWorkflowRun>();
  for (const run of runs) {
    const previousIdentity = byId.get(run.runId);
    if (previousIdentity && !sameRunIdentity(previousIdentity, run)) {
      findings.push(finding('run-id-collision', 'runs', `Run id ${run.runId} is reused by inconsistent immutable identity evidence.`));
      continue;
    }
    byId.set(run.runId, run);
    const attemptKey = `${run.runId}\u0000${run.attempt}`;
    const previousAttempt = attempts.get(attemptKey);
    if (previousAttempt && !sameAttempt(previousAttempt, run)) {
      findings.push(finding('run-attempt-conflict', 'runs', `Run ${run.runId} attempt ${run.attempt} has contradictory evidence.`));
      continue;
    }
    attempts.set(attemptKey, run);
    const key = `${run.name}\u0000${run.headSha}`;
    const previous = byKey.get(key);
    if (!previous || run.attempt > previous.attempt || (run.attempt === previous.attempt && run.updated > previous.updated)) {
      byKey.set(key, run);
    } else if (run.attempt === previous.attempt && run.updated === previous.updated && run.runId !== previous.runId) {
      findings.push(finding('ambiguous-latest-run', 'runs', `Workflow ${run.name} has ambiguous latest evidence.`));
    }
  }
  return byKey;
}

export function evaluateReleaseEvidenceQuorum(input: unknown, policy: unknown = {}): WorkflowEvidenceResult {
  const findings: ReleaseFinding[] = [];
  const policyRecord = isRecord(policy) ? policy : null;
  if (!policyRecord) findings.push(finding('policy-invalid', 'policy', 'Workflow evidence policy must be an object.'));
  const evidence = normalizeWorkflowEvidence(input, findings);
  const required = normalizedRequiredNames(policyRecord?.required, 'policy.required', findings);
  if (evidence) {
    if (evidence.baseSha !== evidence.currentMainSha) findings.push(finding('base-stale', 'baseSha', 'Evidence base must equal current main.'));
    if (evidence.headSha === evidence.currentMainSha) findings.push(finding('head-equals-main', 'headSha', 'Candidate head must differ from current main.'));
    const latest = latestWorkflowRuns(evidence.runs, findings);
    for (const name of required) {
      const run = latest.get(`${name}\u0000${evidence.headSha}`);
      if (!run) {
        findings.push(finding('required-run-missing', 'runs', `Missing exact-head evidence for ${name}.`));
        continue;
      }
      if (run.event !== 'pull_request') findings.push(finding('run-event-untrusted', 'runs', `${name} must be bound to a pull_request event that executes the candidate head.`));
      if (run.status !== 'completed') findings.push(finding('run-pending', 'runs', `${name} is not completed.`));
      if (run.conclusion !== 'success') findings.push(finding('run-not-success', 'runs', `${name} did not conclude success.`));
      if (run.updated > evidence.observed) findings.push(finding('run-from-future', 'runs', `${name} evidence is newer than observation time.`));
      if (evidence.observed - run.updated > evidence.maxEvidenceAgeMs) findings.push(finding('run-stale', 'runs', `${name} evidence exceeds the freshness window.`));
    }
    const identities = new Map<string, Set<number>>();
    for (const run of evidence.runs.filter(run => run.headSha === evidence.headSha)) {
      const set = identities.get(run.name) ?? new Set<number>();
      set.add(run.runId);
      identities.set(run.name, set);
    }
    for (const [name, ids] of identities) {
      if (ids.size > 32) findings.push(finding('run-cardinality-exceeded', 'runs', `${name} exceeds bounded evidence cardinality.`));
    }
  }
  const ordered = freezeArray([...findings].sort((left, right) => left.field.localeCompare(right.field) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)));
  return deepFreeze({
    version: RELEASE_ADMISSION_VERSION,
    passed: ordered.length === 0,
    findings: ordered,
    summary: { errors: ordered.length, total: ordered.length, required },
  });
}

export function evaluateReleasePrLifecycle(input: unknown, policy: unknown = {}): PullRequestLifecycleResult {
  const findings: ReleaseFinding[] = [];
  if (!isRecord(input)) {
    const ordered = freezeArray([finding('evidence-invalid', '$', 'PR lifecycle evidence must be an object.')]);
    return deepFreeze({ version: RELEASE_ADMISSION_VERSION, passed: false, mergeAllowed: false, findings: ordered, summary: { errors: 1 } });
  }
  const policyRecord = isRecord(policy) ? policy : null;
  if (!policyRecord) findings.push(finding('policy-invalid', 'policy', 'PR lifecycle policy must be an object.'));
  if (input.version !== RELEASE_ADMISSION_VERSION) findings.push(finding('version-unsupported', 'version', `Version must be ${RELEASE_ADMISSION_VERSION}.`));
  const number = positiveInteger(input.number) ? input.number : null;
  const state = input.state === 'open' || input.state === 'closed' ? input.state : null;
  const merged = boolean(input.merged);
  const draft = boolean(input.draft);
  const mergeable = boolean(input.mergeable);
  const baseSha = exactSha(input.baseSha);
  const headSha = exactSha(input.headSha);
  const createdAt = timestamp(input.createdAt);
  const updatedAt = timestamp(input.updatedAt);
  const observedAt = timestamp(input.observedAt);
  if (!number) findings.push(finding('number-invalid', 'number', 'PR number must be a positive safe integer.'));
  if (!state) findings.push(finding('state-invalid', 'state', 'PR state must be open or closed.'));
  if (merged === null) findings.push(finding('merged-invalid', 'merged', 'merged must be boolean.'));
  if (draft === null) findings.push(finding('draft-invalid', 'draft', 'draft must be boolean.'));
  if (mergeable === null) findings.push(finding('mergeable-invalid', 'mergeable', 'mergeable must be boolean.'));
  if (!baseSha) findings.push(finding('base-sha-invalid', 'baseSha', 'baseSha must be an exact SHA.'));
  if (!headSha) findings.push(finding('head-sha-invalid', 'headSha', 'headSha must be an exact SHA.'));
  if (!createdAt) findings.push(finding('created-at-invalid', 'createdAt', 'createdAt must be canonical UTC ISO-8601.'));
  if (!updatedAt) findings.push(finding('updated-at-invalid', 'updatedAt', 'updatedAt must be canonical UTC ISO-8601.'));
  if (!observedAt) findings.push(finding('observed-at-invalid', 'observedAt', 'observedAt must be canonical UTC ISO-8601.'));
  if (state === 'closed') findings.push(finding('pr-closed', 'state', 'Release candidate PR must remain open.'));
  if (merged === true) findings.push(finding('pr-merged', 'merged', 'Release candidate PR must not already be merged.'));
  if (draft === true) findings.push(finding('pr-draft', 'draft', 'Release candidate PR must be ready for review.'));
  if (mergeable === false) findings.push(finding('pr-not-mergeable', 'mergeable', 'Release candidate PR must be mergeable.'));
  if (baseSha && headSha && baseSha === headSha) findings.push(finding('head-equals-base', 'headSha', 'Candidate head must differ from base.'));
  const expectedNumber = policyRecord?.expectedNumber;
  if (expectedNumber !== undefined && !positiveInteger(expectedNumber)) findings.push(finding('expected-number-invalid', 'policy.expectedNumber', 'Expected PR number must be a positive safe integer.'));
  else if (typeof expectedNumber === 'number' && number && number !== expectedNumber) findings.push(finding('number-mismatch', 'number', `Expected PR #${expectedNumber}; observed #${number}.`));
  const expectedHeadSha = policyRecord?.expectedHeadSha === undefined ? null : exactSha(policyRecord.expectedHeadSha);
  if (policyRecord?.expectedHeadSha !== undefined && !expectedHeadSha) findings.push(finding('expected-head-invalid', 'policy.expectedHeadSha', 'Expected head must be an exact SHA.'));
  else if (expectedHeadSha && headSha && expectedHeadSha !== headSha) findings.push(finding('head-mismatch', 'headSha', 'Observed head does not equal expected exact head.'));
  const expectedBaseSha = policyRecord?.expectedBaseSha === undefined ? null : exactSha(policyRecord.expectedBaseSha);
  if (policyRecord?.expectedBaseSha !== undefined && !expectedBaseSha) findings.push(finding('expected-base-invalid', 'policy.expectedBaseSha', 'Expected base must be an exact SHA.'));
  else if (expectedBaseSha && baseSha && expectedBaseSha !== baseSha) findings.push(finding('base-mismatch', 'baseSha', 'Observed base does not equal expected current main.'));
  const maxMetadataAgeMs = policyRecord?.maxMetadataAgeMs ?? DEFAULT_MAX_PR_METADATA_AGE_MS;
  if (!nonNegativeInteger(maxMetadataAgeMs) || maxMetadataAgeMs > 86_400_000) findings.push(finding('freshness-policy-invalid', 'policy.maxMetadataAgeMs', 'Metadata freshness budget must be between 0 and 24 hours.'));
  if (createdAt && updatedAt && updatedAt.millis < createdAt.millis) findings.push(finding('timestamp-order-invalid', 'updatedAt', 'updatedAt must not precede createdAt.'));
  if (updatedAt && observedAt && updatedAt.millis > observedAt.millis) findings.push(finding('metadata-from-future', 'updatedAt', 'updatedAt must not be later than observedAt.'));
  if (createdAt && observedAt && createdAt.millis > observedAt.millis) findings.push(finding('created-from-future', 'createdAt', 'createdAt must not be later than observedAt.'));
  if (updatedAt && observedAt && nonNegativeInteger(maxMetadataAgeMs) && observedAt.millis - updatedAt.millis > maxMetadataAgeMs) findings.push(finding('metadata-stale', 'updatedAt', 'PR metadata is older than the configured freshness budget.'));
  const ordered = freezeArray([...findings].sort((left, right) => left.field.localeCompare(right.field) || left.code.localeCompare(right.code)));
  return deepFreeze({ version: RELEASE_ADMISSION_VERSION, passed: ordered.length === 0, mergeAllowed: ordered.length === 0, findings: ordered, summary: { errors: ordered.length } });
}

function normalizeReviewThreads(raw: unknown, findings: ReleaseFinding[]): readonly ReviewThreadEvidence[] | null {
  if (!Array.isArray(raw)) {
    findings.push(finding('review-threads-invalid', 'reviewThreads', 'reviewThreads must be an array.'));
    return null;
  }
  if (raw.length > MAX_REVIEW_THREADS) {
    findings.push(finding('review-threads-limit', 'reviewThreads', `reviewThreads must contain at most ${MAX_REVIEW_THREADS} entries.`));
    return null;
  }
  const ids = new Set<string>();
  const result: ReviewThreadEvidence[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!isRecord(item)) {
      findings.push(finding('review-thread-invalid', `reviewThreads[${index}]`, 'Review thread must be an object.'));
      continue;
    }
    const id = cleanText(item.id, 160);
    const resolved = boolean(item.resolved);
    if (!id) findings.push(finding('review-thread-id-invalid', `reviewThreads[${index}].id`, 'Review thread id must be a bounded non-control string.'));
    if (resolved === null) findings.push(finding('review-thread-resolved-invalid', `reviewThreads[${index}].resolved`, 'Review thread resolved must be boolean.'));
    if (id && ids.has(id)) findings.push(finding('review-thread-duplicate', `reviewThreads[${index}].id`, `Duplicate review thread id: ${id}.`));
    if (id && resolved !== null && !ids.has(id)) {
      ids.add(id);
      result.push(deepFreeze({ id, resolved }));
    }
  }
  return freezeArray(result);
}

function candidateChecks(runs: readonly NormalizedWorkflowRun[], headSha: string): readonly ReleaseCheckEvidence[] {
  return freezeArray(REQUIRED_RELEASE_CHECKS.map(name => {
    const matches = runs
      .filter(run => run.name === name && run.headSha === headSha)
      .sort((left, right) => right.attempt - left.attempt || right.updated - left.updated || right.runId - left.runId);
    const selected = matches[0];
    return selected
      ? deepFreeze({ name, status: selected.status, conclusion: selected.conclusion, headSha })
      : deepFreeze({ name, status: 'missing', conclusion: null, headSha });
  }));
}

export function evaluateReleaseAdmissionSnapshot(input: unknown, policy: unknown = {}): ReleaseAdmissionSnapshotResult {
  const findings: ReleaseFinding[] = [];
  const policyRecord = isRecord(policy) ? policy : null;
  if (!policyRecord) findings.push(finding('policy-invalid', 'policy', 'Release admission snapshot policy must be an object.'));
  if (!isRecord(input)) {
    const ordered = freezeArray([finding('snapshot-invalid', '$', 'Release admission snapshot must be an object.')]);
    return deepFreeze({ version: RELEASE_ADMISSION_VERSION, passed: false, mergeAllowed: false, findings: ordered, candidate: null, workflow: null, summary: { errors: 1, workflowRuns: 0, reviewThreads: 0 } });
  }
  if (input.version !== RELEASE_ADMISSION_VERSION) findings.push(finding('snapshot-version', 'version', `Snapshot version must be ${RELEASE_ADMISSION_VERSION}.`));
  const main = isRecord(input.main) ? input.main : null;
  const pullRequest = isRecord(input.pullRequest) ? input.pullRequest : null;
  const compare = isRecord(input.compare) ? input.compare : null;
  if (!main) findings.push(finding('main-invalid', 'main', 'main must be an object.'));
  if (!pullRequest) findings.push(finding('pull-request-invalid', 'pullRequest', 'pullRequest must be an object.'));
  if (!compare) findings.push(finding('compare-invalid', 'compare', 'compare must be an object.'));
  const mainSha = exactSha(main?.headSha);
  const mainRef = cleanText(main?.ref, MAX_REF_LENGTH);
  const baseSha = exactSha(pullRequest?.baseSha);
  const headSha = exactSha(pullRequest?.headSha);
  const baseRef = cleanText(pullRequest?.baseRef, MAX_REF_LENGTH);
  const headRef = cleanText(pullRequest?.headRef, MAX_REF_LENGTH);
  const draft = boolean(pullRequest?.draft);
  const mergeable = boolean(pullRequest?.mergeable);
  const additions = pullRequest?.additions;
  const deletions = pullRequest?.deletions;
  const compareBase = exactSha(compare?.baseSha);
  const compareHead = exactSha(compare?.headSha);
  const mergeBase = exactSha(compare?.mergeBaseSha);
  const aheadBy = compare?.aheadBy;
  const behindBy = compare?.behindBy;
  const compareStatusText = cleanText(compare?.status, 40)?.toLowerCase();
  const compareStatus = compareStatusText && COMPARE_STATUSES.has(compareStatusText as CompareStatus) ? compareStatusText as CompareStatus : null;
  if (!mainSha) findings.push(finding('main-sha-invalid', 'main.headSha', 'main.headSha must be an exact SHA.'));
  if (!mainRef || !SAFE_REF.test(mainRef)) findings.push(finding('main-ref-invalid', 'main.ref', 'main.ref must be a bounded non-control ref.'));
  if (!baseSha) findings.push(finding('pr-base-sha-invalid', 'pullRequest.baseSha', 'pullRequest.baseSha must be an exact SHA.'));
  if (!headSha) findings.push(finding('pr-head-sha-invalid', 'pullRequest.headSha', 'pullRequest.headSha must be an exact SHA.'));
  if (!baseRef || !SAFE_REF.test(baseRef)) findings.push(finding('pr-base-ref-invalid', 'pullRequest.baseRef', 'pullRequest.baseRef must be a bounded non-control ref.'));
  if (!headRef || !SAFE_REF.test(headRef)) findings.push(finding('pr-head-ref-invalid', 'pullRequest.headRef', 'pullRequest.headRef must be a bounded non-control ref.'));
  if (draft === null) findings.push(finding('pr-draft-invalid', 'pullRequest.draft', 'pullRequest.draft must be boolean.'));
  if (mergeable === null) findings.push(finding('pr-mergeable-invalid', 'pullRequest.mergeable', 'pullRequest.mergeable must be boolean.'));
  if (!nonNegativeInteger(additions)) findings.push(finding('pr-additions-invalid', 'pullRequest.additions', 'pullRequest.additions must be a non-negative safe integer.'));
  if (!nonNegativeInteger(deletions)) findings.push(finding('pr-deletions-invalid', 'pullRequest.deletions', 'pullRequest.deletions must be a non-negative safe integer.'));
  if (!compareBase) findings.push(finding('compare-base-invalid', 'compare.baseSha', 'compare.baseSha must be an exact SHA.'));
  if (!compareHead) findings.push(finding('compare-head-invalid', 'compare.headSha', 'compare.headSha must be an exact SHA.'));
  if (!mergeBase) findings.push(finding('compare-merge-base-invalid', 'compare.mergeBaseSha', 'compare.mergeBaseSha must be an exact SHA.'));
  if (!nonNegativeInteger(aheadBy)) findings.push(finding('compare-ahead-invalid', 'compare.aheadBy', 'compare.aheadBy must be a non-negative safe integer.'));
  if (!nonNegativeInteger(behindBy)) findings.push(finding('compare-behind-invalid', 'compare.behindBy', 'compare.behindBy must be a non-negative safe integer.'));
  if (!compareStatus) findings.push(finding('compare-status-invalid', 'compare.status', 'compare.status must be ahead, behind, diverged, or identical.'));
  const reviewThreads = normalizeReviewThreads(input.reviewThreads, findings);
  const workflowFindings: ReleaseFinding[] = [];
  const normalizedWorkflowInput = {
    version: RELEASE_ADMISSION_VERSION,
    headSha,
    baseSha,
    currentMainSha: mainSha,
    runs: input.workflowRuns,
    maxEvidenceAgeMs: input.maxEvidenceAgeMs,
    observedAt: input.observedAt,
  };
  const workflowEvidence = normalizeWorkflowEvidence(normalizedWorkflowInput, workflowFindings);
  findings.push(...workflowFindings.filter(item => item.code !== 'version-invalid'));
  if (mainSha && mainRef && baseSha && headSha && baseRef && headRef && compareBase && compareHead && mergeBase && nonNegativeInteger(aheadBy) && nonNegativeInteger(behindBy) && compareStatus) {
    if (mainRef !== 'main') findings.push(finding('main-ref-unexpected', 'main.ref', 'Release admission requires the main branch authority.'));
    if (baseRef !== 'main') findings.push(finding('pr-base-ref-unexpected', 'pullRequest.baseRef', 'Release candidate must target main.'));
    if (headRef === 'main') findings.push(finding('pr-head-ref-main', 'pullRequest.headRef', 'Release candidate head ref must not be main.'));
    if (baseSha !== mainSha) findings.push(finding('pr-base-stale', 'pullRequest.baseSha', 'Pull request base SHA must equal current main.'));
    if (compareBase !== mainSha) findings.push(finding('compare-base-stale', 'compare.baseSha', 'Compare base SHA must equal current main.'));
    if (headSha !== compareHead) findings.push(finding('head-authority-mismatch', 'compare.headSha', 'Compare head SHA must equal pull request head SHA.'));
    if (mergeBase !== mainSha) findings.push(finding('merge-base-stale', 'compare.mergeBaseSha', 'Compare merge-base must equal current main.'));
    if (behindBy !== 0) findings.push(finding('compare-behind', 'compare.behindBy', 'Candidate must be zero commits behind current main.'));
    if (aheadBy === 0) findings.push(finding('compare-empty', 'compare.aheadBy', 'Candidate must contain commits ahead of current main.'));
    if (compareStatus !== 'ahead') findings.push(finding('compare-not-ahead', 'compare.status', `Candidate compare status must be ahead; observed ${compareStatus}.`));
  }
  let workflow: WorkflowEvidenceResult | null = null;
  let candidate: ReleaseCandidateResult | null = null;
  if (mainSha && baseSha && headSha && mergeBase && reviewThreads && workflowEvidence && draft !== null && mergeable !== null && nonNegativeInteger(additions) && nonNegativeInteger(deletions) && nonNegativeInteger(aheadBy) && nonNegativeInteger(behindBy)) {
    workflow = evaluateReleaseEvidenceQuorum({
      version: RELEASE_ADMISSION_VERSION,
      headSha,
      baseSha,
      currentMainSha: mainSha,
      runs: workflowEvidence.runs,
      maxEvidenceAgeMs: workflowEvidence.maxEvidenceAgeMs,
      observedAt: workflowEvidence.observedAt,
    }, { required: policyRecord?.requiredWorkflows });
    for (const item of workflow.findings) findings.push(finding(`workflow-${item.code}`, `workflow.${item.field}`, item.message));
    candidate = evaluateReleaseCandidate({
      version: RELEASE_ADMISSION_VERSION,
      baseSha,
      headSha,
      mergeBaseSha: mergeBase,
      currentMainSha: mainSha,
      additions,
      deletions,
      aheadBy,
      behindBy,
      unresolvedThreads: reviewThreads.filter(thread => !thread.resolved).length,
      mergeable,
      draft,
      checks: candidateChecks(workflowEvidence.runs, headSha),
    }, { requiredChecks: policyRecord?.requiredChecks, minimumAdditions: policyRecord?.minimumAdditions });
    for (const item of candidate.findings) findings.push(finding(`candidate-${item.code}`, `candidate.${item.field}`, item.message));
  }
  const ordered = freezeArray([...findings].sort((left, right) => left.field.localeCompare(right.field) || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)));
  return deepFreeze({
    version: RELEASE_ADMISSION_VERSION,
    passed: ordered.length === 0,
    mergeAllowed: ordered.length === 0 && candidate?.mergeAllowed === true && workflow?.passed === true,
    findings: ordered,
    candidate,
    workflow,
    summary: {
      errors: ordered.length,
      workflowRuns: workflowEvidence?.runs.length ?? 0,
      reviewThreads: reviewThreads?.length ?? 0,
    },
  });
}

export function parseReleaseAdmissionJson(text: string, maximumBytes = 2 * 1024 * 1024): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new Error(`Release admission evidence must be UTF-8 JSON no larger than ${maximumBytes} bytes.`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Release admission JSON root must be an object.');
  return parsed;
}

export function formatReleaseAdmissionResult(result: ReleaseAdmissionSnapshotResult): string {
  return [
    `Release admission snapshot: ${result.passed ? 'PASS' : 'FAIL'} (${result.summary.errors} errors)`,
    ...result.findings.map(item => `ERROR ${item.code} ${item.field} — ${item.message}`),
  ].join('\n');
}

declare const Buffer: {
  byteLength(value: string, encoding: string): number;
};
