import { describe, expect, it } from 'vitest';
import {
  buildingHeightMeters,
  createBuildingQuery,
  parseOverpassBuildings,
  type OSMBounds,
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
