import { vi as jest } from 'vitest';
import { createResourceScope } from './resourceScope';
import {
  bindAbortController,
  bindAnimationFrame,
  bindDisposable,
  bindEventListener,
  bindObserver,
  bindSubscription,
  type AnimationFramePort,
  type EventTargetPort,
} from './resourceScopeAdapters';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('resourceScopeAdapters event listener ownership', () => {
  test('binds and removes an EventTarget listener through scope cleanup', async () => {
    const target = new EventTarget();
    const listener = jest.fn();
    const scope = createResourceScope('component');
    const handle = bindEventListener(scope, {
      owner: 'map',
      key: 'move-listener',
      target,
      type: 'move',
      listener,
    });

    target.dispatchEvent(new Event('move'));
    expect(listener).toHaveBeenCalledTimes(1);
    await handle.release('component-unmounted');
    target.dispatchEvent(new Event('move'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('scope close removes every bound listener', async () => {
    const target = new EventTarget();
    const move = jest.fn();
    const zoom = jest.fn();
    const scope = createResourceScope('component');

    bindEventListener(scope, {
      owner: 'map',
      key: 'move',
      target,
      type: 'move',
      listener: move,
    });
    bindEventListener(scope, {
      owner: 'map',
      key: 'zoom',
      target,
      type: 'zoom',
      listener: zoom,
    });

    await scope.close();
    target.dispatchEvent(new Event('move'));
    target.dispatchEvent(new Event('zoom'));
    expect(move).not.toHaveBeenCalled();
    expect(zoom).not.toHaveBeenCalled();
  });

  test('forwards capture option consistently to add/remove boundaries', async () => {
    const addEventListener = jest.fn();
    const removeEventListener = jest.fn();
    const target: EventTargetPort = { addEventListener, removeEventListener };
    const listener = jest.fn();
    const scope = createResourceScope('component');

    const handle = bindEventListener(scope, {
      owner: 'map',
      key: 'capture',
      target,
      type: 'click',
      listener,
      options: { capture: true, passive: true },
    });
    expect(addEventListener).toHaveBeenCalledWith(
      'click',
      listener,
      { capture: true, passive: true },
    );

    await handle.release();
    expect(removeEventListener).toHaveBeenCalledWith(
      'click',
      listener,
      { capture: true },
    );
  });

  test('rolls back listener registration if scope admission rejects', () => {
    const addEventListener = jest.fn();
    const removeEventListener = jest.fn();
    const target: EventTargetPort = { addEventListener, removeEventListener };
    const scope = createResourceScope('component', {
      maxResources: 1,
      maxOwnerResources: 1,
    });
    scope.register({ owner: 'owner', key: 'occupied', cleanup: jest.fn() });

    expect(() => bindEventListener(scope, {
      owner: 'owner',
      key: 'listener',
      target,
      type: 'move',
      listener: jest.fn(),
    })).toThrow(expect.objectContaining({ code: 'RESOURCE_CAPACITY_EXCEEDED' }));

    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  test('validates event target add capability before side effects', () => {
    const scope = createResourceScope('component');
    expect(() => bindEventListener(scope, {
      owner: 'owner',
      key: 'listener',
      target: {
        addEventListener: null as unknown as EventTargetPort['addEventListener'],
        removeEventListener: jest.fn(),
      },
      type: 'move',
      listener: jest.fn(),
    })).toThrow(TypeError);
    expect(scope.snapshot().activeResources).toBe(0);
  });

  test('validates event target remove capability before side effects', () => {
    const addEventListener = jest.fn();
    const scope = createResourceScope('component');
    expect(() => bindEventListener(scope, {
      owner: 'owner',
      key: 'listener',
      target: {
        addEventListener,
        removeEventListener: null as unknown as EventTargetPort['removeEventListener'],
      },
      type: 'move',
      listener: jest.fn(),
    })).toThrow(TypeError);
    expect(addEventListener).not.toHaveBeenCalled();
  });

  test('rejects invalid event type before touching target', () => {
    const addEventListener = jest.fn();
    const target: EventTargetPort = {
      addEventListener,
      removeEventListener: jest.fn(),
    };
    const scope = createResourceScope('component');

    expect(() => bindEventListener(scope, {
      owner: 'owner',
      key: 'listener',
      target,
      type: 'move\ninvalid',
      listener: jest.fn(),
    })).toThrow(TypeError);
    expect(addEventListener).not.toHaveBeenCalled();
  });

  test('retains bounded metadata on listener resources', () => {
    const target = new EventTarget();
    const scope = createResourceScope('component');
    bindEventListener(scope, {
      owner: 'map',
      key: 'move',
      target,
      type: 'move',
      listener: jest.fn(),
      metadata: { component: 'map-view', token: 'private' },
    });

    expect(scope.snapshot().resources[0]?.metadata).toEqual({
      component: 'map-view',
      token: '[redacted]',
    });
  });
});

describe('resourceScopeAdapters subscriptions and observers', () => {
  test('bindSubscription invokes async unsubscribe exactly once', async () => {
    const unsubscribe = jest.fn(async () => undefined);
    const scope = createResourceScope('component');
    const handle = bindSubscription(scope, {
      owner: 'store',
      key: 'state-subscription',
      unsubscribe,
    });

    await handle.release();
    await handle.release();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('bindSubscription validates unsubscribe contract', () => {
    const scope = createResourceScope('component');
    expect(() => bindSubscription(scope, {
      owner: 'store',
      key: 'state-subscription',
      unsubscribe: null as unknown as () => void,
    })).toThrow(TypeError);
  });

  test('bindObserver disconnects observer during release', async () => {
    const disconnect = jest.fn();
    const scope = createResourceScope('component');
    const handle = bindObserver(scope, {
      owner: 'performance',
      key: 'observer',
      observer: { disconnect },
    });

    await handle.release();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test('bindObserver supports asynchronous disconnect', async () => {
    const disconnect = jest.fn(async () => undefined);
    const scope = createResourceScope('component');
    bindObserver(scope, {
      owner: 'resize',
      key: 'observer',
      observer: { disconnect },
    });

    await scope.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  test('bindObserver validates disconnect capability', () => {
    const scope = createResourceScope('component');
    expect(() => bindObserver(scope, {
      owner: 'resize',
      key: 'observer',
      observer: {} as { disconnect(): void },
    })).toThrow(TypeError);
  });

  test('subscription cleanup failures are governed by ResourceScope', async () => {
    const scope = createResourceScope('component');
    const handle = bindSubscription(scope, {
      owner: 'store',
      key: 'bad-subscription',
      unsubscribe: () => { throw new Error('unsubscribe failed'); },
    });

    await expect(handle.release())
      .rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    expect(scope.snapshot().counters.failed).toBe(1);
  });
});

describe('resourceScopeAdapters AbortController ownership', () => {
  test('creates a controller when one is not provided', () => {
    const scope = createResourceScope('component');
    const binding = bindAbortController(scope, {
      owner: 'network',
      key: 'request-scope',
    });

    expect(binding.controller).toBeInstanceOf(AbortController);
    expect(binding.signal).toBe(binding.controller.signal);
    expect(binding.signal.aborted).toBe(false);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test('aborts owned controller during resource release', async () => {
    const scope = createResourceScope('component');
    const binding = bindAbortController(scope, {
      owner: 'network',
      key: 'request-scope',
      reason: 'route-change',
    });

    await binding.handle.release();
    expect(binding.signal.aborted).toBe(true);
    expect(binding.signal.reason).toBe('route-change');
  });

  test('does not overwrite an already aborted controller reason', async () => {
    const controller = new AbortController();
    controller.abort('caller-cancelled');
    const scope = createResourceScope('component');
    const binding = bindAbortController(scope, {
      owner: 'network',
      key: 'request-scope',
      controller,
      reason: 'scope-closed',
    });

    await binding.handle.release();
    expect(binding.signal.reason).toBe('caller-cancelled');
  });

  test('scope close aborts every owned request controller', async () => {
    const scope = createResourceScope('component');
    const first = bindAbortController(scope, { owner: 'network', key: 'first' });
    const second = bindAbortController(scope, { owner: 'network', key: 'second' });

    await scope.close({ reason: 'component-unmounted' });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});

describe('resourceScopeAdapters animation frame ownership', () => {
  const createFramePort = () => {
    let sequence = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const port: AnimationFramePort & {
      fire(id: number, timestamp?: number): void;
      pending(): number;
      cancelled: number[];
    } = {
      requestAnimationFrame: (callback) => {
        const id = ++sequence;
        callbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id) => {
        callbacks.delete(id);
        port.cancelled.push(id);
      },
      fire: (id, timestamp = 16) => {
        const callback = callbacks.get(id);
        callbacks.delete(id);
        callback?.(timestamp);
      },
      pending: () => callbacks.size,
      cancelled: [],
    };
    return port;
  };

  test('registers a pending animation frame as an owned resource', () => {
    const port = createFramePort();
    const scope = createResourceScope('component');
    const binding = bindAnimationFrame(scope, {
      owner: 'render',
      key: 'next-frame',
      callback: jest.fn(),
      port,
    });

    expect(binding.frameId).toBe(1);
    expect(port.pending()).toBe(1);
    expect(scope.snapshot().activeResources).toBe(1);
  });

  test('scope close cancels a pending animation frame', async () => {
    const port = createFramePort();
    const scope = createResourceScope('component');
    const binding = bindAnimationFrame(scope, {
      owner: 'render',
      key: 'next-frame',
      callback: jest.fn(),
      port,
    });

    await scope.close();
    expect(port.cancelled).toEqual([binding.frameId]);
    expect(port.pending()).toBe(0);
  });

  test('completed frame invokes callback and self-releases ownership', async () => {
    const port = createFramePort();
    const callback = jest.fn();
    const scope = createResourceScope('component');
    const binding = bindAnimationFrame(scope, {
      owner: 'render',
      key: 'next-frame',
      callback,
      port,
    });

    port.fire(binding.frameId, 42);
    await flush();

    expect(callback).toHaveBeenCalledWith(42);
    expect(binding.handle.released).toBe(true);
    expect(scope.snapshot().activeResources).toBe(0);
    expect(port.cancelled).toEqual([]);
  });

  test('does not cancel a frame that already completed', async () => {
    const port = createFramePort();
    const scope = createResourceScope('component');
    const binding = bindAnimationFrame(scope, {
      owner: 'render',
      key: 'next-frame',
      callback: jest.fn(),
      port,
    });

    port.fire(binding.frameId);
    await flush();
    await scope.close();
    expect(port.cancelled).toEqual([]);
  });

  test('rolls back frame registration when scope admission fails', () => {
    const port = createFramePort();
    const scope = createResourceScope('component', {
      maxResources: 1,
      maxOwnerResources: 1,
    });
    scope.register({ owner: 'render', key: 'occupied', cleanup: jest.fn() });

    expect(() => bindAnimationFrame(scope, {
      owner: 'render',
      key: 'frame',
      callback: jest.fn(),
      port,
    })).toThrow(expect.objectContaining({ code: 'RESOURCE_CAPACITY_EXCEEDED' }));

    expect(port.cancelled).toEqual([1]);
    expect(port.pending()).toBe(0);
  });

  test('validates animation frame callback before scheduling', () => {
    const port = createFramePort();
    const scope = createResourceScope('component');
    expect(() => bindAnimationFrame(scope, {
      owner: 'render',
      key: 'frame',
      callback: null as unknown as FrameRequestCallback,
      port,
    })).toThrow(TypeError);
    expect(port.pending()).toBe(0);
  });
});

describe('resourceScopeAdapters generic disposable helper', () => {
  test('bindDisposable delegates ownership to ResourceScope', async () => {
    const dispose = jest.fn();
    const scope = createResourceScope('component');
    const handle = bindDisposable(
      scope,
      'worker',
      'parser-worker',
      { dispose },
      { metadata: { kind: 'worker' } },
    );

    expect(handle.snapshot()?.metadata).toEqual({ kind: 'worker' });
    await scope.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('owner teardown works consistently across adapter types', async () => {
    const unsubscribe = jest.fn();
    const disconnect = jest.fn();
    const target = new EventTarget();
    const listener = jest.fn();
    const scope = createResourceScope('component');

    bindSubscription(scope, {
      owner: 'feature',
      key: 'subscription',
      unsubscribe,
    });
    bindObserver(scope, {
      owner: 'feature',
      key: 'observer',
      observer: { disconnect },
    });
    bindEventListener(scope, {
      owner: 'feature',
      key: 'listener',
      target,
      type: 'change',
      listener,
    });
    bindAbortController(scope, {
      owner: 'other-feature',
      key: 'controller',
    });

    await expect(scope.releaseOwner('feature')).resolves.toBe(3);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().activeResources).toBe(1);
  });

  test('adapters do not add polling or remote network activity', () => {
    const scope = createResourceScope('component');
    bindSubscription(scope, {
      owner: 'store',
      key: 'subscription',
      unsubscribe: jest.fn(),
    });
    bindAbortController(scope, {
      owner: 'network',
      key: 'controller',
    });

    expect(scope.snapshot().activeResources).toBe(2);
    expect(JSON.stringify(scope.snapshot())).not.toMatch(/https?:\/\//i);
  });
});
