import { describe, expect, it } from 'vitest';
import type { StoreTransitionDescriptor } from './contracts';
import { analyzeStoreTransitions, analyzeTransitionEntries } from './stateTransitionAnalytics';

const entry = (
  actionType: string,
  status: 'changed' | 'noop' | 'failed',
  durationMs: number,
  changedSlices: StoreTransitionDescriptor['changedSlices'] = [],
  errorCode: string | null = null,
): StoreTransitionDescriptor => ({
  actionType,
  actionAudit: {
    actionType,
    payloadKind: 'none',
    estimatedEntries: 0,
    maxDepthObserved: 0,
    hasSensitiveKeys: false,
    hasFunctions: false,
    truncated: false,
  },
  timestamp: 1,
  durationMs,
  status,
  changedSlices,
  changedPaths: [],
  beforeFingerprint: 'a',
  afterFingerprint: status === 'changed' ? 'b' : 'a',
  invariantErrors: 0,
  invariantWarnings: 0,
  errorCode,
});

describe('stateTransitionAnalytics', () => {
  it('summarizes action frequency, slices, failures and durations', () => {
    const entries = [
      entry('Map/Update', 'changed', 5, ['Map']),
      entry('Map/Update', 'changed', 9, ['Map']),
      entry('Common/Open', 'changed', 3, ['Common']),
      entry('Common/Open', 'noop', 1),
      entry('Danger', 'failed', 4, [], 'Error'),
    ];
    const result = analyzeTransitionEntries(entries);
    expect(result).toMatchObject({
      totalTransitions: 5,
      changedTransitions: 3,
      noopTransitions: 1,
      failedTransitions: 1,
      maxDurationMs: 9,
    });
    expect(result.noopRatio).toBeCloseTo(0.2);
    expect(result.averageDurationMs).toBeCloseTo(4.4);
    expect(result.actionCounts).toEqual({
      'Map/Update': 2,
      'Common/Open': 2,
      Danger: 1,
    });
    expect(result.changedSliceCounts).toMatchObject({
      Map: 2,
      Common: 1,
    });
    expect(result.failureCodeCounts).toEqual({ Error: 1 });
  });

  it('orders hottest and slowest action summaries deterministically', () => {
    const entries = [
      entry('B', 'changed', 10, ['Map']),
      entry('A', 'changed', 10, ['Map']),
      entry('A', 'noop', 1),
      entry('C', 'changed', 20, ['Common']),
    ];
    const result = analyzeTransitionEntries(entries, 2);
    expect(result.hottestActions).toEqual([
      { actionType: 'A', count: 2 },
      { actionType: 'B', count: 1 },
    ]);
    expect(result.slowestActions).toEqual([
      { actionType: 'C', maxDurationMs: 20 },
      { actionType: 'A', maxDurationMs: 10 },
    ]);
  });

  it('never exposes action payload data because it consumes privacy-safe history', () => {
    const entries = [
      entry('Sensitive/Save', 'failed', 2, [], 'NETWORK'),
    ];
    const result = analyzeTransitionEntries(entries);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('Sensitive/Save');
    expect(serialized).toContain('NETWORK');
    expect(serialized).not.toContain('payload');
    expect(serialized).not.toContain('token');
  });

  it('handles empty history without NaN or division errors', () => {
    const result = analyzeStoreTransitions({
      entries: [],
      totalRecorded: 0,
      changed: 0,
      noop: 0,
      failed: 0,
    });
    expect(result).toMatchObject({
      totalTransitions: 0,
      noopRatio: 0,
      averageDurationMs: 0,
      maxDurationMs: 0,
      hottestActions: [],
      slowestActions: [],
    });
  });

  it('bounds top lists independently from full counters', () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry('action-' + index, 'changed', index, ['Map']));
    const result = analyzeTransitionEntries(entries, 3);
    expect(result.hottestActions).toHaveLength(3);
    expect(result.slowestActions).toHaveLength(3);
    expect(Object.keys(result.actionCounts)).toHaveLength(20);
  });
});
