import { describe, expect, it } from 'vitest';
import { ViewStateTransitionCoordinator, type UnifiedViewState } from './viewStateTransitionCoordinator';

const sr = { wkid: 3857, latestWkid: 3857 };
const state2d = (x = 10, y = 20): UnifiedViewState => ({
  mode: '2d',
  center: { x, y, spatialReference: sr },
  scale: 5_000,
  rotation: 0,
});
const state3d = (x = 10, y = 20): UnifiedViewState => ({
  mode: '3d',
  camera: { position: { x, y, z: 500, spatialReference: sr }, heading: 0, tilt: 45 },
  scale: 5_000,
});

describe('ViewStateTransitionCoordinator', () => {
  it('seeds immutable normalized state', () => {
    const coordinator = new ViewStateTransitionCoordinator();
    const state = coordinator.seed({ ...state2d(), rotation: 370 });
    expect(state.mode).toBe('2d');
    if (state.mode === '2d') expect(state.rotation).toBe(10);
    expect(Object.isFrozen(state)).toBe(true);
    expect(coordinator.snapshot().historySize).toBe(1);
  });

  it('transitions between 2D and 3D while preserving executor ownership', async () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d());
    const result = await coordinator.transition({ target: state3d(), intent: 'user' }, async (context) => {
      expect(context.from?.mode).toBe('2d');
      expect(context.target.mode).toBe('3d');
      expect(context.intent).toBe('user');
      return context.target;
    });
    expect(result.stale).toBe(false);
    expect(result.state.mode).toBe('3d');
    expect(coordinator.snapshot().completed).toBe(1);
  });

  it('forces zero duration for reduced-motion transitions', async () => {
    const coordinator = new ViewStateTransitionCoordinator({ defaultDurationMs: 500 });
    coordinator.seed(state2d());
    await coordinator.transition({ target: state3d(), reducedMotion: true }, async (context) => {
      expect(context.durationMs).toBe(0);
      return context.target;
    });
  });

  it('caps transition duration to the configured maximum', async () => {
    const coordinator = new ViewStateTransitionCoordinator({ maxDurationMs: 800, defaultDurationMs: 200 });
    coordinator.seed(state2d());
    await coordinator.transition({ target: state3d(), durationMs: 5_000 }, async (context) => {
      expect(context.durationMs).toBe(800);
      return context.target;
    });
  });

  it('cancels superseded work and suppresses stale completion', async () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d());
    let releaseFirst: ((state: UnifiedViewState) => void) | undefined;
    const first = coordinator.transition({ target: state3d(100, 100) }, (context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve(context.target), { once: true });
      releaseFirst = resolve;
    }));
    const second = coordinator.transition({ target: state3d(200, 200) }, async (context) => context.target);
    const secondResult = await second;
    releaseFirst?.(state3d(100, 100));
    const firstResult = await first;
    expect(secondResult.stale).toBe(false);
    expect(firstResult.stale).toBe(true);
    expect(coordinator.snapshot().cancelled).toBeGreaterThanOrEqual(1);
    expect(coordinator.snapshot().staleCompletions).toBeGreaterThanOrEqual(1);
  });

  it('propagates caller cancellation', async () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d());
    const controller = new AbortController();
    const promise = coordinator.transition({ target: state3d(), signal: controller.signal }, (context) => new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      void resolve;
    }));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.snapshot().cancelled).toBe(1);
  });

  it('keeps bounded back-forward history', async () => {
    const coordinator = new ViewStateTransitionCoordinator({ maxHistory: 3 });
    coordinator.seed(state2d(0, 0));
    for (const x of [1, 2, 3, 4]) {
      await coordinator.transition({ target: state2d(x, 0) }, async (context) => context.target);
    }
    expect(coordinator.snapshot().historySize).toBe(3);
    expect(coordinator.historyBack()).toMatchObject({ mode: '2d' });
    expect(coordinator.historyBack()).toMatchObject({ mode: '2d' });
    expect(coordinator.historyBack()).toBeUndefined();
    expect(coordinator.canGoForward()).toBe(true);
  });

  it('truncates forward history after divergent navigation', async () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d(0, 0));
    await coordinator.transition({ target: state2d(1, 0) }, async (context) => context.target);
    await coordinator.transition({ target: state2d(2, 0) }, async (context) => context.target);
    coordinator.historyBack();
    await coordinator.transition({ target: state2d(9, 0) }, async (context) => context.target);
    expect(coordinator.canGoForward()).toBe(false);
    expect(coordinator.snapshot().historySize).toBe(3);
  });

  it('deduplicates identical consecutive history states', async () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d());
    await coordinator.transition({ target: state2d() }, async (context) => context.target);
    expect(coordinator.snapshot().historySize).toBe(1);
  });

  it('normalizes heading and validates tilt', () => {
    const coordinator = new ViewStateTransitionCoordinator();
    const seeded = coordinator.seed({
      mode: '3d',
      camera: { position: { x: 1, y: 2, z: 3, spatialReference: sr }, heading: -10, tilt: 60 },
      scale: 100,
    });
    if (seeded.mode === '3d') expect(seeded.camera.heading).toBe(350);
    expect(() => coordinator.seed({
      mode: '3d',
      camera: { position: { x: 1, y: 2, spatialReference: sr }, heading: 0, tilt: 181 },
      scale: 100,
    })).toThrow('tilt');
  });

  it('fails closed on malformed spatial references and coordinates', () => {
    const coordinator = new ViewStateTransitionCoordinator({ coordinateLimit: 1_000 });
    expect(() => coordinator.seed({
      mode: '2d', center: { x: 2_000, y: 0, spatialReference: sr }, scale: 100, rotation: 0,
    })).toThrow('coordinate');
    expect(() => coordinator.seed({
      mode: '2d', center: { x: 0, y: 0, spatialReference: {} }, scale: 100, rotation: 0,
    })).toThrow('spatial reference');
    expect(() => coordinator.seed({ ...state2d(), scale: 0 })).toThrow('scale');
  });

  it('records executor failures without mutating current state', async () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d());
    await expect(coordinator.transition({ target: state3d() }, async () => {
      throw new Error('executor failed');
    })).rejects.toThrow('executor failed');
    expect(coordinator.snapshot().current?.mode).toBe('2d');
    expect(coordinator.snapshot().failed).toBe(1);
  });

  it('fails closed after idempotent disposal', () => {
    const coordinator = new ViewStateTransitionCoordinator();
    coordinator.seed(state2d());
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.seed(state2d())).toThrow('disposed');
    expect(coordinator.snapshot().historySize).toBe(0);
  });
});
