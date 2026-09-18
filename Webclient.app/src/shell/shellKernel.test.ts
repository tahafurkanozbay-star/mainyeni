import { describe, expect, it, vi } from 'vitest';
import type {
  PerformanceRuntime,
  PerformanceRuntimeSnapshot,
} from '../performance/contracts';
import { createShellKernel } from './shellKernel';

const performanceStub = (
  snapshot: PerformanceRuntimeSnapshot | null = null,
): PerformanceRuntime => ({
  recordVital: vi.fn(),
  capture: vi.fn(() => {
    if (!snapshot) throw new Error('capture not configured');
    return snapshot;
  }),
  setBaseline: vi.fn(),
  getBaseline: vi.fn(() => null),
  getLastSnapshot: vi.fn(() => snapshot),
  reset: vi.fn(),
});

const readinessSnapshot = (
  level: 'pass' | 'warning' | 'block',
  ready: boolean,
): PerformanceRuntimeSnapshot => ({
  report: {
    level,
    ready,
  },
} as PerformanceRuntimeSnapshot);

describe('createShellKernel', () => {
  it('composes bounded shell runtimes behind one lifecycle boundary', () => {
    const performance = performanceStub();
    const kernel = createShellKernel({ performance });
    expect(kernel.notifications).toBeDefined();
    expect(kernel.windows).toBeDefined();
    expect(kernel.commands).toBeDefined();
    expect(kernel.resources).toBeDefined();
    expect(kernel.performance).toBe(performance);
    expect(kernel.sidebar).toBeNull();
    expect(kernel.snapshot()).toEqual({
      destroyed: false,
      notificationCount: 0,
      registeredWindows: 0,
      visibleWindows: 0,
      commandCount: 0,
      cachedResources: 0,
      sidebarItems: 0,
      performanceCaptured: false,
      performanceReady: null,
      performanceLevel: null,
    });
  });

  it('aggregates live shell counts', async () => {
    const kernel = createShellKernel({
      performance: performanceStub(readinessSnapshot('warning', true)),
      sidebar: {
        groups: [{ id: 'ABB', label: 'ABB' }],
        items: [{ group: 'ABB', label: 'Parklar', windowId: 'parks' }],
      },
    });

    kernel.notifications.publish({ message: 'hello', ttlMs: null });
    kernel.windows.register({ id: 'sidebar', initiallyVisible: true });
    kernel.commands.register({ id: 'search', label: 'Ara', execute: () => undefined });
    await kernel.resources.load('catalog', async () => ({ ready: true }), { ttlMs: null });

    expect(kernel.snapshot()).toEqual({
      destroyed: false,
      notificationCount: 1,
      registeredWindows: 1,
      visibleWindows: 1,
      commandCount: 1,
      cachedResources: 1,
      sidebarItems: 1,
      performanceCaptured: true,
      performanceReady: true,
      performanceLevel: 'warning',
    });
  });

  it.each([
    ['pass', true],
    ['warning', true],
    ['block', false],
  ] as const)('reflects canonical performance readiness %s', (level, ready) => {
    const kernel = createShellKernel({
      performance: performanceStub(readinessSnapshot(level, ready)),
    });
    expect(kernel.snapshot()).toMatchObject({
      performanceCaptured: true,
      performanceLevel: level,
      performanceReady: ready,
    });
  });

  it('shares no hidden shell state between kernels', () => {
    const first = createShellKernel({ performance: performanceStub() });
    const second = createShellKernel({ performance: performanceStub() });
    first.notifications.publish({ message: 'first', ttlMs: null });
    first.windows.register({ id: 'a' });
    expect(first.snapshot().notificationCount).toBe(1);
    expect(second.snapshot().notificationCount).toBe(0);
    expect(second.snapshot().registeredWindows).toBe(0);
  });

  it('forwards bounded notification options', () => {
    const kernel = createShellKernel({
      performance: performanceStub(),
      notifications: { capacity: 1, defaultTtlMs: null },
    });
    kernel.notifications.publish({ message: 'a' });
    kernel.notifications.publish({ message: 'b' });
    expect(kernel.notifications.snapshot().active.map((item) => item.message)).toEqual(['b']);
  });

  it('forwards bounded window capacity', () => {
    const kernel = createShellKernel({
      performance: performanceStub(),
      windows: { capacity: 1 },
    });
    kernel.windows.register({ id: 'a' });
    expect(() => kernel.windows.register({ id: 'b' })).toThrow(/capacity/i);
  });

  it('forwards bounded command capacity', () => {
    const kernel = createShellKernel({
      performance: performanceStub(),
      commands: { capacity: 1 },
    });
    kernel.commands.register({ id: 'a', label: 'A', execute: () => undefined });
    expect(() => kernel.commands.register({
      id: 'b',
      label: 'B',
      execute: () => undefined,
    })).toThrow(/capacity/i);
  });

  it('forwards bounded resource capacity', async () => {
    const kernel = createShellKernel({
      performance: performanceStub(),
      resources: { capacity: 1, defaultTtlMs: null },
    });
    await kernel.resources.load('a', async () => 'a');
    await kernel.resources.load('b', async () => 'b');
    expect(kernel.resources.has('a')).toBe(false);
    expect(kernel.resources.has('b')).toBe(true);
  });

  it('constructs the optional sidebar catalog', () => {
    const kernel = createShellKernel({
      performance: performanceStub(),
      sidebar: {
        groups: [{ id: 'ABB', label: 'ABB' }],
        items: [{ group: 'ABB', label: 'Parklar', windowId: 'parks' }],
      },
    });
    expect(kernel.sidebar?.getItem('parks')?.label).toBe('Parklar');
  });

  it('fails construction on an invalid sidebar catalog', () => {
    expect(() => createShellKernel({
      performance: performanceStub(),
      sidebar: {
        groups: [],
        items: [{ group: 'MISSING', label: 'Broken', windowId: 'broken' }],
      },
    })).toThrow(/unknown group/i);
  });

  it('can execute commands that coordinate other shell runtimes', async () => {
    const kernel = createShellKernel({ performance: performanceStub() });
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
    const kernel = createShellKernel({ performance: performanceStub() });
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

  it('does not capture performance implicitly', () => {
    const performance = performanceStub();
    const kernel = createShellKernel({ performance });
    kernel.snapshot();
    expect(performance.capture).not.toHaveBeenCalled();
  });

  it('does not reset application-owned performance runtime on destroy', () => {
    const performance = performanceStub();
    const kernel = createShellKernel({ performance });
    kernel.destroy();
    expect(performance.reset).not.toHaveBeenCalled();
  });

  it('destroy tears down shell-owned mutable runtimes', async () => {
    const performance = performanceStub();
    const kernel = createShellKernel({ performance });
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
    expect(performance.reset).not.toHaveBeenCalled();
  });

  it('destroy is idempotent', () => {
    const kernel = createShellKernel({ performance: performanceStub() });
    kernel.destroy();
    expect(() => kernel.destroy()).not.toThrow();
  });

  it('does not invent network work', () => {
    const kernel = createShellKernel({ performance: performanceStub() });
    expect(kernel.snapshot().cachedResources).toBe(0);
    expect(kernel.snapshot().notificationCount).toBe(0);
  });
});
