import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DrainCapacityError,
  DrainRejectedError,
  createDrainCoordinator,
} from './drainCoordinator';

afterEach(() => {
  vi.useRealTimers();
});

describe('drainCoordinator', () => {
  it('tracks active work and releases it idempotently', () => {
    let now = 100;
    const coordinator = createDrainCoordinator({}, {
      now: () => now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    });
    const lease = coordinator.enter('query-a', 'foreground');
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'accepting',
      accepting: true,
      active: 1,
      started: 1,
      completed: 0,
    });
    expect(lease.startedAt).toBe(100);
    now = 120;
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      completed: 1,
      cancelled: 0,
    });
  });

  it('reports active work by lane', () => {
    const coordinator = createDrainCoordinator();
    const a = coordinator.enter('a', 'foreground');
    const b = coordinator.enter('b', 'foreground');
    const c = coordinator.enter('c', 'background');
    expect(coordinator.snapshot().byLane).toEqual({
      foreground: 2,
      background: 1,
    });
    a.release();
    b.release();
    c.release();
  });

  it('enforces bounded active capacity', () => {
    const coordinator = createDrainCoordinator({ maxActive: 2 });
    const a = coordinator.enter('a');
    const b = coordinator.enter('b');
    expect(() => coordinator.enter('c')).toThrow(DrainCapacityError);
    expect(coordinator.snapshot().rejected).toBe(1);
    a.release();
    b.release();
  });

  it('stops accepting new work during drain', () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('a');
    coordinator.stopAccepting();
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'draining',
      accepting: false,
      active: 1,
    });
    expect(() => coordinator.enter('late')).toThrow(DrainRejectedError);
    lease.release();
    expect(coordinator.snapshot().phase).toBe('drained');
  });

  it('enters drained phase immediately when no work is active', () => {
    const coordinator = createDrainCoordinator();
    coordinator.stopAccepting();
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'drained',
      accepting: false,
      active: 0,
    });
  });

  it('can resume accepting after a complete drain', () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('a');
    coordinator.stopAccepting();
    expect(coordinator.resumeAccepting()).toBe(false);
    lease.release();
    expect(coordinator.resumeAccepting()).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'accepting',
      accepting: true,
    });
    const next = coordinator.enter('b');
    next.release();
  });

  it('resolves drain when active work releases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 5_000 });
    const first = coordinator.enter('first');
    const second = coordinator.enter('second');
    const pending = coordinator.drain();
    first.release();
    expect(coordinator.snapshot().active).toBe(1);
    second.release();
    await expect(pending).resolves.toMatchObject({
      drained: true,
      timedOut: false,
      remaining: 0,
      phase: 'drained',
    });
  });

  it('force-cancels remaining work when drain deadline expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 100 });
    const first = coordinator.enter('first');
    const second = coordinator.enter('second');
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();
    first.signal.addEventListener('abort', firstAbort);
    second.signal.addEventListener('abort', secondAbort);
    const pending = coordinator.drain();
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toMatchObject({
      drained: true,
      timedOut: true,
      cancelled: 2,
      remaining: 0,
    });
    expect(firstAbort).toHaveBeenCalledTimes(1);
    expect(secondAbort).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      cancelled: 2,
      forced: 2,
    });
  });

  it('can report a timeout without cancelling active work', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 50 });
    const lease = coordinator.enter('first');
    const pending = coordinator.drain({ cancelOnTimeout: false });
    await vi.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toMatchObject({
      drained: false,
      timedOut: true,
      cancelled: 0,
      remaining: 1,
    });
    expect(lease.signal.aborted).toBe(false);
    lease.release();
  });

  it('propagates explicit timeout cancellation reason to leases', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 50 });
    const lease = coordinator.enter('first');
    const reason = new Error('deployment deadline');
    const pending = coordinator.drain({ reason });
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe(reason);
  });

  it('removes work when its external AbortSignal fires', () => {
    const coordinator = createDrainCoordinator();
    const controller = new AbortController();
    const lease = coordinator.enter('query', 'default', controller.signal);
    const reason = new Error('caller left');
    controller.abort(reason);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe(reason);
    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      cancelled: 1,
    });
    expect(lease.release()).toBe(false);
  });

  it('rejects already-aborted external signals without tracking work', () => {
    const coordinator = createDrainCoordinator();
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    expect(() => coordinator.enter('query', 'default', controller.signal)).toThrow(reason);
    expect(coordinator.snapshot()).toMatchObject({
      active: 0,
      rejected: 1,
    });
  });

  it('selectively cancels matching active work', () => {
    const coordinator = createDrainCoordinator();
    const foreground = coordinator.enter('foreground', 'foreground');
    const background = coordinator.enter('background', 'background');
    const maintenance = coordinator.enter('maintenance', 'maintenance');
    const cancelled = coordinator.cancel((lease) => lease.lane !== 'foreground');
    expect(cancelled).toBe(2);
    expect(background.signal.aborted).toBe(true);
    expect(maintenance.signal.aborted).toBe(true);
    expect(foreground.signal.aborted).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({
      active: 1,
      cancelled: 2,
      forced: 2,
    });
    foreground.release();
  });

  it('passes custom cancellation reasons through selective cancellation', () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('background', 'background');
    const reason = new Error('pressure evacuation');
    coordinator.cancel(() => true, reason);
    expect(lease.signal.reason).toBe(reason);
  });

  it('normalizes blank keys and lanes without throwing', () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('   ', '   ');
    expect(lease.key).toMatch(/^drain-/);
    expect(lease.lane).toBe('default');
    lease.release();
  });

  it('bounds key and lane cardinality surfaces', () => {
    const coordinator = createDrainCoordinator({
      maxKeyLength: 5,
      maxLaneLength: 4,
    });
    const lease = coordinator.enter('abcdefgh', 'foreground');
    expect(lease.key).toBe('abcde');
    expect(lease.lane).toBe('fore');
    lease.release();
  });

  it('returns frozen snapshots and lane maps', () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('a', 'foreground');
    const snapshot = coordinator.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.byLane)).toBe(true);
    lease.release();
  });

  it('supports multiple concurrent drain observers', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 10_000 });
    const lease = coordinator.enter('a');
    const first = coordinator.drain();
    const second = coordinator.drain();
    lease.release();
    await expect(first).resolves.toMatchObject({ drained: true, timedOut: false });
    await expect(second).resolves.toMatchObject({ drained: true, timedOut: false });
  });

  it('rejects a drain observer when its signal aborts without cancelling work', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 10_000 });
    const lease = coordinator.enter('a');
    const controller = new AbortController();
    const pending = coordinator.drain({ signal: controller.signal });
    const reason = new Error('observer cancelled');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(lease.signal.aborted).toBe(false);
    lease.release();
  });

  it('rejects an already-aborted drain request signal', async () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('a');
    const controller = new AbortController();
    const reason = new Error('observer already cancelled');
    controller.abort(reason);
    await expect(coordinator.drain({ signal: controller.signal })).rejects.toBe(reason);
    lease.release();
  });

  it('measures drain duration with the injected monotonic clock', async () => {
    vi.useFakeTimers();
    let now = 100;
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 500 }, {
      now: () => now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    });
    const lease = coordinator.enter('a');
    const pending = coordinator.drain();
    now = 175;
    lease.release();
    await expect(pending).resolves.toMatchObject({ durationMs: 75 });
  });

  it('uses bounded maximum timeout even for extreme requests', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({
      defaultTimeoutMs: 100,
      maxTimeoutMs: 250,
    });
    const lease = coordinator.enter('a');
    const pending = coordinator.drain({ timeoutMs: 100_000, cancelOnTimeout: false });
    await vi.advanceTimersByTimeAsync(249);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toMatchObject({ timedOut: true, remaining: 1 });
    lease.release();
  });

  it('uses policy default timeout for non-positive request values', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({
      defaultTimeoutMs: 75,
      maxTimeoutMs: 500,
    });
    const lease = coordinator.enter('a');
    const pending = coordinator.drain({ timeoutMs: 0, cancelOnTimeout: false });
    await vi.advanceTimersByTimeAsync(76);
    await expect(pending).resolves.toMatchObject({ timedOut: true });
    lease.release();
  });

  it('dispose aborts all work and becomes terminal', () => {
    const coordinator = createDrainCoordinator();
    const a = coordinator.enter('a');
    const b = coordinator.enter('b');
    coordinator.dispose();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'disposed',
      accepting: false,
      active: 0,
      cancelled: 2,
    });
    expect(() => coordinator.enter('late')).toThrow(DrainRejectedError);
  });

  it('dispose is idempotent', () => {
    const coordinator = createDrainCoordinator();
    const lease = coordinator.enter('a');
    coordinator.dispose();
    const afterFirst = coordinator.snapshot();
    coordinator.dispose();
    expect(coordinator.snapshot()).toEqual(afterFirst);
    expect(lease.signal.aborted).toBe(true);
  });

  it('drain after dispose resolves as terminal and drained', async () => {
    const coordinator = createDrainCoordinator();
    coordinator.dispose();
    await expect(coordinator.drain()).resolves.toMatchObject({
      drained: true,
      timedOut: false,
      remaining: 0,
      phase: 'disposed',
    });
  });

  it('cannot resume after dispose', () => {
    const coordinator = createDrainCoordinator();
    coordinator.dispose();
    expect(coordinator.resumeAccepting()).toBe(false);
  });

  it('cancel after dispose is a no-op', () => {
    const coordinator = createDrainCoordinator();
    coordinator.dispose();
    expect(coordinator.cancel()).toBe(0);
  });

  it('preserves completed and cancelled accounting independently', () => {
    const coordinator = createDrainCoordinator();
    const complete = coordinator.enter('complete');
    coordinator.enter('cancel');
    complete.release();
    coordinator.cancel((lease) => lease.key === 'cancel');
    expect(coordinator.snapshot()).toMatchObject({
      started: 2,
      completed: 1,
      cancelled: 1,
      active: 0,
    });
  });

  it('records rejection after stopAccepting', () => {
    const coordinator = createDrainCoordinator();
    coordinator.stopAccepting();
    expect(() => coordinator.enter('late')).toThrow(DrainRejectedError);
    expect(coordinator.snapshot().rejected).toBe(1);
  });

  it('keeps drain start timestamp stable across repeated stop calls', () => {
    let now = 10;
    const coordinator = createDrainCoordinator({}, {
      now: () => now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    });
    const lease = coordinator.enter('a');
    now = 20;
    coordinator.stopAccepting();
    const startedAt = coordinator.snapshot().drainStartedAt;
    now = 30;
    coordinator.stopAccepting();
    expect(coordinator.snapshot().drainStartedAt).toBe(startedAt);
    lease.release();
  });

  it('reset-like resume clears drain timestamp after a full drain', () => {
    let now = 10;
    const coordinator = createDrainCoordinator({}, {
      now: () => now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    });
    const lease = coordinator.enter('a');
    now = 20;
    coordinator.stopAccepting();
    lease.release();
    expect(coordinator.snapshot().drainStartedAt).toBe(20);
    expect(coordinator.resumeAccepting()).toBe(true);
    expect(coordinator.snapshot().drainStartedAt).toBeNull();
  });
  it('settles multiple drain observers consistently after forced timeout cancellation', async () => {
    vi.useFakeTimers();
    const coordinator = createDrainCoordinator({ defaultTimeoutMs: 50 });
    coordinator.enter('a');
    coordinator.enter('b');
    const timed = coordinator.drain({ timeoutMs: 50 });
    const observer = coordinator.drain({ timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(51);
    await expect(timed).resolves.toMatchObject({
      timedOut: true,
      cancelled: 2,
      remaining: 0,
      phase: 'drained',
    });
    await expect(observer).resolves.toMatchObject({
      timedOut: false,
      remaining: 0,
      phase: 'drained',
    });
  });


});
