import { describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_OBSERVER_LIMIT,
  MapWorkspaceAccessibilityModel,
} from './mapWorkspaceAccessibility';

describe('MapWorkspaceAccessibilityModel', () => {
  it('starts in a bounded booting state', () => {
    const model = new MapWorkspaceAccessibilityModel();
    expect(model.getSnapshot()).toEqual({
      revision: 0,
      phase: 'booting',
      isInteractive: false,
      isBusy: true,
      announcement: 'Harita çalışma alanı hazırlanıyor.',
      errorMessage: null,
    });
    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
  });

  it('publishes ready and updating lifecycle state', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.markReady();
    expect(model.getSnapshot()).toMatchObject({ revision: 1, phase: 'ready', isInteractive: true, isBusy: false });
    model.markUpdating(true);
    expect(model.getSnapshot()).toMatchObject({ revision: 2, phase: 'updating', isInteractive: true, isBusy: true });
    model.markUpdating(false);
    expect(model.getSnapshot()).toMatchObject({ revision: 3, phase: 'ready', isInteractive: true, isBusy: false });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('ignores updating signals before the map becomes interactive', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.markUpdating(true);
    expect(model.getSnapshot().phase).toBe('booting');
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('deduplicates identical transitions', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.markReady();
    model.markReady();
    model.markUpdating(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().revision).toBe(1);
  });

  it('sanitizes and bounds lifecycle errors before announcement', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.markError(new Error(`  ArcGIS\u0000  yüklenemedi   ${'x'.repeat(300)} `));
    const snapshot = model.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.isInteractive).toBe(false);
    expect(snapshot.isBusy).toBe(false);
    expect(snapshot.errorMessage).not.toContain('\u0000');
    expect(snapshot.errorMessage!.length).toBeLessThanOrEqual(180);
    expect(snapshot.announcement).toContain('Harita hazırlanamadı.');
  });

  it('uses a non-sensitive generic message for non-string failures', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.markError({ secret: 'do-not-render' });
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      errorMessage: null,
      announcement: 'Harita çalışma alanı hazırlanamadı.',
    });
  });

  it('isolates observer failures and records sanitized diagnostics', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('private observer detail'); });
    model.subscribe(healthy);
    expect(() => model.markReady()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 1,
      activeObserverCount: 2,
      rejectedObserverCount: 0,
      lastFailureRevision: 1,
      lastFailureKind: 'TypeError',
      disposed: false,
    });
    expect(JSON.stringify(model.getObserverDiagnostics())).not.toContain('private observer detail');
  });

  it('continues notifying after multiple observer failures', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw 'first'; });
    model.subscribe(() => { throw new RangeError('second private detail'); });
    model.subscribe(healthy);
    model.markReady();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getObserverDiagnostics()).toMatchObject({
      failureCount: 2,
      lastFailureKind: 'RangeError',
      lastFailureRevision: 1,
    });
  });

  it('deduplicates subscriptions and supports deterministic unsubscribe', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    const first = model.subscribe(listener);
    const second = model.subscribe(listener);
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(1);
    model.markReady();
    expect(listener).toHaveBeenCalledTimes(1);
    second();
    expect(model.getObserverDiagnostics().activeObserverCount).toBe(0);
    first();
    model.markUpdating(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('bounds observer cardinality and records rejection count', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listeners = Array.from({ length: MAP_WORKSPACE_OBSERVER_LIMIT + 6 }, () => vi.fn());
    listeners.forEach((listener) => model.subscribe(listener));
    model.markReady();
    expect(listeners.filter((listener) => listener.mock.calls.length === 1)).toHaveLength(MAP_WORKSPACE_OBSERVER_LIMIT);
    expect(listeners.slice(MAP_WORKSPACE_OBSERVER_LIMIT).every((listener) => listener.mock.calls.length === 0)).toBe(true);
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: MAP_WORKSPACE_OBSERVER_LIMIT,
      rejectedObserverCount: 6,
    });
  });

  it('freezes observer diagnostics', () => {
    const model = new MapWorkspaceAccessibilityModel();
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
    model.subscribe(() => { throw new Error('failure'); });
    model.markReady();
    expect(Object.isFrozen(model.getObserverDiagnostics())).toBe(true);
  });

  it('reset returns the semantic lifecycle to booting', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.markReady();
    model.markUpdating(true);
    model.reset();
    expect(model.getSnapshot()).toMatchObject({ phase: 'booting', isInteractive: false, isBusy: true, errorMessage: null });
  });

  it('dispose clears observers and makes future transitions inert', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.dispose();
    model.markReady();
    model.markError(new Error('ignored'));
    expect(listener).not.toHaveBeenCalled();
    expect(model.getSnapshot().phase).toBe('booting');
    expect(model.getObserverDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      disposed: true,
    });
  });

  it('rejects subscriptions after disposal without invoking them', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const listener = vi.fn();
    model.dispose();
    const unsubscribe = model.subscribe(listener);
    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(model.getObserverDiagnostics().rejectedObserverCount).toBe(1);
  });
});
