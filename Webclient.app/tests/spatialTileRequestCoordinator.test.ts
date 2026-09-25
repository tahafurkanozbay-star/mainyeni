import { describe, expect, it } from 'vitest';
import {
  SpatialTileRequestCoordinator,
  type SpatialTileRequestDescriptor,
} from '../src/gis-engine/spatialTileRequestCoordinator';

const request = (
  key: string,
  layerId = 'roads',
  estimatedBytes = 100,
  priority: SpatialTileRequestDescriptor['priority'] = 'interactive',
): SpatialTileRequestDescriptor => ({ key, layerId, estimatedBytes, priority });

describe('SpatialTileRequestCoordinator', () => {
  it('grants an owner lease to the first subscriber', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const lease = runtime.acquire(request('tile-1'), 'view-1');
    expect(lease).toMatchObject({ key: 'tile-1', subscriberId: 'view-1', generation: 0, owner: true });
    expect(runtime.snapshot()).toMatchObject({ inflight: 1, inflightBytes: 100, subscribers: 1 });
  });

  it('deduplicates later subscribers onto the same request', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('tile-1'), 'view-1');
    const lease = runtime.acquire(request('tile-1'), 'view-2');
    expect(lease?.owner).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ inflight: 1, subscribers: 2, deduplicated: 1 });
  });

  it('returns the same generation for duplicate work', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const first = runtime.acquire(request('tile-1'), 'view-1');
    const second = runtime.acquire(request('tile-1'), 'view-2');
    expect(second?.generation).toBe(first?.generation);
  });

  it('treats reacquire by the same subscriber as idempotent dedupe', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const first = runtime.acquire(request('tile-1'), 'view-1');
    const second = runtime.acquire(request('tile-1'), 'view-1');
    expect(second).toMatchObject({ owner: false, generation: first?.generation });
    expect(runtime.snapshot().subscribers).toBe(1);
  });

  it('rejects a key collision with different request metadata', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('tile-1', 'roads', 100), 'view-1');
    expect(runtime.acquire(request('tile-1', 'buildings', 100), 'view-2')).toBeUndefined();
    expect(runtime.snapshot().rejected).toBe(1);
  });

  it('rejects a key collision with a different byte estimate', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('tile-1', 'roads', 100), 'view-1');
    expect(runtime.acquire(request('tile-1', 'roads', 101), 'view-2')).toBeUndefined();
  });

  it('rejects a key collision with a different priority', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('tile-1', 'roads', 100, 'critical'), 'view-1');
    expect(runtime.acquire(request('tile-1', 'roads', 100, 'prefetch'), 'view-2')).toBeUndefined();
  });

  it('bounds global inflight count', () => {
    const runtime = new SpatialTileRequestCoordinator({ maxInflight: 2, maxPerLayer: 2, maxTracked: 2 });
    expect(runtime.acquire(request('a'), 's1')).toBeDefined();
    expect(runtime.acquire(request('b'), 's2')).toBeDefined();
    expect(runtime.acquire(request('c'), 's3')).toBeUndefined();
  });

  it('bounds global inflight bytes', () => {
    const runtime = new SpatialTileRequestCoordinator({ maxInflightBytes: 150 });
    runtime.acquire(request('a', 'roads', 100), 's1');
    expect(runtime.acquire(request('b', 'roads', 51), 's2')).toBeUndefined();
    expect(runtime.acquire(request('b', 'roads', 50), 's2')).toBeDefined();
  });

  it('bounds per-layer concurrency independently', () => {
    const runtime = new SpatialTileRequestCoordinator({ maxInflight: 3, maxPerLayer: 1 });
    runtime.acquire(request('a', 'roads'), 's1');
    expect(runtime.acquire(request('b', 'roads'), 's2')).toBeUndefined();
    expect(runtime.acquire(request('c', 'buildings'), 's3')).toBeDefined();
  });

  it('bounds subscribers per shared request', () => {
    const runtime = new SpatialTileRequestCoordinator({ maxSubscribersPerRequest: 2 });
    runtime.acquire(request('a'), 's1');
    runtime.acquire(request('a'), 's2');
    expect(runtime.acquire(request('a'), 's3')).toBeUndefined();
  });

  it('keeps transport alive while another subscriber remains', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const first = runtime.acquire(request('a'), 's1')!;
    runtime.acquire(request('a'), 's2');
    expect(runtime.release(first)).toBe(false);
    expect(runtime.has('a')).toBe(true);
  });

  it('signals transport cancellation when the final subscriber leaves', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const lease = runtime.acquire(request('a'), 's1')!;
    expect(runtime.release(lease)).toBe(true);
    expect(runtime.has('a')).toBe(false);
    expect(runtime.snapshot().cancelled).toBe(1);
  });

  it('does not release the same subscriber twice', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const first = runtime.acquire(request('a'), 's1')!;
    const second = runtime.acquire(request('a'), 's2')!;
    expect(runtime.release(first)).toBe(false);
    expect(runtime.release(first)).toBe(false);
    expect(runtime.release(second)).toBe(true);
  });

  it('returns subscribers deterministically on completion', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const owner = runtime.acquire(request('a'), 'z-view')!;
    runtime.acquire(request('a'), 'a-view');
    runtime.acquire(request('a'), 'm-view');
    expect(runtime.complete('a', owner.generation)).toEqual(['a-view', 'm-view', 'z-view']);
  });

  it('ignores stale completion generations', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const first = runtime.acquire(request('a'), 's1')!;
    runtime.complete('a', first.generation);
    const second = runtime.acquire(request('a'), 's2')!;
    expect(second.generation).not.toBe(first.generation);
    expect(runtime.complete('a', first.generation)).toEqual([]);
    expect(runtime.has('a')).toBe(true);
  });

  it('ignores stale release generations', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const first = runtime.acquire(request('a'), 's1')!;
    runtime.complete('a', first.generation);
    runtime.acquire(request('a'), 's1');
    expect(runtime.release(first)).toBe(false);
    expect(runtime.has('a')).toBe(true);
  });

  it('cancels all requests for one layer without touching others', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('z', 'roads'), 's1');
    runtime.acquire(request('a', 'roads'), 's2');
    runtime.acquire(request('b', 'buildings'), 's3');
    expect(runtime.cancelLayer('roads')).toEqual(['a', 'z']);
    expect(runtime.has('b')).toBe(true);
    expect(runtime.snapshot().cancelled).toBe(2);
  });

  it('clear returns deterministic transport cancellation keys', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('z'), 's1');
    runtime.acquire(request('a', 'buildings'), 's2');
    expect(runtime.clear()).toEqual(['a', 'z']);
    expect(runtime.snapshot()).toMatchObject({ inflight: 0, inflightBytes: 0, subscribers: 0, cancelled: 2 });
  });

  it('reports per-layer inflight counts', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('a', 'roads'), 's1');
    runtime.acquire(request('b', 'roads'), 's2');
    runtime.acquire(request('c', 'buildings'), 's3');
    expect(runtime.snapshot().byLayer).toEqual({ roads: 2, buildings: 1 });
  });

  it('fails closed for malformed identity text', () => {
    const runtime = new SpatialTileRequestCoordinator();
    expect(runtime.acquire(request('   '), 's1')).toBeUndefined();
    expect(runtime.acquire(request('ok'), '\n')).toBeUndefined();
    expect(runtime.acquire(request('<script>'), 's1')).toBeUndefined();
    expect(runtime.snapshot().rejected).toBe(3);
  });

  it('fails closed for invalid byte estimates', () => {
    const runtime = new SpatialTileRequestCoordinator();
    expect(runtime.acquire(request('zero', 'roads', 0), 's1')).toBeUndefined();
    expect(runtime.acquire(request('float', 'roads', 1.5), 's2')).toBeUndefined();
    expect(runtime.acquire(request('negative', 'roads', -1), 's3')).toBeUndefined();
  });

  it('rejects invalid limit relationships', () => {
    expect(() => new SpatialTileRequestCoordinator({ maxInflight: 2, maxPerLayer: 3 })).toThrow(RangeError);
    expect(() => new SpatialTileRequestCoordinator({ maxInflight: 3, maxTracked: 2 })).toThrow(RangeError);
    expect(() => new SpatialTileRequestCoordinator({ maxInflightBytes: 0 })).toThrow(RangeError);
  });

  it('normalizes safe surrounding whitespace in identities', () => {
    const runtime = new SpatialTileRequestCoordinator();
    const lease = runtime.acquire(request(' tile-1 ', ' roads '), ' view-1 ');
    expect(lease).toMatchObject({ key: 'tile-1', subscriberId: 'view-1' });
    expect(runtime.snapshot().byLayer).toEqual({ roads: 1 });
  });

  it('does not expose mutable layer diagnostics', () => {
    const runtime = new SpatialTileRequestCoordinator();
    runtime.acquire(request('a'), 's1');
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
    expect(Object.isFrozen(runtime.snapshot().byLayer)).toBe(true);
  });

  it('allows capacity reuse after completion', () => {
    const runtime = new SpatialTileRequestCoordinator({ maxInflight: 1, maxPerLayer: 1, maxTracked: 1 });
    const first = runtime.acquire(request('a'), 's1')!;
    expect(runtime.acquire(request('b'), 's2')).toBeUndefined();
    runtime.complete('a', first.generation);
    expect(runtime.acquire(request('b'), 's2')).toBeDefined();
  });
});
