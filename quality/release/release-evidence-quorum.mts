export const QUORUM_VERSION = 1 as const;
export const MAX_REQUIRED_WORKFLOWS = 64;
export const MAX_RUN_EVIDENCE = 256;
export const DEFAULT_REQUIRED = Object.freeze([
  'Release QA',
  'Platform Architecture Audit',
  'Platform Typed Test Validation',
  'Release Evidence Contract',
  'Webclient Quality',
] as const);

export interface QuorumFinding {
  readonly code: string;
  readonly field: string;
  readonly message: string;
  readonly severity: 'error';
}

export interface NormalizedWorkflowRun {
  readonly name: string;
  readonly headSha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runId: number;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly created: number;
  readonly updated: number;
}

export interface ReleaseEvidenceQuorumResult {
  readonly version: typeof QUORUM_VERSION;
  readonly passed: boolean;
  readonly findings: readonly QuorumFinding[];
  readonly summary: {
    readonly errors: number;
    readonly total: number;
    readonly required: readonly string[];
  };
}

export interface ReleaseEvidenceQuorumOptions {
  readonly required?: readonly unknown[];
}

interface NormalizedEvidence {
  readonly headSha: string;
  readonly baseSha: string;
  readonly currentMainSha: string;
  readonly runs: readonly NormalizedWorkflowRun[];
  readonly maxEvidenceAgeMs: number;
  readonly observedAt: string;
  readonly observed: number;
}

const SHA = /^[0-9a-f]{40}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/()\-]{0,119}$/;
const ISO_INSTANT = /^(?:\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;
const STRUCTURAL_CODES = new Set([
  'evidence-invalid',
  'version-invalid',
  'sha-invalid',
  'runs-invalid',
  'runs-limit',
  'age-policy-invalid',
  'observed-at-invalid',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
    return Object.freeze(value) as T;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
    return Object.freeze(value);
  }
  return value;
}

function finding(code: string, field: string, message: string): QuorumFinding {
  return freeze({ code, field, message, severity: 'error' as const });
}

function cleanText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  if (value !== value.trim() || value.length === 0 || value.length > max) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function normalizeSha(value: unknown): string | null {
  const normalized = cleanText(value, 40)?.toLowerCase() ?? null;
  return normalized && SHA.test(normalized) ? normalized : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function instant(value: unknown): { text: string; epochMs: number } | null {
  const text = cleanText(value, 64);
  if (!text || !ISO_INSTANT.test(text)) return null;
  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs)) return null;
  if (!new Date(epochMs).toISOString().startsWith(text.slice(0, 19))) return null;
  return { text, epochMs };
}

function normalizeRun(
  raw: unknown,
  index: number,
  findings: QuorumFinding[],
): NormalizedWorkflowRun | null {
  if (!isRecord(raw)) {
    findings.push(finding('run-invalid', `runs[${index}]`, 'Workflow evidence must be an object.'));
    return null;
  }
  const name = cleanText(raw.name);
  const headSha = normalizeSha(raw.headSha);
  const event = cleanText(raw.event, 32);
  const status = cleanText(raw.status, 32)?.toLowerCase() ?? null;
  const conclusion = raw.conclusion == null ? null : cleanText(raw.conclusion, 32)?.toLowerCase() ?? null;
  const runId = raw.runId;
  const attempt = raw.attempt;
  const created = instant(raw.createdAt);
  const updated = instant(raw.updatedAt);

  if (!name || !SAFE_NAME.test(name)) findings.push(finding('run-name-invalid', `runs[${index}].name`, 'Workflow name is invalid.'));
  if (!headSha) findings.push(finding('run-head-invalid', `runs[${index}].headSha`, 'Workflow evidence requires an exact head SHA.'));
  if (!event) findings.push(finding('run-event-invalid', `runs[${index}].event`, 'Workflow event is required.'));
  if (!status) findings.push(finding('run-status-invalid', `runs[${index}].status`, 'Workflow status is required.'));
  if (raw.conclusion != null && !conclusion) findings.push(finding('run-conclusion-invalid', `runs[${index}].conclusion`, 'Workflow conclusion is invalid.'));
  if (!isNonNegativeInteger(runId) || runId === 0) findings.push(finding('run-id-invalid', `runs[${index}].runId`, 'runId must be a positive safe integer.'));
  if (!isNonNegativeInteger(attempt) || attempt === 0) findings.push(finding('run-attempt-invalid', `runs[${index}].attempt`, 'attempt must be a positive safe integer.'));
  if (!created) findings.push(finding('run-created-invalid', `runs[${index}].createdAt`, 'createdAt must be canonical UTC ISO-8601.'));
  if (!updated) findings.push(finding('run-updated-invalid', `runs[${index}].updatedAt`, 'updatedAt must be canonical UTC ISO-8601.'));
  if (created && updated && updated.epochMs < created.epochMs) findings.push(finding('run-time-reversed', `runs[${index}].updatedAt`, 'updatedAt cannot precede createdAt.'));

  if (
    !name || !SAFE_NAME.test(name) || !headSha || !event || !status
    || !isNonNegativeInteger(runId) || runId === 0
    || !isNonNegativeInteger(attempt) || attempt === 0
    || !created || !updated
  ) return null;

  return freeze({
    name,
    headSha,
    event,
    status,
    conclusion,
    runId,
    attempt,
    createdAt: created.text,
    updatedAt: updated.text,
    created: created.epochMs,
    updated: updated.epochMs,
  });
}

function normalizeEvidence(
  input: unknown,
  findings: QuorumFinding[],
): NormalizedEvidence | null {
  if (!isRecord(input)) {
    findings.push(finding('evidence-invalid', '$', 'Release evidence must be an object.'));
    return null;
  }
  if (input.version !== QUORUM_VERSION) {
    findings.push(finding('version-invalid', 'version', `Evidence version must be ${QUORUM_VERSION}.`));
  }

  const headSha = normalizeSha(input.headSha);
  const baseSha = normalizeSha(input.baseSha);
  const currentMainSha = normalizeSha(input.currentMainSha);
  for (const [field, value] of Object.entries({ headSha, baseSha, currentMainSha })) {
    if (!value) findings.push(finding('sha-invalid', field, `${field} must be a 40-character Git SHA.`));
  }

  let runs: readonly NormalizedWorkflowRun[] = [];
  if (!Array.isArray(input.runs)) {
    findings.push(finding('runs-invalid', 'runs', 'runs must be an array.'));
  } else if (input.runs.length > MAX_RUN_EVIDENCE) {
    findings.push(finding('runs-limit', 'runs', `runs must contain at most ${MAX_RUN_EVIDENCE} entries.`));
  } else {
    runs = input.runs
      .map((item, index) => normalizeRun(item, index, findings))
      .filter((item): item is NormalizedWorkflowRun => item !== null);
  }

  const maxEvidenceAgeMs = input.maxEvidenceAgeMs;
  if (
    !isNonNegativeInteger(maxEvidenceAgeMs)
    || maxEvidenceAgeMs < 60_000
    || maxEvidenceAgeMs > 86_400_000
  ) {
    findings.push(finding('age-policy-invalid', 'maxEvidenceAgeMs', 'Evidence age must be between one minute and one day.'));
  }

  const observed = instant(input.observedAt);
  if (!observed) {
    findings.push(finding('observed-at-invalid', 'observedAt', 'observedAt must be canonical UTC ISO-8601.'));
  }

  if (findings.some(item => STRUCTURAL_CODES.has(item.code))) return null;
  if (!headSha || !baseSha || !currentMainSha || !observed || !isNonNegativeInteger(maxEvidenceAgeMs)) return null;
  return freeze({
    headSha,
    baseSha,
    currentMainSha,
    runs,
    maxEvidenceAgeMs,
    observedAt: observed.text,
    observed: observed.epochMs,
  });
}

function normalizeRequired(
  value: readonly unknown[] | undefined,
  findings: QuorumFinding[],
): readonly string[] {
  if (value === undefined) return [...DEFAULT_REQUIRED];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REQUIRED_WORKFLOWS) {
    findings.push(finding('required-invalid', 'required', `required must contain 1-${MAX_REQUIRED_WORKFLOWS} workflow names.`));
    return [...DEFAULT_REQUIRED];
  }

  const effective = new Set<string>(DEFAULT_REQUIRED);
  const callerSeen = new Set<string>();
  const extras: string[] = [];
  for (const raw of value) {
    const name = cleanText(raw);
    if (!name || !SAFE_NAME.test(name)) {
      findings.push(finding('required-name-invalid', 'required', 'Required workflow name is invalid.'));
      continue;
    }
    if (callerSeen.has(name)) {
      findings.push(finding('required-name-duplicate', 'required', `Required workflow is duplicated: ${name}.`));
      continue;
    }
    callerSeen.add(name);
    if (!effective.has(name)) {
      effective.add(name);
      extras.push(name);
    }
  }
  const names = [...DEFAULT_REQUIRED, ...extras];
  if (names.length > MAX_REQUIRED_WORKFLOWS) {
    findings.push(finding('required-invalid', 'required', `Effective required workflow policy must contain at most ${MAX_REQUIRED_WORKFLOWS} names.`));
  }
  return names.slice(0, MAX_REQUIRED_WORKFLOWS);
}

function sameAttemptEvidence(left: NormalizedWorkflowRun, right: NormalizedWorkflowRun): boolean {
  return left.name === right.name
    && left.headSha === right.headSha
    && left.event === right.event
    && left.status === right.status
    && left.conclusion === right.conclusion
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function sameRunIdentity(left: NormalizedWorkflowRun, right: NormalizedWorkflowRun): boolean {
  return left.name === right.name
    && left.headSha === right.headSha
    && left.event === right.event
    && left.createdAt === right.createdAt;
}

function selectLatest(
  runs: readonly NormalizedWorkflowRun[],
  findings: QuorumFinding[],
): Map<string, NormalizedWorkflowRun> {
  const byWorkflowHead = new Map<string, NormalizedWorkflowRun>();
  const byRunId = new Map<string, NormalizedWorkflowRun>();
  const byAttempt = new Map<string, NormalizedWorkflowRun>();

  for (const run of runs) {
    const runId = String(run.runId);
    const oldRun = byRunId.get(runId);
    if (oldRun && !sameRunIdentity(oldRun, run)) {
      findings.push(finding('run-id-collision', 'runs', `Run id ${run.runId} is reused by inconsistent immutable identity evidence.`));
      continue;
    }
    byRunId.set(runId, run);

    const attemptKey = `${run.runId}\0${run.attempt}`;
    const oldAttempt = byAttempt.get(attemptKey);
    if (oldAttempt && !sameAttemptEvidence(oldAttempt, run)) {
      findings.push(finding('run-attempt-conflict', 'runs', `Run ${run.runId} attempt ${run.attempt} has contradictory evidence.`));
      continue;
    }
    byAttempt.set(attemptKey, run);

    const key = `${run.name}\0${run.headSha}`;
    const old = byWorkflowHead.get(key);
    if (!old || run.attempt > old.attempt || (run.attempt === old.attempt && run.updated > old.updated)) {
      byWorkflowHead.set(key, run);
    } else if (run.attempt === old.attempt && run.updated === old.updated && run.runId !== old.runId) {
      findings.push(finding('ambiguous-latest-run', 'runs', `Workflow ${run.name} has ambiguous latest evidence.`));
    }
  }
  return byWorkflowHead;
}

export function evaluateReleaseEvidenceQuorum(
  input: unknown,
  options: ReleaseEvidenceQuorumOptions = {},
): ReleaseEvidenceQuorumResult {
  const findings: QuorumFinding[] = [];
  const evidence = normalizeEvidence(input, findings);
  const required = normalizeRequired(options.required, findings);

  if (evidence) {
    if (evidence.baseSha !== evidence.currentMainSha) {
      findings.push(finding('base-stale', 'baseSha', 'Evidence base must equal current main.'));
    }
    if (evidence.headSha === evidence.currentMainSha) {
      findings.push(finding('head-equals-main', 'headSha', 'Candidate head must differ from current main.'));
    }

    const latest = selectLatest(evidence.runs, findings);
    for (const name of required) {
      const run = latest.get(`${name}\0${evidence.headSha}`);
      if (!run) {
        findings.push(finding('required-run-missing', 'runs', `Missing exact-head evidence for ${name}.`));
        continue;
      }
      if (run.event !== 'pull_request') findings.push(finding('run-event-untrusted', 'runs', `${name} must be bound to a pull_request event that executes the candidate head.`));
      if (run.status !== 'completed') findings.push(finding('run-pending', 'runs', `${name} is not completed.`));
      if (run.conclusion !== 'success') findings.push(finding('run-not-success', 'runs', `${name} did not conclude success.`));
      if (run.updated > evidence.observed) findings.push(finding('run-from-future', 'runs', `${name} evidence is newer than observation time.`));
      if (evidence.observed - run.updated > evidence.maxEvidenceAgeMs) findings.push(finding('run-stale', 'runs', `${name} evidence exceeds freshness window.`));
    }

    const namesAtHead = new Map<string, Set<number>>();
    for (const run of evidence.runs.filter(item => item.headSha === evidence.headSha)) {
      const ids = namesAtHead.get(run.name) ?? new Set<number>();
      ids.add(run.runId);
      namesAtHead.set(run.name, ids);
    }
    for (const [name, ids] of namesAtHead) {
      if (ids.size > 32) findings.push(finding('run-cardinality-exceeded', 'runs', `${name} exceeds bounded evidence cardinality.`));
    }
  }

  const sorted = [...findings].sort((left, right) =>
    left.field.localeCompare(right.field, 'en')
    || left.code.localeCompare(right.code, 'en')
    || left.message.localeCompare(right.message, 'en'));
  return freeze({
    version: QUORUM_VERSION,
    passed: sorted.length === 0,
    findings: sorted,
    summary: {
      errors: sorted.length,
      total: sorted.length,
      required: Object.freeze([...required]),
    },
  });
}

export function formatReleaseEvidenceQuorum(result: ReleaseEvidenceQuorumResult): string {
  return [
    `Release evidence quorum: ${result.passed ? 'PASS' : 'FAIL'} (${result.summary.errors} errors)`,
    ...result.findings.map(item => `ERROR ${item.code} ${item.field} — ${item.message}`),
  ].join('\n');
}
