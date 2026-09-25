import { describe, expect, test, vi } from 'vitest';
import { createStartupExperienceModel } from './startupExperienceModel';

describe('startupExperienceModel', () => {
  test('starts with a bounded idle snapshot', () => {
    const model = createStartupExperienceModel();
    const snapshot = model.snapshot();

    expect(snapshot.phase).toBe('idle');
    expect(snapshot.attempt).toBe(0);
    expect(snapshot.maxAttempts).toBe(4);
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.busy).toBe(true);
    expect(snapshot.canRetry).toBe(false);
    expect(snapshot.exhausted).toBe(false);
  });

  test('begins an attempt using the injected clock', () => {
    let now = 10_000;
    const model = createStartupExperienceModel({ now: () => now });

    expect(model.beginAttempt()).toBe(true);
    expect(model.snapshot()).toMatchObject({
      phase: 'starting',
      attempt: 1,
      startedAt: 10_000,
      elapsedMs: 0,
    });

    now += 1_250;
    expect(model.snapshot().elapsedMs).toBe(1_250);
  });

  test('derives delayed phase after the configured threshold', () => {
    let now = 1_000;
    const model = createStartupExperienceModel({
      now: () => now,
      delayedAfterMs: 2_000,
    });

    model.beginAttempt();
    now = 2_999;
    expect(model.snapshot().phase).toBe('starting');
    now = 3_000;
    expect(model.snapshot().phase).toBe('delayed');
    expect(model.snapshot().tone).toBe('warning');
  });

  test('clamps delay and retry limits to bounded values', () => {
    const minimums = createStartupExperienceModel({
      delayedAfterMs: 1,
      maxAttempts: 0,
    }).snapshot();
    const maximums = createStartupExperienceModel({
      delayedAfterMs: 999_999,
      maxAttempts: 999,
    }).snapshot();

    expect(minimums.delayedAfterMs).toBe(1_500);
    expect(minimums.maxAttempts).toBe(1);
    expect(maximums.delayedAfterMs).toBe(60_000);
    expect(maximums.maxAttempts).toBe(8);
  });

  test('does not consume an attempt while initially offline', () => {
    const model = createStartupExperienceModel({ initialOnline: false });

    expect(model.beginAttempt()).toBe(false);
    expect(model.snapshot()).toMatchObject({
      phase: 'offline',
      attempt: 0,
      online: false,
    });

    model.setOnline(true);
    expect(model.snapshot().phase).toBe('idle');
    expect(model.beginAttempt()).toBe(true);
    expect(model.snapshot().attempt).toBe(1);
  });

  test('preserves an in-flight attempt across connectivity loss and recovery', () => {
    let now = 5_000;
    const model = createStartupExperienceModel({ now: () => now });
    model.beginAttempt();

    now = 5_500;
    model.setOnline(false);
    expect(model.snapshot()).toMatchObject({
      phase: 'offline',
      attempt: 1,
      online: false,
      startedAt: 5_000,
    });

    model.setOnline(true);
    expect(model.snapshot()).toMatchObject({
      phase: 'starting',
      attempt: 1,
      online: true,
    });
  });

  test('sanitizes and bounds failure data', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();
    model.fail({
      message: `  upstream   response   failed ${'x'.repeat(400)}  `,
      code: '<script>alert(1)</script>',
    });

    const snapshot = model.snapshot();
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.failure?.message.length).toBeLessThanOrEqual(320);
    expect(snapshot.failure?.message).not.toContain('  ');
    expect(snapshot.failure?.code).toBeNull();
    expect(snapshot.canRetry).toBe(true);
  });

  test('preserves safe diagnostic codes', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();
    model.fail({ message: 'failed', code: ' bootstrap_timeout-1 ' });

    expect(model.snapshot().failure?.code).toBe('BOOTSTRAP_TIMEOUT-1');
    expect(model.snapshot().announcement).toContain('BOOTSTRAP_TIMEOUT-1');
  });

  test('honors non-retryable failures', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();
    model.fail({ message: 'configuration invalid', retryable: false });

    expect(model.snapshot()).toMatchObject({
      phase: 'failed',
      canRetry: false,
      exhausted: false,
    });
  });

  test('enforces the retry budget without consuming extra attempts', () => {
    const model = createStartupExperienceModel({ maxAttempts: 2 });

    expect(model.beginAttempt()).toBe(true);
    model.fail({ message: 'first' });
    expect(model.snapshot().canRetry).toBe(true);

    expect(model.beginAttempt()).toBe(true);
    model.fail({ message: 'second' });
    expect(model.snapshot()).toMatchObject({
      attempt: 2,
      exhausted: true,
      canRetry: false,
      heading: 'Başlatma sınırına ulaşıldı',
    });

    expect(model.beginAttempt()).toBe(false);
    expect(model.snapshot().attempt).toBe(2);
  });

  test('uses retry-specific copy after the first attempt', () => {
    const model = createStartupExperienceModel({ maxAttempts: 3 });
    model.beginAttempt();
    model.fail({ message: 'temporary failure' });
    model.beginAttempt();

    expect(model.snapshot().heading).toBe('Kent Rehberi yeniden hazırlanıyor');
    expect(model.snapshot().announcement).toContain('Deneme 2');
  });

  test('ready state is terminal against late failure callbacks', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();
    model.succeed();
    model.fail({ message: 'late failure' });

    expect(model.snapshot()).toMatchObject({
      phase: 'ready',
      ready: true,
      failure: null,
    });
  });

  test('reset restores idle state and retry capacity', () => {
    const model = createStartupExperienceModel({ maxAttempts: 1 });
    model.beginAttempt();
    model.fail({ message: 'failed' });
    expect(model.snapshot().exhausted).toBe(true);

    model.reset();
    expect(model.snapshot()).toMatchObject({
      phase: 'idle',
      attempt: 0,
      exhausted: false,
      failure: null,
    });
    expect(model.beginAttempt()).toBe(true);
  });

  test('refresh notifies observers while startup is active', () => {
    let now = 1_000;
    const model = createStartupExperienceModel({
      now: () => now,
      delayedAfterMs: 1_500,
    });
    const phases: string[] = [];
    model.subscribe((snapshot) => phases.push(snapshot.phase));

    model.beginAttempt();
    now = 3_000;
    model.refresh();

    expect(phases).toEqual(['idle', 'starting', 'delayed']);
  });

  test('refresh becomes inert once startup is ready', () => {
    const model = createStartupExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    model.beginAttempt();
    model.succeed();
    const calls = observer.mock.calls.length;

    model.refresh();
    expect(observer).toHaveBeenCalledTimes(calls);
  });

  test('isolates observer failures and reports them', () => {
    const report = vi.fn();
    const model = createStartupExperienceModel({ onObserverError: report });
    const healthy = vi.fn();

    model.subscribe(() => {
      throw new Error('observer failed');
    });
    model.subscribe(healthy);
    healthy.mockClear();

    expect(() => model.beginAttempt()).not.toThrow();
    expect(report).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('isolates failures thrown by the observer error reporter', () => {
    const model = createStartupExperienceModel({
      onObserverError: () => {
        throw new Error('reporter failed');
      },
    });
    model.subscribe(() => {
      throw new Error('observer failed');
    });

    expect(() => model.beginAttempt()).not.toThrow();
  });

  test('unsubscribe prevents future notifications', () => {
    const model = createStartupExperienceModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    observer.mockClear();

    unsubscribe();
    model.beginAttempt();
    expect(observer).not.toHaveBeenCalled();
  });

  test('connectivity can still be reflected after ready', () => {
    const model = createStartupExperienceModel();
    model.beginAttempt();
    model.succeed();
    model.setOnline(false);

    expect(model.snapshot()).toMatchObject({
      phase: 'ready',
      online: false,
      ready: true,
    });
  });

  test('failed state disables retry while offline and restores it online', () => {
    const model = createStartupExperienceModel({ maxAttempts: 3 });
    model.beginAttempt();
    model.fail({ message: 'temporary failure' });
    expect(model.snapshot().canRetry).toBe(true);

    model.setOnline(false);
    expect(model.snapshot().canRetry).toBe(false);

    model.setOnline(true);
    expect(model.snapshot().canRetry).toBe(true);
  });
});
