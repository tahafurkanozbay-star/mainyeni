import { describe, expect, it } from 'vitest';
import {
  GENERAL_SEARCH_TRANSPORT_VERSION_V11,
  type GeneralSearchTransportDiagnosticV11,
  type GeneralSearchTransportSnapshotV11,
} from './GenelAramaTransportContractsV11';
import {
  assertHealthyGeneralSearchTransportV11,
  auditGeneralSearchTransportSnapshotV11,
} from './GenelAramaTransportAuditV11';

const diagnostic = (
  sequence: number,
  overrides: Partial<GeneralSearchTransportDiagnosticV11> = {},
): GeneralSearchTransportDiagnosticV11 => Object.freeze({
  sequence,
  operation: 'search',
  requestId: sequence,
  requestFingerprint: `fp-${sequence}`,
  outcome: 'success',
  startedAt: sequence * 10,
  completedAt: sequence * 10 + 5,
  elapsedMs: 5,
  inputRecordCount: 1,
  acceptedRecordCount: 1,
  malformedRecordCount: 0,
  code: 'OK',
  ...overrides,
});

const snapshot = (
  overrides: Partial<GeneralSearchTransportSnapshotV11> = {},
): GeneralSearchTransportSnapshotV11 => Object.freeze({
  version: GENERAL_SEARCH_TRANSPORT_VERSION_V11,
  disposed: false,
  activeSearchRequestId: null,
  activeDetailRequestId: null,
  started: 2,
  completed: 2,
  failed: 0,
  cancelled: 0,
  superseded: 0,
  blocked: 0,
  malformedRecords: 0,
  reporterFailures: 0,
  diagnostics: Object.freeze([diagnostic(1), diagnostic(2)]),
  ...overrides,
});

describe('Genel Arama transport audit v11', () => {
  it('accepts a healthy scalar-only transport snapshot', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot());
    expect(report.healthy).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.fingerprint).toBeTruthy();
  });

  it('is deterministic for equivalent snapshots', () => {
    const first = auditGeneralSearchTransportSnapshotV11(snapshot());
    const second = auditGeneralSearchTransportSnapshotV11(snapshot());
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('detects diagnostic retention beyond the configured audit budget', () => {
    const report = auditGeneralSearchTransportSnapshotV11(
      snapshot({
        started: 3,
        completed: 3,
        diagnostics: Object.freeze([
          diagnostic(1),
          diagnostic(2),
          diagnostic(3),
        ]),
      }),
      { maximumDiagnostics: 2 },
    );

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'diagnostic-budget-exceeded',
      severity: 'error',
    }));
  });

  it('detects non-monotonic diagnostic sequences', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot({
      diagnostics: Object.freeze([diagnostic(2), diagnostic(2)]),
    }));

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'diagnostic-sequence-invalid',
      diagnosticSequence: 2,
    }));
  });

  it('detects missing request fingerprints without inspecting payload data', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot({
      diagnostics: Object.freeze([
        diagnostic(1, { requestFingerprint: '' }),
        diagnostic(2),
      ]),
    }));

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'fingerprint-missing',
      diagnosticSequence: 1,
    }));
  });

  it('rejects a disposed snapshot that still retains active request IDs', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot({
      disposed: true,
      activeSearchRequestId: 9,
    }));

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'active-request-after-dispose',
      severity: 'error',
    }));
  });

  it('rejects impossible negative or non-integer counters', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot({
      started: -1,
      completed: 1.5,
    }));

    expect(report.healthy).toBe(false);
    expect(report.issues.filter(item => item.code === 'negative-counter')).toHaveLength(2);
  });

  it('rejects terminal counters that exceed started operations', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot({
      started: 1,
      completed: 1,
      failed: 1,
    }));

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'counter-invariant',
      severity: 'error',
    }));
  });

  it('warns when a completed diagnostic exceeds elapsed-time audit budget', () => {
    const report = auditGeneralSearchTransportSnapshotV11(
      snapshot({
        diagnostics: Object.freeze([
          diagnostic(1, { elapsedMs: 2_000 }),
          diagnostic(2),
        ]),
      }),
      { maximumElapsedMs: 1_000 },
    );

    expect(report.healthy).toBe(true);
    expect(report.warnings).toBe(1);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'elapsed-budget-exceeded',
      severity: 'warning',
      diagnosticSequence: 1,
    }));
  });

  it('rejects malformed-record diagnostics above the audit budget', () => {
    const report = auditGeneralSearchTransportSnapshotV11(
      snapshot({
        malformedRecords: 20,
        diagnostics: Object.freeze([
          diagnostic(1, { malformedRecordCount: 20 }),
          diagnostic(2),
        ]),
      }),
      { maximumMalformedRecordsPerRequest: 10 },
    );

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'malformed-budget-exceeded',
      severity: 'error',
      diagnosticSequence: 1,
    }));
  });

  it('warns on a high fail/block ratio while preserving structural health', () => {
    const report = auditGeneralSearchTransportSnapshotV11(
      snapshot({
        started: 4,
        completed: 1,
        failed: 2,
        blocked: 1,
        diagnostics: Object.freeze([
          diagnostic(1, { outcome: 'success' }),
          diagnostic(2, { outcome: 'failure', code: 'E' }),
          diagnostic(3, { outcome: 'failure', code: 'E' }),
          diagnostic(4, { outcome: 'invalid-response', code: 'INVALID' }),
        ]),
      }),
      { maximumFailureRatio: 0.25 },
    );

    expect(report.healthy).toBe(true);
    expect(report.warnings).toBe(1);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'failure-ratio-exceeded',
      severity: 'warning',
    }));
  });

  it('does not count cancellations/supersession against the service failure ratio', () => {
    const report = auditGeneralSearchTransportSnapshotV11(snapshot({
      started: 5,
      completed: 1,
      cancelled: 2,
      superseded: 2,
      diagnostics: Object.freeze([
        diagnostic(1, { outcome: 'success' }),
        diagnostic(2, { outcome: 'cancelled', code: 'ABORTED' }),
        diagnostic(3, { outcome: 'cancelled', code: 'ABORTED' }),
        diagnostic(4, { outcome: 'superseded', code: 'SUPERSEDED' }),
        diagnostic(5, { outcome: 'superseded', code: 'SUPERSEDED' }),
      ]),
    }));

    expect(report.healthy).toBe(true);
    expect(report.warnings).toBe(0);
  });

  it('assert helper returns the report for healthy snapshots', () => {
    expect(assertHealthyGeneralSearchTransportV11(snapshot()).healthy).toBe(true);
  });

  it('assert helper throws a compact code list for structural failures', () => {
    expect(() => assertHealthyGeneralSearchTransportV11(snapshot({
      disposed: true,
      activeDetailRequestId: 1,
      started: 0,
      completed: 1,
    }))).toThrow(/active-request-after-dispose|counter-invariant/);
  });
});
