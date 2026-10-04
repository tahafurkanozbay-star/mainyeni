import fs from 'node:fs';
import process from 'node:process';

export const RELEASE_GATE_VERSION = 1;
export const MIN_MEANINGFUL_ADDITIONS = 4000;
export const REQUIRED_CHECKS = Object.freeze([
  'Release QA',
  'Platform Architecture Audit',
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TERMINAL_SUCCESS = new Set(['success']);
const TERMINAL_FAILURE = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const PENDING = new Set(['queued', 'in_progress', 'pending', 'requested', 'waiting']);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = freeze(item);
    return Object.freeze(out);
  }
  return value;
}

function issue(code, message, field, severity = 'error') {
  return freeze({ code, message, field, severity });
}

function finiteInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function cleanString(value, max = 160) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function normalizeSha(value) {
  const text = cleanString(value, 40)?.toLowerCase() ?? null;
  return text && SHA_PATTERN.test(text) ? text : null;
}

function normalizeCheck(raw, index, findings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    findings.push(issue('check-invalid', `Check ${index} must be an object.`, `checks[${index}]`));
    return null;
  }
  const name = cleanString(raw.name, 120);
  if (!name) findings.push(issue('check-name-invalid', `Check ${index} has an invalid name.`, `checks[${index}].name`));
  const status = cleanString(raw.status, 40)?.toLowerCase() ?? null;
  const conclusion = raw.conclusion == null ? null : cleanString(raw.conclusion, 40)?.toLowerCase() ?? null;
  if (!status) findings.push(issue('check-status-invalid', `Check ${index} has an invalid status.`, `checks[${index}].status`));
  if (raw.conclusion != null && !conclusion) findings.push(issue('check-conclusion-invalid', `Check ${index} has an invalid conclusion.`, `checks[${index}].conclusion`));
  const headSha = normalizeSha(raw.headSha);
  if (!headSha) findings.push(issue('check-head-invalid', `Check ${index} must carry an exact 40-character head SHA.`, `checks[${index}].headSha`));
  return name && status && headSha ? freeze({ name, status, conclusion, headSha }) : null;
}

function validateShape(candidate, findings) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    findings.push(issue('candidate-invalid', 'Release candidate must be an object.', '$'));
    return null;
  }
  const version = candidate.version;
  if (version !== RELEASE_GATE_VERSION) findings.push(issue('version-unsupported', `Release gate version must be ${RELEASE_GATE_VERSION}.`, 'version'));
  const baseSha = normalizeSha(candidate.baseSha);
  const headSha = normalizeSha(candidate.headSha);
  const mergeBaseSha = normalizeSha(candidate.mergeBaseSha);
  const currentMainSha = normalizeSha(candidate.currentMainSha);
  for (const [field, value] of Object.entries({ baseSha, headSha, mergeBaseSha, currentMainSha })) {
    if (!value) findings.push(issue('sha-invalid', `${field} must be a lowercase-compatible 40-character Git SHA.`, field));
  }
  for (const field of ['additions', 'deletions', 'aheadBy', 'behindBy', 'unresolvedThreads']) {
    if (!finiteInteger(candidate[field])) findings.push(issue('integer-invalid', `${field} must be a non-negative safe integer.`, field));
  }
  if (typeof candidate.mergeable !== 'boolean') findings.push(issue('mergeable-invalid', 'mergeable must be boolean.', 'mergeable'));
  if (typeof candidate.draft !== 'boolean') findings.push(issue('draft-invalid', 'draft must be boolean.', 'draft'));
  if (!Array.isArray(candidate.checks)) findings.push(issue('checks-invalid', 'checks must be an array.', 'checks'));
  const checks = Array.isArray(candidate.checks)
    ? candidate.checks.map((item, index) => normalizeCheck(item, index, findings)).filter(Boolean)
    : [];
  if (findings.some(item => item.severity === 'error' && ['candidate-invalid', 'sha-invalid', 'integer-invalid', 'mergeable-invalid', 'draft-invalid', 'checks-invalid', 'version-unsupported'].includes(item.code))) return null;
  return freeze({
    version,
    baseSha,
    headSha,
    mergeBaseSha,
    currentMainSha,
    additions: candidate.additions,
    deletions: candidate.deletions,
    aheadBy: candidate.aheadBy,
    behindBy: candidate.behindBy,
    unresolvedThreads: candidate.unresolvedThreads,
    mergeable: candidate.mergeable,
    draft: candidate.draft,
    checks,
  });
}

function evaluateLineage(candidate, findings) {
  if (candidate.baseSha !== candidate.currentMainSha) findings.push(issue('base-stale', 'PR base SHA is not current main.', 'baseSha'));
  if (candidate.mergeBaseSha !== candidate.currentMainSha) findings.push(issue('merge-base-stale', 'Merge-base must equal current main.', 'mergeBaseSha'));
  if (candidate.behindBy !== 0) findings.push(issue('branch-behind', 'Candidate branch must be zero commits behind current main.', 'behindBy'));
  if (candidate.aheadBy === 0) findings.push(issue('branch-empty', 'Candidate must contain at least one commit ahead of main.', 'aheadBy'));
  if (candidate.headSha === candidate.currentMainSha) findings.push(issue('head-equals-main', 'Candidate head must differ from current main.', 'headSha'));
}

function evaluateScope(candidate, findings) {
  if (candidate.additions < MIN_MEANINGFUL_ADDITIONS) {
    findings.push(issue('additions-gate', `Candidate requires at least ${MIN_MEANINGFUL_ADDITIONS} additions; observed ${candidate.additions}.`, 'additions'));
  }
}

function evaluateMergeState(candidate, findings) {
  if (!candidate.mergeable) findings.push(issue('not-mergeable', 'GitHub must report mergeable=true.', 'mergeable'));
  if (candidate.draft) findings.push(issue('draft', 'Candidate must be ready for review before merge.', 'draft'));
  if (candidate.unresolvedThreads !== 0) findings.push(issue('review-threads', 'All review threads must be resolved before merge.', 'unresolvedThreads'));
}

function evaluateChecks(candidate, findings, requiredChecks) {
  const byName = new Map();
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
    if (check.headSha !== candidate.headSha) findings.push(issue('check-head-mismatch', `${name} is not bound to the exact candidate head.`, 'checks'));
    if (check.status !== 'completed') {
      findings.push(issue(PENDING.has(check.status) ? 'check-pending' : 'check-status', `${name} must be completed; observed ${check.status}.`, 'checks'));
      continue;
    }
    if (!TERMINAL_SUCCESS.has(check.conclusion)) {
      const code = TERMINAL_FAILURE.has(check.conclusion) ? 'check-failed' : 'check-conclusion';
      findings.push(issue(code, `${name} must conclude success; observed ${check.conclusion ?? 'null'}.`, 'checks'));
    }
  }
}

export function evaluateReleaseCandidate(input, options = {}) {
  const findings = [];
  const candidate = validateShape(input, findings);
  const requiredChecks = Array.isArray(options.requiredChecks) && options.requiredChecks.length
    ? options.requiredChecks.map(value => cleanString(value, 120)).filter(Boolean)
    : [...REQUIRED_CHECKS];
  if (candidate) {
    evaluateLineage(candidate, findings);
    evaluateScope(candidate, findings);
    evaluateMergeState(candidate, findings);
    evaluateChecks(candidate, findings, requiredChecks);
  }
  const errors = findings.filter(item => item.severity === 'error');
  return freeze({
    version: RELEASE_GATE_VERSION,
    passed: errors.length === 0,
    mergeAllowed: errors.length === 0,
    findings: [...findings].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code)),
    summary: {
      errors: errors.length,
      total: findings.length,
      additionsRequired: MIN_MEANINGFUL_ADDITIONS,
      requiredChecks,
    },
  });
}

export function formatReleaseCandidateResult(result) {
  const lines = [`Release candidate gate: ${result.passed ? 'PASS' : 'FAIL'} (${result.summary.errors} errors)`];
  for (const finding of result.findings) lines.push(`ERROR ${finding.code} ${finding.field} — ${finding.message}`);
  return lines.join('\n');
}

export function parseCandidateJson(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Candidate evidence must be UTF-8 JSON no larger than 1 MiB.');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Candidate evidence root must be an object.');
  return parsed;
}

function runCli() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const selfTest = args.includes('--self-test');
  if (selfTest) {
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const fixture = {
      version: 1,
      baseSha: shaA,
      headSha: shaB,
      mergeBaseSha: shaA,
      currentMainSha: shaA,
      additions: 4000,
      deletions: 0,
      aheadBy: 1,
      behindBy: 0,
      unresolvedThreads: 0,
      mergeable: true,
      draft: false,
      checks: REQUIRED_CHECKS.map(name => ({ name, status: 'completed', conclusion: 'success', headSha: shaB })),
    };
    const result = evaluateReleaseCandidate(fixture);
    if (!result.passed) throw new Error(formatReleaseCandidateResult(result));
    console.log('Release candidate gate self-test: PASS');
    return;
  }
  const fileIndex = args.indexOf('--file');
  if (fileIndex < 0 || !args[fileIndex + 1]) throw new Error('Usage: release-candidate-gate.mjs --file <candidate.json> [--strict]');
  const input = parseCandidateJson(fs.readFileSync(args[fileIndex + 1], 'utf8'));
  const result = evaluateReleaseCandidate(input);
  console.log(formatReleaseCandidateResult(result));
  if (strict && !result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) runCli();
