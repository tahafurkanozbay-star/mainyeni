import { describe, expect, it, vi } from 'vitest';
import { MapModeTransitionModel, createMapModeTransitionModel } from './mapModeTransitionModel';

const request3d = (model: MapModeTransitionModel) => {
  const request = model.request('3d', 'control');
  expect(request).not.toBeNull();
  return request!;
};

describe('MapModeTransitionModel', () => {
  it('starts in a deterministic 2B idle state', () => {
    const model = createMapModeTransitionModel();
    expect(model.getSnapshot()).toMatchObject({
      revision: 0,
      activeMode: '2d',
      desiredMode: '2d',
      phase: 'idle',
      busy: false,
      queued: false,
      canRequest2d: false,
      canRequest3d: true,
      failureCount: 0,
    });
    expect(model.getSnapshot().announcement).toContain('2B');
  });

  it('supports an explicit initial 3B mode', () => {
    const model = createMapModeTransitionModel({ initialMode: '3d' });
    expect(model.getSnapshot().activeMode).toBe('3d');
    expect(model.getSnapshot().desiredMode).toBe('3d');
    expect(model.getSnapshot().canRequest2d).toBe(true);
    expect(model.getSnapshot().canRequest3d).toBe(false);
  });

  it('queues a new 3B request with stable identity and source', () => {
    const model = createMapModeTransitionModel({ now: () => 42 });
    const request = request3d(model);
    expect(request).toEqual({ requestId: 1, targetMode: '3d', source: 'control', queuedAtMs: 42 });
    expect(model.getSnapshot()).toMatchObject({
      requestId: 1,
      desiredMode: '3d',
      phase: 'queued',
      busy: true,
      queued: true,
      source: 'control',
    });
    expect(model.getSnapshot().announcement).toContain('sıraya alındı');
  });

  it('begins only the latest matching request', () => {
    const model = createMapModeTransitionModel();
    const first = request3d(model);
    const second = model.request('2d', 'command');
    expect(second).not.toBeNull();
    expect(model.begin(first)).toBe(false);
    expect(model.begin(second!)).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'transitioning',
      desiredMode: '2d',
      activeRequestId: second!.requestId,
    });
  });

  it('coalesces duplicate busy requests instead of growing a queue', () => {
    const model = createMapModeTransitionModel();
    const first = request3d(model);
    const second = model.request('3d', 'command');
    const third = model.request('3d', 'preference');
    expect(second?.requestId).toBe(first.requestId);
    expect(third?.requestId).toBe(first.requestId);
    expect(model.getSnapshot().coalescedRequestCount).toBe(2);
    expect(model.getSnapshot().requestId).toBe(1);
  });

  it('counts an opposite request as superseding the current intent', () => {
    const model = createMapModeTransitionModel();
    request3d(model);
    const request2d = model.request('2d', 'command');
    expect(request2d?.requestId).toBe(2);
    expect(model.getSnapshot().supersededRequestCount).toBe(1);
    expect(model.getSnapshot().desiredMode).toBe('2d');
  });

  it('does not create work for the already active mode when idle', () => {
    const model = createMapModeTransitionModel();
    const request = model.request('2d', 'control');
    expect(request).toBeNull();
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', activeMode: '2d', desiredMode: '2d' });
  });

  it('records deterministic transition duration on completion', () => {
    let now = 100;
    const model = createMapModeTransitionModel({ now: () => now });
    const request = request3d(model);
    expect(model.begin(request)).toBe(true);
    now = 365;
    expect(model.complete(request)).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      activeMode: '3d',
      desiredMode: '3d',
      lastDurationMs: 265,
      activeRequestId: null,
    });
    expect(model.getDiagnostics()).toMatchObject({
      completedTransitionCount: 1,
      maximumObservedDurationMs: 265,
    });
    expect(model.getDiagnostics().recentDurationsMs).toEqual([265]);
  });

  it('keeps only the configured bounded duration window', () => {
    let now = 0;
    const model = createMapModeTransitionModel({ now: () => now, maxDurationSamples: 2 });
    const run = (mode: '2d' | '3d', duration: number) => {
      const request = model.request(mode, 'control');
      expect(request).not.toBeNull();
      model.begin(request!);
      now += duration;
      model.complete(request!);
    };
    run('3d', 10);
    run('2d', 20);
    run('3d', 30);
    expect(model.getDiagnostics().recentDurationsMs).toEqual([20, 30]);
    expect(model.getDiagnostics().maximumObservedDurationMs).toBe(30);
  });

  it('records a sanitized error kind while preserving the fallback mode', () => {
    let now = 10;
    const model = createMapModeTransitionModel({ now: () => now });
    const request = request3d(model);
    model.begin(request);
    now = 25;
    const error = new Error('secret runtime text');
    error.name = 'WebGL\nFailure';
    expect(model.fail(request, error, '2d')).toBe(true);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      activeMode: '2d',
      desiredMode: '3d',
      lastErrorKind: 'WebGLFailure',
      failureCount: 1,
      lastDurationMs: 15,
    });
    expect(model.getSnapshot().announcement).not.toContain('secret runtime text');
    expect(model.getDiagnostics().transitionFailureCount).toBe(1);
  });

  it('rejects stale completion from an earlier active request', () => {
    const model = createMapModeTransitionModel();
    const request = request3d(model);
    model.begin(request);
    const replacement = model.request('2d', 'command');
    expect(replacement).not.toBeNull();
    expect(model.complete(request, '3d')).toBe(true);
    expect(model.getSnapshot().phase).toBe('queued');
    expect(model.getSnapshot().desiredMode).toBe('2d');
  });

  it('rejects completion if the request never became active', () => {
    const model = createMapModeTransitionModel();
    const request = request3d(model);
    expect(model.complete(request)).toBe(false);
    expect(model.getSnapshot().activeMode).toBe('2d');
  });

  it('acknowledges runtime mode without synthesizing a request', () => {
    const model = createMapModeTransitionModel();
    model.acknowledge('3d', 'runtime');
    expect(model.getSnapshot()).toMatchObject({
      activeMode: '3d', desiredMode: '3d', phase: 'ready', requestId: 0, source: 'runtime',
    });
  });

  it('exposes reduced-motion presentation facts without media-query duplication in consumers', () => {
    const model = createMapModeTransitionModel({ reducedMotion: true });
    expect(model.getSnapshot().presentation).toMatchObject({
      reducedMotion: true,
      motionDurationMs: 0,
      minimumTargetSizePx: 44,
    });
  });

  it('uses 48px targets for coarse pointers', () => {
    const model = createMapModeTransitionModel({ coarsePointer: true });
    expect(model.getSnapshot().presentation.minimumTargetSizePx).toBe(48);
  });

  it('updates presentation facts independently from transition state', () => {
    const model = createMapModeTransitionModel();
    const revision = model.getSnapshot().revision;
    model.setPresentation({ reducedMotion: true, forcedColors: true, coarsePointer: true });
    expect(model.getSnapshot().revision).toBe(revision + 1);
    expect(model.getSnapshot().presentation).toMatchObject({
      reducedMotion: true,
      forcedColors: true,
      coarsePointer: true,
      motionDurationMs: 0,
      minimumTargetSizePx: 48,
    });
  });

  it('keeps snapshots immutable', () => {
    const model = createMapModeTransitionModel();
    const snapshot = model.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.presentation)).toBe(true);
  });

  it('notifies every healthy listener when state changes', () => {
    const model = createMapModeTransitionModel();
    const first = vi.fn();
    const second = vi.fn();
    model.subscribe(first);
    model.subscribe(second);
    request3d(model);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing listener and keeps later listeners alive', () => {
    const model = createMapModeTransitionModel();
    const healthy = vi.fn();
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);
    request3d(model);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics().listenerFailureCount).toBe(1);
  });

  it('bounds listener growth', () => {
    const model = createMapModeTransitionModel({ maxListeners: 2 });
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    model.subscribe(a);
    model.subscribe(b);
    model.subscribe(c);
    expect(model.getDiagnostics()).toMatchObject({ listenerCount: 2, rejectedListenerCount: 1 });
    request3d(model);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();
  });

  it('unsubscribes idempotently', () => {
    const model = createMapModeTransitionModel();
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    expect(model.getDiagnostics().listenerCount).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(model.getDiagnostics().listenerCount).toBe(0);
  });

  it('disposes listeners and rejects future mutations', () => {
    const model = createMapModeTransitionModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.dispose();
    expect(model.getDiagnostics()).toMatchObject({ disposed: true, listenerCount: 0 });
    expect(model.request('3d')).toBeNull();
    model.acknowledge('3d');
    model.setPresentation({ reducedMotion: true });
    expect(model.getSnapshot().activeMode).toBe('2d');
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects subscriptions after dispose and records diagnostics', () => {
    const model = createMapModeTransitionModel();
    model.dispose();
    const unsubscribe = model.subscribe(vi.fn());
    unsubscribe();
    expect(model.getDiagnostics().rejectedListenerCount).toBe(1);
  });

  it('uses finite fallback time when a custom clock is invalid', () => {
    const model = createMapModeTransitionModel({ now: () => Number.NaN });
    const request = request3d(model);
    expect(Number.isFinite(request.queuedAtMs)).toBe(true);
  });
});
