import { describe, expect, it } from 'vitest';

import { normalizeRecordCollection } from './normalization';
import {
  buildSpatialIndex,
  collectSpatialCandidatePositions,
  createSpatialBounds,
  haversineDistanceMeters,
  isCoordinateInsideBounds,
  searchRadius,
} from './spatialIndex';

const recordsFrom = (points: readonly {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
}[]) => normalizeRecordCollection(points.map(point => ({
  ...point,
  title: point.id,
}))).records;

const idsWithin = (
  points: Parameters<typeof recordsFrom>[0],
  center: readonly [number, number],
  radiusMeters: number,
) => {
  const index = buildSpatialIndex(recordsFrom(points));
  return searchRadius(index, center, { radiusMeters, limit: 50 })
    .items.map(hit => hit.record.id);
};

describe('geodesic radius index at longitude and latitude boundaries', () => {
  it('finds both sides of the antimeridian without scanning unrelated longitudes', () => {
    const points = [
      { id: 'east', latitude: 0, longitude: 179.99 },
      { id: 'west', latitude: 0, longitude: -179.95 },
      { id: 'far', latitude: 0, longitude: 175 },
    ] as const;
    const bounds = createSpatialBounds([179.99, 0], 10_000);
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    expect(bounds.minLongitude).toBeGreaterThan(bounds.maxLongitude);
    expect(isCoordinateInsideBounds([ -179.95, 0 ], bounds)).toBe(true);
    expect(isCoordinateInsideBounds([175, 0], bounds)).toBe(false);
    expect(idsWithin(points, [179.99, 0], 10_000)).toEqual(['east', 'west']);
    expect(idsWithin(points, [-179.95, 0], 10_000)).toEqual(['west', 'east']);
  });

  it('canonicalizes the two representations of the 180 degree meridian', () => {
    const points = [
      { id: 'negative', latitude: 0, longitude: -180 },
      { id: 'positive', latitude: 0, longitude: 180 },
      { id: 'other', latitude: 0, longitude: 179.9 },
    ] as const;
    expect(haversineDistanceMeters([180, 0], [-180, 0])).toBe(0);
    expect(idsWithin(points, [180, 0], 0)).toEqual(['negative', 'positive']);
    expect(idsWithin(points, [-180, 0], 0)).toEqual(['negative', 'positive']);
  });

  it('uses the spherical longitude envelope near the north pole', () => {
    const points = [
      { id: 'center', latitude: 89.9, longitude: 0 },
      { id: 'diagonal', latitude: 89.9, longitude: 45 },
      { id: 'outside', latitude: 89.9, longitude: 90 },
    ] as const;
    const bounds = createSpatialBounds([0, 89.9], 10_000);
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    expect(bounds.maxLatitude).toBeLessThan(90);
    expect(isCoordinateInsideBounds([45, 89.9], bounds)).toBe(true);
    expect(isCoordinateInsideBounds([90, 89.9], bounds)).toBe(false);
    expect(idsWithin(points, [0, 89.9], 10_000)).toEqual(['center', 'diagonal']);
  });

  it('covers all longitudes when the radius reaches either pole', () => {
    const north = [
      { id: 'center', latitude: 89.9, longitude: 0 },
      { id: 'across', latitude: 89.99, longitude: 170 },
      { id: 'outside', latitude: 89.7, longitude: 180 },
    ] as const;
    const northBounds = createSpatialBounds([0, 89.9], 20_000);
    expect(northBounds?.minLongitude).toBe(-180);
    expect(northBounds?.maxLongitude).toBe(180);
    expect(idsWithin(north, [0, 89.9], 20_000)).toEqual(['center', 'across']);

    const south = [
      { id: 'center', latitude: -89.9, longitude: 0 },
      { id: 'across', latitude: -89.99, longitude: -170 },
      { id: 'outside', latitude: -89.7, longitude: -180 },
    ] as const;
    const southBounds = createSpatialBounds([0, -89.9], 20_000);
    expect(southBounds?.minLongitude).toBe(-180);
    expect(southBounds?.maxLongitude).toBe(180);
    expect(idsWithin(south, [0, -89.9], 20_000)).toEqual(['center', 'across']);
  });

  it('includes all finite geographic coordinates for a globe-spanning radius', () => {
    const points = [
      { id: 'origin', latitude: 0, longitude: 0 },
      { id: 'antipode', latitude: 0, longitude: 180 },
      { id: 'north', latitude: 90, longitude: -180 },
      { id: 'south', latitude: -90, longitude: 180 },
    ] as const;
    const bounds = createSpatialBounds([0, 0], 25_000_000);
    expect(bounds).toEqual({
      minLatitude: -90,
      maxLatitude: 90,
      minLongitude: -180,
      maxLongitude: 180,
    });
    expect(idsWithin(points, [0, 0], 25_000_000)).toEqual([
      'origin', 'north', 'south', 'antipode',
    ]);
  });

  it('accepts exactly the candidate budget and fails closed only on overflow', () => {
    const points = [
      { id: 'first', latitude: 39.9208, longitude: 32.8541 },
      { id: 'second', latitude: 39.9209, longitude: 32.8542 },
      { id: 'third', latitude: 39.9210, longitude: 32.8543 },
    ] as const;
    const bounds = createSpatialBounds([32.8541, 39.9208], 10_000);
    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const exact = collectSpatialCandidatePositions(
      buildSpatialIndex(recordsFrom(points.slice(0, 2))),
      bounds,
      { maxCandidates: 2 },
    );
    expect(exact.truncated).toBe(false);
    expect(exact.positions).toEqual([0, 1]);

    const overflow = collectSpatialCandidatePositions(
      buildSpatialIndex(recordsFrom(points)),
      bounds,
      { maxCandidates: 2 },
    );
    expect(overflow.truncated).toBe(true);
    expect(overflow.positions).toEqual([]);

    const page = searchRadius(buildSpatialIndex(recordsFrom(points.slice(0, 2))),
      [32.8541, 39.9208], { radiusMeters: 10_000, maxCandidates: 2 });
    expect(page.items.map(hit => hit.record.id)).toEqual(['first', 'second']);
  });

  it('does not suppress aborts or admit invalid coordinate bounds', () => {
    expect(createSpatialBounds([181, 0], 10_000)).toBeNull();
    expect(createSpatialBounds([0, 91], 10_000)).toBeNull();
    expect(createSpatialBounds([0, 0], -1)).toBeNull();
    const controller = new AbortController();
    controller.abort();
    const index = buildSpatialIndex(recordsFrom([
      { id: 'first', latitude: 0, longitude: 0 },
    ]));
    expect(() => searchRadius(index, [0, 0], {
      radiusMeters: 10_000,
      signal: controller.signal,
    })).toThrowError(/aborted/i);
  });
});
