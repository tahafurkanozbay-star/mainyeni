import { describe, expect, it, vi } from 'vitest';
import type { SceneNavigationRuntime } from '../gis-engine/sceneNavigationRuntime';
import { executeSceneCommand } from './sceneCommandRuntime';

const createNavigation = (): SceneNavigationRuntime => ({
  capture: vi.fn(() => ({})),
  navigate: vi.fn(async () => true),
  zoomBy: vi.fn(async () => true),
  rotateBy: vi.fn(async () => true),
  tiltBy: vi.fn(async () => true),
  resetNorth: vi.fn(async () => true),
  setHome: vi.fn(() => ({})),
  goHome: vi.fn(async () => true),
  back: vi.fn(async () => true),
  forward: vi.fn(async () => true),
  saveBookmark: vi.fn(() => ({ id: 'bookmark', title: 'bookmark', pose: {}, createdAt: 0 })),
  removeBookmark: vi.fn(() => true),
  goToBookmark: vi.fn(async () => true),
  getSnapshot: vi.fn(() => ({
    disposed: false,
    moving: false,
    sequence: 0,
    pose: {},
    historyDepth: 0,
    historyIndex: -1,
    canGoBack: false,
    canGoForward: false,
    bookmarks: [],
    lastError: null,
  })),
  subscribe: vi.fn(() => () => true),
  dispose: vi.fn(),
});

describe('sceneCommandRuntime', () => {
  it('routes home through the navigation runtime', async () => {
    const navigation = createNavigation();
    await expect(executeSceneCommand({ name: 'map-home' }, {
      navigation,
      focusMap: () => false,
      reducedMotion: () => false,
    })).resolves.toBe(true);

    expect(navigation.goHome).toHaveBeenCalledWith(expect.objectContaining({
      animate: true,
      durationMs: 220,
      reason: 'command-home',
    }));
  });

  it('routes zoom commands with bounded factors', async () => {
    const navigation = createNavigation();
    const context = { navigation, focusMap: () => false, reducedMotion: () => false };

    await executeSceneCommand({ name: 'map-zoom-in' }, context);
    await executeSceneCommand({ name: 'map-zoom-out' }, context);

    expect(navigation.zoomBy).toHaveBeenNthCalledWith(1, 0.5, expect.objectContaining({ reason: 'command-zoom-in' }));
    expect(navigation.zoomBy).toHaveBeenNthCalledWith(2, 2, expect.objectContaining({ reason: 'command-zoom-out' }));
  });

  it('disables animation when reduced motion is requested', async () => {
    const navigation = createNavigation();
    await executeSceneCommand({ name: 'map-home' }, {
      navigation,
      focusMap: () => false,
      reducedMotion: () => true,
      durationMs: 900,
    });

    expect(navigation.goHome).toHaveBeenCalledWith(expect.objectContaining({
      animate: false,
      durationMs: 0,
    }));
  });

  it('delegates focus-map without starting navigation', async () => {
    const navigation = createNavigation();
    const focusMap = vi.fn(() => true);

    await expect(executeSceneCommand({ name: 'focus-map' }, {
      navigation,
      focusMap,
    })).resolves.toBe(true);

    expect(focusMap).toHaveBeenCalledOnce();
    expect(navigation.goHome).not.toHaveBeenCalled();
    expect(navigation.zoomBy).not.toHaveBeenCalled();
  });

  it('ignores commands that are not owned by the scene runtime', async () => {
    const navigation = createNavigation();
    await expect(executeSceneCommand({ name: 'layers' }, {
      navigation,
      focusMap: () => false,
    })).resolves.toBe(false);
  });
});
