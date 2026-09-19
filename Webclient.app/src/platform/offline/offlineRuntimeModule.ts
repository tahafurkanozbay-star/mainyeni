import type { OfflineRuntimeModuleSnapshot } from './contracts';
import {
  createOfflineRuntime,
  type OfflineRuntime,
  type OfflineRuntimeOptions,
} from './offlineRuntime';
import type {
  RuntimeKernelModule,
  RuntimeKernelModuleContext,
} from '../runtime/runtimeKernel';

export interface OfflineRuntimeModuleOptions extends OfflineRuntimeOptions {
  readonly id?: string;
  readonly order?: number;
  readonly required?: boolean;
  readonly runtime?: OfflineRuntime;
}

export interface OfflineRuntimeModule {
  readonly module: RuntimeKernelModule;
  readonly runtime: OfflineRuntime;
  readonly snapshot: () => OfflineRuntimeModuleSnapshot;
  readonly dispose: () => Promise<void>;
}

export const createOfflineRuntimeModule = (
  options: OfflineRuntimeModuleOptions = {},
): OfflineRuntimeModule => {
  const runtime = options.runtime ?? createOfflineRuntime(options);
  let startCount = 0;
  let suspendCount = 0;
  let resumeCount = 0;
  let stopCount = 0;
  let disposed = false;

  const start = async (context: RuntimeKernelModuleContext): Promise<void> => {
    if (disposed) throw new Error('Offline runtime module is disposed.');
    if (context.signal.aborted) throw context.signal.reason;
    startCount += 1;
    const state = await runtime.start();
    context.telemetry.info('offline', 'runtime-start', {
      status: state.phase,
      result: state.phase === 'error' ? 'degraded' : 'success',
    });
    if (options.required === true && state.phase === 'error') {
      throw new Error('Required offline runtime failed to start.');
    }
  };

  const suspend = (): void => {
    if (disposed) return;
    suspendCount += 1;
    runtime.stop();
  };

  const resume = async (context: RuntimeKernelModuleContext): Promise<void> => {
    if (disposed) throw new Error('Offline runtime module is disposed.');
    if (context.signal.aborted) throw context.signal.reason;
    resumeCount += 1;
    await runtime.start();
  };

  const stop = (): void => {
    if (disposed) return;
    stopCount += 1;
    runtime.stop();
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };

  const snapshot = (): OfflineRuntimeModuleSnapshot => Object.freeze({
    phase: runtime.snapshot().phase,
    runtime: runtime.snapshot(),
    startCount,
    suspendCount,
    resumeCount,
    stopCount,
  });

  const module: RuntimeKernelModule = Object.freeze({
    id: options.id ?? 'offline-runtime',
    order: options.order ?? 70,
    required: options.required ?? false,
    start,
    ready: async () => {
      await runtime.refreshStatus();
    },
    suspend,
    resume,
    stop,
    dispose,
  });

  return Object.freeze({
    module,
    runtime,
    snapshot,
    dispose,
  });
};
