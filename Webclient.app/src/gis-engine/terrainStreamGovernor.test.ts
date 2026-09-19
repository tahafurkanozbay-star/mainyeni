import { describe, expect, it } from 'vitest';
import {
  TerrainStreamGovernor,
  terrainBudgetForQuality,
  type TerrainTileSample,
} from './terrainStreamGovernor';

const MIB = 1024 * 1024;

const tile = (id: string, overrides: Partial<TerrainTileSample> = {}): TerrainTileSample => ({
  id,
  level: 12,
  distanceMeters: 100,
  screenPixels: 96,
  estimatedBytes: 2 * MIB,
  visible: true,
  ...overrides,
});

describe('terrainBudgetForQuality', () => {
  it('exposes progressively larger stable budgets', () => {
    const eco = terrainBudgetForQuality('eco');
    const balanced = terrainBudgetForQuality('balanced');
    const quality = terrainBudgetForQuality('quality');

    expect(eco.maxResidentBytes).toBeLessThan(balanced.maxResidentBytes);
    expect(balanced.maxResidentBytes).toBeLessThan(quality.maxResidentBytes);
    expect(eco.maxConcurrentRequests).toBeLessThan(balanced.maxConcurrentRequests);
    expect(balanced.maxConcurrentRequests).toBeLessThan(quality.maxConcurrentRequests);
    expect(eco.maxLevel).toBeLessThan(balanced.maxLevel);
    expect(balanced.maxLevel).toBeLessThan(quality.maxLevel);
    expect(Object.isFrozen(eco)).toBe(true);
  });

  it('fails closed for an invalid runtime quality value', () => {
    expect(() => terrainBudgetForQuality('ultra' as TerrainQuality))
      .toThrow('terrain quality must be eco, balanced, or quality');
    expect(() => new TerrainStreamGovernor({ quality: 'ultra' as TerrainQuality }))
      .toThrow(TypeError);
  });
});

describe('TerrainStreamGovernor pressure accounting', () => {
  it('starts with a bounded empty balanced snapshot', () => {
    const governor = new TerrainStreamGovernor();
    expect(governor.getSnapshot()).toMatchObject({
      quality: 'balanced',
      pressure: 'normal',
      residentBytes: 0,
      residentTiles: 0,
      activeRequests: 0,
      averageFrameMs: 0,
      p95FrameMs: 0,
      decisions: [],
    });
  });

  it('updates quality and recalculates pressure against the selected budget', () => {
    const governor = new TerrainStreamGovernor({ quality: 'quality' });
    const qualityBudget = terrainBudgetForQuality('quality');
    governor.setResidentUsage(qualityBudget.maxResidentBytes * 0.9, 1);
    expect(governor.getSnapshot().pressure).toBe('elevated');

    governor.setQuality('eco');
    expect(governor.getSnapshot().quality).toBe('eco');
    expect(governor.getSnapshot().pressure).toBe('critical');
  });

  it('derives critical pressure from slow p95 frame time', () => {
    const governor = new TerrainStreamGovernor({ quality: 'balanced' });
    for (let index = 0; index < 20; index += 1) governor.recordFrame(30);

    const snapshot = governor.getSnapshot();
    expect(snapshot.p95FrameMs).toBe(30);
    expect(snapshot.averageFrameMs).toBe(30);
    expect(snapshot.pressure).toBe('critical');
  });

  it('ignores invalid frame samples instead of poisoning pressure metrics', () => {
    const governor = new TerrainStreamGovernor();
    governor.recordFrame(Number.NaN);
    governor.recordFrame(-10);
    governor.recordFrame(5_000);

    expect(governor.getSnapshot()).toMatchObject({
      averageFrameMs: 0,
      p95FrameMs: 0,
      pressure: 'normal',
    });
  });

  it('uses resident tile pressure as an independent signal', () => {
    const governor = new TerrainStreamGovernor({ quality: 'eco' });
    const budget = terrainBudgetForQuality('eco');
    governor.setResidentUsage(0, Math.ceil(budget.maxResidentTiles * 0.9));

    expect(governor.getSnapshot().pressure).toBe('elevated');
  });

  it('uses active request pressure as an independent signal', () => {
    const governor = new TerrainStreamGovernor({ quality: 'balanced' });
    const budget = terrainBudgetForQuality('balanced');
    governor.setActiveRequests(budget.maxConcurrentRequests + 1);

    expect(governor.getSnapshot().pressure).toBe('critical');
  });

  it('clamps negative resident and request counters to zero', () => {
    const governor = new TerrainStreamGovernor();
    governor.setResidentUsage(-1, -1);
    governor.setActiveRequests(-5);

    expect(governor.getSnapshot()).toMatchObject({
      residentBytes: 0,
      residentTiles: 0,
      activeRequests: 0,
    });
  });
});

describe('TerrainStreamGovernor request planning', () => {
  it('requests a visible tile when resource and concurrency budgets allow it', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([tile('visible')]);

    expect(snapshot.decisions).toEqual([
      expect.objectContaining({
        tileId: 'visible',
        action: 'request',
        reason: 'visible',
      }),
    ]);
  });

  it('requests an offscreen tile inside the prefetch radius', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([
      tile('prefetch', {
        visible: false,
        distanceMeters: 500,
        screenPixels: 100,
      }),
    ]);

    expect(snapshot.decisions[0]).toMatchObject({
      tileId: 'prefetch',
      action: 'request',
      reason: 'prefetch',
    });
  });

  it('evicts an offscreen tile beyond the prefetch radius', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([
      tile('far', {
        visible: false,
        distanceMeters: 10_000,
        screenPixels: 100,
      }),
    ]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'evict',
      reason: 'prefetch-radius',
    });
  });

  it('defers a visible tile below the effective screen-error threshold', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([tile('tiny', { screenPixels: 1 })]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'defer',
      reason: 'screen-error',
    });
  });

  it('defers a visible tile above the configured LOD cap', () => {
    const governor = new TerrainStreamGovernor({ quality: 'eco', now: () => 1_000 });
    const budget = terrainBudgetForQuality('eco');
    const snapshot = governor.plan([
      tile('too-detailed', { level: budget.maxLevel + 1 }),
    ]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'defer',
      reason: 'lod-cap',
    });
  });

  it('preserves requestedAt zero as evidence that a tile is already requested', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([tile('epoch-request', { requestedAt: 0 })]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'keep',
      reason: 'already-requested',
    });
  });

  it('defers new work when all request slots are already occupied', () => {
    const governor = new TerrainStreamGovernor({ quality: 'eco', now: () => 1_000 });
    governor.setActiveRequests(terrainBudgetForQuality('eco').maxConcurrentRequests);
    const snapshot = governor.plan([tile('queued')]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'defer',
      reason: 'request-concurrency',
    });
  });

  it('reduces available request slots under elevated pressure', () => {
    const governor = new TerrainStreamGovernor({ quality: 'balanced', now: () => 1_000 });
    const budget = terrainBudgetForQuality('balanced');
    governor.setResidentUsage(budget.maxResidentBytes * 0.9, 0);

    const snapshot = governor.plan([
      tile('a'),
      tile('b'),
      tile('c'),
      tile('d'),
      tile('e'),
      tile('f'),
    ]);
    const requested = snapshot.decisions.filter((decision) => decision.action === 'request');
    const deferred = snapshot.decisions.filter((decision) => decision.reason === 'request-concurrency');

    expect(requested).toHaveLength(Math.floor(budget.maxConcurrentRequests * 0.8));
    expect(deferred.length).toBeGreaterThan(0);
  });

  it('respects projected resident byte budget across multiple planned requests', () => {
    const governor = new TerrainStreamGovernor({ quality: 'eco', now: () => 1_000 });
    const budget = terrainBudgetForQuality('eco');
    governor.setResidentUsage(budget.maxResidentBytes - 3 * MIB, 0);

    const snapshot = governor.plan([
      tile('first', { estimatedBytes: 2 * MIB }),
      tile('second', { estimatedBytes: 2 * MIB }),
    ]);

    expect(snapshot.decisions.map(({ action, reason }) => ({ action, reason }))).toEqual([
      { action: 'request', reason: 'visible' },
      { action: 'defer', reason: 'memory-budget' },
    ]);
  });

  it('respects projected resident tile-count budget', () => {
    const governor = new TerrainStreamGovernor({ quality: 'eco', now: () => 1_000 });
    const budget = terrainBudgetForQuality('eco');
    governor.setResidentUsage(0, budget.maxResidentTiles);

    const snapshot = governor.plan([tile('capacity')]);
    expect(snapshot.decisions[0]).toMatchObject({
      action: 'defer',
      reason: 'tile-budget',
    });
  });

  it('rejects an individually oversized visible tile before global resident accounting', () => {
    const governor = new TerrainStreamGovernor({
      now: () => 1_000,
      maxTileBytes: MIB,
    });
    const snapshot = governor.plan([
      tile('oversized', { estimatedBytes: 2 * MIB }),
    ]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'defer',
      reason: 'tile-memory-budget',
    });
  });

  it('evicts an individually oversized offscreen tile', () => {
    const governor = new TerrainStreamGovernor({
      now: () => 1_000,
      maxTileBytes: MIB,
    });
    const snapshot = governor.plan([
      tile('oversized-background', {
        estimatedBytes: 2 * MIB,
        visible: false,
      }),
    ]);

    expect(snapshot.decisions[0]).toMatchObject({
      action: 'evict',
      reason: 'tile-memory-budget',
    });
  });

  it('bounds recency scoring when last-used timestamps are in the future', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([
      tile('future', { lastUsedAt: 50_000 }),
      tile('current', { lastUsedAt: 1_000 }),
    ]);

    const future = snapshot.decisions.find((decision) => decision.tileId === 'future');
    const current = snapshot.decisions.find((decision) => decision.tileId === 'current');
    expect(future?.score).toBe(current?.score);
  });

  it('treats epoch last-used time as valid recency input instead of missing metadata', () => {
    const governor = new TerrainStreamGovernor({ now: () => 10_000 });
    const snapshot = governor.plan([
      tile('epoch', { lastUsedAt: 0 }),
      tile('missing'),
    ]);

    const epoch = snapshot.decisions.find((decision) => decision.tileId === 'epoch');
    const missing = snapshot.decisions.find((decision) => decision.tileId === 'missing');
    expect(epoch?.score).toBeGreaterThan(missing?.score ?? Number.NEGATIVE_INFINITY);
  });

  it('sorts equal-score tiles by stable normalized id', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const snapshot = governor.plan([
      tile('c'),
      tile('a'),
      tile('b'),
    ]);

    expect(snapshot.decisions.map((decision) => decision.tileId)).toEqual(['a', 'b', 'c']);
  });

  it('uses visibility as a dominant request-priority signal', () => {
    const governor = new TerrainStreamGovernor({
      quality: 'eco',
      now: () => 1_000,
    });
    governor.setActiveRequests(terrainBudgetForQuality('eco').maxConcurrentRequests - 1);

    const snapshot = governor.plan([
      tile('prefetch', { visible: false, distanceMeters: 10 }),
      tile('visible', { visible: true, distanceMeters: 1_000 }),
    ]);

    expect(snapshot.decisions[0]).toMatchObject({
      tileId: 'visible',
      action: 'request',
    });
    expect(snapshot.decisions[1]).toMatchObject({
      tileId: 'prefetch',
      action: 'defer',
      reason: 'request-concurrency',
    });
  });

  it('does not mutate caller tile records while normalizing the plan', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    const input = tile('  normalized-id  ');
    governor.plan([input]);

    expect(input.id).toBe('  normalized-id  ');
    expect(governor.getSnapshot().decisions[0]?.tileId).toBe('normalized-id');
  });
});

describe('TerrainStreamGovernor input integrity', () => {
  it('rejects duplicate ids after normalization', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    expect(() => governor.plan([
      tile('roads'),
      tile(' roads '),
    ])).toThrow('duplicate terrain tile id: roads');
  });

  it('rejects blank tile ids', () => {
    const governor = new TerrainStreamGovernor({ now: () => 1_000 });
    expect(() => governor.plan([tile('   ')])).toThrow('terrain tile id is required');
  });

  it('rejects tile ids beyond the metadata budget', () => {
    const governor = new TerrainStreamGovernor({
      now: () => 1_000,
      maxTileIdLength: 4,
    });
    expect(() => governor.plan([tile('abcde')]))
      .toThrow('terrain tile id exceeds length budget');
  });

  it('rejects non-finite or negative numeric tile metadata', () => {
    const invalid: Array<Partial<TerrainTileSample>> = [
      { level: Number.NaN },
      { level: -1 },
      { distanceMeters: Number.POSITIVE_INFINITY },
      { distanceMeters: -1 },
      { screenPixels: Number.NaN },
      { screenPixels: -1 },
      { estimatedBytes: Number.NaN },
      { estimatedBytes: -1 },
      { requestedAt: -1 },
      { lastUsedAt: Number.NaN },
    ];

    for (const overrides of invalid) {
      const governor = new TerrainStreamGovernor({ now: () => 1_000 });
      expect(() => governor.plan([tile('invalid', overrides)])).toThrow(RangeError);
    }
  });

  it('rejects invalid deterministic clocks', () => {
    const governor = new TerrainStreamGovernor({ now: () => Number.NaN });
    expect(() => governor.plan([tile('clock')]))
      .toThrow('terrain clock must be finite and non-negative');
  });

  it('rejects plan cardinality beyond the configured CPU budget', () => {
    const governor = new TerrainStreamGovernor({
      now: () => 1_000,
      maxTilesPerPlan: 2,
    });

    expect(() => governor.plan([tile('a'), tile('b'), tile('c')]))
      .toThrow('terrain plan exceeds configured tile budget');
  });

  it('rejects invalid governor budget configuration', () => {
    expect(() => new TerrainStreamGovernor({ maxTilesPerPlan: 0 })).toThrow(RangeError);
    expect(() => new TerrainStreamGovernor({ maxTileBytes: Number.NaN })).toThrow(RangeError);
    expect(() => new TerrainStreamGovernor({ maxTileIdLength: -1 })).toThrow(RangeError);
  });
});
