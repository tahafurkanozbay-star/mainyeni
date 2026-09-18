import { describe, expect, it, vi } from 'vitest';
import type { WebVitalSample } from '../observability/webVitalsRuntime';
import { createShellKernel } from './shellKernel';

const lcp = (value: number): WebVitalSample => ({
  name: 'LCP',
  value,
  delta: value,
  rating: 'unknown',
  navigationType: 'navigate',
  id: `lcp-${value}`,
  recordedAt: value,
});

describe('createShellKernel', () => {
  it('composes shell runtimes behind one lifecycle boundary', () => {
    const kernel = createShellKernel();
    expect(kernel.notifications).toBeDefined();
    expect(kernel.windows).toBeDefined();
    expect(kernel.commands).toBeDefined();
    expect(kernel.resources).toBeDefined();
    expect(kernel.performance).toBeDefined();
    expect(kernel.sidebar).toBeNull();
    expect(kernel.snapshot()).toEqual({
      destroyed: false,
      notificationCount: 0,
      registeredWindows: 0,
      visibleWindows: 0,
      commandCount: 0,
      cachedResources: 0,
      criticalPerformanceSamples: 0,
      sidebarItems: 0,
    });
  });

  it('aggregates live shell counts', async () => {
    const kernel = createShellKernel({
      performanceBudgets: { LCP: { warning: 2500, critical: 4000 } },
      sidebar: {
        groups: [{ id: 'ABB', label: 'ABB' }],
        items: [{ group: 'ABB', label: 'Parklar', windowId: 'parks' }],
      },
    });
    kernel.notifications.publish({ message: 'hello', ttlMs: null });
    kernel.windows.register({ id: 'sidebar', initiallyVisible: true });
    kernel.commands.register({ id: 'search', label: 'Ara', execute: () => undefined });
    await kernel.resources.load('catalog', async () => ({ ready: true }), { ttlMs: null });
    kernel.performance.evaluate(lcp(5000));

    expect(kernel.snapshot()).toEqual({
      destroyed: false,
      notificationCount: 1,
      registeredWindows: 1,
      visibleWindows: 1,
      commandCount: 1,
      cachedResources: 1,
      criticalPerformanceSamples: 1,
      sidebarItems: 1,
    });
  });

  it('shares no hidden global state between kernels', () => {
    const first = createShellKernel();
    const second = createShellKernel();
    first.notifications.publish({ message: 'first', ttlMs: null });
    first.windows.register({ id: 'a' });
    expect(first.snapshot().notificationCount).toBe(1);
    expect(second.snapshot().notificationCount).toBe(0);
    expect(second.snapshot().registeredWindows).toBe(0);
  });

  it('forwards bounded notification options', () => {
    const kernel = createShellKernel({ notifications: { capacity: 1, defaultTtlMs: null } });
    kernel.notifications.publish({ message: 'a' });
    kernel.notifications.publish({ message: 'b' });
    expect(kernel.notifications.snapshot().active.map((item) => item.message)).toEqual(['b']);
  });

  it('forwards bounded window capacity', () => {
    const kernel = createShellKernel({ windows: { capacity: 1 } });
    kernel.windows.register({ id: 'a' });
    expect(() => kernel.windows.register({ id: 'b' })).toThrow(/capacity/i);
  });

  it('forwards bounded command capacity', () => {
    const kernel = createShellKernel({ commands: { capacity: 1 } });
    kernel.commands.register({ id: 'a', label: 'A', execute: () => undefined });
    expect(() => kernel.commands.register({ id: 'b', label: 'B', execute: () => undefined })).toThrow(/capacity/i);
  });

  it('forwards bounded resource capacity', async () => {
    const kernel = createShellKernel({ resources: { capacity: 1, defaultTtlMs: null } });
    await kernel.resources.load('a', async () => 'a');
    await kernel.resources.load('b', async () => 'b');
    expect(kernel.resources.has('a')).toBe(false);
    expect(kernel.resources.has('b')).toBe(true);
  });

  it('forwards performance window configuration', () => {
    const kernel = createShellKernel({
      performanceBudgets: { LCP: { warning: 100, critical: 200 } },
      performanceWindowSize: 5,
    });
    for (let index = 0; index < 8; index += 1) kernel.performance.evaluate(lcp(index));
    expect(kernel.performance.snapshot().evaluations).toHaveLength(5);
  });

  it('constructs optional sidebar catalog', () => {
    const kernel = createShellKernel({
      sidebar: {
        groups: [{ id: 'ABB', label: 'ABB' }],
        items: [{ group: 'ABB', label: 'Parklar', windowId: 'parks' }],
      },
    });
    expect(kernel.sidebar?.getItem('parks')?.label).toBe('Parklar');
  });

  it('fails construction on invalid sidebar catalog', () => {
    expect(() => createShellKernel({
      sidebar: {
        groups: [],
        items: [{ group: 'MISSING', label: 'Broken', windowId: 'broken' }],
      },
    })).toThrow(/unknown group/i);
  });

  it('can execute commands that coordinate other kernel runtimes', async () => {
    const kernel = createShellKernel();
    kernel.windows.register({ id: 'sidebar' });
    kernel.commands.register({
      id: 'sidebar.show',
      label: 'Menüyü Aç',
      execute: () => {
        kernel.windows.show('sidebar');
        kernel.notifications.publish({ message: 'Menü açıldı', ttlMs: null });
      },
    });
    await expect(kernel.commands.execute('sidebar.show')).resolves.toBe(true);
    expect(kernel.windows.get('sidebar')?.visible).toBe(true);
    expect(kernel.notifications.snapshot().active[0]?.message).toBe('Menü açıldı');
  });

  it('supports command predicates against shell context', async () => {
    const execute = vi.fn();
    const kernel = createShellKernel();
    kernel.commands.register({
      id: 'secure',
      label: 'Secure',
      enabled: (context) => context.allowed === true,
      execute,
    });
    await expect(kernel.commands.execute('secure', { allowed: false })).resolves.toBe(false);
    await expect(kernel.commands.execute('secure', { allowed: true })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('tracks noncritical performance samples as healthy', () => {
    const kernel = createShellKernel({
      performanceBudgets: { LCP: { warning: 2500, critical: 4000 } },
    });
    kernel.performance.evaluate(lcp(3000));
    expect(kernel.performance.snapshot()).toMatchObject({ warningCount: 1, criticalCount: 0, healthy: true });
    expect(kernel.snapshot().criticalPerformanceSamples).toBe(0);
  });

  it('destroy tears down mutable child runtimes', async () => {
    const kernel = createShellKernel();
    kernel.notifications.publish({ message: 'x', ttlMs: null });
    kernel.windows.register({ id: 'window' });
    kernel.commands.register({ id: 'command', label: 'Command', execute: () => undefined });
    await kernel.resources.load('resource', async () => 'ready', { ttlMs: null });

    kernel.destroy();

    expect(() => kernel.snapshot()).toThrow(/destroyed/i);
    expect(() => kernel.notifications.snapshot()).toThrow(/destroyed/i);
    expect(() => kernel.windows.snapshot()).toThrow(/destroyed/i);
    expect(() => kernel.commands.snapshot()).toThrow(/destroyed/i);
    expect(() => kernel.resources.snapshot()).toThrow(/destroyed/i);
    expect(kernel.performance.snapshot().totalEvaluated).toBe(0);
  });

  it('destroy is idempotent', () => {
    const kernel = createShellKernel();
    kernel.destroy();
    expect(() => kernel.destroy()).not.toThrow();
  });

  it('does not invent network work', () => {
    const kernel = createShellKernel();
    expect(kernel.snapshot().cachedResources).toBe(0);
    expect(kernel.snapshot().notificationCount).toBe(0);
  });
});
