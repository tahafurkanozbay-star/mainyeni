import { describe, expect, it, vi } from 'vitest';
import {
  buildingHeightMeters,
  createBuildingQuery,
  OSM3DBuildingsRuntime,
  parseOverpassBuildings,
  resolveOSMSceneTarget,
  type OSMBounds,
  type OSM3DSceneViewLike,
} from './osm3DBuildingsRuntime';

const closedBuilding = {
  type: 'way',
  id: 101,
  tags: { building: 'apartments', height: '18 m', name: 'Test Apartmanı' },
  geometry: [
    { lat: 39.93, lon: 32.85 },
    { lat: 39.93, lon: 32.851 },
    { lat: 39.931, lon: 32.851 },
    { lat: 39.931, lon: 32.85 },
    { lat: 39.93, lon: 32.85 },
  ],
};

describe('OSM 3D building footprint parsing', () => {
  it('uses the target map center rather than the offset camera position', () => {
    expect(resolveOSMSceneTarget({
      center: { longitude: 32.85, latitude: 39.93, spatialReference: { wkid: 4326 } },
      camera: { position: { longitude: 32.95, latitude: 40.01, altitude: 720 } },
    })).toEqual({ longitude: 32.85, latitude: 39.93, altitudeMeters: 720 });
  });

  it('normalizes a WebMercator target center', () => {
    const target = resolveOSMSceneTarget({
      center: { x: 3658572.3, y: 4851900.4, spatialReference: { wkid: 3857 } },
      camera: { position: { altitude: 400 } },
    });
    expect(target?.longitude).toBeCloseTo((3658572.3 / 20037508.34) * 180, 4);
    expect(target?.latitude).toBeCloseTo((Math.atan(Math.exp((4851900.4 / 20037508.34) * Math.PI)) * 2 - Math.PI / 2) * (180 / Math.PI), 4);
    expect(target?.altitudeMeters).toBe(400);
  });

  it('parses closed OpenStreetMap ways into 3D-ready rings', () => {
    const result = parseOverpassBuildings({ elements: [closedBuilding] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 101, heightMeters: 18, name: 'Test Apartmanı', building: 'apartments' });
    expect(result[0]?.ring[0]).toEqual([32.85, 39.93]);
    expect(result[0]?.ring[0]).toEqual(result[0]?.ring[result[0]!.ring.length - 1]);
  });

  it('converts feet and building levels into bounded height estimates', () => {
    expect(buildingHeightMeters({ building: 'house', height: '30 ft' })).toBe(9.1);
    expect(buildingHeightMeters({ building: 'house', 'building:levels': '4' })).toBe(12);
    expect(buildingHeightMeters({ building: 'house', height: '999 m' })).toBe(120);
    expect(buildingHeightMeters({ building: 'house' })).toBe(9);
  });

  it('ignores non-building ways, open rings, and invalid coordinates', () => {
    const result = parseOverpassBuildings({ elements: [
      closedBuilding,
      { ...closedBuilding, id: 102, tags: { highway: 'residential' } },
      { ...closedBuilding, id: 103, geometry: [{ lat: 39.93, lon: 32.85 }, { lat: 39.931, lon: 32.85 }] },
      { ...closedBuilding, id: 104, geometry: [{ lat: 39.93, lon: 32.85 }, { lat: 39.931, lon: 32.85 }, { lat: 39.932, lon: 999 }] },
      { ...closedBuilding, id: 105, tags: { building: 'no' } },
    ] });
    expect(result.map((building) => building.id)).toEqual([101]);
  });

  it('requests only a small bounding cell and caps the number of returned features', () => {
    const bounds: OSMBounds = { south: 39.93, west: 32.85, north: 39.936, east: 32.856 };
    const query = createBuildingQuery(bounds);
    expect(query).toContain('[timeout:12]');
    expect(query).toContain('way["building"]["building"!="no"]');
    expect(query).toContain('(39.93000,32.85000,39.93600,32.85600)');
    expect(query).toContain('out geom 250');
  });

  it('safely accepts empty or malformed provider payloads', () => {
    expect(parseOverpassBuildings(null)).toEqual([]);
    expect(parseOverpassBuildings({ elements: 'not-an-array' })).toEqual([]);
    expect(parseOverpassBuildings({ elements: [] })).toEqual([]);
  });
});

describe('OSM3DBuildingsRuntime', () => {
  it('watches SceneView camera changes through reactiveUtils', async () => {
    class GraphicsLayer {
      visible = false;
      removeAll = vi.fn();
      destroy = vi.fn();
    }
    class Graphic {}

    const reactiveUtils = {
      watch: vi.fn(() => ({ remove: vi.fn() })),
    };
    const request = vi.fn(async () => ({ data: { elements: [] } }));
    const runtime = new OSM3DBuildingsRuntime({
      loadModules: async () => [GraphicsLayer, Graphic, reactiveUtils] as const,
      loadRequest: async () => request,
    });
    const map = { add: vi.fn(), remove: vi.fn() };
    const legacyWatch = vi.fn();
    const view = {
      map,
      center: { longitude: 32.85, latitude: 39.93 },
      camera: { position: { altitude: 100 } },
      scale: 1_000,
      watch: legacyWatch,
    } as OSM3DSceneViewLike;

    await runtime.activate(view);

    expect(reactiveUtils.watch).toHaveBeenNthCalledWith(1, view, 'camera', expect.any(Function));
    expect(reactiveUtils.watch).toHaveBeenNthCalledWith(2, view, 'scale', expect.any(Function));
    expect(legacyWatch).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
