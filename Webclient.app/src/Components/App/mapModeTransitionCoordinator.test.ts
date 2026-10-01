import { describe, expect, it, vi } from 'vitest';
import { createMapModeTransitionCoordinator } from './mapModeTransitionCoordinator';
import { createMapModeTransitionModel } from './mapModeTransitionModel';

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('MapModeTransitionCoordinator', () => {
  it('executes a simple 3B request and publishes ready state', async () => {
    const model = createMapModeTransitionModel();
    const executor = vi.fn(async () => '3d' as const);
    const coordinator = createMapModeTransitionCoordinator(model, executor);
    await coordinator.request('3d', 'control');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('3d', expect.objectContaining({ request: expect.objectContaining({ source: 'control' }) }));
    expect(model.getSnapshot()).toMatchObject({ activeMode: '3d', desiredMode: '3d', phase: 'ready' });
    expect(coordinator.getDiagnostics()).toMatchObject({ executionCount: 1, running: false });
  });

  it('retains at most one pending latest intent while an execution is active', async () => {
    const model = createMapModeTransitionModel();
    const first = deferred<'3d'>();
    const executor = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce('2d');
    const coordinator = createMapModeTransitionCoordinator(model, executor);

    const running = coordinator.request('3d', 'control');
    await Promise.resolve();
    coordinator.request('2d', 'command');
    coordinator.request('3d', 'command');
    coordinator.request('2d', 'preference');

    expect(coordinator.getDiagnostics().maximumPendingDepth).toBe(2);
    first.resolve('3d');
    await running;
    await coordinator.whenIdle();

    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[0]?.[0]).toBe('3d');
    expect(executor.mock.calls[1]?.[0]).toBe('2d');
    expect(model.getSnapshot()).toMatchObject({ activeMode: '2d', desiredMode: '2d', phase: 'ready' });
  });

  it('coalesces duplicate intent through the state model', async () => {
    const model = createMapModeTransitionModel();
    const task = deferred<'3d'>();
    const executor = vi.fn(() => task.promise);
    const coordinator = createMapModeTransitionCoordinator(model, executor);
    const running = coordinator.request('3d', 'control');
    await Promise.resolve();
    coordinator.request('3d', 'command');
    coordinator.request('3d', 'preference');
    expect(model.getSnapshot().coalescedRequestCount).toBe(2);
    task.resolve('3d');
    await running;
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('exposes request currency to long-running executors', async () => {
    const model = createMapModeTransitionModel();
    const gate = deferred<'3d'>();
    const currency: boolean[] = [];
    const coordinator = createMapModeTransitionCoordinator(model, async (target, context) => {
      currency.push(context.isCurrent());
      if (target === '3d') {
        await gate.promise;
        currency.push(context.isCurrent());
      }
      return target;
    });
    const running = coordinator.request('3d');
    await Promise.resolve();
    coordinator.request('2d');
    gate.resolve('3d');
    await running;
    expect(currency).toEqual([true, false, true]);
  });

  it('records executor failures without rejecting the public drain promise', async () => {
    const model = createMapModeTransitionModel();
    const coordinator = createMapModeTransitionCoordinator(model, async () => {
      throw new TypeError('scene creation failed');
    });
    await expect(coordinator.request('3d')).resolves.toBeUndefined();
    expect(model.getSnapshot()).toMatchObject({ phase: 'error', activeMode: '2d', lastErrorKind: 'TypeError' });
    expect(coordinator.getDiagnostics().executorFailureCount).toBe(1);
  });

  it('can recover from a failed request with a later request', async () => {
    const model = createMapModeTransitionModel();
    const executor = vi.fn()
      .mockRejectedValueOnce(new Error('no scene'))
      .mockResolvedValueOnce('3d');
    const coordinator = createMapModeTransitionCoordinator(model, executor);
    await coordinator.request('3d');
    expect(model.getSnapshot().phase).toBe('error');
    await coordinator.request('3d', 'recovery');
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', activeMode: '3d', source: 'recovery' });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('ignores requests that already match an idle active mode', async () => {
    const model = createMapModeTransitionModel();
    const executor = vi.fn(async () => '2d' as const);
    const coordinator = createMapModeTransitionCoordinator(model, executor);
    await coordinator.request('2d');
    expect(executor).not.toHaveBeenCalled();
    expect(coordinator.getDiagnostics().ignoredRequestCount).toBe(1);
  });

  it('lets the executor report a safe fallback active mode', async () => {
    const model = createMapModeTransitionModel();
    const coordinator = createMapModeTransitionCoordinator(model, async () => '2d');
    await coordinator.request('3d');
    expect(model.getSnapshot()).toMatchObject({ activeMode: '2d', desiredMode: '2d', phase: 'ready' });
  });

  it('supports replacing the executor without rebuilding state', async () => {
    const model = createMapModeTransitionModel();
    const first = vi.fn(async () => '3d' as const);
    const second = vi.fn(async () => '2d' as const);
    const coordinator = createMapModeTransitionCoordinator(model, first);
    await coordinator.request('3d');
    coordinator.setExecutor(second);
    await coordinator.request('2d');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().activeMode).toBe('2d');
  });

  it('does not mutate after dispose', async () => {
    const model = createMapModeTransitionModel();
    const executor = vi.fn(async () => '3d' as const);
    const coordinator = createMapModeTransitionCoordinator(model, executor);
    coordinator.dispose();
    await coordinator.request('3d');
    expect(executor).not.toHaveBeenCalled();
    expect(coordinator.getDiagnostics()).toMatchObject({ disposed: true, ignoredRequestCount: 1 });
    expect(model.getSnapshot().activeMode).toBe('2d');
  });

  it('drops pending intent when disposed during a long execution', async () => {
    const model = createMapModeTransitionModel();
    const task = deferred<'3d'>();
    const executor = vi.fn(() => task.promise);
    const coordinator = createMapModeTransitionCoordinator(model, executor);
    const running = coordinator.request('3d');
    await Promise.resolve();
    coordinator.request('2d');
    coordinator.dispose();
    task.resolve('3d');
    await running;
    expect(executor).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().activeMode).toBe('2d');
  });

  it('keeps diagnostics immutable', () => {
    const model = createMapModeTransitionModel();
    const coordinator = createMapModeTransitionCoordinator(model, async (target) => target);
    expect(Object.isFrozen(coordinator.getDiagnostics())).toBe(true);
  });
});
