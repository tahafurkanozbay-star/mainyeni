import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetArcgisModuleRuntimeCache, setArcgisModuleTransport } from './arcgisModuleRuntime';
import {
  MEASUREMENT_TOOLS,
  clearMeasurementRuntimeCache,
  createMeasurementController,
  type MeasurementDiagnostic,
  type MeasurementRuntimeDiagnostics,
} from './measurementRuntime';

const loadModules = vi.fn();
const transport = { name: 'measurement-resilience-test', loadModules };

const readyMeasurement = (overrides: Record<string, unknown> = {}) => {
  const clear = vi.fn();
  const destroy = vi.fn();
  const widget = {
    activeTool: MEASUREMENT_TOOLS.NONE,
    clear,
    destroy,
    ...overrides,
  };
  const Measurement = vi.fn().mockImplementation((options) => Object.assign(widget, options));
  loadModules.mockResolvedValue([Measurement]);
  return { widget, Measurement, clear, destroy };
};

const diagnosticsOf = (controller: ReturnType<typeof createMeasurementController>): MeasurementRuntimeDiagnostics => {
  const diagnostics = controller.getDiagnostics?.();
  if (!diagnostics) throw new Error('Measurement runtime diagnostics are unavailable.');
  return diagnostics;
};

describe('measurementRuntime resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setArcgisModuleTransport(transport);
    resetArcgisModuleRuntimeCache();
    clearMeasurementRuntimeCache();
  });

  it('starts with bounded observer diagnostics', () => {
    const controller = createMeasurementController();

    expect(diagnosticsOf(controller)).toEqual({
      listenerCount: 0,
      rejectedListenerCount: 0,
      listenerFailureCount: 0,
      diagnosticReporterFailureCount: 0,
      lastFailurePhase: null,
      lastFailureKind: null,
      destroyed: false,
    });
    expect(Object.isFrozen(diagnosticsOf(controller))).toBe(true);
  });

  it('tracks listener cardinality on subscribe and unsubscribe', () => {
    const controller = createMeasurementController();
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = controller.subscribe(first);
    const unsubscribeSecond = controller.subscribe(second);

    expect(diagnosticsOf(controller).listenerCount).toBe(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    expect(unsubscribeFirst()).toBe(true);
    expect(diagnosticsOf(controller).listenerCount).toBe(1);
    expect(unsubscribeSecond()).toBe(true);
    expect(diagnosticsOf(controller).listenerCount).toBe(0);
  });

  it('makes unsubscribe idempotent', () => {
    const controller = createMeasurementController();
    const unsubscribe = controller.subscribe(vi.fn());

    expect(unsubscribe()).toBe(true);
    expect(unsubscribe()).toBe(false);
    expect(diagnosticsOf(controller).listenerCount).toBe(0);
  });

  it('bounds listener registration at the configured capacity', () => {
    const controller = createMeasurementController({ maxListeners: 2 });
    const first = vi.fn();
    const second = vi.fn();
    const rejected = vi.fn();

    controller.subscribe(first);
    controller.subscribe(second);
    const rejectedUnsubscribe = controller.subscribe(rejected);

    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 2,
      rejectedListenerCount: 1,
    }));
    expect(rejected).not.toHaveBeenCalled();
    expect(rejectedUnsubscribe()).toBe(false);
  });

  it('clamps listener capacity to at least one observer', () => {
    const controller = createMeasurementController({ maxListeners: 0 });
    const first = vi.fn();
    const second = vi.fn();

    controller.subscribe(first);
    controller.subscribe(second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 1,
      rejectedListenerCount: 1,
    }));
  });

  it('clamps excessive listener capacity instead of accepting an unbounded value', () => {
    const controller = createMeasurementController({ maxListeners: 10_000 });
    const listeners = Array.from({ length: 258 }, () => vi.fn());

    for (const listener of listeners) controller.subscribe(listener);

    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 256,
      rejectedListenerCount: 2,
    }));
    expect(listeners[255]).toHaveBeenCalledTimes(1);
    expect(listeners[256]).not.toHaveBeenCalled();
  });

  it('uses the default listener capacity for non-finite input', () => {
    const controller = createMeasurementController({ maxListeners: Number.NaN });
    const listeners = Array.from({ length: 65 }, () => vi.fn());

    for (const listener of listeners) controller.subscribe(listener);

    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 64,
      rejectedListenerCount: 1,
    }));
  });

  it('treats duplicate listener subscriptions as a single observer', () => {
    const controller = createMeasurementController({ maxListeners: 1 });
    const listener = vi.fn();

    const first = controller.subscribe(listener);
    const second = controller.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 1,
      rejectedListenerCount: 0,
    }));
    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });

  it('passes a state clone to the initial listener instead of exposing internal state', () => {
    const controller = createMeasurementController();
    const listener = vi.fn((state) => {
      state.status = 'destroyed';
      state.error = { code: 'MUTATED', message: 'mutated' };
    });

    controller.subscribe(listener);

    expect(controller.getState()).toEqual({
      status: 'idle',
      activeTool: MEASUREMENT_TOOLS.NONE,
      error: null,
      createdAt: null,
      clearedAt: null,
      destroyedAt: null,
    });
  });

  it('passes independent error objects to listeners', () => {
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    const observed: Array<{ code: string; message: string } | null> = [];
    controller.subscribe((state) => {
      if (state.error) {
        observed.push(state.error);
        state.error.code = 'CHANGED_BY_LISTENER';
      }
    });
    loadModules.mockRejectedValueOnce(Object.assign(new Error('sdk failed'), { code: 'SDK_FAILED' }));

    return controller.ensureWidget().catch(() => {
      expect(observed).toHaveLength(1);
      expect(controller.getState().error?.code).toBe('SDK_FAILED');
    });
  });

  it('contains a listener failure during the immediate subscription callback', () => {
    const diagnostic = vi.fn();
    const controller = createMeasurementController({ onDiagnostic: diagnostic });

    expect(() => controller.subscribe(() => {
      throw new TypeError('initial observer failed');
    })).not.toThrow();

    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 1,
      listenerFailureCount: 1,
      lastFailurePhase: 'listener',
      lastFailureKind: 'TypeError',
    }));
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'listener',
      message: 'initial observer failed',
    }));
  });

  it('keeps notifying healthy listeners after an earlier listener throws', async () => {
    readyMeasurement();
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    const broken = vi.fn(() => {
      throw new Error('observer failed');
    });
    const healthy = vi.fn();
    controller.subscribe(broken);
    controller.subscribe(healthy);
    broken.mockClear();
    healthy.mockClear();

    await controller.ensureWidget();

    expect(broken).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();
    expect(healthy.mock.calls.some(([state]) => state.status === 'ready')).toBe(true);
    expect(diagnosticsOf(controller).listenerFailureCount).toBeGreaterThanOrEqual(2);
  });

  it('contains a diagnostic reporter failure during listener error reporting', () => {
    const controller = createMeasurementController({
      onDiagnostic() {
        throw new RangeError('diagnostic reporter failed');
      },
    });

    expect(() => controller.subscribe(() => {
      throw new TypeError('observer failed');
    })).not.toThrow();

    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerFailureCount: 1,
      diagnosticReporterFailureCount: 1,
      lastFailurePhase: 'listener',
      lastFailureKind: 'reporter:RangeError',
    }));
  });

  it('does not let a failing reporter block healthy listeners', async () => {
    readyMeasurement();
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic() {
        throw new Error('reporter failed');
      },
    });
    const broken = vi.fn(() => {
      throw new Error('observer failed');
    });
    const healthy = vi.fn();
    controller.subscribe(broken);
    controller.subscribe(healthy);
    healthy.mockClear();

    await expect(controller.ensureWidget()).resolves.toEqual(expect.any(Object));
    expect(healthy.mock.calls.some(([state]) => state.status === 'ready')).toBe(true);
    expect(diagnosticsOf(controller).diagnosticReporterFailureCount).toBeGreaterThan(0);
  });

  it('preserves load error state even when the diagnostic reporter throws', async () => {
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic() {
        throw new Error('reporter failed');
      },
    });
    loadModules.mockRejectedValueOnce(Object.assign(new Error('sdk unavailable'), { code: 'SDK_UNAVAILABLE' }));

    await expect(controller.ensureWidget()).rejects.toThrow('sdk unavailable');

    expect(controller.getState()).toMatchObject({
      status: 'error',
      error: {
        code: 'SDK_UNAVAILABLE',
        message: 'sdk unavailable',
      },
    });
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      diagnosticReporterFailureCount: 1,
      lastFailurePhase: 'load',
      lastFailureKind: 'reporter:Error',
    }));
  });

  it('preserves the original unsupported-tool rejection when reporter code fails', async () => {
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic() {
        throw new Error('reporter failed');
      },
    });

    await expect(controller.setTool('volume')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEASUREMENT_TOOL',
      message: 'Unsupported measurement tool: volume',
    });
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      diagnosticReporterFailureCount: 1,
      lastFailurePhase: 'tool',
    }));
  });

  it('contains widget clear failures and still publishes a cleared state', async () => {
    const diagnostic = vi.fn();
    const { widget } = readyMeasurement({
      clear: vi.fn(() => {
        throw new Error('clear failed');
      }),
    });
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic: diagnostic,
    });
    await controller.setTool(MEASUREMENT_TOOLS.AREA);

    expect(() => controller.clear()).not.toThrow();

    expect(widget.activeTool).toBe(MEASUREMENT_TOOLS.AREA);
    expect(controller.getState()).toEqual(expect.objectContaining({
      activeTool: MEASUREMENT_TOOLS.NONE,
      clearedAt: expect.any(String),
    }));
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'clear',
      message: 'clear failed',
    }));
  });

  it('contains clear reporter failures as well', async () => {
    readyMeasurement({
      clear: vi.fn(() => {
        throw new Error('clear failed');
      }),
    });
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic() {
        throw new TypeError('reporter failed');
      },
    });
    await controller.ensureWidget();

    expect(controller.clear()).toBe(true);
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      diagnosticReporterFailureCount: 1,
      lastFailurePhase: 'clear',
      lastFailureKind: 'reporter:TypeError',
    }));
  });

  it('contains widget destroy failures and marks runtime diagnostics destroyed', async () => {
    const diagnostic = vi.fn();
    readyMeasurement({
      clear: vi.fn(),
      destroy: vi.fn(() => {
        throw new Error('destroy failed');
      }),
    });
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic: diagnostic,
    });
    await controller.ensureWidget();

    expect(() => controller.destroy()).not.toThrow();
    expect(controller.destroyed).toBe(true);
    expect(controller.getState().status).toBe('destroyed');
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 0,
      destroyed: true,
      lastFailurePhase: 'destroy',
      lastFailureKind: 'Error',
    }));
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ phase: 'destroy' }));
  });

  it('contains destroy reporter failures', async () => {
    readyMeasurement({
      clear: vi.fn(),
      destroy: vi.fn(() => {
        throw new Error('destroy failed');
      }),
    });
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic() {
        throw new RangeError('reporter failed');
      },
    });
    await controller.ensureWidget();

    controller.destroy();

    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      diagnosticReporterFailureCount: 1,
      lastFailurePhase: 'destroy',
      lastFailureKind: 'reporter:RangeError',
      destroyed: true,
    }));
  });

  it('rejects subscriptions after destroy without invoking them', () => {
    const controller = createMeasurementController();
    controller.destroy();
    const listener = vi.fn();

    const unsubscribe = controller.subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(unsubscribe()).toBe(false);
    expect(diagnosticsOf(controller)).toEqual(expect.objectContaining({
      listenerCount: 0,
      rejectedListenerCount: 1,
      destroyed: true,
    }));
  });

  it('clears all listener accounting on destroy', () => {
    const controller = createMeasurementController();
    controller.subscribe(vi.fn());
    controller.subscribe(vi.fn());
    expect(diagnosticsOf(controller).listenerCount).toBe(2);

    controller.destroy();

    expect(diagnosticsOf(controller).listenerCount).toBe(0);
  });

  it('does not notify listeners after destroy', async () => {
    readyMeasurement();
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.ensureWidget();
    listener.mockClear();

    controller.destroy();
    controller.clear();

    expect(listener).not.toHaveBeenCalled();
  });

  it('returns cloned state from getState', async () => {
    readyMeasurement();
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    await controller.ensureWidget();
    const first = controller.getState();
    first.status = 'destroyed';
    first.error = { code: 'LOCAL', message: 'local' };

    const second = controller.getState();
    expect(second.status).toBe('ready');
    expect(second.error).toBeNull();
    expect(second).not.toBe(first);
  });

  it('returns independent error objects from getState', async () => {
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    loadModules.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'LOAD_FAIL' }));
    await controller.ensureWidget().catch(() => undefined);
    const first = controller.getState();
    expect(first.error).not.toBeNull();
    first.error!.code = 'MUTATED';

    expect(controller.getState().error?.code).toBe('LOAD_FAIL');
  });

  it('keeps diagnostics snapshots immutable across later transitions', () => {
    const controller = createMeasurementController({ maxListeners: 1 });
    const initial = diagnosticsOf(controller);
    controller.subscribe(vi.fn());
    const subscribed = diagnosticsOf(controller);
    controller.subscribe(vi.fn());
    const rejected = diagnosticsOf(controller);

    expect(initial.listenerCount).toBe(0);
    expect(subscribed.listenerCount).toBe(1);
    expect(subscribed.rejectedListenerCount).toBe(0);
    expect(rejected.rejectedListenerCount).toBe(1);
    expect(initial).not.toBe(subscribed);
    expect(subscribed).not.toBe(rejected);
    expect(Object.isFrozen(rejected)).toBe(true);
  });

  it('reports listener failures with the original error object', () => {
    const error = new TypeError('observer failed');
    const diagnostic = vi.fn<(value: MeasurementDiagnostic) => void>();
    const controller = createMeasurementController({ onDiagnostic: diagnostic });

    controller.subscribe(() => {
      throw error;
    });

    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'listener',
      code: 'MEASUREMENT_ERROR',
      error,
    }));
  });

  it('retains normal measurement behavior when diagnostics are unused', async () => {
    const { widget } = readyMeasurement();
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });

    await controller.setTool('distance');
    expect(widget.activeTool).toBe(MEASUREMENT_TOOLS.DISTANCE);
    expect(controller.getState()).toEqual(expect.objectContaining({
      status: 'ready',
      activeTool: MEASUREMENT_TOOLS.DISTANCE,
      error: null,
    }));

    expect(controller.clear()).toBe(true);
    expect(controller.getState().activeTool).toBe(MEASUREMENT_TOOLS.NONE);
  });

  it('keeps module-load recovery working with runtime diagnostics enabled', async () => {
    const { Measurement } = readyMeasurement();
    loadModules
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce([Measurement]);
    const diagnostic = vi.fn();
    const controller = createMeasurementController({
      view: {},
      container: 'measurementDiv',
      onDiagnostic: diagnostic,
    });

    await expect(controller.ensureWidget()).rejects.toThrow('temporary outage');
    await expect(controller.ensureWidget()).resolves.toEqual(expect.any(Object));

    expect(controller.getState().status).toBe('ready');
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'load',
      message: 'temporary outage',
    }));
  });

  it('keeps healthy listener ordering deterministic', async () => {
    readyMeasurement();
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    const order: string[] = [];
    controller.subscribe((state) => order.push(`first:${state.status}`));
    controller.subscribe((state) => order.push(`second:${state.status}`));
    order.length = 0;

    await controller.ensureWidget();

    expect(order.slice(0, 4)).toEqual([
      'first:loading',
      'second:loading',
      'first:ready',
      'second:ready',
    ]);
  });

  it('continues deterministic ordering around a failed listener', async () => {
    readyMeasurement();
    const controller = createMeasurementController({ view: {}, container: 'measurementDiv' });
    const order: string[] = [];
    controller.subscribe((state) => order.push(`first:${state.status}`));
    controller.subscribe(() => {
      throw new Error('middle failed');
    });
    controller.subscribe((state) => order.push(`third:${state.status}`));
    order.length = 0;

    await controller.ensureWidget();

    expect(order).toEqual([
      'first:loading',
      'third:loading',
      'first:ready',
      'third:ready',
    ]);
  });
});
