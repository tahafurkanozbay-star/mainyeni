import { describe, expect, it, vi } from 'vitest';
import { MapModeExperienceModel } from './mapModeExperienceModel';
import { MapModeFocusModel } from './mapModeFocusModel';
import { resolveMapModePresentation } from './mapModePresentationPolicy';
import { MapWorkspaceRecoveryModel } from './mapWorkspaceRecoveryModel';

describe('map experience resilience', () => {
  it('keeps the newest mode request authoritative under stale timeout callbacks', () => {
    let now = 0;
    const model = new MapModeExperienceModel({ now: () => now });
    const first = model.requestMode('3d');
    now = 100;
    model.confirmMode('3d', 'runtime');
    const second = model.requestMode('2d');

    for (let index = 0; index < 50; index += 1) {
      model.markTimeout(first!);
    }

    expect(model.getSnapshot()).toMatchObject({
      phase: 'requesting',
      requestId: second,
      requestedMode: '2d',
      currentMode: '3d',
    });
  });

  it('survives repeated late mode confirmations without reopening settled requests', () => {
    const model = new MapModeExperienceModel();
    const request = model.requestMode('3d');
    model.markTimeout(request!);
    model.confirmMode('3d', 'late-runtime');

    for (let index = 0; index < 100; index += 1) {
      model.confirmMode('3d', 'duplicate-runtime-event');
    }

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      currentMode: '3d',
      requestedMode: null,
      canRetry: false,
    });
  });

  it('never exceeds the configured mode retry budget under repeated timeouts', () => {
    const model = new MapModeExperienceModel({ maxAttempts: 3 });
    const requestIds: number[] = [];

    let requestId = model.requestMode('3d');
    while (requestId !== null) {
      requestIds.push(requestId);
      model.markTimeout(requestId);
      requestId = model.retry();
    }

    expect(requestIds).toEqual([1, 2, 3]);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      attempt: 3,
      canRetry: false,
    });
  });

  it('keeps environment churn bounded to scalar presentation facts', () => {
    const model = new MapModeExperienceModel();

    for (let index = 0; index < 250; index += 1) {
      model.setEnvironment({
        viewport: index % 3 === 0 ? 'compact' : index % 3 === 1 ? 'medium' : 'wide',
        reducedMotion: index % 2 === 0,
        forcedColors: index % 5 === 0,
        coarsePointer: index % 7 === 0,
      });
    }

    const snapshot = model.getSnapshot();
    expect(snapshot.revision).toBeLessThanOrEqual(250);
    expect(Object.keys(snapshot.environment).sort()).toEqual([
      'coarsePointer',
      'forcedColors',
      'reducedMotion',
      'viewport',
    ]);
    expect(Object.isFrozen(snapshot.environment)).toBe(true);
  });

  it('keeps presentation resolution pure under repeated reads', () => {
    const model = new MapModeExperienceModel();
    model.setEnvironment({ viewport: 'compact', coarsePointer: true });
    const snapshot = model.getSnapshot();

    const facts = Array.from({ length: 200 }, () => resolveMapModePresentation(snapshot));

    expect(facts.every((fact) => fact.layout === 'compact-dock')).toBe(true);
    expect(facts.every((fact) => fact.targetSizePx === 48)).toBe(true);
    expect(model.getSnapshot()).toBe(snapshot);
  });

  it('keeps exactly one roving tab stop through repeated focus movement', () => {
    const focus = new MapModeFocusModel();

    for (let index = 0; index < 101; index += 1) {
      focus.move(index % 2 === 0 ? 'next' : 'previous');
      const snapshot = focus.getSnapshot();
      const tabStops = [snapshot.tabIndex2D, snapshot.tabIndex3D].filter((value) => value === 0);
      expect(tabStops).toHaveLength(1);
    }
  });

  it('resynchronizes roving focus after alternating runtime confirmations', () => {
    const focus = new MapModeFocusModel();

    for (let index = 0; index < 50; index += 1) {
      const mode = index % 2 === 0 ? '3d' : '2d';
      focus.sync(mode, false);
      expect(focus.getSnapshot().activeMode).toBe(mode);
      expect(focus.getSnapshot().focusedMode).toBe(mode);
    }
  });

  it('blocks focus activation during transition lock without losing the last focus target', () => {
    const focus = new MapModeFocusModel();
    focus.setFocused('3d');
    focus.sync('2d', true);

    for (let index = 0; index < 20; index += 1) {
      expect(focus.move('next')).toBe('3d');
      expect(focus.activateFocused()).toBeNull();
    }

    expect(focus.getSnapshot()).toMatchObject({
      focusedMode: '3d',
      activeMode: '2d',
      disabled: true,
    });
  });

  it('keeps observer cardinality stable through subscribe-unsubscribe churn', () => {
    const model = new MapModeExperienceModel({ maxObservers: 8 });
    const listeners = Array.from({ length: 8 }, () => vi.fn());
    const unsubscribe = listeners.map((listener) => model.subscribe(listener));

    for (let index = 0; index < 100; index += 1) {
      const listenerIndex = index % unsubscribe.length;
      unsubscribe[listenerIndex]();
      unsubscribe[listenerIndex] = model.subscribe(listeners[listenerIndex]);
    }

    expect(model.getDiagnostics().activeObserverCount).toBe(8);
    unsubscribe.forEach((remove) => remove());
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('contains many failing observers without blocking healthy notification delivery', () => {
    const reporter = vi.fn();
    const model = new MapModeExperienceModel({ maxObservers: 12, onObserverError: reporter });
    const healthy = vi.fn();

    for (let index = 0; index < 6; index += 1) {
      model.subscribe(() => { throw new Error(`failure-${index}`); });
    }
    model.subscribe(healthy);
    model.requestMode('3d');

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(6);
    expect(model.getDiagnostics().observerFailureCount).toBe(6);
  });

  it('keeps recovery attempts sequential under duplicate begin calls', () => {
    const recovery = new MapWorkspaceRecoveryModel({ maxAttempts: 3 });
    const first = recovery.beginAttempt();

    const duplicates = Array.from({ length: 40 }, () => recovery.beginAttempt());

    expect(new Set(duplicates)).toEqual(new Set([first]));
    expect(recovery.getSnapshot()).toMatchObject({
      attempt: 1,
      attemptId: first,
      phase: 'booting',
    });
  });

  it('ignores stale recovery callbacks after the next attempt begins', () => {
    const recovery = new MapWorkspaceRecoveryModel();
    const first = recovery.beginAttempt();
    recovery.fail(first!, new Error('first'));
    const second = recovery.beginAttempt();

    for (let index = 0; index < 50; index += 1) {
      recovery.markDelayed(first!);
      recovery.succeed(first!);
      recovery.fail(first!, new Error('stale'));
    }

    expect(recovery.getSnapshot()).toMatchObject({
      attemptId: second,
      attempt: 2,
      phase: 'booting',
    });
  });

  it('never exceeds the recovery attempt budget after repeated failures', () => {
    const recovery = new MapWorkspaceRecoveryModel({ maxAttempts: 3 });
    const seen: number[] = [];

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const attemptId = recovery.beginAttempt();
      if (attemptId === null) break;
      seen.push(attemptId);
      recovery.fail(attemptId, new Error('runtime'));
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(recovery.beginAttempt()).toBeNull();
    expect(recovery.getSnapshot()).toMatchObject({
      attempt: 3,
      canRetry: false,
      phase: 'error',
    });
  });

  it('keeps raw error payloads out of recovery snapshots during adversarial failures', () => {
    const recovery = new MapWorkspaceRecoveryModel();
    const secrets = [
      'https://internal.example/maps?token=secret',
      'Bearer abc.def.ghi',
      '/srv/private/config.json',
      'apikey=never-render-this',
    ];

    for (const secret of secrets) {
      const attempt = recovery.beginAttempt();
      if (attempt === null) break;
      recovery.fail(attempt, new Error(secret), 'MAP_SAFE');
      const serialized = JSON.stringify(recovery.getSnapshot());
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('secret');
      if (!recovery.canRetry()) break;
    }
  });

  it('keeps recovery observer failures isolated under repeated lifecycle changes', () => {
    const reporter = vi.fn();
    const healthy = vi.fn();
    const recovery = new MapWorkspaceRecoveryModel({ onObserverError: reporter });
    recovery.subscribe(() => { throw new TypeError('broken'); });
    recovery.subscribe(healthy);

    const attempt = recovery.beginAttempt();
    recovery.markDelayed(attempt!);
    recovery.fail(attempt!, new Error('failed'));

    expect(healthy).toHaveBeenCalledTimes(3);
    expect(reporter).toHaveBeenCalledTimes(3);
    expect(recovery.getDiagnostics().observerFailureCount).toBe(3);
  });

  it('stops all three authorities from mutating after disposal', () => {
    const mode = new MapModeExperienceModel();
    const focus = new MapModeFocusModel();
    const recovery = new MapWorkspaceRecoveryModel();

    const modeSnapshot = mode.getSnapshot();
    const focusSnapshot = focus.getSnapshot();
    const recoverySnapshot = recovery.getSnapshot();

    mode.dispose();
    focus.dispose();
    recovery.dispose();

    for (let index = 0; index < 20; index += 1) {
      mode.requestMode('3d');
      mode.setEnvironment({ coarsePointer: true });
      focus.setFocused('3d');
      focus.sync('3d', false);
      recovery.beginAttempt();
      recovery.markDelayed(index + 1);
    }

    expect(mode.getSnapshot()).toBe(modeSnapshot);
    expect(focus.getSnapshot()).toBe(focusSnapshot);
    expect(recovery.getSnapshot()).toBe(recoverySnapshot);
    expect(mode.getDiagnostics().disposed).toBe(true);
    expect(focus.getDiagnostics().disposed).toBe(true);
    expect(recovery.getDiagnostics().disposed).toBe(true);
  });
});
