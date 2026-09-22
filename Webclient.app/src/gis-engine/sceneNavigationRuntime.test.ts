import { describe, expect, it, vi } from 'vitest';
import {
  createSceneNavigationRuntime,
  type SceneNavigationView,
} from './sceneNavigationRuntime';

const createView = (overrides: Partial<SceneNavigationView> = {}) => {
  const view: SceneNavigationView = {
    camera: {
      position: { longitude: 32.85, latitude: 39.93, z: 1_500 },
      heading: 15,
      tilt: 45,
    },
    scale: 25_000,
    stationary: true,
    destroyed: false,
    goTo: vi.fn(async (target: unknown) => {
      const value = target as Record<string, unknown>;
      const camera = value.camera as { position?: Record<string, unknown>; heading?: number; tilt?: number } | undefined;
      if (camera && view.camera) {
        if (camera.position) view.camera.position = { ...camera.position };
        if (camera.heading !== undefined) view.camera.heading = camera.heading;
        if (camera.tilt !== undefined) view.camera.tilt = camera.tilt;
      }
      if (Array.isArray(value.center) && value.center.length >= 2 && view.camera?.position) {
        view.camera.position.longitude = Number(value.center[0]);
        view.camera.position.latitude = Number(value.center[1]);
      }
      if (value.heading !== undefined && view.camera) view.camera.heading = Number(value.heading);
      if (value.tilt !== undefined && view.camera) view.camera.tilt = Number(value.tilt);
      if (value.scale !== undefined) view.scale = Number(value.scale);
    }),
    ...overrides,
  };
  return view;
};

describe('sceneNavigationRuntime', () => {
  it('captures the current 3d camera pose', () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    expect(runtime.capture()).toMatchObject({
      center: [32.85, 39.93],
      heading: 15,
      tilt: 45,
      scale: 25_000,
    });
  });

  it('normalizes heading, tilt and scale before navigation', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view, {
      minimumScale: 100,
      maximumScale: 1_000_000,
      minimumTilt: 0,
      maximumTilt: 80,
    });

    await expect(runtime.navigate({
      center: [33, 40],
      heading: -30,
      tilt: 120,
      scale: 20,
    })).resolves.toBe(true);

    expect(view.goTo).toHaveBeenCalledWith(expect.objectContaining({
      center: [33, 40],
      heading: 330,
      tilt: 80,
      scale: 100,
    }), expect.objectContaining({ animate: true }));
  });

  it('disables animation for reduced motion', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view, {
      reducedMotion: () => true,
      defaultDurationMs: 800,
    });
    await runtime.zoomBy(0.5);
    expect(view.goTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      animate: false,
      duration: 0,
      signal: expect.anything(),
    }));
  });

  it('zooms by a multiplicative scale factor', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    await expect(runtime.zoomBy(0.5)).resolves.toBe(true);
    expect(view.scale).toBe(12_500);
    await expect(runtime.zoomBy(2)).resolves.toBe(true);
    expect(view.scale).toBe(25_000);
  });

  it('rejects invalid zoom factors without moving', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    await expect(runtime.zoomBy(0)).resolves.toBe(false);
    await expect(runtime.zoomBy(-1)).resolves.toBe(false);
    await expect(runtime.zoomBy(1)).resolves.toBe(false);
    expect(view.goTo).not.toHaveBeenCalled();
  });

  it('rotates relative to the current heading with wrapping', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    await runtime.rotateBy(370);
    expect(view.camera?.heading).toBe(25);
    await runtime.rotateBy(-50);
    expect(view.camera?.heading).toBe(335);
  });

  it('clamps relative tilt to navigation limits', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view, { maximumTilt: 70 });
    await runtime.tiltBy(100);
    expect(view.camera?.tilt).toBe(70);
    await runtime.tiltBy(-200);
    expect(view.camera?.tilt).toBe(0);
  });

  it('resets heading to north while retaining the other pose values', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    await runtime.resetNorth();
    expect(view.camera?.heading).toBe(0);
    expect(view.camera?.tilt).toBe(45);
    expect(view.scale).toBe(25_000);
  });

  it('captures home and returns to it after movement', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    runtime.setHome();
    await runtime.navigate({ center: [31, 38], heading: 90, tilt: 20, scale: 8_000 });
    expect(runtime.capture().center).toEqual([31, 38]);

    await expect(runtime.goHome()).resolves.toBe(true);
    expect(runtime.capture()).toMatchObject({
      center: [32.85, 39.93],
      heading: 15,
      tilt: 45,
      scale: 25_000,
    });
  });

  it('keeps bounded navigation history', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view, { historyLimit: 3 });
    await runtime.navigate({ center: [30, 39], scale: 10_000 });
    await runtime.navigate({ center: [31, 39], scale: 9_000 });
    await runtime.navigate({ center: [32, 39], scale: 8_000 });
    await runtime.navigate({ center: [33, 39], scale: 7_000 });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.historyDepth).toBe(3);
    expect(snapshot.historyIndex).toBe(2);
    expect(snapshot.canGoBack).toBe(true);
    expect(snapshot.canGoForward).toBe(false);
  });

  it('navigates backward and forward without duplicating history', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    await runtime.navigate({ center: [31, 39], scale: 10_000 });
    await runtime.navigate({ center: [32, 39], scale: 8_000 });
    const depth = runtime.getSnapshot().historyDepth;

    await expect(runtime.back()).resolves.toBe(true);
    expect(runtime.capture().center).toEqual([31, 39]);
    expect(runtime.getSnapshot().historyDepth).toBe(depth);
    expect(runtime.getSnapshot().canGoForward).toBe(true);

    await expect(runtime.forward()).resolves.toBe(true);
    expect(runtime.capture().center).toEqual([32, 39]);
    expect(runtime.getSnapshot().historyDepth).toBe(depth);
  });

  it('drops forward history when a new branch of navigation starts', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    await runtime.navigate({ center: [31, 39], scale: 10_000 });
    await runtime.navigate({ center: [32, 39], scale: 8_000 });
    await runtime.back();
    expect(runtime.getSnapshot().canGoForward).toBe(true);

    await runtime.navigate({ center: [35, 40], scale: 6_000 });
    expect(runtime.getSnapshot().canGoForward).toBe(false);
    expect(runtime.capture().center).toEqual([35, 40]);
  });

  it('stores, replaces, navigates and removes scene bookmarks', async () => {
    const view = createView();
    let clock = 100;
    const runtime = createSceneNavigationRuntime(view, { now: () => clock++ });
    const bookmark = runtime.saveBookmark('ankara', 'Ankara Merkez');
    expect(bookmark).toMatchObject({ id: 'ankara', title: 'Ankara Merkez', createdAt: 100 });

    await runtime.navigate({ center: [29, 41], heading: 120, tilt: 35, scale: 12_000 });
    await expect(runtime.goToBookmark('ankara')).resolves.toBe(true);
    expect(runtime.capture().center).toEqual([32.85, 39.93]);

    runtime.saveBookmark('ankara', 'Yeni Ankara', { center: [32.9, 39.95], scale: 5_000 });
    expect(runtime.getSnapshot().bookmarks).toHaveLength(1);
    expect(runtime.getSnapshot().bookmarks[0]?.title).toBe('Yeni Ankara');
    expect(runtime.removeBookmark('ankara')).toBe(true);
    expect(runtime.removeBookmark('ankara')).toBe(false);
  });

  it('rejects empty bookmark identifiers', () => {
    const runtime = createSceneNavigationRuntime(createView());
    expect(() => runtime.saveBookmark('   ')).toThrow(/non-empty id/);
  });

  it('returns false for unknown bookmarks', async () => {
    const runtime = createSceneNavigationRuntime(createView());
    await expect(runtime.goToBookmark('missing')).resolves.toBe(false);
  });

  it('honors an already aborted navigation signal', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.navigate({ scale: 10_000 }, { signal: controller.signal })).resolves.toBe(false);
    expect(view.goTo).not.toHaveBeenCalled();
  });

  it('forwards caller cancellation into the ArcGIS goTo signal', async () => {
    const controller = new AbortController();
    let sdkSignal: AbortSignal | undefined;
    const view = createView({
      goTo: vi.fn(async (_target: unknown, options?: unknown) => {
        sdkSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
        return new Promise<void>((_resolve, reject) => {
          sdkSignal?.addEventListener('abort', () => {
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }),
    });
    const runtime = createSceneNavigationRuntime(view);
    const pending = runtime.navigate({ scale: 10_000 }, { signal: controller.signal });
    await Promise.resolve();
    expect(sdkSignal?.aborted).toBe(false);
    controller.abort('caller-cancelled');
    expect(sdkSignal?.aborted).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('aborts the previous SDK navigation when a newer move supersedes it', async () => {
    let callCount = 0;
    let firstSignal: AbortSignal | undefined;
    const view = createView({
      goTo: vi.fn(async (_target: unknown, options?: unknown) => {
        callCount += 1;
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        if (callCount !== 1) return;
        firstSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('superseded');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }),
    });
    const runtime = createSceneNavigationRuntime(view);
    const first = runtime.navigate({ center: [31, 39], scale: 10_000 });
    await Promise.resolve();
    const second = runtime.navigate({ center: [32, 39], scale: 8_000 });
    expect(firstSignal?.aborted).toBe(true);
    await expect(second).resolves.toBe(true);
    await expect(first).resolves.toBe(false);
  });

  it('treats ArcGIS AbortError as a cancelled move instead of a runtime failure', async () => {
    const view = createView({
      goTo: vi.fn(async () => {
        const error = new Error('interrupted');
        error.name = 'AbortError';
        throw error;
      }),
    });
    const onError = vi.fn();
    const runtime = createSceneNavigationRuntime(view, { onError });
    await expect(runtime.navigate({ scale: 10_000 })).resolves.toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('records non-cancellation navigation errors and notifies observers', async () => {
    const failure = new Error('camera failed');
    const view = createView({ goTo: vi.fn(async () => { throw failure; }) });
    const onError = vi.fn();
    const reasons: string[] = [];
    const runtime = createSceneNavigationRuntime(view, { onError });
    runtime.subscribe((_snapshot, reason) => reasons.push(reason));

    await expect(runtime.navigate({ scale: 10_000 }, { reason: 'inspection' })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(failure, 'scene-navigation-go-to');
    expect(runtime.getSnapshot().lastError).toBe(failure);
    expect(reasons).toContain('inspection');
  });

  it('isolates listener failures from navigation results', async () => {
    const view = createView();
    const onError = vi.fn();
    const runtime = createSceneNavigationRuntime(view, { onError });
    runtime.subscribe(() => { throw new Error('observer'); });

    await expect(runtime.zoomBy(0.5)).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'scene-navigation-listener');
  });

  it('becomes inert after disposal and releases local state', async () => {
    const view = createView();
    const runtime = createSceneNavigationRuntime(view);
    runtime.saveBookmark('saved');
    runtime.dispose();

    expect(runtime.getSnapshot().disposed).toBe(true);
    expect(runtime.getSnapshot().bookmarks).toHaveLength(0);
    expect(runtime.getSnapshot().historyDepth).toBe(0);
    await expect(runtime.navigate({ scale: 5_000 })).resolves.toBe(false);
  });

  it('requires a view with goTo support', () => {
    expect(() => createSceneNavigationRuntime({})).toThrow(/goTo/);
  });
});
