import { describe, expect, it, vi } from 'vitest';
import { MAP_WORKSPACE_SHORTCUTS } from './mapWorkspaceShortcuts';
import { MapShortcutHelpModel } from './mapShortcutHelpModel';

describe('MapShortcutHelpModel observer diagnostics', () => {
  it('tracks active observers without exposing mutable collections', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
    const first = model.subscribe(() => undefined);
    const second = model.subscribe(() => undefined);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      rejectedObserverCount: 0,
      failureCount: 0,
      reporterFailureCount: 0,
      disposed: false,
    });
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
    first();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(1);
    second();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
  });

  it('records rejected observer subscriptions at the budget', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS, { maxListeners: 1 });
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow(/listener limit exceeded/u);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
    });
  });

  it('records a rejected observer after disposal', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
    model.dispose();
    const unsubscribe = model.subscribe(() => undefined);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      rejectedObserverCount: 1,
      disposed: true,
    });
    expect(() => unsubscribe()).not.toThrow();
  });

  it('isolates one failing observer and continues healthy delivery', () => {
    const reporter = vi.fn();
    const healthy = vi.fn();
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS, { onListenerError: reporter });
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    model.setQuery('ölçüm');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 1,
      reporterFailureCount: 0,
      activeObserverCount: 2,
      lastFailureRevision: 1,
      lastFailureKind: 'TypeError',
    });
  });

  it('records reporter failures instead of swallowing them', () => {
    const healthy = vi.fn();
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS, {
      onListenerError: () => { throw new RangeError('reporter failed'); },
    });
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    expect(() => model.setQuery('harita')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 2,
      reporterFailureCount: 1,
      lastFailureRevision: 1,
      lastFailureKind: 'RangeError',
    });
  });

  it('counts failures across independent state transitions', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
    model.subscribe(() => { throw new Error('observer failed'); });
    model.setQuery('harita');
    model.setCategory('tools');
    model.moveActive('next');
    expect(model.getObserverDiagnostics().failureCount).toBeGreaterThanOrEqual(2);
    expect(model.getObserverDiagnostics().lastFailureRevision).toBe(model.getSnapshot().revision);
  });

  it('does not record failures for no-op state transitions', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
    model.subscribe(() => { throw new Error('observer failed'); });
    model.setQuery('');
    model.setCategory('all');
    model.setActive('does-not-exist');
    expect(model.getObserverDiagnostics().failureCount).toBe(0);
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('marks diagnostics disposed and clears active observer count', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    model.dispose();
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
    expect(model.listenerCount()).toBe(0);
  });

  it('keeps diagnostic snapshots immutable over time', () => {
    const model = new MapShortcutHelpModel(MAP_WORKSPACE_SHORTCUTS);
    const before = model.getObserverDiagnostics();
    model.subscribe(() => undefined);
    const after = model.getObserverDiagnostics();
    expect(before).not.toBe(after);
    expect(before.activeObserverCount).toBe(0);
    expect(after.activeObserverCount).toBe(1);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(after)).toBe(true);
  });
});
