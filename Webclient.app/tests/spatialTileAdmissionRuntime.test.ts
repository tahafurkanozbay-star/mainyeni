import { describe, expect, it } from 'vitest';
import { SpatialTileAdmissionRuntime } from '../src/gis-engine/spatialTileAdmissionRuntime';

const request = (key: string, layerId = 'roads', estimatedBytes = 10, priority: 'critical' | 'interactive' | 'prefetch' = 'interactive') => ({
  key,
  layerId,
  estimatedBytes,
  priority,
} as const);

describe('SpatialTileAdmissionRuntime', () => {
  it('admits work immediately while active budgets allow it', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 2, maxPerLayer: 2 });
    expect(runtime.admit(request('a'))).toEqual({ key: 'a', state: 'active' });
    expect(runtime.admit(request('b'))).toEqual({ key: 'b', state: 'active' });
    expect(runtime.snapshot().activeCount).toBe(2);
  });

  it('queues work when active concurrency is exhausted', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1 });
    runtime.admit(request('a'));
    expect(runtime.admit(request('b'))).toEqual({ key: 'b', state: 'queued' });
    expect(runtime.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 1 });
  });

  it('promotes critical work before older lower-priority work', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1 });
    runtime.admit(request('active'));
    runtime.admit(request('prefetch', 'roads', 10, 'prefetch'));
    runtime.admit(request('critical', 'roads', 10, 'critical'));
    expect(runtime.release('active')).toEqual([{ key: 'critical', state: 'active' }]);
  });

  it('preserves FIFO order inside one priority class', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1 });
    runtime.admit(request('active'));
    runtime.admit(request('first'));
    runtime.admit(request('second'));
    expect(runtime.release('active')).toEqual([{ key: 'first', state: 'active' }]);
    expect(runtime.release('first')).toEqual([{ key: 'second', state: 'active' }]);
  });

  it('deduplicates active identities', () => {
    const runtime = new SpatialTileAdmissionRuntime();
    expect(runtime.admit(request('same'))).toEqual({ key: 'same', state: 'active' });
    expect(runtime.admit(request(' same '))).toEqual({ key: 'same', state: 'active' });
    expect(runtime.snapshot().activeCount).toBe(1);
  });

  it('deduplicates queued identities', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1 });
    runtime.admit(request('active'));
    expect(runtime.admit(request('same'))).toEqual({ key: 'same', state: 'queued' });
    expect(runtime.admit(request(' same '))).toEqual({ key: 'same', state: 'queued' });
    expect(runtime.snapshot().queuedCount).toBe(1);
  });

  it('fails closed for malformed identities', () => {
    const runtime = new SpatialTileAdmissionRuntime();
    expect(runtime.admit(request(''))).toBeUndefined();
    expect(runtime.admit(request('bad\nkey'))).toBeUndefined();
    expect(runtime.admit(request('ok', ''))).toBeUndefined();
    expect(runtime.snapshot().activeCount).toBe(0);
  });

  it('fails closed for invalid byte estimates', () => {
    const runtime = new SpatialTileAdmissionRuntime();
    expect(runtime.admit(request('zero', 'roads', 0))).toBeUndefined();
    expect(runtime.admit(request('fraction', 'roads', 1.5))).toBeUndefined();
    expect(runtime.admit(request('nan', 'roads', Number.NaN))).toBeUndefined();
  });

  it('rejects entries that can never fit active byte capacity', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActiveBytes: 20, maxPerLayerBytes: 20 });
    expect(runtime.admit(request('large', 'roads', 21))).toBeUndefined();
    expect(runtime.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0 });
  });

  it('enforces global active byte capacity', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 3, maxPerLayer: 3, maxActiveBytes: 20, maxPerLayerBytes: 20 });
    runtime.admit(request('a', 'roads', 15));
    expect(runtime.admit(request('b', 'roads', 10))).toEqual({ key: 'b', state: 'queued' });
  });

  it('enforces per-layer concurrency without blocking other layers', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 3, maxPerLayer: 1 });
    runtime.admit(request('road-a', 'roads'));
    expect(runtime.admit(request('road-b', 'roads'))).toEqual({ key: 'road-b', state: 'queued' });
    expect(runtime.admit(request('park-a', 'parks'))).toEqual({ key: 'park-a', state: 'active' });
  });

  it('enforces per-layer active byte capacity', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 3, maxPerLayer: 3, maxActiveBytes: 100, maxPerLayerBytes: 15 });
    runtime.admit(request('a', 'roads', 10));
    expect(runtime.admit(request('b', 'roads', 10))).toEqual({ key: 'b', state: 'queued' });
    expect(runtime.admit(request('c', 'parks', 10))).toEqual({ key: 'c', state: 'active' });
  });

  it('enforces queue entry capacity', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1, maxQueued: 1 });
    runtime.admit(request('active'));
    expect(runtime.admit(request('queued'))?.state).toBe('queued');
    expect(runtime.admit(request('overflow'))).toBeUndefined();
  });

  it('enforces queue byte capacity', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1, maxQueuedBytes: 15 });
    runtime.admit(request('active'));
    runtime.admit(request('queued', 'roads', 10));
    expect(runtime.admit(request('overflow', 'roads', 10))).toBeUndefined();
  });

  it('releases queued work without disturbing active work', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1 });
    runtime.admit(request('active'));
    runtime.admit(request('queued'));
    expect(runtime.release('queued')).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });
  });

  it('returns an empty transition for unknown release identities', () => {
    const runtime = new SpatialTileAdmissionRuntime();
    runtime.admit(request('active'));
    expect(runtime.release('missing')).toEqual([]);
    expect(runtime.snapshot().activeCount).toBe(1);
  });

  it('cancels one layer across active and queued state', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 2, maxPerLayer: 1 });
    runtime.admit(request('road-a', 'roads'));
    runtime.admit(request('park-a', 'parks'));
    runtime.admit(request('road-b', 'roads'));
    expect(runtime.cancelLayer('roads')).toEqual(['road-a', 'road-b']);
    expect(runtime.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0 });
  });

  it('reports deterministic per-layer diagnostics', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 2, maxPerLayer: 1 });
    runtime.admit(request('road-a', 'roads', 7));
    runtime.admit(request('park-a', 'parks', 11));
    runtime.admit(request('road-b', 'roads', 13));
    expect(runtime.snapshot()).toEqual({
      activeCount: 2,
      activeBytes: 18,
      queuedCount: 1,
      queuedBytes: 13,
      activeByLayer: { roads: 1, parks: 1 },
      queuedByLayer: { roads: 1 },
    });
  });

  it('clears all work and returns sorted identities', () => {
    const runtime = new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 1 });
    runtime.admit(request('z'));
    runtime.admit(request('a'));
    expect(runtime.clear()).toEqual(['a', 'z']);
    expect(runtime.snapshot()).toMatchObject({ activeCount: 0, queuedCount: 0, activeBytes: 0, queuedBytes: 0 });
  });

  it('validates impossible limit combinations', () => {
    expect(() => new SpatialTileAdmissionRuntime({ maxActive: 1, maxPerLayer: 2 })).toThrow(RangeError);
    expect(() => new SpatialTileAdmissionRuntime({ maxActiveBytes: 10, maxPerLayerBytes: 11 })).toThrow(RangeError);
    expect(() => new SpatialTileAdmissionRuntime({ maxQueued: 0 })).toThrow(RangeError);
  });

  it('keeps snapshots and returned collections immutable', () => {
    const runtime = new SpatialTileAdmissionRuntime();
    runtime.admit(request('a'));
    const snapshot = runtime.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.activeByLayer)).toBe(true);
    expect(Object.isFrozen(runtime.clear())).toBe(true);
  });
});
