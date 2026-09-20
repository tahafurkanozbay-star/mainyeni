import { describe, expect, it } from 'vitest';
import { createViewportTilePlanner } from './viewportTilePlanner';

const extent = Object.freeze({
  xmin: 0,
  ymin: 0,
  xmax: 100,
  ymax: 100,
  spatialReference: 'EPSG:3857',
});

describe('viewportTilePlanner', () => {
  it('keeps sparse viewports in one deterministic tile', () => {
    const planner = createViewportTilePlanner();
    const plan = planner.plan({
      extent,
      pixelWidth: 1200,
      pixelHeight: 800,
      maxFeatures: 5000,
      estimatedFeatureDensity: 0.01,
    });
    expect(plan.tileCount).toBe(1);
    expect(plan.rows).toBe(1);
    expect(plan.columns).toBe(1);
    expect(plan.tiles[0]?.coreExtent).toEqual(extent);
    expect(plan.tiles[0]?.extent).toEqual(extent);
  });

  it('splits dense viewports into bounded tiles', () => {
    const planner = createViewportTilePlanner({
      maximumEstimatedFeaturesPerTile: 1000,
      maximumTiles: 16,
      maximumRows: 4,
      maximumColumns: 4,
    });
    const plan = planner.plan({
      extent,
      pixelWidth: 1600,
      pixelHeight: 900,
      maxFeatures: 8000,
      estimatedFeatureDensity: 0.8,
    });
    expect(plan.tileCount).toBeGreaterThan(1);
    expect(plan.tileCount).toBeLessThanOrEqual(16);
    expect(plan.tiles).toHaveLength(plan.tileCount);
    expect(plan.tiles.every((tile) => tile.featureBudget > 0)).toBe(true);
  });

  it('never exceeds the hard tile cardinality budget', () => {
    const planner = createViewportTilePlanner({
      maximumTiles: 9,
      maximumRows: 3,
      maximumColumns: 3,
      maximumEstimatedFeaturesPerTile: 10,
    });
    const plan = planner.plan({
      extent,
      pixelWidth: 1000,
      pixelHeight: 1000,
      maxFeatures: 1000,
      estimatedFeatureDensity: 100,
    });
    expect(plan.tileCount).toBeLessThanOrEqual(9);
    expect(plan.warnings).toContain('tile-count-budget-saturated');
  });

  it('covers the full core extent without gaps at outer boundaries', () => {
    const planner = createViewportTilePlanner({
      maximumEstimatedFeaturesPerTile: 100,
      maximumTiles: 16,
    });
    const plan = planner.plan({
      extent,
      pixelWidth: 1000,
      pixelHeight: 1000,
      maxFeatures: 1000,
      estimatedFeatureDensity: 0.1,
    });
    const left = Math.min(...plan.tiles.map((tile) => tile.coreExtent.xmin));
    const right = Math.max(...plan.tiles.map((tile) => tile.coreExtent.xmax));
    const bottom = Math.min(...plan.tiles.map((tile) => tile.coreExtent.ymin));
    const top = Math.max(...plan.tiles.map((tile) => tile.coreExtent.ymax));
    expect({ left, right, bottom, top }).toEqual({ left: 0, right: 100, bottom: 0, top: 100 });
  });

  it('bounds overlap to the original viewport extent', () => {
    const planner = createViewportTilePlanner({
      maximumEstimatedFeaturesPerTile: 100,
      overlapRatio: 0.1,
    });
    const plan = planner.plan({
      extent,
      pixelWidth: 1000,
      pixelHeight: 1000,
      maxFeatures: 1000,
      estimatedFeatureDensity: 0.1,
    });
    for (const tile of plan.tiles) {
      expect(tile.extent.xmin).toBeGreaterThanOrEqual(extent.xmin);
      expect(tile.extent.ymin).toBeGreaterThanOrEqual(extent.ymin);
      expect(tile.extent.xmax).toBeLessThanOrEqual(extent.xmax);
      expect(tile.extent.ymax).toBeLessThanOrEqual(extent.ymax);
    }
  });

  it('uses stable plan and tile identities for identical inputs', () => {
    const planner = createViewportTilePlanner({ precision: 4 });
    const input = {
      extent,
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 2000,
      estimatedFeatureDensity: 0.5,
    };
    const first = planner.plan(input);
    const second = planner.plan(input);
    expect(second.key).toBe(first.key);
    expect(second.tiles.map((tile) => tile.id)).toEqual(first.tiles.map((tile) => tile.id));
  });

  it('changes identities when the viewport changes materially', () => {
    const planner = createViewportTilePlanner({ precision: 3 });
    const first = planner.plan({
      extent,
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 2000,
    });
    const second = planner.plan({
      ...{
        extent: { ...extent, xmin: 1 },
        pixelWidth: 800,
        pixelHeight: 600,
        maxFeatures: 2000,
      },
    });
    expect(second.key).not.toBe(first.key);
  });

  it('prioritizes center tiles ahead of edge tiles', () => {
    const planner = createViewportTilePlanner({
      maximumEstimatedFeaturesPerTile: 100,
      maximumTiles: 9,
      maximumRows: 3,
      maximumColumns: 3,
    });
    const plan = planner.plan({
      extent,
      pixelWidth: 900,
      pixelHeight: 900,
      maxFeatures: 900,
      estimatedFeatureDensity: 0.09,
      priority: 'interactive',
    });
    expect(plan.tiles[0]?.priorityScore).toBeGreaterThanOrEqual(plan.tiles.at(-1)?.priorityScore ?? 0);
  });

  it('applies a movement penalty to non-interactive tiles', () => {
    const planner = createViewportTilePlanner({
      maximumEstimatedFeaturesPerTile: 100,
    });
    const base = {
      extent,
      pixelWidth: 1000,
      pixelHeight: 1000,
      maxFeatures: 1000,
      estimatedFeatureDensity: 0.1,
    };
    const stationary = planner.plan({ ...base, priority: 'foreground' });
    const moving = planner.plan({ ...base, priority: 'foreground', moving: true });
    expect(moving.tiles[0]?.priorityScore).toBeLessThan(stationary.tiles[0]?.priorityScore ?? 0);
    expect(moving.warnings).toContain('moving-viewport-tiled');
  });

  it('does not penalize interactive work while moving', () => {
    const planner = createViewportTilePlanner({
      maximumEstimatedFeaturesPerTile: 100,
    });
    const base = {
      extent,
      pixelWidth: 1000,
      pixelHeight: 1000,
      maxFeatures: 1000,
      estimatedFeatureDensity: 0.1,
      priority: 'interactive' as const,
    };
    const stationary = planner.plan(base);
    const moving = planner.plan({ ...base, moving: true });
    expect(moving.tiles[0]?.priorityScore).toBe(stationary.tiles[0]?.priorityScore);
  });

  it('reports high tile pressure when density exceeds available feature capacity', () => {
    const planner = createViewportTilePlanner({
      maximumTiles: 4,
      maximumRows: 2,
      maximumColumns: 2,
      maximumEstimatedFeaturesPerTile: 100,
    });
    const plan = planner.plan({
      extent,
      pixelWidth: 800,
      pixelHeight: 800,
      maxFeatures: 100,
      estimatedFeatureDensity: 10,
    });
    expect(plan.pressure).toBe('high');
    expect(plan.warnings).toContain('estimated-features-exceed-tile-budget');
  });

  it('supports unknown density without fabricating feature estimates', () => {
    const planner = createViewportTilePlanner();
    const plan = planner.plan({
      extent,
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 1000,
    });
    expect(plan.estimatedFeatures).toBeNull();
    expect(plan.estimatedFeaturesPerTile).toBeNull();
    expect(plan.pressure).toBe('low');
  });

  it('normalizes the spatial reference identity', () => {
    const planner = createViewportTilePlanner();
    const plan = planner.plan({
      extent: { ...extent, spatialReference: ' EPSG:3857 ' },
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 1000,
    });
    expect(plan.extent.spatialReference).toBe('EPSG:3857');
  });

  it('rejects malformed extents and viewport dimensions', () => {
    const planner = createViewportTilePlanner();
    expect(() => planner.plan({
      extent: { ...extent, xmax: 0 },
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 1000,
    })).toThrow('positive width and height');
    expect(() => planner.plan({
      extent,
      pixelWidth: 0,
      pixelHeight: 600,
      maxFeatures: 1000,
    })).toThrow('pixelWidth');
  });

  it('rejects negative or non-finite density', () => {
    const planner = createViewportTilePlanner();
    expect(() => planner.plan({
      extent,
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 1000,
      estimatedFeatureDensity: -1,
    })).toThrow('estimatedFeatureDensity');
    expect(() => planner.plan({
      extent,
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 1000,
      estimatedFeatureDensity: Number.NaN,
    })).toThrow('estimatedFeatureDensity');
  });

  it('rejects impossible grid configuration eagerly', () => {
    expect(() => createViewportTilePlanner({
      maximumTiles: 10,
      maximumRows: 2,
      maximumColumns: 2,
    })).toThrow('maximumRows * maximumColumns');
  });

  it('rejects unbounded overlap ratios', () => {
    expect(() => createViewportTilePlanner({ overlapRatio: 0.5 })).toThrow('overlapRatio');
  });

  it('rejects invalid precision and minimum tile dimensions', () => {
    expect(() => createViewportTilePlanner({ precision: 13 })).toThrow('precision');
    expect(() => createViewportTilePlanner({ minimumTileWidth: 0 })).toThrow('minimumTileWidth');
    expect(() => createViewportTilePlanner({ minimumTileHeight: Number.NaN })).toThrow('minimumTileHeight');
  });

  it('freezes plan, warnings, tile list, and tile records', () => {
    const planner = createViewportTilePlanner();
    const plan = planner.plan({
      extent,
      pixelWidth: 800,
      pixelHeight: 600,
      maxFeatures: 1000,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.warnings)).toBe(true);
    expect(Object.isFrozen(plan.tiles)).toBe(true);
    expect(Object.isFrozen(plan.tiles[0])).toBe(true);
  });
});
