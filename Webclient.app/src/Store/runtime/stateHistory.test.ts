import { describe, expect, it } from 'vitest';
import { createStoreTransitionHistory } from './stateHistory';

const entry = (index: number, status: 'changed' | 'noop' | 'failed' = 'changed') => ({
  actionType: 'action/' + index,
  actionAudit: {
    actionType: 'action/' + index,
    payloadKind: 'none' as const,
    estimatedEntries: 0,
    maxDepthObserved: 0,
    hasSensitiveKeys: false,
    hasFunctions: false,
    truncated: false,
  },
  timestamp: index,
  durationMs: index,
  status,
  changedSlices: status === 'changed' ? ['Map' as const] : [],
  changedPaths: status === 'changed' ? ['map.graphicsCount'] : [],
  beforeFingerprint: 'before-' + index,
  afterFingerprint: 'after-' + index,
  invariantErrors: 0,
  invariantWarnings: 0,
  errorCode: status === 'failed' ? 'Error' : null,
});

describe('stateHistory', () => {
  it('retains newest events within a strict capacity', () => {
    const history = createStoreTransitionHistory({ maxHistoryEntries: 2 });
    history.record(entry(1));
    history.record(entry(2));
    history.record(entry(3));
    expect(history.list().map((item) => item.actionType)).toEqual(['action/3', 'action/2']);
    expect(history.snapshot()).toMatchObject({
      capacity: 2,
      retained: 2,
      totalRecorded: 3,
      dropped: 1,
    });
  });

  it('tracks changed, noop and failed counters independently', () => {
    const history = createStoreTransitionHistory();
    history.record(entry(1, 'changed'));
    history.record(entry(2, 'noop'));
    history.record(entry(3, 'failed'));
    expect(history.snapshot()).toMatchObject({
      changed: 1,
      noop: 1,
      failed: 1,
    });
  });

  it('freezes stored changed slice arrays', () => {
    const history = createStoreTransitionHistory();
    const stored = history.record(entry(1));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.changedSlices)).toBe(true);
  });

  it('clears retained entries without resetting lifetime counters', () => {
    const history = createStoreTransitionHistory();
    history.record(entry(1));
    history.record(entry(2));
    expect(history.clear()).toBe(2);
    expect(history.snapshot()).toMatchObject({
      retained: 0,
      totalRecorded: 2,
      changed: 2,
    });
  });
});
