import type {
  RuntimeKernelModule,
  RuntimeKernelModuleContext,
} from './runtimeKernel';
import type { RuntimeControlPlane } from './runtimeControlPlane';

export interface RuntimeControlPlaneModuleOptions {
  readonly id?: string;
  readonly order?: number;
  readonly required?: boolean;
  readonly readinessTimeoutMs?: number;
  readonly allowDegradedReadiness?: boolean;
  readonly stopOnKernelStop?: boolean;
  readonly disposeControlPlane?: boolean;
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

const normalizeModuleId = (value: unknown): string => {
  if (typeof value !== 'string') return 'runtime-control-plane';
  const normalized = value.trim();
  if (!normalized) return 'runtime-control-plane';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new TypeError('Runtime control-plane module id contains unsupported characters.');
  }
  return normalized.slice(0, 100);
};

const telemetry = (
  context: RuntimeKernelModuleContext,
  level: 'info' | 'warn',
  name: string,
  result: string,
): void => {
  try {
    context.telemetry[level]('control-plane', name, {
      result,
      phase: context.kernel.phase(),
    });
  } catch {
    // Kernel telemetry must never change lifecycle semantics.
  }
};

export const createRuntimeControlPlaneModule = (
  controlPlane: RuntimeControlPlane,
  options: RuntimeControlPlaneModuleOptions = {},
): RuntimeKernelModule => {
  if (!controlPlane || typeof controlPlane.start !== 'function') {
    throw new TypeError('Runtime control plane is required.');
  }
  const id = normalizeModuleId(options.id);
  const readinessTimeoutMs = boundedInteger(options.readinessTimeoutMs, 15_000, 0, 10 * 60_000);
  const allowDegradedReadiness = options.allowDegradedReadiness !== false;
  const stopOnKernelStop = options.stopOnKernelStop !== false;
  const disposeControlPlane = options.disposeControlPlane !== false;

  return Object.freeze({
    id,
    order: Number.isFinite(options.order) ? Number(options.order) : 40,
    required: options.required !== false,
    start: async (context: RuntimeKernelModuleContext) => {
      telemetry(context, 'info', 'start', 'pending');
      await controlPlane.start(context.signal);
      telemetry(context, 'info', 'start', controlPlane.phase());
    },
    ready: async (context: RuntimeKernelModuleContext) => {
      try {
        await controlPlane.waitUntilReady({
          signal: context.signal,
          timeoutMs: readinessTimeoutMs,
          allowDegraded: allowDegradedReadiness,
        });
        telemetry(context, 'info', 'ready', 'ready');
      } catch (error) {
        telemetry(context, 'warn', 'ready', 'not-ready');
        throw error;
      }
    },
    stop: async (context: RuntimeKernelModuleContext) => {
      if (!stopOnKernelStop) return;
      telemetry(context, 'info', 'stop', 'pending');
      await controlPlane.stop(context.signal);
      telemetry(context, 'info', 'stop', controlPlane.phase());
    },
    dispose: async () => {
      if (disposeControlPlane) await controlPlane.dispose();
    },
  });
};
