import { describe, expect, it } from 'vitest';

import { normalizeRecordCollection } from './normalization';
import {
  buildSpatialIndex,
  collectSpatialCandidatePositions,
  createSpatialBounds,
  searchRadius,
} from './spatialIndex';

const ankaraRecords = normalizeRecordCollection([
  {
    id: 'center',
    title: 'Ankara Merkez',
    latitude: 39.9208,
    longitude: 32.8541,
  },
  {
    id: 'nearby',
    title: 'Yakın Hizmet',
    latitude: 39.905,
    longitude: 32.87,
  },
  {
    id: 'outside',
    title: 'Uzak Hizmet',
    latitude: 41.015,
    longitude: 28.979,
  },
]).records;

describe('spatial index wide-radius sparse traversal', () => {
  it('finds occupied cells near the center even when the theoretical empty grid exceeds the cell budget', () => {
    const index = buildSpatialIndex(ankaraRecords, {
      cellSizeMeters: 500,
      maxCellsPerQuery: 20_000,
      maxCandidates: 100,
    });
    const center = [32.8541, 39.9208] as const;
    const bounds = createSpatialBounds(center, 50_000);

    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const candidates = collectSpatialCandidatePositions(index, bounds, {
      cellSizeMeters: 500,
      maxCellsPerQuery: 20_000,
      maxCandidates: 100,
    });

    expect(candidates.truncated).toBe(false);
    expect(candidates.cellCount).toBe(2);
    expect(candidates.positions).toEqual([0, 1]);

    const page = searchRadius(index, center, {
      radiusMeters: 50_000,
      cellSizeMeters: 500,
      maxCellsPerQuery: 20_000,
      maxCandidates: 100,
      limit: 10,
    });

    expect(page.items.map(hit => hit.record.id)).toEqual(['center', 'nearby']);
    expect(page.items[0]?.distanceMeters).toBe(0);
    expect(page.items[1]?.distanceMeters).toBeGreaterThan(0);
  });

  it('fails closed when the number of occupied matching cells exceeds the configured cell budget', () => {
    const records = normalizeRecordCollection([
      { id: 'a', title: 'A', latitude: 39.90, longitude: 32.82 },
      { id: 'b', title: 'B', latitude: 39.92, longitude: 32.84 },
      { id: 'c', title: 'C', latitude: 39.94, longitude: 32.86 },
      { id: 'd', title: 'D', latitude: 39.96, longitude: 32.88 },
    ]).records;
    const index = buildSpatialIndex(records, {
      cellSizeMeters: 500,
      maxCellsPerQuery: 2,
      maxCandidates: 100,
    });
    const bounds = createSpatialBounds([32.85, 39.93], 25_000);

    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const candidates = collectSpatialCandidatePositions(index, bounds, {
      cellSizeMeters: 500,
      maxCellsPerQuery: 2,
      maxCandidates: 100,
    });

    expect(candidates.truncated).toBe(true);
    expect(candidates.cellCount).toBeGreaterThan(2);
    expect(candidates.positions).toEqual([]);

    const page = searchRadius(index, [32.85, 39.93], {
      radiusMeters: 25_000,
      cellSizeMeters: 500,
      maxCellsPerQuery: 2,
      maxCandidates: 100,
      limit: 10,
    });

    expect(page.items).toEqual([]);
    expect(page.page.total).toBe(0);
  });

  it('fails closed when the candidate budget is saturated instead of returning a partial spatial set', () => {
    const records = normalizeRecordCollection([
      { id: 'a', title: 'A', latitude: 39.9208, longitude: 32.8541 },
      { id: 'b', title: 'B', latitude: 39.9209, longitude: 32.8542 },
      { id: 'c', title: 'C', latitude: 39.9210, longitude: 32.8543 },
    ]).records;
    const index = buildSpatialIndex(records, {
      cellSizeMeters: 5_000,
      maxCellsPerQuery: 100,
      maxCandidates: 2,
    });
    const bounds = createSpatialBounds([32.8541, 39.9208], 10_000);

    expect(bounds).not.toBeNull();
    if (!bounds) return;

    const candidates = collectSpatialCandidatePositions(index, bounds, {
      cellSizeMeters: 5_000,
      maxCellsPerQuery: 100,
      maxCandidates: 2,
    });

    expect(candidates.truncated).toBe(true);
    expect(candidates.positions).toEqual([]);
  });
});
