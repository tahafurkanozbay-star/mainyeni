import { describe, expect, test, vi } from 'vitest';
import { createCommandCenterUsageModel } from './commandCenterUsageModel';

describe('commandCenterUsageModel', () => {
  test('starts empty with bounded immutable limits', () => {
    const model = createCommandCenterUsageModel();
    expect(model.limits).toEqual({
      maxTracked: 64,
      recentLimit: 8,
      frequentLimit: 8,
    });
    expect(Object.isFrozen(model.limits)).toBe(true);
    expect(model.snapshot()).toEqual({
      revision: 0,
      sequence: 0,
      totalExecutions: 0,
      lastExecutedId: null,
      trackedCount: 0,
      recentIds: [],
      frequentIds: [],
      records: [],
    });
  });

  test('records a command without persisting browser state', () => {
    const model = createCommandCenterUsageModel();
    const snapshot = model.record('layers');
    expect(snapshot.revision).toBe(1);
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.totalExecutions).toBe(1);
    expect(snapshot.lastExecutedId).toBe('layers');
    expect(snapshot.recentIds).toEqual(['layers']);
    expect(snapshot.frequentIds).toEqual(['layers']);
    expect(snapshot.records).toEqual([{ commandId: 'layers', executionCount: 1, firstSequence: 1, lastSequence: 1 }]);
  });

  test('increments repeat executions while preserving first sequence', () => {
    const model = createCommandCenterUsageModel();
    model.record('layers');
    model.record('search');
    const snapshot = model.record('layers');
    const layers = snapshot.records.find(record => record.commandId === 'layers');
    expect(layers).toEqual({ commandId: 'layers', executionCount: 2, firstSequence: 1, lastSequence: 3 });
    expect(snapshot.totalExecutions).toBe(3);
    expect(snapshot.lastExecutedId).toBe('layers');
  });

  test('orders recency independently from frequency', () => {
    const model = createCommandCenterUsageModel();
    model.record('layers');
    model.record('layers');
    model.record('layers');
    model.record('search');
    model.record('measure');
    const snapshot = model.snapshot();
    expect(snapshot.recentIds.slice(0, 3)).toEqual(['measure', 'search', 'layers']);
    expect(snapshot.frequentIds.slice(0, 3)).toEqual(['layers', 'measure', 'search']);
  });

  test('uses latest sequence as frequency tie breaker', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    model.record('layers');
    model.record('measure');
    expect(model.snapshot().frequentIds.slice(0, 3)).toEqual(['measure', 'layers', 'search']);
  });

  test('caps recent and frequent projections independently', () => {
    const model = createCommandCenterUsageModel({
      maxTracked: 10,
      recentLimit: 2,
      frequentLimit: 3,
    });
    for (const id of ['a', 'b', 'c', 'd', 'e']) model.record(id);
    expect(model.snapshot().recentIds).toEqual(['e', 'd']);
    expect(model.snapshot().frequentIds).toEqual(['e', 'd', 'c']);
    expect(model.snapshot().records).toHaveLength(5);
  });

  test('evicts the least recently used record at capacity', () => {
    const model = createCommandCenterUsageModel({ maxTracked: 3 });
    model.record('a');
    model.record('b');
    model.record('c');
    model.record('a');
    model.record('d');
    expect(model.snapshot().records.map(record => record.commandId)).toEqual(['a', 'c', 'd']);
    expect(model.snapshot().trackedCount).toBe(3);
  });

  test('prefers evicting lower-frequency record when recency is otherwise comparable', () => {
    const model = createCommandCenterUsageModel({ maxTracked: 2 });
    model.record('a');
    model.record('a');
    model.record('b');
    model.record('c');
    expect(model.snapshot().records.map(record => record.commandId)).toEqual(['b', 'c']);
  });

  test('sanitizes whitespace and punctuation in recorded ids', () => {
    const model = createCommandCenterUsageModel();
    model.record(' service / park ');
    expect(model.snapshot().lastExecutedId).toBe('service-park');
    expect(model.snapshot().records[0]?.commandId).toBe('service-park');
  });

  test('ignores empty command ids without advancing revision', () => {
    const model = createCommandCenterUsageModel();
    const before = model.snapshot();
    const after = model.record('  !!!  ');
    expect(after).toBe(before);
    expect(after.revision).toBe(0);
  });

  test('reconciles removed commands out of session usage facts', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    model.record('layers');
    model.record('measure');
    const snapshot = model.reconcile(['search', 'measure']);
    expect(snapshot.records.map(record => record.commandId)).toEqual(['search', 'measure']);
    expect(snapshot.recentIds).toEqual(['measure', 'search']);
    expect(snapshot.lastExecutedId).toBe('measure');
  });

  test('clears last executed id when reconciliation removes it', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    model.record('layers');
    const snapshot = model.reconcile(['search']);
    expect(snapshot.lastExecutedId).toBeNull();
    expect(snapshot.records.map(record => record.commandId)).toEqual(['search']);
  });

  test('reconcile is a no-op when inventory is unchanged', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    const before = model.snapshot();
    const after = model.reconcile(['search', 'layers']);
    expect(after).toBe(before);
  });

  test('clear removes records without rewinding execution counters', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    model.record('layers');
    const snapshot = model.clear();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.trackedCount).toBe(0);
    expect(snapshot.lastExecutedId).toBeNull();
    expect(snapshot.totalExecutions).toBe(2);
    expect(snapshot.sequence).toBe(2);
  });

  test('clear is a no-op on an already empty model', () => {
    const model = createCommandCenterUsageModel();
    expect(model.clear()).toBe(model.snapshot());
    expect(model.snapshot().revision).toBe(0);
  });

  test('prioritizes recent commands while preserving stable source order for untouched items', () => {
    const model = createCommandCenterUsageModel();
    model.record('layers');
    model.record('measure');
    const source = [
      { id: 'search' },
      { id: 'layers' },
      { id: 'legend' },
      { id: 'measure' },
      { id: 'help' },
    ];
    expect(model.prioritize(source, entry => entry.id).map(entry => entry.id)).toEqual([
      'measure', 'layers', 'search', 'legend', 'help',
    ]);
  });

  test('keeps source order when there is no usage history', () => {
    const model = createCommandCenterUsageModel();
    const source = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    const prioritized = model.prioritize(source, entry => entry.id);
    expect(prioritized.map(entry => entry.id)).toEqual(['b', 'a', 'c']);
    expect(Object.isFrozen(prioritized)).toBe(true);
  });

  test('does not mutate the caller collection while prioritizing', () => {
    const model = createCommandCenterUsageModel();
    model.record('b');
    const source = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const copy = [...source];
    model.prioritize(source, entry => entry.id);
    expect(source).toEqual(copy);
  });

  test('subscribers receive an immediate frozen snapshot', () => {
    const model = createCommandCenterUsageModel();
    const observer = vi.fn();
    model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    const [snapshot, previous] = observer.mock.calls[0] as [ReturnType<typeof model.snapshot>, ReturnType<typeof model.snapshot>];
    expect(snapshot).toBe(previous);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('subscribers receive committed revisions with previous snapshots', () => {
    const model = createCommandCenterUsageModel();
    const calls: Array<[number, number]> = [];
    model.subscribe((snapshot, previous) => calls.push([snapshot.revision, previous.revision]));
    model.record('search');
    model.record('layers');
    expect(calls).toEqual([[0, 0], [1, 0], [2, 1]]);
  });

  test('unsubscribe is idempotent and stops future notifications', () => {
    const model = createCommandCenterUsageModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    unsubscribe();
    unsubscribe();
    model.record('search');
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test('isolates observer failures and continues notifying remaining observers', () => {
    const errors: unknown[] = [];
    const model = createCommandCenterUsageModel({ onObserverError: error => errors.push(error) });
    const healthy = vi.fn();
    model.subscribe(() => { throw new Error('observer failed'); });
    model.subscribe(healthy);
    model.record('search');
    expect(errors).toHaveLength(2);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  test('isolates reporter failures without aborting model transitions', () => {
    const model = createCommandCenterUsageModel({
      onObserverError: () => { throw new Error('reporter failed'); },
    });
    model.subscribe(() => { throw new Error('observer failed'); });
    expect(() => model.record('search')).not.toThrow();
    expect(model.snapshot().lastExecutedId).toBe('search');
  });

  test('rejects observer growth beyond the bounded capacity', () => {
    const model = createCommandCenterUsageModel();
    const releases: Array<() => void> = [];
    for (let index = 0; index < 24; index += 1) {
      releases.push(model.subscribe(() => undefined));
    }
    expect(() => model.subscribe(() => undefined)).toThrow('observer capacity exceeded');
    releases.forEach(release => release());
  });

  test('dispose is idempotent and makes future writes inert', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    const before = model.snapshot();
    model.dispose();
    model.dispose();
    expect(model.record('layers')).toBe(before);
    expect(model.reconcile(['layers'])).toBe(before);
    expect(model.clear()).toBe(before);
  });

  test('subscribe after dispose returns an inert release function', () => {
    const model = createCommandCenterUsageModel();
    model.dispose();
    const observer = vi.fn();
    const release = model.subscribe(observer);
    expect(observer).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });

  test('clamps unsafe limits to deterministic bounds', () => {
    const model = createCommandCenterUsageModel({
      maxTracked: Number.POSITIVE_INFINITY,
      recentLimit: -5,
      frequentLimit: 9999,
    });
    expect(model.limits).toEqual({
      maxTracked: 1,
      recentLimit: 1,
      frequentLimit: 1,
    });
  });

  test('freezes nested records and projections', () => {
    const model = createCommandCenterUsageModel();
    model.record('search');
    const snapshot = model.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(Object.isFrozen(snapshot.records[0])).toBe(true);
    expect(Object.isFrozen(snapshot.recentIds)).toBe(true);
    expect(Object.isFrozen(snapshot.frequentIds)).toBe(true);
  });
});