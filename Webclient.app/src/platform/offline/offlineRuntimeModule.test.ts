import { vi } from 'vitest';
import { createOfflineRuntimeModule } from './offlineRuntimeModule';
import type { OfflineRuntime, OfflineRuntimeOptions } from './offlineRuntime';
import type { OfflineRuntimeSnapshot } from './contracts';
import type { RuntimeKernelModuleContext } from '../runtime/runtimeKernel';

const snapshot = (
  phase: OfflineRuntimeSnapshot['phase'] = 'ready',
): OfflineRuntimeSnapshot => Object.freeze({
  phase,
  supported: true,
  secureContext: true,
  online: true,
  controlled: true,
  registered: true,
  updateAvailable: false,
  scope: '/',
  scriptUrl: '/service-worker.js',
  lastErrorCode: phase === 'error' ? 'FAIL' : null,
  startedAt: 1,
  lastChangedAt: 1,
  workerStatus: null,
  events: Object.freeze([]),
});

const createRuntime = (phase: OfflineRuntimeSnapshot['phase'] = 'ready') => {
  let current = snapshot(phase);
  const runtime = {
    start: vi.fn(async () => current),
    stop: vi.fn(() => {
      current = snapshot('stopped');
      return current;
    }),
    dispose: vi.fn(async () => {
      current = snapshot('disposed');
    }),
    snapshot: vi.fn(() => current),
    subscribe: vi.fn(() => () => undefined),
    refreshStatus: vi.fn(async () => null),
    clearCache: vi.fn(async () => 0),
    activateUpdate: vi.fn(async () => false),
    checkForUpdate: vi.fn(async () => false),
    unregister: vi.fn(async () => false),
  } satisfies OfflineRuntime;
  return runtime;
};

const context = (): RuntimeKernelModuleContext => ({
  signal: new AbortController().signal,
  telemetry: {
    record: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    measure: vi.fn(async (_domain, _name, operation) => operation()),
    snapshot: vi.fn(() => []),
    summary: vi.fn(() => ({
      capacity: 1,
      eventCount: 0,
      droppedEvents: 0,
      countsByLevel: { debug: 0, info: 0, warn: 0, error: 0 },
      countsByDomain: {},
    })),
    clear: vi.fn(),
  } as unknown as RuntimeKernelModuleContext['telemetry'],
  scheduler: {} as RuntimeKernelModuleContext['scheduler'],
  budget: {} as RuntimeKernelModuleContext['budget'],
  kernel: {} as RuntimeKernelModuleContext['kernel'],
});

describe('offline runtime kernel module', () => {
  test('uses stable default module identity and order', () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    expect(feature.module.id).toBe('offline-runtime');
    expect(feature.module.order).toBe(70);
    expect(feature.module.required).toBe(false);
  });

  test('start delegates to offline runtime and records telemetry', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    const ctx = context();
    await feature.module.start?.(ctx);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(ctx.telemetry.info).toHaveBeenCalledWith('offline', 'runtime-start', {
      status: 'ready',
      result: 'success',
    });
    expect(feature.snapshot().startCount).toBe(1);
  });

  test('optional module does not fail kernel when service worker registration degrades', async () => {
    const runtime = createRuntime('error');
    const feature = createOfflineRuntimeModule({ runtime, required: false });
    await expect(feature.module.start?.(context())).resolves.toBeUndefined();
  });

  test('required module fails when offline runtime is in error phase', async () => {
    const runtime = createRuntime('error');
    const feature = createOfflineRuntimeModule({ runtime, required: true });
    await expect(feature.module.start?.(context())).rejects.toThrow(/Required offline runtime/u);
  });

  test('ready refreshes worker status without restarting', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    await feature.module.ready?.(context());
    expect(runtime.refreshStatus).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  test('suspend stops local listeners and increments counter', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    await feature.module.suspend?.(context());
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(feature.snapshot().suspendCount).toBe(1);
  });

  test('resume restarts runtime lifecycle', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    await feature.module.resume?.(context());
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(feature.snapshot().resumeCount).toBe(1);
  });

  test('stop delegates without uninstalling service worker', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    await feature.module.stop?.(context());
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(runtime.unregister).not.toHaveBeenCalled();
    expect(feature.snapshot().stopCount).toBe(1);
  });

  test('dispose delegates once and becomes idempotent', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    await feature.dispose();
    await feature.dispose();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  test('aborted start fails before runtime activation', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const ctx = { ...context(), signal: controller.signal };
    await expect(feature.module.start?.(ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  test('aborted resume fails before runtime activation', async () => {
    const runtime = createRuntime();
    const feature = createOfflineRuntimeModule({ runtime });
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const ctx = { ...context(), signal: controller.signal };
    await expect(feature.module.resume?.(ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(runtime.start).not.toHaveBeenCalled();
  });

  test('custom identity and order are preserved', () => {
    const runtime = createRuntime();
    const options: OfflineRuntimeOptions = {};
    const feature = createOfflineRuntimeModule({
      ...options,
      runtime,
      id: 'offline-readiness',
      order: 90,
      required: true,
    });
    expect(feature.module.id).toBe('offline-readiness');
    expect(feature.module.order).toBe(90);
    expect(feature.module.required).toBe(true);
  });
});
