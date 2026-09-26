import { describe, expect, it } from 'vitest';
import { SpatialTilePipelineRuntime, type SpatialTilePipelineDescriptor } from '../src/gis-engine/spatialTilePipelineRuntime';

const tile = (key: string, layerId = 'parcels', overrides: Partial<SpatialTilePipelineDescriptor> = {}): SpatialTilePipelineDescriptor => ({ key, layerId, level: 12, row: 120, column: 240, estimatedBytes: 1024, priority: 'interactive', ...overrides });
const cache = (now = 100) => ({ now, ttlMs: 1_000, bytes: 1_024 });

describe('SpatialTilePipelineRuntime', () => {
  it('fails closed for malformed descriptors and subscriber identities', () => {
    const runtime = new SpatialTilePipelineRuntime();
    expect(runtime.acquire(tile(''), 'viewer', 1)).toBeUndefined();
    expect(runtime.acquire(tile('valid'), '', 1)).toBeUndefined();
    expect(runtime.acquire(tile('negative', 'parcels', { row: -1 }), 'viewer', 1)).toBeUndefined();
    expect(runtime.acquire(tile('bytes', 'parcels', { estimatedBytes: 0 }), 'viewer', 1)).toBeUndefined();
    expect(runtime.snapshot(1)).toMatchObject({ rejected: 4, knownTiles: 0 });
  });

  it('deduplicates concurrent subscribers through the request coordinator', () => {
    const runtime = new SpatialTilePipelineRuntime();
    const first = runtime.acquire(tile('12/120/240'), 'map-a', 10);
    const second = runtime.acquire(tile('12/120/240'), 'map-b', 11);
    expect(first).toMatchObject({ owner: true, state: 'inflight' });
    expect(second).toMatchObject({ owner: false, state: 'inflight' });
    expect(second?.generation).toBe(first?.generation);
    expect(runtime.snapshot(11)).toMatchObject({ inflightRequests: 1, requestSubscribers: 2, knownTiles: 1 });
  });

  it('completes a generation atomically and exposes a subsequent cache hit', () => {
    const runtime = new SpatialTilePipelineRuntime();
    const lease = runtime.acquire(tile('complete'), 'map-a', 10);
    expect(lease).toBeDefined();
    expect(runtime.complete('complete', lease?.generation ?? -1, cache(20))).toEqual(['map-a']);
    expect(runtime.stateOf('complete')).toBe('cached');
    expect(runtime.acquire(tile('complete'), 'map-b', 21)).toMatchObject({ owner: false, state: 'cached', generation: 0 });
    expect(runtime.snapshot(21)).toMatchObject({ cachedTiles: 1, cacheHits: 1, completed: 1, inflightRequests: 0 });
  });

  it('ignores stale completion generations without mutating cache state', () => {
    const runtime = new SpatialTilePipelineRuntime();
    const lease = runtime.acquire(tile('stale'), 'map-a', 10);
    expect(lease).toBeDefined();
    expect(runtime.complete('stale', (lease?.generation ?? 0) + 1, cache(20))).toEqual([]);
    expect(runtime.stateOf('stale')).toBe('inflight');
    expect(runtime.snapshot(20).completed).toBe(0);
  });

  it('keeps a request alive until its final subscriber releases', () => {
    const runtime = new SpatialTilePipelineRuntime();
    const first = runtime.acquire(tile('shared'), 'map-a', 10);
    const second = runtime.acquire(tile('shared'), 'map-b', 11);
    expect(first).toBeDefined(); expect(second).toBeDefined();
    expect(runtime.release(first!)).toBe(false);
    expect(runtime.stateOf('shared')).toBe('inflight');
    expect(runtime.release(second!)).toBe(true);
    expect(runtime.stateOf('shared')).toBe('idle');
    expect(runtime.snapshot(12).cancelled).toBe(1);
  });

  it('enforces global known-tile capacity before allocating new request work', () => {
    const runtime = new SpatialTilePipelineRuntime({ pipeline: { maxKnownTiles: 2, maxLayerTiles: 2 } });
    expect(runtime.acquire(tile('a'), 'map', 1)).toBeDefined();
    expect(runtime.acquire(tile('b'), 'map', 2)).toBeDefined();
    expect(runtime.acquire(tile('c'), 'map', 3)).toBeUndefined();
    expect(runtime.snapshot(3)).toMatchObject({ knownTiles: 2, rejected: 1 });
  });

  it('enforces per-layer known-tile capacity independently', () => {
    const runtime = new SpatialTilePipelineRuntime({ pipeline: { maxKnownTiles: 4, maxLayerTiles: 1 } });
    expect(runtime.acquire(tile('a', 'parcels'), 'map', 1)).toBeDefined();
    expect(runtime.acquire(tile('b', 'parcels'), 'map', 2)).toBeUndefined();
    expect(runtime.acquire(tile('c', 'roads'), 'map', 3)).toBeDefined();
    expect(runtime.snapshot(3).byLayer).toEqual({ parcels: 1, roads: 1 });
  });

  it('does not count a cache hit against inflight request capacity', () => {
    const runtime = new SpatialTilePipelineRuntime({ request: { maxInflight: 1 } });
    const first = runtime.acquire(tile('cached'), 'map-a', 1);
    expect(first).toBeDefined(); runtime.complete('cached', first!.generation, cache(2));
    expect(runtime.acquire(tile('cached'), 'map-b', 3)?.state).toBe('cached');
    expect(runtime.acquire(tile('other'), 'map-c', 4)).toBeDefined();
    expect(runtime.snapshot(4).inflightRequests).toBe(1);
  });

  it('expires cache entries and reacquires transport work after TTL', () => {
    const runtime = new SpatialTilePipelineRuntime();
    const first = runtime.acquire(tile('ttl'), 'map-a', 1);
    expect(first).toBeDefined(); runtime.complete('ttl', first!.generation, { now: 2, ttlMs: 5, bytes: 1024 });
    expect(runtime.acquire(tile('ttl'), 'map-b', 3)?.state).toBe('cached');
    expect(runtime.acquire(tile('ttl'), 'map-c', 8)).toMatchObject({ owner: true, state: 'inflight' });
  });

  it('cancels only inflight work belonging to the selected layer', () => {
    const runtime = new SpatialTilePipelineRuntime();
    runtime.acquire(tile('parcel-a', 'parcels'), 'map', 1); runtime.acquire(tile('road-a', 'roads'), 'map', 2);
    expect(runtime.cancelLayer('parcels')).toEqual(['parcel-a']);
    expect(runtime.stateOf('parcel-a')).toBe('idle'); expect(runtime.stateOf('road-a')).toBe('inflight');
  });

  it('preserves cached records when cancelling a layer', () => {
    const runtime = new SpatialTilePipelineRuntime(); const lease = runtime.acquire(tile('cached-layer', 'parcels'), 'map', 1);
    expect(lease).toBeDefined(); runtime.complete('cached-layer', lease!.generation, cache(2));
    expect(runtime.cancelLayer('parcels')).toEqual([]); expect(runtime.stateOf('cached-layer')).toBe('cached');
  });

  it('clear removes request, admission, cache and pipeline state deterministically', () => {
    const runtime = new SpatialTilePipelineRuntime(); runtime.acquire(tile('z'), 'map', 1); runtime.acquire(tile('a'), 'map', 2);
    expect(runtime.clear()).toEqual(['a', 'z']); expect(runtime.snapshot(3)).toMatchObject({ knownTiles: 0, cacheEntries: 0, inflightRequests: 0 });
  });

  it('returns immutable diagnostics bounded by configured history capacity', () => {
    const runtime = new SpatialTilePipelineRuntime({ pipeline: { maxDiagnostics: 2 } });
    runtime.acquire(tile(''), 'map', 1); runtime.acquire(tile('a'), '', 2); runtime.acquire(tile('b'), '', 3);
    const diagnostics = runtime.diagnostics(); expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry) => entry.sequence)).toEqual([1, 2]); expect(Object.isFrozen(diagnostics)).toBe(true); expect(Object.isFrozen(diagnostics[0])).toBe(true);
  });

  it('normalizes harmless surrounding whitespace in identity fields', () => {
    const runtime = new SpatialTilePipelineRuntime();
    expect(runtime.acquire(tile(' tile ', ' parcels '), ' viewer ', 1)).toMatchObject({ key: 'tile', subscriberId: 'viewer' });
    expect(runtime.snapshot(1).byLayer).toEqual({ parcels: 1 });
  });

  it('rejects identity characters outside the deterministic key alphabet', () => {
    const runtime = new SpatialTilePipelineRuntime();
    expect(runtime.acquire(tile('bad\nkey'), 'map', 1)).toBeUndefined(); expect(runtime.acquire(tile('good'), 'bad\tviewer', 1)).toBeUndefined();
    expect(runtime.snapshot(1).rejected).toBe(2);
  });

  it('supports unicode layer and tile identities without lossy coercion', () => {
    const runtime = new SpatialTilePipelineRuntime(); expect(runtime.acquire(tile('ankara/çankaya', 'ulaşım'), 'görünüm', 1)).toBeDefined();
    expect(runtime.snapshot(1).byLayer).toEqual({ ulaşım: 1 });
  });

  it('keeps variant-bearing tile cache identities distinct', () => {
    const runtime = new SpatialTilePipelineRuntime(); const dark = runtime.acquire(tile('dark', 'base', { variant: 'dark' }), 'map', 1);
    expect(dark).toBeDefined(); runtime.complete('dark', dark!.generation, cache(2));
    expect(runtime.acquire(tile('dark', 'base', { variant: 'dark' }), 'map-2', 3)?.state).toBe('cached');
  });

  it('forwards admission decisions through the bounded admission authority', () => {
    const runtime = new SpatialTilePipelineRuntime({ admission: { maxActive: 1, maxQueued: 1 } });
    expect(runtime.admit({ key: 'a', layerId: 'parcels', estimatedBytes: 1024, priority: 'interactive' })).toBeDefined();
    expect(runtime.admit({ key: 'b', layerId: 'parcels', estimatedBytes: 1024, priority: 'prefetch' })).toBeDefined();
    expect(runtime.snapshot(1)).toMatchObject({ activeAdmissions: 1, queuedAdmissions: 1 });
  });

  it('forwards prefetch planning through the deterministic bounded planner', () => {
    const runtime = new SpatialTilePipelineRuntime({ prefetch: { maxSelected: 1 } });
    const plan = runtime.planPrefetch([
      { layerId: 'roads', level: 12, row: 1, column: 1, estimatedBytes: 100, priority: 'nearby', distance: 10 },
      { layerId: 'roads', level: 12, row: 1, column: 2, estimatedBytes: 100, priority: 'speculative', distance: 20 },
    ]);
    expect(plan.selected).toHaveLength(1); expect(plan.selected[0]).toMatchObject({ priority: 'nearby', column: 1 });
  });

  it('reports deterministic state accounting across multiple layers', () => {
    const runtime = new SpatialTilePipelineRuntime(); const cached = runtime.acquire(tile('cached', 'parcels'), 'map', 1);
    expect(cached).toBeDefined(); runtime.complete('cached', cached!.generation, cache(2)); runtime.acquire(tile('live', 'roads'), 'map', 3);
    expect(runtime.snapshot(3)).toMatchObject({ knownTiles: 2, cachedTiles: 1, inflightTiles: 1, byLayer: { parcels: 1, roads: 1 }, completed: 1 });
  });

  it('does not mutate state when releasing a synthetic cached lease', () => {
    const runtime = new SpatialTilePipelineRuntime();
    expect(runtime.release({ key: 'none', subscriberId: 'viewer', generation: 0, owner: false, state: 'cached' })).toBe(false);
    expect(runtime.snapshot(1).knownTiles).toBe(0);
  });

  it('bounds subscriber identifiers before request allocation', () => {
    const runtime = new SpatialTilePipelineRuntime({ pipeline: { maxSubscriberIdLength: 4 } });
    expect(runtime.acquire(tile('a'), '12345', 1)).toBeUndefined(); expect(runtime.acquire(tile('b'), '1234', 2)).toBeDefined();
  });

  it('rejects non-finite acquisition timestamps without allocating state', () => {
    const runtime = new SpatialTilePipelineRuntime();
    expect(runtime.acquire(tile('a'), 'map', Number.NaN)).toBeUndefined(); expect(runtime.acquire(tile('b'), 'map', Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(runtime.snapshot(1).knownTiles).toBe(0);
  });

  it('returns idle for malformed or unknown state keys', () => {
    const runtime = new SpatialTilePipelineRuntime(); expect(runtime.stateOf('')).toBe('idle'); expect(runtime.stateOf('unknown')).toBe('idle');
  });
});
