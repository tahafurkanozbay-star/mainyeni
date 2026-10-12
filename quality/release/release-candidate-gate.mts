import fs from 'node:fs';
import process from 'node:process';

export const RELEASE_GATE_VERSION = 1 as const;
export const MIN_MEANINGFUL_ADDITIONS = 4000;
export const MAX_CHECK_EVIDENCE = 64;
export const REQUIRED_CHECKS = Object.freeze([
  'Release QA',
  'Platform Architecture Audit',
  'Release Evidence Contract',
  'Platform Typed Test Validation',
  'Webclient Quality',
] as const);

export type ReleaseGateSeverity = 'error';

export interface ReleaseGateIssue {
  readonly code: string;
  readonly message: string;
  readonly field: string;
  readonly severity: ReleaseGateSeverity;
}

export interface ReleaseCheckEvidence {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
}

export interface ReleaseCandidate {
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

export interface ReleaseCandidateOptions {
  readonly requiredChecks?: readonly unknown[];
}

export interface ReleaseCandidateResult {
  readonly version: typeof RELEASE_GATE_VERSION;
  readonly passed: boolean;
  readonly mergeAllowed: boolean;
  readonly findings: readonly ReleaseGateIssue[];
  readonly summary: {
    readonly errors: number;
    readonly total: number;
    readonly additionsRequired: number;
    readonly requiredChecks: readonly string[];
  };
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SUCCESS = new Set(['success']);
const FAILURE = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const PENDING = new Set(['queued', 'in_progress', 'pending', 'requested', 'waiting']);
const STRUCTURAL_CODES = new Set([
  'candidate-invalid',
  'version-unsupported',
  'sha-invalid',
  'integer-invalid',
  'mergeable-invalid',
  'draft-invalid',
  'checks-invalid',
  'checks-limit',
]);

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

function issue(code: string, message: string, field: string): ReleaseGateIssue {
  return deepFreeze({ code, message, field, severity: 'error' as const });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function cleanString(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) return null;
  return cleaned;
}

function sha(value: unknown): string | null {
  const cleaned = cleanString(value, 40)?.toLowerCase() ?? null;
  return cleaned && SHA_PATTERN.test(cleaned) ? cleaned : null;
}

function normalizeCheck(
  raw: unknown,
  index: number,
  findings: ReleaseGateIssue[],
): ReleaseCheckEvidence | null {
  if (!isRecord(raw)) {
    findings.push(issue('check-invalid', `Check ${index} must be an object.`, `checks[${index}]`));
    return null;
  }
  const name = cleanString(raw.name, 120);
  const status = cleanString(raw.status, 40)?.toLowerCase() ?? null;
  const conclusion = raw.conclusion == null ? null : cleanString(raw.conclusion, 40)?.toLowerCase() ?? null;
  const headSha = sha(raw.headSha);
  if (!name) findings.push(issue('check-name-invalid', `Check ${index} has an invalid name.`, `checks[${index}].name`));
  if (!status) findings.push(issue('check-status-invalid', `Check ${index} has an invalid status.`, `checks[${index}].status`));
  if (raw.conclusion != null && !conclusion) findings.push(issue('check-conclusion-invalid', `Check ${index} has an invalid conclusion.`, `checks[${index}].conclusion`));
  if (!headSha) findings.push(issue('check-head-invalid', `Check ${index} must carry an exact 40-character head SHA.`, `checks[${index}].headSha`));
  if (!name || !status || !headSha) return null;
  return deepFreeze({ name, status, conclusion, headSha });
}

function readInteger(
  input: Readonly<Record<string, unknown>>,
  field: string,
  findings: ReleaseGateIssue[],
): number | null {
  const value = input[field];
  if (!nonNegativeInteger(value)) {
    findings.push(issue('integer-invalid', `${field} must be a non-negative safe integer.`, field));
    return null;
  }
  return value;
}

function normalizeCandidate(
  input: unknown,
  findings: ReleaseGateIssue[],
): ReleaseCandidate | null {
  if (!isRecord(input)) {
    findings.push(issue('candidate-invalid', 'Release candidate must be an object.', '$'));
    return null;
  }
  if (input.version !== RELEASE_GATE_VERSION) {
    findings.push(issue('version-unsupported', `Release gate version must be ${RELEASE_GATE_VERSION}.`, 'version'));
  }

  const baseSha = sha(input.baseSha);
  const headSha = sha(input.headSha);
  const mergeBaseSha = sha(input.mergeBaseSha);
  const currentMainSha = sha(input.currentMainSha);
  for (const [field, value] of Object.entries({ baseSha, headSha, mergeBaseSha, currentMainSha })) {
    if (!value) findings.push(issue('sha-invalid', `${field} must be a 40-character Git SHA.`, field));
  }

  const additions = readInteger(input, 'additions', findings);
  const deletions = readInteger(input, 'deletions', findings);
  const aheadBy = readInteger(input, 'aheadBy', findings);
  const behindBy = readInteger(input, 'behindBy', findings);
  const unresolvedThreads = readInteger(input, 'unresolvedThreads', findings);

  if (typeof input.mergeable !== 'boolean') findings.push(issue('mergeable-invalid', 'mergeable must be boolean.', 'mergeable'));
  if (typeof input.draft !== 'boolean') findings.push(issue('draft-invalid', 'draft must be boolean.', 'draft'));

  let checks: readonly ReleaseCheckEvidence[] = [];
  if (!Array.isArray(input.checks)) {
    findings.push(issue('checks-invalid', 'checks must be an array.', 'checks'));
  } else if (input.checks.length > MAX_CHECK_EVIDENCE) {
    findings.push(issue('checks-limit', `checks must contain at most ${MAX_CHECK_EVIDENCE} entries.`, 'checks'));
  } else {
    checks = input.checks
      .map((item, index) => normalizeCheck(item, index, findings))
      .filter((item): item is ReleaseCheckEvidence => item !== null);
  }

  if (findings.some(item => STRUCTURAL_CODES.has(item.code))) return null;
  if (!baseSha || !headSha || !mergeBaseSha || !currentMainSha) return null;
  if (additions === null || deletions === null || aheadBy === null || behindBy === null || unresolvedThreads === null) return null;
  if (typeof input.mergeable !== 'boolean' || typeof input.draft !== 'boolean') return null;

  return deepFreeze({
    baseSha,
    headSha,
    mergeBaseSha,
    currentMainSha,
    additions,
    deletions,
    aheadBy,
    behindBy,
    unresolvedThreads,
    mergeable: input.mergeable,
    draft: input.draft,
    checks,
  });
}

function normalizeRequiredChecks(
  value: readonly unknown[] | undefined,
  findings: ReleaseGateIssue[],
): readonly string[] {
  if (value === undefined) return [...REQUIRED_CHECKS];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECK_EVIDENCE) {
    findings.push(issue('required-checks-invalid', `requiredChecks must contain 1-${MAX_CHECK_EVIDENCE} valid check names.`, 'requiredChecks'));
    return [...REQUIRED_CHECKS];
  }
  const effective = new Set<string>(REQUIRED_CHECKS);
  const callerSeen = new Set<string>();
  const extras: string[] = [];
  value.forEach((raw, index) => {
    const name = cleanString(raw, 120);
    if (!name) {
      findings.push(issue('required-check-name-invalid', `Required check ${index} has an invalid name.`, `requiredChecks[${index}]`));
      return;
    }
    if (callerSeen.has(name)) {
      findings.push(issue('required-check-duplicate', `Required check is duplicated: ${name}.`, 'requiredChecks'));
      return;
    }
    callerSeen.add(name);
    if (!effective.has(name)) {
      effective.add(name);
      extras.push(name);
    }
  });
  const required = [...REQUIRED_CHECKS, ...extras];
  if (required.length > MAX_CHECK_EVIDENCE) {
    findings.push(issue('required-checks-invalid', `Effective requiredChecks policy must contain at most ${MAX_CHECK_EVIDENCE} names.`, 'requiredChecks'));
  }
  return required.slice(0, MAX_CHECK_EVIDENCE);
}

function checkFindings(candidate: ReleaseCandidate, requiredChecks: readonly string[]): ReleaseGateIssue[] {
  const findings: ReleaseGateIssue[] = [];
  const byName = new Map<string, ReleaseCheckEvidence>();
  for (const check of candidate.checks) {
    if (byName.has(check.name)) {
      findings.push(issue('duplicate-check', `Duplicate check evidence is ambiguous: ${check.name}.`, 'checks'));
      continue;
    }
    byName.set(check.name, check);
  }
  for (const name of requiredChecks) {
    const check = byName.get(name);
    if (!check) {
      findings.push(issue('required-check-missing', `Required check is missing: ${name}.`, 'checks'));
      continue;
    }
    if (check.headSha !== candidate.headSha) {
      findings.push(issue('check-head-mismatch', `${name} is not bound to the exact candidate head.`, 'checks'));
    }
    if (check.status !== 'completed') {
      findings.push(issue(PENDING.has(check.status) ? 'check-pending' : 'check-status', `${name} must be completed; observed ${check.status}.`, 'checks'));
      continue;
    }
    if (!SUCCESS.has(check.conclusion ?? '')) {
      findings.push(issue(FAILURE.has(check.conclusion ?? '') ? 'check-failed' : 'check-conclusion', `${name} must conclude success; observed ${check.conclusion ?? 'null'}.`, 'checks'));
    }
  }
  return findings;
}

export function evaluateReleaseCandidate(
  input: unknown,
  options: ReleaseCandidateOptions = {},
): ReleaseCandidateResult {
  const findings: ReleaseGateIssue[] = [];
  const candidate = normalizeCandidate(input, findings);
  const requiredChecks = normalizeRequiredChecks(options.requiredChecks, findings);
  if (candidate) {
    if (candidate.baseSha !== candidate.currentMainSha) findings.push(issue('base-stale', 'PR base SHA is not current main.', 'baseSha'));
    if (candidate.mergeBaseSha !== candidate.currentMainSha) findings.push(issue('merge-base-stale', 'Merge-base must equal current main.', 'mergeBaseSha'));
    if (candidate.behindBy !== 0) findings.push(issue('branch-behind', 'Candidate branch must be zero commits behind current main.', 'behindBy'));
    if (candidate.aheadBy === 0) findings.push(issue('branch-empty', 'Candidate must contain at least one commit ahead of main.', 'aheadBy'));
    if (candidate.headSha === candidate.currentMainSha) findings.push(issue('head-equals-main', 'Candidate head must differ from current main.', 'headSha'));
    if (candidate.additions < MIN_MEANINGFUL_ADDITIONS) findings.push(issue('additions-gate', `Candidate requires at least ${MIN_MEANINGFUL_ADDITIONS} additions; observed ${candidate.additions}.`, 'additions'));
    if (!candidate.mergeable) findings.push(issue('not-mergeable', 'GitHub must report mergeable=true.', 'mergeable'));
    if (candidate.draft) findings.push(issue('draft', 'Candidate must be ready for review before merge.', 'draft'));
    if (candidate.unresolvedThreads !== 0) findings.push(issue('review-threads', 'All review threads must be resolved before merge.', 'unresolvedThreads'));
    findings.push(...checkFindings(candidate, requiredChecks));
  }
  const sorted = [...findings].sort((left, right) => left.field.localeCompare(right.field, 'en') || left.code.localeCompare(right.code, 'en'));
  const errors = sorted.length;
  return deepFreeze({
    version: RELEASE_GATE_VERSION,
    passed: errors === 0,
    mergeAllowed: errors === 0,
    findings: sorted,
    summary: {
      errors,
      total: sorted.length,
      additionsRequired: MIN_MEANINGFUL_ADDITIONS,
      requiredChecks,
    },
  });
}

export function formatReleaseCandidateResult(result: ReleaseCandidateResult): string {
  return [
    `Release candidate gate: ${result.passed ? 'PASS' : 'FAIL'} (${result.summary.errors} errors)`,
    ...result.findings.map(item => `ERROR ${item.code} ${item.field} — ${item.message}`),
  ].join('\n');
}

export function parseCandidateJson(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || text.length > 1024 * 1024) {
    throw new Error('Candidate evidence must be UTF-8 JSON no larger than 1 MiB.');
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Candidate evidence root must be an object.');
  return parsed;
}

export function runReleaseCandidateCli(args: readonly string[] = process.argv.slice(2)): void {
  const strict = args.includes('--strict');
  if (args.includes('--self-test')) {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const result = evaluateReleaseCandidate({
      version: RELEASE_GATE_VERSION,
      baseSha: base,
      headSha: head,
      mergeBaseSha: base,
      currentMainSha: base,
      additions: MIN_MEANINGFUL_ADDITIONS,
      deletions: 0,
      aheadBy: 1,
      behindBy: 0,
      unresolvedThreads: 0,
      mergeable: true,
      draft: false,
      checks: REQUIRED_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success', headSha: head })),
    });
    if (!result.passed) throw new Error(formatReleaseCandidateResult(result));
    process.stdout.write('Release candidate gate self-test: PASS\n');
    return;
  }
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  if (!file) throw new Error('Usage: release-candidate-gate.mjs --file <candidate.json> [--strict]');
  const result = evaluateReleaseCandidate(parseCandidateJson(fs.readFileSync(file, 'utf8')));
  process.stdout.write(formatReleaseCandidateResult(result) + '\n');
  if (strict && !result.passed) process.exitCode = 1;
}
