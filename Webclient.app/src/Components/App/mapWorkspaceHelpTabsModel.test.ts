import { describe, expect, it, vi } from 'vitest';
import {
  MapWorkspaceHelpTabsModel,
  createMapWorkspaceHelpTabsSnapshot,
} from './mapWorkspaceHelpTabsModel';

describe('mapWorkspaceHelpTabsModel', () => {
  it('creates an immutable shortcuts-first snapshot', () => {
    const snapshot = createMapWorkspaceHelpTabsSnapshot(0, 'shortcuts');
    expect(snapshot).toEqual({
      revision: 0,
      activeTab: 'shortcuts',
      tabs: [
        { id: 'shortcuts', label: 'Kısayollar', selected: true, tabIndex: 0, panelHidden: false },
        { id: 'guide', label: 'Çalışma rehberi', selected: false, tabIndex: -1, panelHidden: true },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tabs)).toBe(true);
    expect(snapshot.tabs.every(Object.isFrozen)).toBe(true);
  });

  it('selects guide and publishes one revision', () => {
    const model = new MapWorkspaceHelpTabsModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.select('guide');
    expect(model.getSnapshot()).toMatchObject({ revision: 1, activeTab: 'guide' });
    expect(model.getSnapshot().tabs[0]).toMatchObject({ selected: false, tabIndex: -1, panelHidden: true });
    expect(model.getSnapshot().tabs[1]).toMatchObject({ selected: true, tabIndex: 0, panelHidden: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not publish for a repeated selection', () => {
    const model = new MapWorkspaceHelpTabsModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.select('shortcuts');
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('moves next and previous with wraparound', () => {
    const model = new MapWorkspaceHelpTabsModel();
    expect(model.move('next')).toBe('guide');
    expect(model.getSnapshot().activeTab).toBe('guide');
    expect(model.move('next')).toBe('shortcuts');
    expect(model.move('previous')).toBe('guide');
    expect(model.move('previous')).toBe('shortcuts');
  });

  it('moves to first and last deterministically', () => {
    const model = new MapWorkspaceHelpTabsModel();
    expect(model.move('last')).toBe('guide');
    expect(model.move('first')).toBe('shortcuts');
  });

  it('resets back to shortcuts', () => {
    const model = new MapWorkspaceHelpTabsModel();
    model.select('guide');
    const revision = model.getSnapshot().revision;
    model.reset();
    expect(model.getSnapshot()).toMatchObject({
      revision: revision + 1,
      activeTab: 'shortcuts',
    });
  });

  it('does not publish for no-op reset', () => {
    const model = new MapWorkspaceHelpTabsModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks observer lifecycle diagnostics', () => {
    const model = new MapWorkspaceHelpTabsModel();
    const first = model.subscribe(() => undefined);
    const second = model.subscribe(() => undefined);
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      observerFailureCount: 0,
      rejectedObserverCount: 0,
      disposed: false,
    });
    expect(Object.isFrozen(model.getDiagnostics())).toBe(true);
    first();
    expect(model.getDiagnostics().activeObserverCount).toBe(1);
    second();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('isolates a failing observer from healthy observers', () => {
    const model = new MapWorkspaceHelpTabsModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    expect(() => model.select('guide')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      lastFailureRevision: 1,
      lastFailureKind: 'TypeError',
    });
  });

  it('records multiple observer failures without exposing error messages', () => {
    const model = new MapWorkspaceHelpTabsModel();
    model.subscribe(() => { throw new Error('secret-detail-should-not-be-stored'); });
    model.select('guide');
    model.select('shortcuts');
    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 2,
      lastFailureRevision: 2,
      lastFailureKind: 'Error',
    });
    expect(JSON.stringify(model.getDiagnostics())).not.toContain('secret-detail');
  });

  it('enforces a bounded observer budget', () => {
    const model = new MapWorkspaceHelpTabsModel({ maxListeners: 2 });
    model.subscribe(() => undefined);
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow(/listener limit exceeded/u);
    expect(model.getDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('normalizes impossible observer budgets', () => {
    const model = new MapWorkspaceHelpTabsModel({ maxListeners: 0 });
    model.subscribe(() => undefined);
    expect(() => model.subscribe(() => undefined)).toThrow();
  });

  it('allows released observer slots to be reused', () => {
    const model = new MapWorkspaceHelpTabsModel({ maxListeners: 1 });
    const unsubscribe = model.subscribe(() => undefined);
    unsubscribe();
    expect(() => model.subscribe(() => undefined)).not.toThrow();
  });

  it('marks diagnostics disposed and clears listeners', () => {
    const model = new MapWorkspaceHelpTabsModel();
    model.subscribe(() => undefined);
    model.dispose();
    expect(model.disposed()).toBe(true);
    expect(model.listenerCount()).toBe(0);
    expect(model.getDiagnostics()).toMatchObject({ activeObserverCount: 0, disposed: true });
  });

  it('returns no-op subscriptions and records rejection after disposal', () => {
    const model = new MapWorkspaceHelpTabsModel();
    model.dispose();
    const unsubscribe = model.subscribe(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
    expect(model.getDiagnostics().rejectedObserverCount).toBe(1);
  });

  it('ignores state changes after disposal', () => {
    const model = new MapWorkspaceHelpTabsModel();
    model.dispose();
    const before = model.getSnapshot();
    model.select('guide');
    model.move('next');
    model.reset();
    expect(model.getSnapshot()).toBe(before);
  });

  it('keeps diagnostic snapshots immutable over lifecycle changes', () => {
    const model = new MapWorkspaceHelpTabsModel();
    const before = model.getDiagnostics();
    model.subscribe(() => undefined);
    const after = model.getDiagnostics();
    expect(before).not.toBe(after);
    expect(before.activeObserverCount).toBe(0);
    expect(after.activeObserverCount).toBe(1);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(after)).toBe(true);
  });
});
