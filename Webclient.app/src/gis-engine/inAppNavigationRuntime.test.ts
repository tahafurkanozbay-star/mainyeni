import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARC_GIS_ROUTE_SERVICE_URL,
  InAppNavigationRuntime,
  type InAppNavigationMapLike,
} from './inAppNavigationRuntime';

const routeHarness = vi.hoisted(() => ({
  routeParameters: [] as Array<Record<string, unknown>>,
  createdGraphics: [] as Array<Record<string, unknown>>,
  solve: vi.fn(),
  fetchServiceDescription: vi.fn(),
  layerInstances: [] as Array<{
    graphics: unknown[];
    add: ReturnType<typeof vi.fn>;
    removeAll: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));

class FakeGraphic {
  readonly geometry: unknown;
  readonly attributes: unknown;
  constructor(properties: Record<string, unknown>) {
    routeHarness.createdGraphics.push(properties);
    this.geometry = properties.geometry;
    this.attributes = properties.attributes;
  }
}

class FakeFeatureSet {
  readonly features: readonly unknown[];
  constructor(properties: { features: readonly unknown[] }) {
    this.features = properties.features;
  }
}

class FakeRouteParameters {
  readonly properties: Record<string, unknown>;
  constructor(properties: Record<string, unknown>) {
    this.properties = properties;
    routeHarness.routeParameters.push(properties);
  }
}

class FakeGraphicsLayer {
  readonly graphics: unknown[] = [];
  readonly add = vi.fn((graphic: unknown) => { this.graphics.push(graphic); });
  readonly removeAll = vi.fn(() => { this.graphics.length = 0; });
  readonly destroy = vi.fn();
  constructor(_properties: Record<string, unknown>) {
    routeHarness.layerInstances.push(this);
  }
}

const modules = [
  { solve: routeHarness.solve },
  FakeRouteParameters,
  FakeFeatureSet,
  FakeGraphic,
  FakeGraphicsLayer,
  { fetchServiceDescription: routeHarness.fetchServiceDescription },
  { apiKey: 'test-domain-restricted-api-key' },
] as const;

const loadModules = vi.fn(async <TModules extends readonly unknown[]>() => modules as unknown as TModules);

const createMap = () => ({
  layers: [] as FakeGraphicsLayer[],
  add(layer: FakeGraphicsLayer) { this.layers.push(layer); },
  remove(layer: FakeGraphicsLayer) { this.layers = this.layers.filter((candidate) => candidate !== layer); },
});

const origin = Object.freeze({
  displayName: 'Kızılay, Ankara',
  latitude: 39.9208,
  longitude: 32.8541,
});
const destination = Object.freeze({
  displayName: 'Anıtkabir, Ankara',
  latitude: 39.9251,
  longitude: 32.8369,
});

describe('InAppNavigationRuntime', () => {
  beforeEach(() => {
    routeHarness.routeParameters.length = 0;
    routeHarness.createdGraphics.length = 0;
    routeHarness.layerInstances.length = 0;
    routeHarness.solve.mockReset();
    routeHarness.fetchServiceDescription.mockReset();
    routeHarness.fetchServiceDescription.mockResolvedValue({
      supportedTravelModes: [
        { name: 'Driving Time' },
        { name: 'Walking Time' },
      ],
    });
    routeHarness.solve.mockResolvedValue({
      routeResults: [{
        route: {
          geometry: { type: 'polyline', paths: [[[32.85, 39.92], [32.84, 39.925]]] },
          attributes: {},
        },
        directions: {
          totalLength: 2.1,
          totalTime: 8.5,
          features: [
            { attributes: { text: 'Kuzeydoğu yönünde ilerleyin', length: 0.2, time: 1 } },
            { attributes: { text: 'Anıtkabir yönüne devam edin', length: 1.9, time: 7.5 } },
          ],
        },
      }],
    });
    loadModules.mockClear();
  });

  it('solves an in-app route, draws both endpoints and returns Turkish step directions', async () => {
    const runtime = new InAppNavigationRuntime({ loadModules });
    const map = createMap();
    const result = await runtime.planRoute(map as InAppNavigationMapLike, origin, destination, 'driving');

    expect(routeHarness.fetchServiceDescription).toHaveBeenCalledWith(
      ARC_GIS_ROUTE_SERVICE_URL,
      'test-domain-restricted-api-key',
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(routeHarness.solve).toHaveBeenCalledWith(
      ARC_GIS_ROUTE_SERVICE_URL,
      expect.any(FakeRouteParameters),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(routeHarness.routeParameters[0]).toMatchObject({
      travelMode: { name: 'Driving Time' },
      apiKey: 'test-domain-restricted-api-key',
      returnRoutes: true,
      returnDirections: true,
      directionsLanguage: 'tr',
      directionsLengthUnits: 'kilometers',
    });
    expect(result).toMatchObject({
      distanceKm: 2.1,
      durationMinutes: 8.5,
      steps: [
        { instruction: 'Kuzeydoğu yönünde ilerleyin', distanceKm: 0.2 },
        { instruction: 'Anıtkabir yönüne devam edin', distanceKm: 1.9 },
      ],
    });
    expect(map.layers).toHaveLength(1);
    expect(map.layers[0]?.graphics).toHaveLength(4);
    expect(routeHarness.createdGraphics.slice(-4).map(({ attributes }) => attributes)).toEqual([
      { role: 'route-outline' },
      { role: 'route-line' },
      { role: 'route-origin', name: origin.displayName },
      { role: 'route-destination', name: destination.displayName },
    ]);
    runtime.dispose();
    expect(map.layers).toHaveLength(0);
  });

  it('uses the requested walking mode from the routing service', async () => {
    const runtime = new InAppNavigationRuntime({ loadModules });
    await runtime.planRoute(createMap() as InAppNavigationMapLike, origin, destination, 'walking');

    expect(routeHarness.routeParameters[0]?.travelMode).toEqual({ name: 'Walking Time' });
  });

  it('rejects invalid or identical stops before requesting a service route', async () => {
    const runtime = new InAppNavigationRuntime({ loadModules });

    await expect(runtime.planRoute(
      createMap() as InAppNavigationMapLike,
      origin,
      { ...destination, latitude: 120 },
      'driving',
    )).rejects.toThrow(/koordinatları geçerli değil/u);
    await expect(runtime.planRoute(
      createMap() as InAppNavigationMapLike,
      origin,
      { ...origin, displayName: 'Başlangıç' },
      'driving',
    )).rejects.toThrow(/aynı olamaz/u);
    expect(loadModules).not.toHaveBeenCalled();
  });

  it('requires the configured ArcGIS routing key before contacting the routing service', async () => {
    const runtime = new InAppNavigationRuntime({
      loadModules: vi.fn(async <TModules extends readonly unknown[]>() => (
        [...modules.slice(0, -1), {}] as unknown as TModules
      )),
    });

    await expect(runtime.planRoute(
      createMap() as InAppNavigationMapLike,
      origin,
      destination,
      'driving',
    )).rejects.toThrow(/VITE_ESRI_BASEMAP_CREDENTIAL/u);
    expect(routeHarness.fetchServiceDescription).not.toHaveBeenCalled();
    expect(routeHarness.solve).not.toHaveBeenCalled();
  });

  it('surfaces missing travel modes and does not replace the currently drawn route', async () => {
    const runtime = new InAppNavigationRuntime({ loadModules });
    const map = createMap();
    routeHarness.fetchServiceDescription.mockResolvedValue({
      supportedTravelModes: [{ name: 'Driving Time' }],
    });
    await runtime.planRoute(map as InAppNavigationMapLike, origin, destination, 'driving');
    const originalLayer = map.layers[0];

    await expect(runtime.planRoute(
      map as InAppNavigationMapLike,
      origin,
      destination,
      'walking',
    )).rejects.toThrow(/Yürüyüş rotası.*desteklenmiyor/u);
    expect(map.layers[0]).toBe(originalLayer);
    expect(originalLayer?.graphics).toHaveLength(4);
    runtime.clear();
    expect(originalLayer?.graphics).toHaveLength(0);
  });

  it('does not draw a response after its request is aborted', async () => {
    const runtime = new InAppNavigationRuntime({ loadModules });
    const controller = new AbortController();
    routeHarness.solve.mockImplementation(() => new Promise((_resolve, reject) => {
      controller.abort(new DOMException('Aborted', 'AbortError'));
      reject(controller.signal.reason);
    }));

    await expect(runtime.planRoute(
      createMap() as InAppNavigationMapLike,
      origin,
      destination,
      'driving',
      controller.signal,
    )).rejects.toThrow('Aborted');
    expect(routeHarness.layerInstances).toHaveLength(0);
  });
});
