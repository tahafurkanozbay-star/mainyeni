import { describe, expect, test, vi } from 'vitest';
import { createConnectivityExperienceModel } from './connectivityExperienceModel';

describe('connectivityExperienceModel', () => {
  test('starts online and hidden by default', () => {
    const model = createConnectivityExperienceModel();
    expect(model.snapshot()).toMatchObject({
      phase: 'online',
      tone: 'neutral',
      online: true,
      visible: false,
      interruptionCount: 0,
      offlineSince: null,
    });
  });

  test('can start offline with one interruption recorded', () => {
    const model = createConnectivityExperienceModel({
      initialOnline: false,
      now: () => 1_000,
    });
    expect(model.snapshot()).toMatchObject({
      phase: 'offline',
      online: false,
      visible: true,
      interruptionCount: 1,
      offlineSince: 1_000,
    });
  });

  test('records offline duration with an injected clock', () => {
    let now = 1_000;
    const model = createConnectivityExperienceModel({ now: () => now });

    model.setOnline(false);
    now = 5_250;
    expect(model.snapshot().offlineDurationMs).toBe(4_250);

    model.setOnline(true);
    expect(model.snapshot()).toMatchObject({
      phase: 'restored',
      online: true,
      offlineDurationMs: 4_250,
      visible: true,
    });
  });

  test('keeps repeated duplicate connectivity events inert', () => {
    const model = createConnectivityExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    observer.mockClear();

    model.setOnline(true);
    expect(observer).not.toHaveBeenCalled();

    model.setOnline(false);
    const revision = model.snapshot().revision;
    model.setOnline(false);
    expect(model.snapshot().revision).toBe(revision);
  });

  test('shows restored state only for the bounded grace period', () => {
    let now = 0;
    const model = createConnectivityExperienceModel({
      now: () => now,
      restoredVisibleMs: 2_000,
    });

    model.setOnline(false);
    now = 1_000;
    model.setOnline(true);
    expect(model.snapshot().phase).toBe('restored');

    now = 2_999;
    expect(model.snapshot().phase).toBe('restored');
    now = 3_000;
    expect(model.snapshot().phase).toBe('online');
  });

  test('refresh commits expired restored state back to online', () => {
    let now = 10;
    const model = createConnectivityExperienceModel({
      now: () => now,
      restoredVisibleMs: 1_500,
    });
    const phases: string[] = [];
    model.subscribe(snapshot => phases.push(snapshot.phase));

    model.setOnline(false);
    now = 100;
    model.setOnline(true);
    now = 1_700;
    model.refresh();

    expect(model.snapshot()).toMatchObject({
      phase: 'online',
      visible: false,
      restoredAt: null,
    });
    expect(phases).toContain('restored');
    expect(phases.at(-1)).toBe('online');
  });

  test('dismissRestored hides success feedback without changing online state', () => {
    const model = createConnectivityExperienceModel();
    model.setOnline(false);
    model.setOnline(true);
    expect(model.snapshot().phase).toBe('restored');

    model.dismissRestored();
    expect(model.snapshot()).toMatchObject({
      phase: 'online',
      online: true,
      visible: false,
    });
  });

  test('dismissRestored is inert outside restored phase', () => {
    const model = createConnectivityExperienceModel();
    const revision = model.snapshot().revision;
    model.dismissRestored();
    expect(model.snapshot().revision).toBe(revision);
  });

  test('clamps restored visibility duration', () => {
    expect(createConnectivityExperienceModel({ restoredVisibleMs: 1 }).snapshot().restoredVisibleMs).toBe(1_500);
    expect(createConnectivityExperienceModel({ restoredVisibleMs: 60_000 }).snapshot().restoredVisibleMs).toBe(15_000);
  });

  test('increments interruption count on each online-to-offline transition', () => {
    const model = createConnectivityExperienceModel();

    model.setOnline(false);
    model.setOnline(true);
    model.setOnline(false);
    model.setOnline(true);

    expect(model.snapshot().interruptionCount).toBe(2);
  });

  test('uses human-friendly copy for short and longer interruptions', () => {
    let now = 0;
    const model = createConnectivityExperienceModel({ now: () => now });
    model.setOnline(false);
    now = 1_000;
    model.setOnline(true);
    expect(model.snapshot().message).toContain('kısa süreli');

    model.setOnline(false);
    now = 67_000;
    model.setOnline(true);
    expect(model.snapshot().message).toContain('1 dakikalık');
  });

  test('reset keeps the current online/offline fact but clears history', () => {
    let now = 100;
    const model = createConnectivityExperienceModel({ now: () => now });
    model.setOnline(false);
    now = 200;
    model.setOnline(true);
    expect(model.snapshot().interruptionCount).toBe(1);

    model.reset();
    expect(model.snapshot()).toMatchObject({
      phase: 'online',
      interruptionCount: 0,
      offlineDurationMs: 0,
    });

    model.setOnline(false);
    now = 300;
    model.reset();
    expect(model.snapshot()).toMatchObject({
      phase: 'offline',
      interruptionCount: 1,
      offlineSince: 300,
    });
  });

  test('notifies observers for actual state changes', () => {
    const model = createConnectivityExperienceModel();
    const observer = vi.fn();
    model.subscribe(observer);
    observer.mockClear();

    model.setOnline(false);
    model.setOnline(true);
    model.dismissRestored();

    expect(observer).toHaveBeenCalledTimes(3);
  });

  test('isolates observer failures and reports them', () => {
    const report = vi.fn();
    const healthy = vi.fn();
    const model = createConnectivityExperienceModel({ onObserverError: report });

    model.subscribe(() => {
      throw new Error('observer failure');
    });
    model.subscribe(healthy);
    healthy.mockClear();

    expect(() => model.setOnline(false)).not.toThrow();
    expect(report).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  test('isolates failures thrown by observer error reporting', () => {
    const model = createConnectivityExperienceModel({
      onObserverError: () => {
        throw new Error('reporter failure');
      },
    });
    model.subscribe(() => {
      throw new Error('observer failure');
    });

    expect(() => model.setOnline(false)).not.toThrow();
  });

  test('unsubscribe prevents future notifications', () => {
    const model = createConnectivityExperienceModel();
    const observer = vi.fn();
    const unsubscribe = model.subscribe(observer);
    observer.mockClear();

    unsubscribe();
    model.setOnline(false);
    expect(observer).not.toHaveBeenCalled();
  });
});
