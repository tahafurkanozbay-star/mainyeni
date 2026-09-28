import { describe, expect, test, vi } from 'vitest';
import {
  createCommandCenterScopeModel,
  type CommandCenterScopeItem,
} from './commandCenterScopeModel';

const item = (
  id: string,
  scopes: CommandCenterScopeItem['scopes'],
): CommandCenterScopeItem => ({ id, scopes });

const inventory: readonly CommandCenterScopeItem[] = [
  item('search', ['map']),
  item('layers', ['map']),
  item('measure', ['map', 'analysis']),
  item('sketch', ['map', 'analysis']),
  item('help', ['help']),
  item('service-parks', ['services']),
  item('service-metro', ['services']),
];

describe('commandCenterScopeModel', () => {
  test('starts on all with deterministic counts', () => {
    const model = createCommandCenterScopeModel(inventory);
    expect(model.snapshot()).toEqual({
      activeScope: 'all',
      counts: {
        all: 7,
        map: 4,
        analysis: 2,
        services: 2,
        help: 1,
      },
      visibleIds: [
        'search', 'layers', 'measure', 'sketch', 'help', 'service-parks', 'service-metro',
      ],
      revision: 0,
    });
  });

  test('filters to map scope without changing source order', () => {
    const model = createCommandCenterScopeModel(inventory);
    const snapshot = model.setScope('map');
    expect(snapshot.visibleIds).toEqual(['search', 'layers', 'measure', 'sketch']);
    expect(snapshot.revision).toBe(1);
  });

  test('supports analysis, services and help scopes', () => {
    const model = createCommandCenterScopeModel(inventory);
    expect(model.setScope('analysis').visibleIds).toEqual(['measure', 'sketch']);
    expect(model.setScope('services').visibleIds).toEqual(['service-parks', 'service-metro']);
    expect(model.setScope('help').visibleIds).toEqual(['help']);
  });

  test('returns to all without losing the inventory', () => {
    const model = createCommandCenterScopeModel(inventory);
    model.setScope('services');
    const snapshot = model.setScope('all');
    expect(snapshot.visibleIds).toHaveLength(7);
    expect(snapshot.counts.all).toBe(7);
  });

  test('treats repeated setScope as a no-op', () => {
    const model = createCommandCenterScopeModel(inventory);
    const first = model.setScope('map');
    const second = model.setScope('map');
    expect(second).toBe(first);
    expect(second.revision).toBe(1);
  });

  test('includes only ids visible in the active scope', () => {
    const model = createCommandCenterScopeModel(inventory);
    model.setScope('services');
    expect(model.includes('service-parks')).toBe(true);
    expect(model.includes('measure')).toBe(false);
    expect(model.includes(' missing ')).toBe(false);
  });

  test('sanitizes ids consistently for includes checks', () => {
    const model = createCommandCenterScopeModel([
      item(' service parks ', ['services']),
    ]);
    model.setScope('services');
    expect(model.snapshot().visibleIds).toEqual(['service-parks']);
    expect(model.includes('service parks')).toBe(true);
  });

  test('deduplicates ids after sanitization', () => {
    const model = createCommandCenterScopeModel([
      item('same id', ['map']),
      item('same-id', ['analysis']),
      item('unique', ['help']),
    ]);
    expect(model.snapshot().counts.all).toBe(2);
    expect(model.snapshot().visibleIds).toEqual(['same-id', 'unique']);
  });

  test('deduplicates repeated scope tags per item', () => {
    const model = createCommandCenterScopeModel([
      item('measure', ['map', 'map', 'analysis', 'analysis']),
    ]);
    expect(model.snapshot().counts).toEqual({
      all: 1,
      map: 1,
      analysis: 1,
      services: 0,
      help: 0,
    });
  });

  test('supports commands belonging to more than one concrete scope', () => {
    const model = createCommandCenterScopeModel([
      item('measure', ['map', 'analysis']),
    ]);
    expect(model.setScope('map').visibleIds).toEqual(['measure']);
    expect(model.setScope('analysis').visibleIds).toEqual(['measure']);
  });

  test('bounds inventory cardinality', () => {
    const many = Array.from({ length: 50 }, (_, index) => item(`item-${index}`, ['map']));
    const model = createCommandCenterScopeModel(many, { maxItems: 5 });
    expect(model.maxItems).toBe(5);
    expect(model.snapshot().counts.all).toBe(5);
    expect(model.snapshot().visibleIds).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
  });

  test('clamps unsafe maxItems values', () => {
    expect(createCommandCenterScopeModel(inventory, { maxItems: -1 }).maxItems).toBe(1);
    expect(createCommandCenterScopeModel(inventory, { maxItems: 99999 }).maxItems).toBe(4096);
    expect(createCommandCenterScopeModel(inventory, { maxItems: Number.NaN }).maxItems).toBe(1);
  });

  test('reconcile updates visible ids while preserving active scope', () => {
    const model = createCommandCenterScopeModel(inventory);
    model.setScope('analysis');
    const snapshot = model.reconcile([
      item('measure', ['analysis']),
      item('buffer', ['analysis']),
      item('service-new', ['services']),
    ]);
    expect(snapshot.activeScope).toBe('analysis');
    expect(snapshot.visibleIds).toEqual(['measure', 'buffer']);
    expect(snapshot.counts.services).toBe(1);
  });

  test('reconcile is a no-op for equivalent inventory', () => {
    const model = createCommandCenterScopeModel(inventory);
    const before = model.snapshot();
    const after = model.reconcile(inventory);
    expect(after).toBe(before);
  });

  test('reconcile notices scope membership changes', () => {
    const model = createCommandCenterScopeModel([
      item('measure', ['analysis']),
    ]);
    model.setScope('analysis');
    const snapshot = model.reconcile([
      item('measure', ['map']),
    ]);
    expect(snapshot.visibleIds).toEqual([]);
    expect(snapshot.counts.analysis).toBe(0);
    expect(snapshot.counts.map).toBe(1);
  });

  test('subscribers receive immediate current snapshot', () => {
    const model = createCommandCenterScopeModel(inventory);
    const observer = vi.fn();
    model.subscribe(observer);
    expect(observer).toHaveBeenCalledTimes(1);
    const [snapshot, previous] = observer.mock.calls[0] as [ReturnType<typeof model.snapshot>, ReturnType<typeof model.snapshot>];
    expect(snapshot).toBe(previous);
    expect(snapshot).toBe(model.snapshot());
  });

  test('subscribers receive previous and current revisions', () => {
    const model = createCommandCenterScopeModel(inventory);
    const revisions: Array<[number, number]> = [];
    model.subscribe((snapshot, previous) => revisions.push([snapshot.revision, previous.revision]));
    model.setScope('map');
    model.setScope('analysis');
    expect(revisions).toEqual([[0, 0], [1, 0], [2, 1]]);
  });

  test('unsubscribe is idempotent', () => {
    const model = createCommandCenterScopeModel(inventory);
    const observer = vi.fn();
    const release = model.subscribe(observer);
    release();
    release();
    model.setScope('map');
    expect(observer).toHaveBeenCalledTimes(1);
  });

  test('isolates observer failures from healthy observers', () => {
    const errors: unknown[] = [];
    const healthy = vi.fn();
    const model = createCommandCenterScopeModel(inventory, {
      onObserverError: error => errors.push(error),
    });
    model.subscribe(() => { throw new Error('scope observer'); });
    model.subscribe(healthy);
    model.setScope('services');
    expect(errors).toHaveLength(2);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  test('isolates failures in the observer error reporter', () => {
    const model = createCommandCenterScopeModel(inventory, {
      onObserverError: () => { throw new Error('reporter'); },
    });
    model.subscribe(() => { throw new Error('observer'); });
    expect(() => model.setScope('map')).not.toThrow();
    expect(model.snapshot().activeScope).toBe('map');
  });

  test('bounds observer growth', () => {
    const model = createCommandCenterScopeModel(inventory);
    const releases: Array<() => void> = [];
    for (let index = 0; index < 24; index += 1) {
      releases.push(model.subscribe(() => undefined));
    }
    expect(() => model.subscribe(() => undefined)).toThrow('observer capacity exceeded');
    releases.forEach(release => release());
  });

  test('dispose is idempotent and makes transitions inert', () => {
    const model = createCommandCenterScopeModel(inventory);
    const before = model.snapshot();
    model.dispose();
    model.dispose();
    expect(model.setScope('services')).toBe(before);
    expect(model.reconcile([])).toBe(before);
  });

  test('subscribe after dispose is inert', () => {
    const model = createCommandCenterScopeModel(inventory);
    model.dispose();
    const observer = vi.fn();
    const release = model.subscribe(observer);
    expect(observer).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });

  test('freezes public snapshots and visible id projections', () => {
    const model = createCommandCenterScopeModel(inventory);
    const snapshot = model.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counts)).toBe(true);
    expect(Object.isFrozen(snapshot.visibleIds)).toBe(true);
  });
});