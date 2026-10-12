import { describe, expect, it, vi } from 'vitest';
import { MapModeFocusModel } from './mapModeFocusModel';

describe('MapModeFocusModel', () => {
  it('starts with exactly one 2B tab stop', () => {
    const model = new MapModeFocusModel();
    expect(model.getSnapshot()).toMatchObject({
      focusedMode: '2d',
      activeMode: '2d',
      disabled: false,
      tabIndex2D: 0,
      tabIndex3D: -1,
    });
  });

  it('supports a 3B initial mode', () => {
    const model = new MapModeFocusModel({ initialMode: '3d' });
    expect(model.getSnapshot()).toMatchObject({
      focusedMode: '3d',
      activeMode: '3d',
      tabIndex2D: -1,
      tabIndex3D: 0,
    });
  });

  it('moves next and previous between the two mode radios', () => {
    const model = new MapModeFocusModel();

    expect(model.move('next')).toBe('3d');
    expect(model.getSnapshot().tabIndex3D).toBe(0);
    expect(model.move('previous')).toBe('2d');
    expect(model.getSnapshot().tabIndex2D).toBe(0);
  });

  it('wraps next and previous deterministically', () => {
    const model = new MapModeFocusModel({ initialMode: '3d' });
    expect(model.move('next')).toBe('2d');
    expect(model.move('previous')).toBe('3d');
  });

  it('maps first and last to 2B and 3B', () => {
    const model = new MapModeFocusModel({ initialMode: '3d' });
    expect(model.move('first')).toBe('2d');
    expect(model.move('last')).toBe('3d');
  });

  it('allows pointer or direct focus to update only the roving tab stop', () => {
    const model = new MapModeFocusModel();
    model.setFocused('3d');
    expect(model.getSnapshot()).toMatchObject({
      focusedMode: '3d',
      activeMode: '2d',
      tabIndex2D: -1,
      tabIndex3D: 0,
    });
  });

  it('does not emit a revision for redundant focus updates', () => {
    const model = new MapModeFocusModel();
    const revision = model.getSnapshot().revision;
    model.setFocused('2d');
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('syncs focus to a new externally confirmed active mode', () => {
    const model = new MapModeFocusModel();
    model.setFocused('2d');

    model.sync('3d', false);

    expect(model.getSnapshot()).toMatchObject({
      activeMode: '3d',
      focusedMode: '3d',
      tabIndex3D: 0,
    });
  });

  it('preserves user focus when only the disabled state changes', () => {
    const model = new MapModeFocusModel();
    model.setFocused('3d');

    model.sync('2d', true);

    expect(model.getSnapshot()).toMatchObject({
      activeMode: '2d',
      focusedMode: '3d',
      disabled: true,
      tabIndex3D: 0,
    });
  });

  it('blocks arrow movement while mode transition controls are disabled', () => {
    const model = new MapModeFocusModel();
    model.sync('2d', true);

    expect(model.move('next')).toBe('2d');
    expect(model.getSnapshot().focusedMode).toBe('2d');
  });

  it('returns null activation while disabled', () => {
    const model = new MapModeFocusModel();
    model.sync('2d', true);
    expect(model.activateFocused()).toBeNull();
  });

  it('returns the focused mode when activation is admitted', () => {
    const model = new MapModeFocusModel();
    model.setFocused('3d');
    expect(model.activateFocused()).toBe('3d');
  });

  it('notifies observers only for accepted focus-state transitions', () => {
    const model = new MapModeFocusModel();
    const seen: string[] = [];
    model.subscribe(() => seen.push(model.getSnapshot().focusedMode));

    model.setFocused('3d');
    model.setFocused('3d');
    model.move('next');

    expect(seen).toEqual(['3d', '2d']);
  });

  it('isolates observer failures from healthy observers', () => {
    const reporter = vi.fn();
    const healthy = vi.fn();
    const model = new MapModeFocusModel({ onObserverError: reporter });
    model.subscribe(() => { throw new TypeError('bad observer'); });
    model.subscribe(healthy);

    model.setFocused('3d');

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      lastObserverFailureKind: 'TypeError',
    });
  });

  it('contains reporter failures as diagnostics', () => {
    const model = new MapModeFocusModel({
      onObserverError: () => { throw new RangeError('bad reporter'); },
    });
    model.subscribe(() => { throw new Error('bad observer'); });

    model.setFocused('3d');

    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      reporterFailureCount: 1,
      lastObserverFailureKind: 'Error',
      lastReporterFailureKind: 'RangeError',
    });
  });

  it('enforces the observer budget without throwing', () => {
    const model = new MapModeFocusModel({ maxObservers: 1 });
    const first = vi.fn();
    const rejected = vi.fn();
    const unsubscribe = model.subscribe(first);
    model.subscribe(rejected);

    model.setFocused('3d');

    expect(first).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
    });
    unsubscribe();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('deduplicates observer registrations', () => {
    const model = new MapModeFocusModel();
    const listener = vi.fn();
    const first = model.subscribe(listener);
    const second = model.subscribe(listener);
    expect(model.getDiagnostics().activeObserverCount).toBe(1);
    first();
    second();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('disposes terminally and removes the active tab-stop authority', () => {
    const model = new MapModeFocusModel();
    model.dispose();

    expect(model.disposed()).toBe(true);
    expect(model.move('next')).toBe('2d');
    expect(model.activateFocused()).toBeNull();
    model.subscribe(vi.fn());
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      rejectedObserverCount: 1,
      disposed: true,
    });
  });

  it('makes disposal idempotent', () => {
    const model = new MapModeFocusModel();
    model.dispose();
    const diagnostics = model.getDiagnostics();
    model.dispose();
    expect(model.getDiagnostics()).toEqual(diagnostics);
  });
});
