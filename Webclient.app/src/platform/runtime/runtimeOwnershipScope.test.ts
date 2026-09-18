import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeOwnershipCapacityError,
  RuntimeOwnershipDisposedError,
  RuntimeOwnershipScope,
} from './runtimeOwnershipScope';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('RuntimeOwnershipScope resource ownership', () => {
  it('releases owned resources explicitly and only once', async () => {
    const dispose = vi.fn();
    const scope = new RuntimeOwnershipScope({ label: 'test' });
    const release = scope.own(dispose, 'resource');
    expect(scope.snapshot().resourceCount).toBe(1);
    await release();
    await release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().resourceCount).toBe(0);
  });

  it('disposes remaining resources in reverse ownership order', async () => {
    const order: string[] = [];
    const scope = new RuntimeOwnershipScope();
    scope.own(() => { order.push('first'); }, 'first');
    scope.own(() => { order.push('second'); }, 'second');
    scope.own(() => { order.push('third'); }, 'third');
    const report = await scope.dispose();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(report.released).toBe(3);
  });

  it('awaits asynchronous disposers in deterministic reverse order', async () => {
    const order: string[] = [];
    const scope = new RuntimeOwnershipScope();
    scope.own(async () => {
      await Promise.resolve();
      order.push('first');
    }, 'first');
    scope.own(async () => {
      await Promise.resolve();
      order.push('second');
    }, 'second');
    await scope.dispose();
    expect(order).toEqual(['second', 'first']);
  });

  it('continues disposal after one resource throws', async () => {
    const dispose = vi.fn();
    const scope = new RuntimeOwnershipScope();
    scope.own(dispose, 'survivor');
    scope.own(() => { throw new Error('cleanup failed'); }, 'broken');
    const report = await scope.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ label: 'broken', message: 'cleanup failed' });
  });

  it('isolates failure observer errors', async () => {
    const scope = new RuntimeOwnershipScope({
      onFailure: () => { throw new Error('observer failed'); },
    });
    scope.own(() => { throw new Error('dispose failed'); }, 'broken');
    await expect(scope.dispose()).resolves.toMatchObject({ released: 1 });
  });

  it('bounds retained failure diagnostics', async () => {
    const scope = new RuntimeOwnershipScope({ maxFailures: 2, maxResources: 4 });
    scope.own(() => { throw new Error('one'); }, 'one');
    scope.own(() => { throw new Error('two'); }, 'two');
    scope.own(() => { throw new Error('three'); }, 'three');
    const report = await scope.dispose();
    expect(report.failures).toHaveLength(2);
    expect(report.failures.map((failure) => failure.label)).toEqual(['two', 'one']);
  });

  it('enforces bounded resource capacity', () => {
    const scope = new RuntimeOwnershipScope({ maxResources: 1 });
    scope.own(() => undefined, 'one');
    expect(() => scope.own(() => undefined, 'two')).toThrow(RuntimeOwnershipCapacityError);
  });
});

describe('RuntimeOwnershipScope AbortController ownership', () => {
  it('aborts owned controllers when the scope is disposed', async () => {
    const scope = new RuntimeOwnershipScope();
    const controller = scope.ownAbortController('request');
    const reason = new Error('scope shutdown');
    await scope.dispose(reason);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
  });

  it('does not interfere with a child controller already aborted by its owner', async () => {
    const scope = new RuntimeOwnershipScope();
    const controller = scope.ownAbortController();
    const reason = new Error('request cancelled');
    controller.abort(reason);
    await scope.dispose();
    expect(controller.signal.reason).toBe(reason);
  });

  it('exposes a scope AbortSignal immediately after disposal', async () => {
    const scope = new RuntimeOwnershipScope();
    expect(scope.signal.aborted).toBe(false);
    await scope.dispose(new Error('shutdown'));
    expect(scope.signal.aborted).toBe(true);
  });
});

describe('RuntimeOwnershipScope event listener ownership', () => {
  it('removes an owned event listener on explicit release', async () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const scope = new RuntimeOwnershipScope();
    const release = scope.ownEventListener(target, 'change', listener);
    target.dispatchEvent(new Event('change'));
    expect(listener).toHaveBeenCalledTimes(1);
    await release();
    target.dispatchEvent(new Event('change'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('removes all owned event listeners on disposal', async () => {
    const target = new EventTarget();
    const first = vi.fn();
    const second = vi.fn();
    const scope = new RuntimeOwnershipScope();
    scope.ownEventListener(target, 'first', first);
    scope.ownEventListener(target, 'second', second);
    await scope.dispose();
    target.dispatchEvent(new Event('first'));
    target.dispatchEvent(new Event('second'));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});

describe('RuntimeOwnershipScope timeout ownership', () => {
  it('cancels an owned timeout when scope disposes first', async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const scope = new RuntimeOwnershipScope();
      scope.ownTimeout(handler, 1_000, 'deferred-work');
      await scope.dispose();
      vi.advanceTimersByTime(2_000);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke a fired timeout again during disposal', async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const scope = new RuntimeOwnershipScope();
      scope.ownTimeout(handler, 10);
      vi.advanceTimersByTime(10);
      expect(handler).toHaveBeenCalledTimes(1);
      await scope.dispose();
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RuntimeOwnershipScope child scopes', () => {
  it('disposes child scope when parent disposes', async () => {
    const childDispose = vi.fn();
    const parent = new RuntimeOwnershipScope({ label: 'parent' });
    const child = parent.fork('child');
    child.own(childDispose, 'child-resource');
    await parent.dispose();
    expect(child.disposed).toBe(true);
    expect(childDispose).toHaveBeenCalledTimes(1);
  });

  it('preserves hierarchical labels for diagnostics', () => {
    const parent = new RuntimeOwnershipScope({ label: 'app' });
    const child = parent.fork('gis');
    const grandchild = child.fork('scene');
    expect(child.label).toBe('app/gis');
    expect(grandchild.label).toBe('app/gis/scene');
  });

  it('child disposal can happen before parent without double cleanup', async () => {
    const dispose = vi.fn();
    const parent = new RuntimeOwnershipScope();
    const child = parent.fork('child');
    child.own(dispose, 'resource');
    await child.dispose();
    await parent.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeOwnershipScope lifecycle state', () => {
  it('snapshot exposes bounded owned-resource metadata', () => {
    let now = 100;
    const scope = new RuntimeOwnershipScope({ label: 'app', now: () => now });
    scope.own(() => undefined, 'http-listener');
    now = 150;
    expect(scope.snapshot()).toMatchObject({
      generatedAt: 150,
      label: 'app',
      disposed: false,
      resourceCount: 1,
      resources: [{ id: 1, label: 'http-listener', ownedAt: 100, released: false }],
    });
  });

  it('rejects new ownership after disposal', async () => {
    const scope = new RuntimeOwnershipScope({ label: 'closed' });
    await scope.dispose();
    expect(() => scope.own(() => undefined)).toThrow(RuntimeOwnershipDisposedError);
    expect(() => scope.ownAbortController()).toThrow(RuntimeOwnershipDisposedError);
  });

  it('returns the same disposal result to concurrent callers', async () => {
    const scope = new RuntimeOwnershipScope();
    scope.own(async () => { await flush(); }, 'async');
    const first = scope.dispose();
    const second = scope.dispose();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(scope.disposed).toBe(true);
  });
});
