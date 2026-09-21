import { describe, expect, it, vi } from 'vitest';
import {
  createSceneSupervisionRuntime,
  type SceneSupervisionView,
} from './sceneSupervisionRuntime';

const createView = () => {
  const watchers = new Map<string, (value?: unknown, oldValue?: unknown) => void>();
  const removed = vi.fn();
  const goTo = vi.fn(async () => undefined);
  const tryFatalErrorRecovery = vi.fn(async () => undefined);
  const view: SceneSupervisionView = {
    camera: {
      position: { longitude: 32.85, latitude: 39.93 },
      heading: 25,
      tilt: 45,
    },
    scale: 25_000,
    environment: {
      atmosphereEnabled: true,
      starsEnabled: false,
      lighting: {
        directShadowsEnabled: false,
        cameraTrackingEnabled: false,
      },
    },
    goTo,
    tryFatalErrorRecovery,
    fatalError: null,
    watch: (property, callback) => {
      watchers.set(property, callback);
      return { remove: removed };
    },
  };
  return { view, watchers, removed, goTo, tryFatalErrorRecovery };
};

describe('sceneSupervisionRuntime', () => {
  it('owns experience and navigation under one active lifecycle', () => {
    const { view } = createView();
    const runtime = createSceneSupervisionRuntime(view, {
      experience: {
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
      },
    });

    expect(runtime.getSnapshot().active).toBe(false);
    expect(runtime.setActive(true).experience.active).toBe(true);
    expect(runtime.setActive(false).experience.active).toBe(false);

    runtime.dispose();
    expect(runtime.getSnapshot().disposed).toBe(true);
  });

  it('automatically recovers observed fatal SceneView errors', async () => {
    const { view, watchers, tryFatalErrorRecovery } = createView();
    tryFatalErrorRecovery.mockImplementation(async () => {
      view.fatalError = null;
    });

    const runtime = createSceneSupervisionRuntime(view, {
      experience: {
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
        recoveryCooldownMs: 250,
      },
    });

    const fatal = new Error('webgl context lost');
    view.fatalError = fatal;
    watchers.get('fatalError')?.(fatal);

    await vi.waitFor(() => {
      expect(tryFatalErrorRecovery).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().recoveryPending).toBe(false);
    });
    expect(runtime.getSnapshot().fatalError).toBeNull();
    expect(runtime.getSnapshot().experience.recovery.successes).toBe(1);

    runtime.dispose();
  });

  it('deduplicates concurrent manual recovery requests', async () => {
    const { view, tryFatalErrorRecovery } = createView();
    let release!: () => void;
    tryFatalErrorRecovery.mockImplementation(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    view.fatalError = new Error('gpu-reset');

    const runtime = createSceneSupervisionRuntime(view, {
      autoRecoverFatalErrors: false,
      experience: {
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
        recoveryCooldownMs: 250,
      },
    });

    const first = runtime.recoverFatalError('manual');
    const second = runtime.recoverFatalError('manual');
    expect(tryFatalErrorRecovery).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    runtime.dispose();
  });

  it('exposes bounded scene navigation through the supervised runtime', async () => {
    const { view, goTo } = createView();
    const runtime = createSceneSupervisionRuntime(view, {
      experience: {
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
      },
      navigation: {
        reducedMotion: () => true,
      },
    });

    await expect(runtime.navigation.resetNorth()).resolves.toBe(true);
    expect(goTo).toHaveBeenCalledWith(
      expect.objectContaining({ heading: 0 }),
      expect.objectContaining({ animate: false, duration: 0 }),
    );

    runtime.dispose();
  });

  it('removes fatal-error observers and disposes idempotently', () => {
    const { view, removed } = createView();
    const runtime = createSceneSupervisionRuntime(view, {
      experience: {
        requestFrame: () => 1,
        cancelFrame: vi.fn(),
      },
    });

    runtime.dispose();
    runtime.dispose();
    expect(removed).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().disposed).toBe(true);
  });
});
