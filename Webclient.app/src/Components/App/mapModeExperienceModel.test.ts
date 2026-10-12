import { describe, expect, it, vi } from 'vitest';
import { MapModeExperienceModel } from './mapModeExperienceModel';

const createClock = (initial = 1_000) => {
  let now = initial;
  return {
    now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
    set: (value: number) => { now = value; },
  };
};

describe('MapModeExperienceModel', () => {
  it('starts in a frozen ready 2B snapshot', () => {
    const model = new MapModeExperienceModel();
    const snapshot = model.getSnapshot();

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.currentMode).toBe('2d');
    expect(snapshot.requestedMode).toBeNull();
    expect(snapshot.canRetry).toBe(false);
    expect(snapshot.announcement).toContain('2B');
    expect(snapshot.environment.viewport).toBe('wide');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.environment)).toBe(true);
  });

  it('supports an explicit 3B initial mode without creating a pending transition', () => {
    const model = new MapModeExperienceModel({ initialMode: '3d' });
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      currentMode: '3d',
      requestedMode: null,
      attempt: 0,
    });
  });

  it('creates a bounded request with a monotonic request id', () => {
    const clock = createClock();
    const model = new MapModeExperienceModel({ now: clock.now });

    const requestId = model.requestMode('3d');

    expect(requestId).toBe(1);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'requesting',
      currentMode: '2d',
      requestedMode: '3d',
      requestId: 1,
      attempt: 1,
      transitionStartedAt: 1_000,
      errorKind: null,
      canRetry: false,
    });
  });

  it('does not create a transition when the requested mode is already active', () => {
    const model = new MapModeExperienceModel();
    expect(model.requestMode('2d')).toBeNull();
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('returns the active request id for duplicate in-flight requests', () => {
    const model = new MapModeExperienceModel();
    expect(model.requestMode('3d')).toBe(1);
    expect(model.requestMode('3d')).toBe(1);
    expect(model.getSnapshot().attempt).toBe(1);
    expect(model.getSnapshot().revision).toBe(1);
  });

  it('confirms the requested mode and records transition duration', () => {
    const clock = createClock();
    const model = new MapModeExperienceModel({ now: clock.now });
    model.requestMode('3d');
    clock.advance(275);

    model.confirmMode('3d', 'map-runtime');

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      currentMode: '3d',
      requestedMode: null,
      attempt: 0,
      lastTransitionMs: 275,
      lastSource: 'map-runtime',
      errorKind: null,
    });
  });

  it('normalizes and bounds runtime source metadata', () => {
    const model = new MapModeExperienceModel();
    model.confirmMode('2d', `  ${'source '.repeat(20)}  `);
    const source = model.getSnapshot().lastSource;

    expect(source).not.toBeNull();
    expect(source!.length).toBeLessThanOrEqual(64);
    expect(source).not.toMatch(/\s{2,}/u);
  });

  it('marks a mismatched runtime confirmation as recovery instead of lying about success', () => {
    const model = new MapModeExperienceModel();
    model.requestMode('3d');

    model.confirmMode('2d', 'map-runtime-recovery');

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      currentMode: '2d',
      requestedMode: '3d',
      errorKind: 'runtime-recovery',
      canRetry: true,
      lastSource: 'map-runtime-recovery',
    });
  });

  it('marks an active request as timed out and preserves its target for retry', () => {
    const clock = createClock();
    const model = new MapModeExperienceModel({ now: clock.now });
    const requestId = model.requestMode('3d');
    clock.advance(8_000);

    model.markTimeout(requestId!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      requestedMode: '3d',
      errorKind: 'timeout',
      attempt: 1,
      canRetry: true,
      lastTransitionMs: 8_000,
    });
    expect(model.getSnapshot().announcement).toContain('Yeniden deneyebilirsiniz');
  });

  it('ignores stale timeout callbacks from older requests', () => {
    const model = new MapModeExperienceModel();
    const first = model.requestMode('3d');
    model.confirmMode('3d');
    const second = model.requestMode('2d');

    model.markTimeout(first!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'requesting',
      requestId: second,
      requestedMode: '2d',
      currentMode: '3d',
    });
  });

  it('classifies a rejected command dispatch as a retryable error', () => {
    const model = new MapModeExperienceModel();
    const requestId = model.requestMode('3d');

    model.markDispatchRejected(requestId!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      errorKind: 'dispatch-rejected',
      canRetry: true,
    });
  });

  it('retries the same target with a new request id and incremented attempt', () => {
    const model = new MapModeExperienceModel();
    const first = model.requestMode('3d');
    model.markTimeout(first!);

    const second = model.retry();

    expect(second).toBe(2);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'requesting',
      requestedMode: '3d',
      requestId: 2,
      attempt: 2,
    });
  });

  it('stops offering retry after the configured attempt budget is exhausted', () => {
    const model = new MapModeExperienceModel({ maxAttempts: 2 });

    const first = model.requestMode('3d');
    model.markTimeout(first!);
    const second = model.retry();
    model.markTimeout(second!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      attempt: 2,
      maxAttempts: 2,
      canRetry: false,
    });
    expect(model.retry()).toBeNull();
    expect(model.getSnapshot().announcement).toContain('sınırına ulaşıldı');
  });

  it('clamps unsafe retry budgets to the supported maximum', () => {
    const model = new MapModeExperienceModel({ maxAttempts: 200 });
    expect(model.getSnapshot().maxAttempts).toBe(5);
  });

  it('resets the retry attempt when the user chooses a different target', () => {
    const model = new MapModeExperienceModel();
    const first = model.requestMode('3d');
    model.markTimeout(first!);

    const requestId = model.requestMode('2d');

    expect(requestId).toBe(2);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'requesting',
      requestedMode: '2d',
      attempt: 1,
    });
  });

  it('accepts a late successful confirmation after a timeout', () => {
    const model = new MapModeExperienceModel();
    const requestId = model.requestMode('3d');
    model.markTimeout(requestId!);

    model.confirmMode('3d', 'late-runtime-confirmation');

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      currentMode: '3d',
      requestedMode: null,
      errorKind: null,
      canRetry: false,
      lastSource: 'late-runtime-confirmation',
    });
  });

  it('cancels a pending request without changing the active map mode', () => {
    const model = new MapModeExperienceModel();
    model.requestMode('3d');

    model.cancelPending();

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      currentMode: '2d',
      requestedMode: null,
      attempt: 0,
      lastSource: 'cancelled',
    });
  });

  it('does not cancel a settled error because retry context would be lost', () => {
    const model = new MapModeExperienceModel();
    const requestId = model.requestMode('3d');
    model.markTimeout(requestId!);
    const revision = model.getSnapshot().revision;

    model.cancelPending();

    expect(model.getSnapshot().revision).toBe(revision);
    expect(model.getSnapshot().canRetry).toBe(true);
  });

  it('updates runtime presentation facts without changing transition state', () => {
    const model = new MapModeExperienceModel();
    model.requestMode('3d');

    model.setEnvironment({
      viewport: 'compact',
      reducedMotion: true,
      forcedColors: true,
      coarsePointer: true,
    });

    expect(model.getSnapshot()).toMatchObject({
      phase: 'requesting',
      requestedMode: '3d',
      environment: {
        viewport: 'compact',
        reducedMotion: true,
        forcedColors: true,
        coarsePointer: true,
      },
    });
    expect(Object.isFrozen(model.getSnapshot().environment)).toBe(true);
  });

  it('treats identical environment updates as a no-op', () => {
    const model = new MapModeExperienceModel();
    const revision = model.getSnapshot().revision;
    model.setEnvironment({ viewport: 'wide' });
    expect(model.getSnapshot().revision).toBe(revision);
  });

  it('ignores invalid environment enum values while keeping valid booleans', () => {
    const model = new MapModeExperienceModel();
    model.setEnvironment({
      viewport: 'invalid' as never,
      reducedMotion: true,
    });
    expect(model.getSnapshot().environment).toMatchObject({
      viewport: 'wide',
      reducedMotion: true,
    });
  });

  it('notifies observers after a snapshot transition', () => {
    const model = new MapModeExperienceModel();
    const seen: string[] = [];
    model.subscribe(() => seen.push(model.getSnapshot().phase));

    model.requestMode('3d');
    model.confirmMode('3d');

    expect(seen).toEqual(['requesting', 'ready']);
  });

  it('isolates a failing observer from healthy observers', () => {
    const reporter = vi.fn();
    const healthy = vi.fn();
    const model = new MapModeExperienceModel({ onObserverError: reporter });
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);

    model.requestMode('3d');

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      observerFailureCount: 1,
      lastObserverFailureKind: 'TypeError',
    });
  });

  it('contains reporter failures and exposes bounded diagnostics', () => {
    const model = new MapModeExperienceModel({
      onObserverError: () => { throw new RangeError('reporter failed'); },
    });
    model.subscribe(() => { throw new Error('observer failed'); });

    model.requestMode('3d');

    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      reporterFailureCount: 1,
      lastObserverFailureKind: 'Error',
      lastReporterFailureKind: 'RangeError',
    });
  });

  it('enforces the observer budget without throwing into rendering code', () => {
    const model = new MapModeExperienceModel({ maxObservers: 1 });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = model.subscribe(first);
    const unsubscribeRejected = model.subscribe(second);
    model.requestMode('3d');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
    });

    unsubscribeRejected();
    unsubscribeFirst();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('deduplicates subscriptions and unsubscribes idempotently', () => {
    const model = new MapModeExperienceModel();
    const listener = vi.fn();
    const unsubscribeA = model.subscribe(listener);
    const unsubscribeB = model.subscribe(listener);

    expect(model.getDiagnostics().activeObserverCount).toBe(1);
    unsubscribeA();
    unsubscribeB();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('keeps monotonic timing safe when the supplied clock is invalid', () => {
    const clock = createClock();
    const model = new MapModeExperienceModel({ now: clock.now });
    model.requestMode('3d');
    clock.set(Number.NaN);

    model.confirmMode('3d');

    expect(model.getSnapshot().lastTransitionMs).toBe(0);
  });

  it('disposes terminally and rejects post-disposal observers', () => {
    const model = new MapModeExperienceModel();
    const listener = vi.fn();
    model.subscribe(listener);

    model.dispose();
    model.requestMode('3d');
    model.setEnvironment({ coarsePointer: true });
    model.confirmMode('3d');
    model.subscribe(listener);

    expect(model.disposed()).toBe(true);
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      rejectedObserverCount: 1,
      disposed: true,
    });
    expect(model.getSnapshot().revision).toBe(0);
  });

  it('makes disposal idempotent', () => {
    const model = new MapModeExperienceModel();
    model.dispose();
    const diagnostics = model.getDiagnostics();
    model.dispose();
    expect(model.getDiagnostics()).toEqual(diagnostics);
  });
});
