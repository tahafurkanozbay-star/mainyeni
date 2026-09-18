import {
  performanceRuntime,
} from '../performance/runtime';
import type {
  PerformanceRuntime,
} from '../performance/contracts';
import {
  createNotificationCenter,
  type NotificationCenter,
  type NotificationCenterOptions,
} from './notificationCenter';
import {
  createWindowLifecycleRuntime,
  type WindowLifecycleOptions,
  type WindowLifecycleRuntime,
} from './windowLifecycleRuntime';
import {
  createShellCommandRegistry,
  type ShellCommandRegistry,
  type ShellCommandRegistryOptions,
} from './commandRegistryRuntime';
import {
  createLazyResourceRuntime,
  type LazyResourceRuntime,
  type LazyResourceRuntimeOptions,
} from './lazyResourceRuntime';
import {
  createSidebarCatalogRuntime,
  type SidebarCatalogInput,
  type SidebarCatalogRuntime,
} from './sidebarCatalogRuntime';

export interface ShellKernelOptions {
  readonly notifications?: NotificationCenterOptions;
  readonly windows?: WindowLifecycleOptions;
  readonly commands?: ShellCommandRegistryOptions;
  readonly resources?: LazyResourceRuntimeOptions;
  readonly sidebar?: SidebarCatalogInput;
  readonly performance?: PerformanceRuntime;
}

export interface ShellKernelSnapshot {
  readonly destroyed: boolean;
  readonly notificationCount: number;
  readonly registeredWindows: number;
  readonly visibleWindows: number;
  readonly commandCount: number;
  readonly cachedResources: number;
  readonly sidebarItems: number;
  readonly performanceCaptured: boolean;
  readonly performanceReady: boolean | null;
  readonly performanceLevel: 'pass' | 'warning' | 'block' | null;
}

export interface ShellKernel {
  readonly notifications: NotificationCenter;
  readonly windows: WindowLifecycleRuntime;
  readonly commands: ShellCommandRegistry;
  readonly resources: LazyResourceRuntime<unknown>;
  readonly sidebar: SidebarCatalogRuntime | null;
  readonly performance: PerformanceRuntime;
  readonly snapshot: () => ShellKernelSnapshot;
  readonly destroy: () => void;
}

export const createShellKernel = (
  options: ShellKernelOptions = {},
): ShellKernel => {
  const notifications = createNotificationCenter(options.notifications);
  const windows = createWindowLifecycleRuntime(options.windows);
  const commands = createShellCommandRegistry(options.commands);
  const resources = createLazyResourceRuntime<unknown>(options.resources);
  const sidebar = options.sidebar
    ? createSidebarCatalogRuntime(options.sidebar)
    : null;
  const performance = options.performance ?? performanceRuntime;
  let destroyed = false;

  const assertActive = (): void => {
    if (destroyed) throw new Error('Shell kernel is destroyed.');
  };

  const snapshot = (): ShellKernelSnapshot => {
    assertActive();
    const notificationSnapshot = notifications.snapshot();
    const windowSnapshot = windows.snapshot();
    const commandSnapshot = commands.snapshot();
    const resourceSnapshot = resources.snapshot();
    const sidebarSnapshot = sidebar?.snapshot();
    const performanceSnapshot = performance.getLastSnapshot();

    return Object.freeze({
      destroyed: false,
      notificationCount: notificationSnapshot.active.length,
      registeredWindows: windowSnapshot.windows.length,
      visibleWindows: windowSnapshot.visibleCount,
      commandCount: commandSnapshot.commandCount,
      cachedResources: resourceSnapshot.entryCount,
      sidebarItems: sidebarSnapshot?.itemCount ?? 0,
      performanceCaptured: performanceSnapshot !== null,
      performanceReady: performanceSnapshot?.report.ready ?? null,
      performanceLevel: performanceSnapshot?.report.level ?? null,
    });
  };

  const destroy = (): void => {
    if (destroyed) return;
    notifications.destroy();
    windows.destroy();
    commands.destroy();
    resources.destroy();
    // Performance runtime is application-owned and may have a page-lifecycle
    // capture installed by the performance domain. The shell never resets it.
    destroyed = true;
  };

  return Object.freeze({
    notifications,
    windows,
    commands,
    resources,
    sidebar,
    performance,
    snapshot,
    destroy,
  });
};
