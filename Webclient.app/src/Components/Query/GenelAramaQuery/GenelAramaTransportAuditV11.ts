import {
  hashFingerprint,
  normalizeInteger,
  stableSerialize,
} from '../../../data-search/normalization';
import type {
  GeneralSearchTransportAuditIssueV11,
  GeneralSearchTransportAuditPolicyV11,
  GeneralSearchTransportAuditReportV11,
  GeneralSearchTransportDiagnosticV11,
  GeneralSearchTransportSnapshotV11,
} from './GenelAramaTransportContractsV11';

interface NormalizedAuditPolicyV11 {
  readonly maximumDiagnostics: number;
  readonly maximumElapsedMs: number;
  readonly maximumMalformedRecordsPerRequest: number;
  readonly maximumFailureRatio: number;
}

const normalizePolicy = (
  input: GeneralSearchTransportAuditPolicyV11 = {},
): NormalizedAuditPolicyV11 => {
  const ratio = Number(input.maximumFailureRatio);
  return Object.freeze({
    maximumDiagnostics: normalizeInteger(input.maximumDiagnostics, {
      min: 1,
      max: 10_000,
      fallback: 128,
    }),
    maximumElapsedMs: normalizeInteger(input.maximumElapsedMs, {
      min: 1,
      max: 600_000,
      fallback: 120_000,
    }),
    maximumMalformedRecordsPerRequest: normalizeInteger(
      input.maximumMalformedRecordsPerRequest,
      {
        min: 0,
        max: 100_000,
        fallback: 256,
      },
    ),
    maximumFailureRatio: Number.isFinite(ratio)
      ? Math.min(1, Math.max(0, ratio))
      : 0.25,
  });
};

const issue = (
  code: GeneralSearchTransportAuditIssueV11['code'],
  severity: GeneralSearchTransportAuditIssueV11['severity'],
  detail: string,
  diagnosticSequence: number | null = null,
): GeneralSearchTransportAuditIssueV11 => Object.freeze({
  code,
  severity,
  detail,
  diagnosticSequence,
});

const nonNegativeCounters = (
  snapshot: GeneralSearchTransportSnapshotV11,
): readonly (readonly [string, number])[] => Object.freeze([
  ['started', snapshot.started],
  ['completed', snapshot.completed],
  ['failed', snapshot.failed],
  ['cancelled', snapshot.cancelled],
  ['superseded', snapshot.superseded],
  ['blocked', snapshot.blocked],
  ['malformedRecords', snapshot.malformedRecords],
  ['reporterFailures', snapshot.reporterFailures],
] as const);

const terminalCount = (snapshot: GeneralSearchTransportSnapshotV11): number => (
  snapshot.completed
  + snapshot.failed
  + snapshot.cancelled
  + snapshot.superseded
  + snapshot.blocked
);

const failureRatio = (snapshot: GeneralSearchTransportSnapshotV11): number => {
  const denominator = snapshot.completed + snapshot.failed + snapshot.blocked;
  return denominator > 0
    ? (snapshot.failed + snapshot.blocked) / denominator
    : 0;
};

const auditDiagnostic = (
  diagnostic: GeneralSearchTransportDiagnosticV11,
  previousSequence: number,
  policy: NormalizedAuditPolicyV11,
): readonly GeneralSearchTransportAuditIssueV11[] => {
  const issues: GeneralSearchTransportAuditIssueV11[] = [];
  if (!Number.isSafeInteger(diagnostic.sequence)
    || diagnostic.sequence <= previousSequence
    || diagnostic.sequence <= 0) {
    issues.push(issue(
      'diagnostic-sequence-invalid',
      'error',
      `Diagnostic sequence ${diagnostic.sequence} is not strictly increasing.`,
      diagnostic.sequence,
    ));
  }
  if (!diagnostic.requestFingerprint) {
    issues.push(issue(
      'fingerprint-missing',
      'error',
      'Diagnostic is missing a request fingerprint.',
      diagnostic.sequence,
    ));
  }
  if (!Number.isFinite(diagnostic.elapsedMs)
    || diagnostic.elapsedMs < 0
    || diagnostic.elapsedMs > policy.maximumElapsedMs) {
    issues.push(issue(
      'elapsed-budget-exceeded',
      diagnostic.elapsedMs > policy.maximumElapsedMs ? 'warning' : 'error',
      `Diagnostic elapsedMs ${diagnostic.elapsedMs} is outside the audit budget.`,
      diagnostic.sequence,
    ));
  }
  if (diagnostic.malformedRecordCount > policy.maximumMalformedRecordsPerRequest) {
    issues.push(issue(
      'malformed-budget-exceeded',
      'error',
      `Malformed record count ${diagnostic.malformedRecordCount} exceeds audit budget.`,
      diagnostic.sequence,
    ));
  }
  return Object.freeze(issues);
};

const fingerprintInput = (
  snapshot: GeneralSearchTransportSnapshotV11,
  issues: readonly GeneralSearchTransportAuditIssueV11[],
): unknown => ({
  version: snapshot.version,
  disposed: snapshot.disposed,
  activeSearchRequestId: snapshot.activeSearchRequestId,
  activeDetailRequestId: snapshot.activeDetailRequestId,
  counters: nonNegativeCounters(snapshot),
  diagnostics: snapshot.diagnostics.map(item => ({
    sequence: item.sequence,
    operation: item.operation,
    requestId: item.requestId,
    requestFingerprint: item.requestFingerprint,
    outcome: item.outcome,
    elapsedMs: item.elapsedMs,
    inputRecordCount: item.inputRecordCount,
    acceptedRecordCount: item.acceptedRecordCount,
    malformedRecordCount: item.malformedRecordCount,
    code: item.code,
  })),
  issues: issues.map(item => ({
    code: item.code,
    severity: item.severity,
    diagnosticSequence: item.diagnosticSequence,
  })),
});

export const auditGeneralSearchTransportSnapshotV11 = (
  snapshot: GeneralSearchTransportSnapshotV11,
  policyInput: GeneralSearchTransportAuditPolicyV11 = {},
): GeneralSearchTransportAuditReportV11 => {
  const policy = normalizePolicy(policyInput);
  const issues: GeneralSearchTransportAuditIssueV11[] = [];

  if (snapshot.diagnostics.length > policy.maximumDiagnostics) {
    issues.push(issue(
      'diagnostic-budget-exceeded',
      'error',
      `Diagnostic count ${snapshot.diagnostics.length} exceeds ${policy.maximumDiagnostics}.`,
    ));
  }

  if (snapshot.disposed
    && (snapshot.activeSearchRequestId !== null || snapshot.activeDetailRequestId !== null)) {
    issues.push(issue(
      'active-request-after-dispose',
      'error',
      'Disposed transport runtime still exposes an active request.',
    ));
  }

  for (const [name, value] of nonNegativeCounters(snapshot)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push(issue(
        'negative-counter',
        'error',
        `${name} counter must be a non-negative safe integer.`,
      ));
    }
  }

  const terminal = terminalCount(snapshot);
  if (terminal > snapshot.started) {
    issues.push(issue(
      'counter-invariant',
      'error',
      `Terminal operation count ${terminal} exceeds started count ${snapshot.started}.`,
    ));
  }

  let previousSequence = 0;
  for (const diagnostic of snapshot.diagnostics) {
    const diagnosticIssues = auditDiagnostic(diagnostic, previousSequence, policy);
    issues.push(...diagnosticIssues);
    previousSequence = Math.max(previousSequence, diagnostic.sequence);
  }

  const ratio = failureRatio(snapshot);
  if (ratio > policy.maximumFailureRatio) {
    issues.push(issue(
      'failure-ratio-exceeded',
      'warning',
      `Failure/block ratio ${ratio.toFixed(4)} exceeds ${policy.maximumFailureRatio.toFixed(4)}.`,
    ));
  }

  const errors = issues.filter(item => item.severity === 'error').length;
  const warnings = issues.filter(item => item.severity === 'warning').length;
  const frozenIssues = Object.freeze(issues);
  return Object.freeze({
    healthy: errors === 0,
    errors,
    warnings,
    issues: frozenIssues,
    fingerprint: hashFingerprint(stableSerialize(fingerprintInput(snapshot, frozenIssues))),
  });
};

export const assertHealthyGeneralSearchTransportV11 = (
  snapshot: GeneralSearchTransportSnapshotV11,
  policy: GeneralSearchTransportAuditPolicyV11 = {},
): GeneralSearchTransportAuditReportV11 => {
  const report = auditGeneralSearchTransportSnapshotV11(snapshot, policy);
  if (report.healthy) return report;
  const codes = Array.from(new Set(
    report.issues
      .filter(item => item.severity === 'error')
      .map(item => item.code),
  )).join(',');
  throw new Error(`General-search transport v11 audit failed: ${codes || 'unknown'}`);
};
