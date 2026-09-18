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
  createPerformanceBudgetRuntime,
  type PerformanceBudgetMap,
  type PerformanceBudgetRuntime,
} from './performanceBudgetRuntime';
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
  readonly performanceBudgets?: PerformanceBudgetMap;
  readonly performanceWindowSize?: number;
  readonly sidebar?: SidebarCatalogInput;
}

export interface ShellKernelSnapshot {
  readonly destroyed: boolean;
  readonly notificationCount: number;
  readonly registeredWindows: number;
  readonly visibleWindows: number;
  readonly commandCount: number;
  readonly cachedResources: number;
  readonly criticalPerformanceSamples: number;
  readonly sidebarItems: number;
}

export interface ShellKernel {
  readonly notifications: NotificationCenter;
  readonly windows: WindowLifecycleRuntime;
  readonly commands: ShellCommandRegistry;
  readonly resources: LazyResourceRuntime<unknown>;
  readonly performance: PerformanceBudgetRuntime;
  readonly sidebar: SidebarCatalogRuntime | null;
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
  const performance = createPerformanceBudgetRuntime({
    budgets: options.performanceBudgets ?? {},
    ...(options.performanceWindowSize === undefined
      ? {}
      : { windowSize: options.performanceWindowSize }),
  });
  const sidebar = options.sidebar
    ? createSidebarCatalogRuntime(options.sidebar)
    : null;
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
    const performanceSnapshot = performance.snapshot();
    const sidebarSnapshot = sidebar?.snapshot();

    return Object.freeze({
      destroyed: false,
      notificationCount: notificationSnapshot.active.length,
      registeredWindows: windowSnapshot.windows.length,
      visibleWindows: windowSnapshot.visibleCount,
      commandCount: commandSnapshot.commandCount,
      cachedResources: resourceSnapshot.entryCount,
      criticalPerformanceSamples: performanceSnapshot.criticalCount,
      sidebarItems: sidebarSnapshot?.itemCount ?? 0,
    });
  };

  const destroy = (): void => {
    if (destroyed) return;
    notifications.destroy();
    windows.destroy();
    commands.destroy();
    resources.destroy();
    performance.clear();
    destroyed = true;
  };

  return Object.freeze({
    notifications,
    windows,
    commands,
    resources,
    performance,
    sidebar,
    snapshot,
    destroy,
  });
};
