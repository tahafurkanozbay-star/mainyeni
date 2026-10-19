import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  type ExperienceCommandDetail,
} from '../../experience/experienceRuntime';
import { ExperienceMapModeBridge } from './ExperienceMapModeBridge';

const harness = vi.hoisted(() => ({
  views: [] as Array<Record<string, any>>,
  containerAssignments: [] as unknown[],
  state: {
    mode: '2d',
    center: [32.85, 39.93],
    scale: 25_000,
    zoom: 12,
    rotation: 0,
    heading: 0,
    tilt: 0,
    extent: null,
    basemapId: 'osm',
  } as Record<string, any>,
  bridge: null as null | { getState: () => Record<string, any>; setState: (state: any) => void },
  createSceneView: vi.fn(),
  loadBasemapModule: vi.fn(),
  applyToMapView: vi.fn(),
  applyToSceneView: vi.fn(),
  resizeScene: vi.fn(),
  destroySceneView: vi.fn(),
  setSceneActive: vi.fn(),
  disposeSceneExperience: vi.fn(),
  disposeSceneNavigation: vi.fn(),
  setSceneHome: vi.fn(),
  bindSceneState: vi.fn(),
  osmBuildingsRuntime: { activate: vi.fn(async () => undefined), deactivate: vi.fn(), dispose: vi.fn() },
}));

vi.mock('../../Store/Managers/MapManager', () => ({
  default: {
    GetViewStateBridge: () => harness.bridge,
  },
}));

vi.mock('../../Toolbox/DebugHelper', () => ({
  DebugHelper: { Log: vi.fn() },
}));

vi.mock('../../gis-engine/viewRuntime', () => ({
  applyViewStateToMapView: harness.applyToMapView,
  snapshotMapViewState: (_view: unknown, previous: Record<string, unknown>) => ({
    ...previous,
    mode: '2d',
    center: [32.85, 39.93],
    scale: 25_000,
    zoom: 12,
    tilt: 0,
  }),
}));

vi.mock('../../gis-engine/sceneRuntime', () => ({
  applyViewStateToSceneView: harness.applyToSceneView,
  bindSceneState: harness.bindSceneState,
  createSceneView: harness.createSceneView,
  destroySceneView: harness.destroySceneView,
  snapshotSceneState: (_view: unknown, previous: Record<string, unknown>) => ({
    ...previous,
    mode: '3d',
    center: [32.85, 39.93],
    scale: 25_000,
    heading: 0,
    tilt: 48,
  }),
  synchronizeSceneViewSize: harness.resizeScene,
  waitForSceneContainer: vi.fn(async () => undefined),
}));

vi.mock('../../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModule: harness.loadBasemapModule,
  loadArcgisModules: vi.fn(async () => {
    class Basemap {
      id?: string;
      title?: string;
      baseLayers?: unknown[];
      load = vi.fn(async () => undefined);
      destroy = vi.fn();
      constructor(properties: Record<string, unknown>) {
        Object.assign(this, properties);
      }
    }
    class OpenStreetMapLayer {}
    return [Basemap, OpenStreetMapLayer];
  }),
}));

vi.mock('../../gis-engine/osm3DBuildingsRuntime', () => ({
  OSM3DBuildingsRuntime: vi.fn(() => harness.osmBuildingsRuntime),
}));

vi.mock('../../gis-engine/viewReadiness', () => ({
  waitForArcgisView: vi.fn(async () => undefined),
}));

vi.mock('../../gis-engine/sceneExperienceRuntime', () => ({
  createSceneExperienceRuntime: vi.fn(() => ({
    setActive: harness.setSceneActive,
    dispose: harness.disposeSceneExperience,
    getSnapshot: () => ({
      status: 'ready',
      profile: 'balanced',
      p95FrameMs: 0,
      recovery: { attempts: 0 },
    }),
    subscribe: (listener: (snapshot: unknown, reason: string) => void) => {
      listener({
        status: 'ready',
        profile: 'balanced',
        p95FrameMs: 0,
        recovery: { attempts: 0 },
      }, 'ready');
      return () => true;
    },
  })),
}));

vi.mock('../../gis-engine/sceneNavigationRuntime', () => ({
  createSceneNavigationRuntime: vi.fn(() => ({
    dispose: harness.disposeSceneNavigation,
    setHome: harness.setSceneHome,
    back: vi.fn(async () => true),
    forward: vi.fn(async () => true),
    goHome: vi.fn(async () => true),
    resetNorth: vi.fn(async () => true),
    rotateBy: vi.fn(async () => true),
    tiltBy: vi.fn(async () => true),
  })),
}));

vi.mock('../../experience/sceneCommandRuntime', () => ({
  executeSceneCommand: vi.fn(async () => true),
}));

vi.mock('./sceneControlsPlacementPolicy', () => ({
  chooseSceneControlsPlacement: () => ({ left: 0, top: 0, strategy: 'test' }),
}));

const mapView = {
  map: { id: 'shared-map', basemap: { id: 'osm' } },
  padding: {},
  destroyed: false,
  popup: {},
};

const dispatchMode = (mode: '2d' | '3d'): void => {
  const detail: ExperienceCommandDetail = {
    name: 'map-mode',
    mode,
    source: 'regression-test',
    timestamp: Date.now(),
  };
  window.dispatchEvent(new CustomEvent(EXPERIENCE_COMMAND_EVENT, { detail }));
};

describe('ExperienceMapModeBridge 2B/3B lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.osmBuildingsRuntime.activate.mockResolvedValue(undefined);
    harness.loadBasemapModule.mockImplementation(async () => ({
      fromId: (id: string) => ({ id, load: vi.fn(async () => undefined), destroy: vi.fn() }),
    }));
    mapView.map.basemap = { id: 'osm' };
    harness.views.length = 0;
    harness.containerAssignments.length = 0;
    harness.state = {
      mode: '2d',
      center: [32.85, 39.93],
      scale: 25_000,
      zoom: 12,
      rotation: 0,
      heading: 0,
      tilt: 0,
      extent: null,
      basemapId: 'osm',
    };
    harness.bridge = {
      getState: () => harness.state,
      setState: (state) => { harness.state = state; },
    };
    harness.createSceneView.mockImplementation(async (container: unknown, options: { map: unknown }) => {
      let currentContainer = container;
      const view: Record<string, any> = {
        map: options.map,
        ready: true,
        readyState: 'ready',
        destroyed: false,
        padding: {},
        camera: {
          position: { longitude: 32.85, latitude: 39.93 },
          heading: 0,
          tilt: 48,
        },
        when: vi.fn(async () => undefined),
        resize: harness.resizeScene,
        goTo: vi.fn(async () => undefined),
      };
      Object.defineProperty(view, 'container', {
        enumerable: true,
        get: () => currentContainer,
        set: (value: unknown) => {
          currentContainer = value;
          harness.containerAssignments.push(value);
          view.readyState = value === null ? 'missing-container' : 'ready';
        },
      });
      harness.views.push(view);
      return { map: options.map, view, ownsMap: false };
    });
    harness.applyToMapView.mockResolvedValue(true);
    harness.applyToSceneView.mockResolvedValue(true);
    harness.bindSceneState.mockReturnValue(() => undefined);
    harness.destroySceneView.mockImplementation((scene: Record<string, any>) => {
      const view = scene?.view ?? scene;
      if (view) {
        view.container = null;
        view.destroyed = true;
      }
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores the same 3B scene after a 3B → 2B → 3B round trip', async () => {
    const changedModes: string[] = [];
    const onModeChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ mode?: string; source?: string }>).detail;
      if (detail?.source?.startsWith('map-runtime') && detail.mode) changedModes.push(detail.mode);
    };
    window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChanged);

    const { container, unmount } = render(
      <div id="esri-map-container">
        <ExperienceMapModeBridge mapView={mapView} />
      </div>,
    );

    try {
      // The SceneView must initialize and become visible on the first load.
      await waitFor(() => expect(changedModes.filter((mode) => mode === '3d')).toHaveLength(1));
      expect((mapView.map.basemap as { id?: string }).id).toBe('openstreetmap-3d');
      expect(harness.bridge?.getState().basemapId).toBe('openstreetmap-3d');
      expect(harness.views).toHaveLength(1);
      const host = container.querySelector('.experience-scene-host');
      expect(host).not.toBeNull();
      expect(harness.views[0]?.container).toBe(host);
      await waitFor(() => expect(host).toHaveClass('is-active'));

      await act(async () => { dispatchMode('2d'); });
      await waitFor(() => expect(changedModes.filter((mode) => mode === '2d')).toHaveLength(1));
      expect((mapView.map.basemap as { id?: string }).id).toBe('osm');
      expect(harness.bridge?.getState().basemapId).toBe('osm');

      await act(async () => { dispatchMode('3d'); });
      await waitFor(() => expect(changedModes.filter((mode) => mode === '3d')).toHaveLength(2));
      expect((mapView.map.basemap as { id?: string }).id).toBe('openstreetmap-3d');

      // Keep the same WebGL host attached across 3B → 2B → 3B transitions.
      // Setting container=null can strand SceneView's renderer on a blank frame.
      expect(harness.views).toHaveLength(1);
      expect(harness.containerAssignments.filter((value) => value === null)).toHaveLength(0);
      expect(harness.views[0]?.container).toBe(host);
      await waitFor(() => expect(host).toHaveClass('is-active'));
      expect(container.querySelector('.experience-scene-controls')).toBeNull();
      expect(harness.resizeScene).toHaveBeenCalled();
      expect(harness.applyToSceneView).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChanged);
      unmount();
    }
  });
});
