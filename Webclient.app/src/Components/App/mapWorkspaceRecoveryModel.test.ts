import { describe, expect, it, vi } from 'vitest';
import { MapWorkspaceRecoveryModel } from './mapWorkspaceRecoveryModel';

const createClock = (initial = 500) => {
  let now = initial;
  return {
    now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
    set: (value: number) => { now = value; },
  };
};

describe('MapWorkspaceRecoveryModel', () => {
  it('starts idle with a frozen non-busy snapshot', () => {
    const model = new MapWorkspaceRecoveryModel();
    const snapshot = model.getSnapshot();

    expect(snapshot).toMatchObject({
      phase: 'idle',
      attempt: 0,
      attemptId: 0,
      canRetry: false,
      isBusy: false,
      errorKind: null,
      errorMessage: null,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('begins the first bounded bootstrap attempt', () => {
    const clock = createClock();
    const model = new MapWorkspaceRecoveryModel({ now: clock.now });

    const attemptId = model.beginAttempt();

    expect(attemptId).toBe(1);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'booting',
      attempt: 1,
      attemptId: 1,
      startedAt: 500,
      isBusy: true,
      canRetry: false,
    });
  });

  it('marks only the current boot attempt as delayed', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();

    model.markDelayed((attemptId ?? 0) + 1);
    expect(model.getSnapshot().phase).toBe('booting');

    model.markDelayed(attemptId!);
    expect(model.getSnapshot()).toMatchObject({
      phase: 'delayed',
      isBusy: true,
    });
    expect(model.getSnapshot().announcement).toContain('beklenenden uzun');
  });

  it('succeeds from booting and records elapsed duration', () => {
    const clock = createClock();
    const model = new MapWorkspaceRecoveryModel({ now: clock.now });
    const attemptId = model.beginAttempt();
    clock.advance(420);

    model.succeed(attemptId!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      isBusy: false,
      lastDurationMs: 420,
      errorKind: null,
      errorMessage: null,
    });
  });

  it('succeeds from delayed state without resetting the attempt counter', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();
    model.markDelayed(attemptId!);

    model.succeed(attemptId!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready',
      attempt: 1,
    });
  });

  it('ignores stale success callbacks from previous attempts', () => {
    const model = new MapWorkspaceRecoveryModel();
    const first = model.beginAttempt();
    model.fail(first!, new Error('failed'));
    const second = model.beginAttempt();

    model.succeed(first!);

    expect(model.getSnapshot()).toMatchObject({
      phase: 'booting',
      attemptId: second,
      attempt: 2,
    });
  });

  it('classifies generic runtime errors without exposing the raw message', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();

    model.fail(attemptId!, new Error('secret internal stack /srv/app/private.ts'));

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      errorKind: 'runtime',
      canRetry: true,
      errorMessage: 'Harita çalışma alanı güvenli biçimde başlatılamadı.',
    });
    expect(model.getSnapshot().announcement).not.toContain('/srv/app/private.ts');
  });

  it('classifies network failures into a safe user message', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();

    model.fail(attemptId!, new TypeError('Failed to fetch https://private.example/token=abc'));

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      errorKind: 'network',
      errorMessage: 'Harita bileşenleri yüklenemedi. Ağ bağlantınızı kontrol edin.',
    });
    expect(model.getSnapshot().announcement).not.toContain('private.example');
    expect(model.getSnapshot().announcement).not.toContain('token=abc');
  });

  it('classifies configuration failures without reflecting configuration values', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();

    const error = new Error('configuration service rejected private value');
    error.name = 'ConfigurationError';
    model.fail(attemptId!, error);

    expect(model.getSnapshot()).toMatchObject({
      errorKind: 'configuration',
      errorMessage: 'Harita yapılandırması güvenli biçimde yüklenemedi.',
    });
    expect(model.getSnapshot().errorMessage).not.toContain('private value');
  });

  it('allows a short allowlisted diagnostic code', () => {
    const model = new MapWorkspaceRecoveryModel();
    const attemptId = model.beginAttempt();

    model.fail(attemptId!, new Error('boom'), 'MAP_INIT_42');

    expect(model.getSnapshot().errorMessage).toBe(
      'Harita çalışma alanı güvenli biçimde başlatılamadı. Hata kodu: MAP_INIT_42.',
    );
  });

  it('rejects diagnostic codes with unsafe characters or excessive length', () => {
    const model = new MapWorkspaceRecoveryModel();
    const first = model.beginAttempt();
    model.fail(first!, new Error('boom'), 'MAP/SECRET?token=x');

    expect(model.getSnapshot().errorMessage).not.toContain('MAP/SECRET');

    const second = model.beginAttempt();
    model.fail(second!, new Error('boom'), 'X'.repeat(100));
    expect(model.getSnapshot().errorMessage).not.toContain('X'.repeat(20));
  });

  it('increments attempts through explicit retry cycles', () => {
    const model = new MapWorkspaceRecoveryModel({ maxAttempts: 3 });
    const first = model.beginAttempt();
    model.fail(first!, new Error('one'));

    expect(model.canRetry()).toBe(true);

    const second = model.beginAttempt();
    expect(model.getSnapshot()).toMatchObject({
      phase: 'booting',
      attempt: 2,
      attemptId: second,
    });
  });

  it('stops admitting new attempts after the retry budget is exhausted', () => {
    const model = new MapWorkspaceRecoveryModel({ maxAttempts: 2 });
    const first = model.beginAttempt();
    model.fail(first!, new Error('one'));
    const second = model.beginAttempt();
    model.fail(second!, new Error('two'));

    expect(model.getSnapshot()).toMatchObject({
      phase: 'error',
      attempt: 2,
      maxAttempts: 2,
      canRetry: false,
    });
    expect(model.canRetry()).toBe(false);
    expect(model.beginAttempt()).toBeNull();
    expect(model.getSnapshot().announcement).toContain('sınırına ulaşıldı');
  });

  it('clamps excessive retry budgets to the hard maximum', () => {
    const model = new MapWorkspaceRecoveryModel({ maxAttempts: 99 });
    expect(model.getSnapshot().maxAttempts).toBe(5);
  });

  it('does not allow a second attempt while the current one is still active', () => {
    const model = new MapWorkspaceRecoveryModel();
    const first = model.beginAttempt();
    const second = model.beginAttempt();

    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(model.getSnapshot().attempt).toBe(1);
  });

  it('keeps duration non-negative when the clock moves backwards', () => {
    const clock = createClock(1_000);
    const model = new MapWorkspaceRecoveryModel({ now: clock.now });
    const attemptId = model.beginAttempt();
    clock.set(100);

    model.succeed(attemptId!);

    expect(model.getSnapshot().lastDurationMs).toBe(0);
  });

  it('uses zero when the supplied clock is not finite', () => {
    const model = new MapWorkspaceRecoveryModel({ now: () => Number.NaN });
    const attemptId = model.beginAttempt();
    model.succeed(attemptId!);
    expect(model.getSnapshot().lastDurationMs).toBe(0);
  });

  it('notifies observers after each accepted lifecycle transition', () => {
    const model = new MapWorkspaceRecoveryModel();
    const phases: string[] = [];
    model.subscribe(() => phases.push(model.getSnapshot().phase));

    const attemptId = model.beginAttempt();
    model.markDelayed(attemptId!);
    model.succeed(attemptId!);

    expect(phases).toEqual(['booting', 'delayed', 'ready']);
  });

  it('isolates failing observers from healthy observers', () => {
    const reporter = vi.fn();
    const healthy = vi.fn();
    const model = new MapWorkspaceRecoveryModel({ onObserverError: reporter });
    model.subscribe(() => { throw new TypeError('observer failed'); });
    model.subscribe(healthy);

    model.beginAttempt();

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 2,
      observerFailureCount: 1,
      lastObserverFailureKind: 'TypeError',
    });
  });

  it('contains reporter failures in bounded diagnostics', () => {
    const model = new MapWorkspaceRecoveryModel({
      onObserverError: () => { throw new RangeError('reporter failed'); },
    });
    model.subscribe(() => { throw new Error('observer failed'); });

    model.beginAttempt();

    expect(model.getDiagnostics()).toMatchObject({
      observerFailureCount: 1,
      reporterFailureCount: 1,
      lastObserverFailureKind: 'Error',
      lastReporterFailureKind: 'RangeError',
    });
  });

  it('enforces the observer budget without throwing', () => {
    const model = new MapWorkspaceRecoveryModel({ maxObservers: 1 });
    const first = vi.fn();
    const rejected = vi.fn();

    const unsubscribe = model.subscribe(first);
    model.subscribe(rejected);
    model.beginAttempt();

    expect(first).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 1,
      rejectedObserverCount: 1,
    });

    unsubscribe();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('deduplicates identical observers', () => {
    const model = new MapWorkspaceRecoveryModel();
    const listener = vi.fn();
    const first = model.subscribe(listener);
    const second = model.subscribe(listener);

    expect(model.getDiagnostics().activeObserverCount).toBe(1);
    first();
    second();
    expect(model.getDiagnostics().activeObserverCount).toBe(0);
  });

  it('disposes terminally and rejects later observers and attempts', () => {
    const model = new MapWorkspaceRecoveryModel();
    model.subscribe(vi.fn());
    model.dispose();

    expect(model.disposed()).toBe(true);
    expect(model.beginAttempt()).toBeNull();
    model.subscribe(vi.fn());
    expect(model.getDiagnostics()).toMatchObject({
      activeObserverCount: 0,
      rejectedObserverCount: 1,
      disposed: true,
    });
  });

  it('makes disposal idempotent', () => {
    const model = new MapWorkspaceRecoveryModel();
    model.dispose();
    const diagnostics = model.getDiagnostics();
    model.dispose();
    expect(model.getDiagnostics()).toEqual(diagnostics);
  });
});
