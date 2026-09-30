import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_WORKSPACE_VIEW_READY_TIMEOUT_MS,
  isMapWorkspaceReadinessFailure,
  mapWorkspaceReadinessMessage,
  waitForMapWorkspaceViewReady,
} from './mapWorkspaceViewReadiness';

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('waitForMapWorkspaceViewReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves legacy-ready behavior when a view does not expose when()', async () => {
    const outcome = await waitForMapWorkspaceViewReady({ destroyed: false });
    expect(outcome).toEqual({ status: 'legacy-ready', ready: true, code: null, failureKind: null });
  });

  it('resolves ready only after the ArcGIS readiness promise resolves', async () => {
    const ready = deferred<void>();
    const promise = waitForMapWorkspaceViewReady({ when: () => ready.promise });
    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    ready.resolve();
    await expect(promise).resolves.toEqual({ status: 'ready', ready: true, code: null, failureKind: null });
  });

  it('returns observable failed state if the view is already destroyed', async () => {
    const when = vi.fn(async () => undefined);
    const outcome = await waitForMapWorkspaceViewReady({ destroyed: true, when });
    expect(outcome).toEqual({
      status: 'failed',
      ready: false,
      code: 'MAP_VIEW_FAILED',
      failureKind: 'DestroyedView',
    });
    expect(when).not.toHaveBeenCalled();
  });

  it('classifies synchronous when() failures without retaining raw detail', async () => {
    const outcomePromise = waitForMapWorkspaceViewReady({
      when() { throw new TypeError('private ArcGIS detail'); },
    });
    await expect(outcomePromise).resolves.toEqual({
      status: 'failed',
      ready: false,
      code: 'MAP_VIEW_FAILED',
      failureKind: 'TypeError',
    });
  });

  it('classifies rejected readiness without leaking the rejection reason', async () => {
    const outcome = await waitForMapWorkspaceViewReady({
      when: async () => { throw new RangeError('token=secret-value'); },
    });
    expect(outcome).toEqual({
      status: 'failed',
      ready: false,
      code: 'MAP_VIEW_FAILED',
      failureKind: 'RangeError',
    });
    expect(JSON.stringify(outcome)).not.toContain('secret-value');
  });

  it('classifies non-Error readiness failures by bounded type only', async () => {
    const outcome = await waitForMapWorkspaceViewReady({
      when: async () => Promise.reject({ token: 'secret-value' }),
    });
    expect(outcome).toMatchObject({
      status: 'failed',
      code: 'MAP_VIEW_FAILED',
      failureKind: 'object',
    });
    expect(JSON.stringify(outcome)).not.toContain('secret-value');
  });

  it('times out with the bounded default timeout and a safe diagnostic kind', async () => {
    const ready = deferred<void>();
    const promise = waitForMapWorkspaceViewReady({ when: () => ready.promise });
    vi.advanceTimersByTime(MAP_WORKSPACE_VIEW_READY_TIMEOUT_MS - 1);
    await Promise.resolve();
    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(promise).resolves.toEqual({
      status: 'timeout',
      ready: false,
      code: 'MAP_VIEW_TIMEOUT',
      failureKind: 'TimeoutError',
    });
  });

  it('clamps too-small timeout to one second', async () => {
    const ready = deferred<void>();
    const promise = waitForMapWorkspaceViewReady({ when: () => ready.promise }, { timeoutMs: 1 });
    vi.advanceTimersByTime(999);
    await Promise.resolve();
    let resolved = false;
    void promise.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(promise).resolves.toMatchObject({ status: 'timeout', failureKind: 'TimeoutError' });
  });

  it('clamps too-large timeout to sixty seconds', async () => {
    const ready = deferred<void>();
    const promise = waitForMapWorkspaceViewReady({ when: () => ready.promise }, { timeoutMs: 999_999 });
    vi.advanceTimersByTime(59_999);
    await Promise.resolve();
    let resolved = false;
    void promise.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(promise).resolves.toMatchObject({ status: 'timeout', failureKind: 'TimeoutError' });
  });

  it('returns aborted immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const when = vi.fn(async () => undefined);
    const outcome = await waitForMapWorkspaceViewReady({ when }, { signal: controller.signal });
    expect(outcome).toEqual({
      status: 'aborted',
      ready: false,
      code: 'MAP_VIEW_ABORTED',
      failureKind: null,
    });
    expect(when).not.toHaveBeenCalled();
  });

  it('aborts an in-flight readiness wait and clears timeout ownership', async () => {
    const ready = deferred<void>();
    const controller = new AbortController();
    const clearScheduledTimeout = vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    const promise = waitForMapWorkspaceViewReady(
      { when: () => ready.promise },
      { signal: controller.signal, clearScheduledTimeout },
    );
    controller.abort();
    await expect(promise).resolves.toEqual({
      status: 'aborted',
      ready: false,
      code: 'MAP_VIEW_ABORTED',
      failureKind: null,
    });
    expect(clearScheduledTimeout).toHaveBeenCalledTimes(1);
  });

  it('ignores late resolve after abort', async () => {
    const ready = deferred<void>();
    const controller = new AbortController();
    const promise = waitForMapWorkspaceViewReady({ when: () => ready.promise }, { signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toMatchObject({ status: 'aborted' });
    ready.resolve();
    await Promise.resolve();
    await expect(promise).resolves.toMatchObject({ status: 'aborted' });
  });

  it('ignores late rejection after timeout', async () => {
    const ready = deferred<void>();
    const promise = waitForMapWorkspaceViewReady({ when: () => ready.promise }, { timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    await expect(promise).resolves.toMatchObject({ status: 'timeout' });
    ready.reject(new Error('late private detail'));
    await Promise.resolve();
    await expect(promise).resolves.toMatchObject({ status: 'timeout', failureKind: 'TimeoutError' });
  });

  it('returns failed when a view is destroyed before readiness resolves', async () => {
    const ready = deferred<void>();
    const view = { destroyed: false, when: () => ready.promise };
    const promise = waitForMapWorkspaceViewReady(view);
    view.destroyed = true;
    ready.resolve();
    await expect(promise).resolves.toEqual({
      status: 'failed',
      ready: false,
      code: 'MAP_VIEW_FAILED',
      failureKind: 'DestroyedView',
    });
  });

  it('clears timeout after successful readiness', async () => {
    const clearScheduledTimeout = vi.fn((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    const outcome = await waitForMapWorkspaceViewReady(
      { when: async () => undefined },
      { clearScheduledTimeout },
    );
    expect(outcome.status).toBe('ready');
    expect(outcome.failureKind).toBeNull();
    expect(clearScheduledTimeout).toHaveBeenCalledTimes(1);
  });

  it('uses a single timeout owner per readiness request', async () => {
    const ready = deferred<void>();
    const scheduleTimeout = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const promise = waitForMapWorkspaceViewReady(
      { when: () => ready.promise },
      { scheduleTimeout },
    );
    expect(scheduleTimeout).toHaveBeenCalledTimes(1);
    ready.resolve();
    await promise;
    expect(scheduleTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not classify ready outcomes as failures', async () => {
    const ready = await waitForMapWorkspaceViewReady({ when: async () => undefined });
    const legacy = await waitForMapWorkspaceViewReady({});
    expect(isMapWorkspaceReadinessFailure(ready)).toBe(false);
    expect(isMapWorkspaceReadinessFailure(legacy)).toBe(false);
    expect(ready.failureKind).toBeNull();
    expect(legacy.failureKind).toBeNull();
  });

  it('classifies timeout and failure outcomes as failures but abort as lifecycle cancellation', async () => {
    const timeoutReady = deferred<void>();
    const timeout = waitForMapWorkspaceViewReady({ when: () => timeoutReady.promise }, { timeoutMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    const timeoutOutcome = await timeout;
    const failed = await waitForMapWorkspaceViewReady({ when: async () => { throw new Error('failed'); } });
    const controller = new AbortController();
    controller.abort();
    const aborted = await waitForMapWorkspaceViewReady({ when: async () => undefined }, { signal: controller.signal });
    expect(isMapWorkspaceReadinessFailure(timeoutOutcome)).toBe(true);
    expect(isMapWorkspaceReadinessFailure(failed)).toBe(true);
    expect(isMapWorkspaceReadinessFailure(aborted)).toBe(false);
    expect(timeoutOutcome.failureKind).toBe('TimeoutError');
    expect(failed.failureKind).toBe('Error');
    expect(aborted.failureKind).toBeNull();
  });

  it('provides safe user-facing readiness messages that do not expose failureKind internals', async () => {
    const ready = await waitForMapWorkspaceViewReady({ when: async () => undefined });
    expect(mapWorkspaceReadinessMessage(ready)).toBe('Harita görünümü hazır.');

    const controller = new AbortController();
    controller.abort();
    const aborted = await waitForMapWorkspaceViewReady({ when: async () => undefined }, { signal: controller.signal });
    expect(mapWorkspaceReadinessMessage(aborted)).toBe('Harita görünümü başlatma işlemi iptal edildi.');

    const failed = await waitForMapWorkspaceViewReady({ when: async () => { throw new TypeError('secret'); } });
    expect(mapWorkspaceReadinessMessage(failed)).toBe('Harita görünümü güvenli biçimde başlatılamadı.');
    expect(failed.failureKind).toBe('TypeError');
    expect(mapWorkspaceReadinessMessage(failed)).not.toContain('TypeError');
    expect(mapWorkspaceReadinessMessage(failed)).not.toContain('secret');
  });
});
