import { describe, expect, it, vi } from 'vitest';
import { createRuntimeControlPlane } from './runtimeControlPlane';
import { createRuntimeControlPlaneModule } from './runtimeControlPlaneModule';
import { createRuntimeKernel } from './runtimeKernel';

describe('runtimeControlPlaneModule kernel integration', () => {
  it('starts control plane as a required runtime kernel module', async () => {
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined });
    const kernel = createRuntimeKernel();
    kernel.registerModule(createRuntimeControlPlaneModule(plane));

    const snapshot = await kernel.start({ warmup: false });
    expect(snapshot.phase).toBe('ready');
    expect(plane.phase()).toBe('running');

    await kernel.stop({ drain: false });
    expect(plane.phase()).toBe('stopped');
    await kernel.dispose();
  });

  it('waits for strict ready status when degraded readiness is disabled', async () => {
    const plane = createRuntimeControlPlane({
      readiness: { stableSamples: 1, defaultTimeoutMs: 0 },
      health: { componentId: 'runtime-health', healthPolicy: { minimumSamples: 10 } },
    });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined });
    await plane.start();
    plane.recordHealth({ at: 1, kind: 'pressure', severity: 'warning', code: 'pressure' });

    const module = createRuntimeControlPlaneModule(plane, {
      allowDegradedReadiness: false,
      readinessTimeoutMs: 1,
    });
    const context = {
      signal: new AbortController().signal,
      telemetry: { info: vi.fn(), warn: vi.fn() },
      kernel: { phase: () => 'starting' },
    } as never;

    await expect(module.ready?.(context)).rejects.toMatchObject({ name: 'TimeoutError' });
    await plane.dispose();
  });

  it('can keep an externally owned control plane alive after module disposal', async () => {
    const plane = createRuntimeControlPlane();
    const module = createRuntimeControlPlaneModule(plane, { disposeControlPlane: false });
    await module.dispose?.();
    expect(plane.phase()).toBe('idle');
    expect(() => plane.snapshot()).not.toThrow();
    await plane.dispose();
  });

  it('can opt out of stopping the control plane during kernel stop hook', async () => {
    const plane = createRuntimeControlPlane({ readiness: { stableSamples: 1, defaultTimeoutMs: 0 } });
    plane.register({ id: 'config', criticality: 'critical', start: () => undefined, stop: () => undefined });
    await plane.start();
    const module = createRuntimeControlPlaneModule(plane, { stopOnKernelStop: false, disposeControlPlane: false });
    const context = {
      signal: new AbortController().signal,
      telemetry: { info: vi.fn(), warn: vi.fn() },
      kernel: { phase: () => 'stopping' },
    } as never;
    await module.stop?.(context);
    expect(plane.phase()).toBe('running');
    await plane.dispose();
  });

  it('validates module ids before kernel registration', () => {
    const plane = createRuntimeControlPlane();
    expect(() => createRuntimeControlPlaneModule(plane, { id: 'bad id!' })).toThrow('unsupported');
  });
});
