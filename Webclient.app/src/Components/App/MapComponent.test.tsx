import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Store from '../../Store/Store';
import { MapReducer_ActionTypes } from '../../Store/Reducers/MapReducer';
import { createWindowManager } from '../../Store/Managers/WindowManager';
import { MapComponent } from './MapComponent';

const runtime = vi.hoisted(() => ({
  load: vi.fn(), destroy: vi.fn(), remove: vi.fn(),
  views: [] as Array<Record<string, unknown>>,
  mapOptions: [] as unknown[],
  clickEvents: [] as Array<Record<string, unknown>>,
  addedLayers: [] as unknown[],
  graphics: [] as Array<Record<string, unknown>>,
  goToCalls: [] as Array<Record<string, unknown>>,
  navigationProps: null as Record<string, unknown> | null,
  create: vi.fn(),
}));
vi.mock('../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: runtime.load }));
vi.mock('../../Store/Managers/MapManager', () => ({ default: {
  GetMapConfiguration: () => ({}), SetViewStateBridge: vi.fn(), SetViewPerformanceMonitor: vi.fn(),
  ClearViewPerformanceMonitor: vi.fn(), ClearViewStateBridge: vi.fn(),
  GetMapView: () => runtime.views[0] ?? null,
  GetActiveMapView: () => runtime.views[0] ?? null,
  SetActiveMapView: vi.fn(),
  SetMapClickEvent: (event: Record<string, unknown>) => runtime.clickEvents.push(event),
  GetMobileRightClick: () => false,
} }));
vi.mock('../../gis-engine/viewRuntime', () => ({
  bindMapViewState: () => vi.fn(), createMapViewOptions: (options: unknown) => options,
  createResponsivePadding: () => ({}), createViewPerformanceMonitor: () => ({ dispose: vi.fn() }),
}));
vi.mock('./NavigationBar', () => ({ NavigationBar: (props: Record<string, unknown>) => {
  runtime.navigationProps = props;
  return <header>Harita menüsü</header>;
} }));
vi.mock('./SidebarModern', () => ({ SidebarModern: () => <aside>Hizmetler hazır</aside> }));
vi.mock('../Widget/Toolbar/ToolbarWidgetModern', () => ({ ToolbarWidgetModern: () => <div>Araçlar hazır</div> }));
vi.mock('./ExperienceMapModeBridge', () => ({ ExperienceMapModeBridge: () => null }));
vi.mock('./KentRehberiDataLayer', () => ({
  KentRehberiDataLayer: () => <div data-testid="all-city-overview-layer" />,
}));
vi.mock('../Common/QueryWindowRegistry', () => ({ QUERY_WINDOW_DEFINITIONS: [] }));
vi.mock('../Common/WidgetWindowRegistry', () => ({ WIDGET_WINDOW_DEFINITIONS: [] }));
const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (value: unknown) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const setup = (strict = false) => {
  const manager = createWindowManager();
  const component = <MapComponent windowManager={manager} />;
  const result = render(strict ? <StrictMode>{component}</StrictMode> : component);
  return { ...result, manager };
};
beforeEach(() => {
  vi.clearAllMocks();
  runtime.views.length = 0;
  runtime.mapOptions.length = 0;
  runtime.clickEvents.length = 0;
  runtime.addedLayers.length = 0;
  runtime.graphics.length = 0;
  runtime.goToCalls.length = 0;
  runtime.navigationProps = null;
  Store.dispatch({ type: MapReducer_ActionTypes.SetMapView, payload: null });
  runtime.create.mockImplementation(() => ({ ready: true, readyState: 'ready' }));
  runtime.load.mockImplementation(async (moduleIds?: string[]) => {
    if (moduleIds?.[0] === 'esri/layers/GraphicsLayer') {
      class GraphicsLayer {
        readonly options: unknown;
        constructor(options: unknown) { this.options = options; }
        add = vi.fn();
        removeAll = vi.fn();
      }
      class Graphic {
        constructor(options: Record<string, unknown>) { runtime.graphics.push(options); }
      }
      return [GraphicsLayer, Graphic];
    }
    return [
      class Map {
        add = vi.fn((layer: unknown) => { runtime.addedLayers.push(layer); });
        remove = vi.fn();
        constructor(options: unknown) { runtime.mapOptions.push(options); }
      },
      class MapView {
        constructor(options: { map: unknown; container: HTMLElement }) {
          const view = {
            map: options.map,
            container: options.container,
            popup: {},
            destroy: runtime.destroy,
            toMap: vi.fn(({ x, y }: { x: number; y: number }) => ({ x, y, longitude: -77, latitude: 38 })),
            goTo: vi.fn((target: unknown, options?: unknown) => { runtime.goToCalls.push({ target, options }); }),
            ...runtime.create(),
          };
          runtime.views.push(view); return view;
        }
      },
      { watch: () => ({ remove: runtime.remove }), whenTrue: () => ({ remove: runtime.remove }), whenFalse: () => ({ remove: runtime.remove }) },
    ];
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('free OpenStreetMap 3D readiness', () => {
  it('keeps the 2D OpenStreetMap basemap without requiring Esri World Elevation credentials', async () => {
    setup();
    await screen.findByText('Araçlar hazır');
    expect(runtime.mapOptions[0]).toMatchObject({ basemap: 'osm' });
    expect(runtime.mapOptions[0]).not.toHaveProperty('ground');
  });
});

describe('global address search map selection', () => {
  it('adds a pin to the active map and zooms to the selected address', async () => {
    setup();
    await screen.findByText('Araçlar hazır');
    const navigation = runtime.navigationProps as {
      onAddressSelect: (result: {
        displayName: string;
        latitude: number;
        longitude: number;
        zoom: number;
      }, signal: AbortSignal) => Promise<void>;
    };
    const result = {
      displayName: 'Kızılay Meydanı, Çankaya, Ankara, Türkiye',
      latitude: 39.9209,
      longitude: 32.8542,
      zoom: 17,
      attribution: '© OpenStreetMap katkıcıları' as const,
      attributionUrl: 'https://www.openstreetmap.org/copyright' as const,
    };

    await act(async () => {
      await navigation.onAddressSelect(result, new AbortController().signal);
    });

    expect(runtime.addedLayers).toHaveLength(1);
    expect(runtime.graphics).toHaveLength(1);
    expect(runtime.graphics[0]).toMatchObject({
      geometry: { type: 'point', longitude: 32.8542, latitude: 39.9209 },
      symbol: { type: 'simple-marker', style: 'path', color: '#c62828' },
      attributes: { address: 'Kızılay Meydanı, Çankaya, Ankara, Türkiye' },
    });
    expect(runtime.goToCalls).toContainEqual({
      target: { center: [32.8542, 39.9209], zoom: 17 },
      options: { duration: 650 },
    });
  });
});

describe('SVG overview markers', () => {
  it('loads the all-city point layer on initial map startup, even when the old opt-in flag is false', async () => {
    vi.stubEnv('VITE_KENT_REHBERI_OVERVIEW_ON_STARTUP', 'false');
    setup();
    await screen.findByText('Araçlar hazır');
    expect(screen.getByTestId('all-city-overview-layer')).toBeInTheDocument();
  });
});

describe('real map workspace admission and recovery', () => {
  it('publishes interactive tools only after the SDK view is ready', async () => {
    const ready = deferred(); runtime.create.mockReturnValue({ ready: false, when: () => ready.promise });
    setup();
    await waitFor(() => expect(runtime.views).toHaveLength(1));
    expect(screen.queryByText('Araçlar hazır')).toBeNull();
    expect(Store.getState().Map.MapView).toBeNull();
    expect(document.getElementById('esri-map-container')).toHaveAttribute('data-workspace-phase', 'booting');
    await act(async () => { ready.resolve(); });
    expect(screen.getByText('Araçlar hazır')).toBeVisible();
    expect(Store.getState().Map.MapView).toBe(runtime.views[0]);
    expect(document.getElementById('esri-map-container')).toHaveAttribute('data-workspace-phase', 'ready');
  });
  it('isolates the ArcGIS canvas from the 3D scene and UI overlays', async () => {
    setup();
    await screen.findByText('Araçlar hazır');

    const root = document.getElementById('esri-map-container');
    const canvasHost = root?.querySelector('.experience-mapview-host') as HTMLElement | null;
    const status = root?.querySelector('.map-workspace-status');

    expect(root).not.toBeNull();
    expect(canvasHost).not.toBeNull();
    expect(canvasHost?.parentElement).toBe(root);
    expect((Store.getState().Map.MapView as unknown as { container?: HTMLElement })?.container).toBe(canvasHost);
    expect(status?.parentElement).toBe(root);
    expect(canvasHost?.contains(status as Node)).toBe(false);
  });
  it('opens point identification from a native right-click on the visible map', async () => {
    const { manager } = setup();
    const showWindow = vi.spyOn(manager, 'ShowWindow');
    await screen.findByText('Araçlar hazır');

    const mapHost = document.querySelector('.experience-mapview-host');
    expect(mapHost).not.toBeNull();
    fireEvent.contextMenu(mapHost as HTMLElement, { button: 2, clientX: 110, clientY: 130 });

    expect(showWindow).toHaveBeenCalledWith('global-identify-widget');
    expect(runtime.clickEvents).toHaveLength(1);
    expect(runtime.clickEvents[0]).toMatchObject({
      x: 110,
      y: 130,
      mapPoint: { x: 110, y: 130, longitude: -77, latitude: 38 },
    });
    expect(showWindow).not.toHaveBeenCalledWith('context-menu-widget');
  });

  it('disposes a failed view immediately and recovers without refreshing the page', async () => {
    const ready = deferred(); runtime.create.mockReturnValueOnce({ when: () => ready.promise });
    setup(); await waitFor(() => expect(runtime.views).toHaveLength(1));
    await act(async () => { ready.reject(new Error('SDK initialization failed')); });
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(Store.getState().Map.MapView).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    await screen.findByText('Araçlar hazır');
    expect(runtime.views).toHaveLength(2);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Haritayı yeniden başlat' })).toBeNull();
  });
  it('cancels waiting on unmount and never publishes a late view', async () => {
    const ready = deferred(); runtime.create.mockReturnValue({ when: () => ready.promise });
    const { unmount } = setup(); await waitFor(() => expect(runtime.views).toHaveLength(1));
    unmount(); await act(async () => { ready.resolve(); });
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(Store.getState().Map.MapView).toBeNull();
  });
  it('bounds stalled module loading and offers a recovery action', async () => {
    vi.useFakeTimers(); runtime.load.mockImplementationOnce(() => new Promise(() => undefined));
    setup(); await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(screen.getByRole('button', { name: 'Haritayı yeniden başlat' })).toBeVisible();
    expect(screen.queryByText('Araçlar hazır')).toBeNull();
    expect(runtime.views).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Haritayı yeniden başlat' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Araçlar hazır')).toBeVisible();
  });
  it('survives React effect replay without disposing the active models', async () => {
    setup(true);
    await screen.findByText('Araçlar hazır');
    expect(document.getElementById('esri-map-container')).toHaveAttribute('data-workspace-phase', 'ready');
    expect(runtime.views).toHaveLength(1);
  });
});
