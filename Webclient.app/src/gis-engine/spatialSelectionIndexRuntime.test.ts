import { describe, expect, it } from 'vitest';
import { SpatialSelectionIndexRuntime } from './spatialSelectionIndexRuntime';

const bounds = (xmin: number, ymin: number, xmax: number, ymax: number) => ({ xmin, ymin, xmax, ymax });
const record = (id: string, layerId = 'places', priority: 'background' | 'normal' | 'high' | 'critical' = 'normal', estimatedBytes = 10) => ({ id, layerId, priority, estimatedBytes, bounds: bounds(0, 0, 10, 10), payload: { id } });

describe('SpatialSelectionIndexRuntime', () => {
  it('indexes and queries intersecting selections deterministically', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert(record('b', 'places', 'normal'));
    runtime.upsert(record('a', 'places', 'high'));
    runtime.upsert({ ...record('outside'), bounds: bounds(20, 20, 30, 30) });
    expect(runtime.query({ bounds: bounds(5, 5, 6, 6) }).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('applies layer filters and minimum priority', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert(record('normal', 'a', 'normal'));
    runtime.upsert(record('high', 'a', 'high'));
    runtime.upsert(record('critical', 'b', 'critical'));
    expect(runtime.query({ bounds: bounds(0, 0, 10, 10), layerIds: new Set(['a']), minimumPriority: 'high' }).map((item) => item.id)).toEqual(['high']);
  });

  it('enforces a bounded result limit', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxQueryResults: 2 });
    for (let index = 0; index < 5; index += 1) runtime.upsert(record(`id-${index}`));
    expect(runtime.query({ bounds: bounds(0, 0, 10, 10), limit: 99 })).toHaveLength(2);
  });

  it('evicts lower-priority entries first under entry pressure', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxEntries: 2 });
    runtime.upsert(record('critical', 'a', 'critical'));
    runtime.upsert(record('background', 'a', 'background'));
    runtime.upsert(record('high', 'a', 'high'));
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('high')).toBe(true);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.snapshot().evictions).toBe(1);
  });

  it('evicts least recently touched records for equal priority', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxEntries: 2 });
    runtime.upsert(record('old'));
    runtime.upsert(record('recent'));
    runtime.get('old');
    runtime.upsert(record('new'));
    expect(runtime.has('old')).toBe(true);
    expect(runtime.has('new')).toBe(true);
    expect(runtime.has('recent')).toBe(false);
  });

  it('enforces byte budgets', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxBytes: 20, maxEntries: 10 });
    runtime.upsert(record('a', 'x', 'normal', 10));
    runtime.upsert(record('b', 'x', 'normal', 10));
    runtime.upsert(record('c', 'x', 'high', 10));
    expect(runtime.snapshot().estimatedBytes).toBeLessThanOrEqual(20);
    expect(runtime.snapshot().entries).toBe(2);
  });

  it('rejects a single entry larger than the byte budget', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxBytes: 20 });
    expect(runtime.upsert(record('huge', 'x', 'critical', 21))).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ entries: 0, rejected: 1 });
  });

  it('enforces per-layer cardinality without evicting other layers', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxEntriesPerLayer: 1, maxEntries: 10 });
    runtime.upsert(record('a1', 'a', 'normal'));
    runtime.upsert(record('b1', 'b', 'normal'));
    runtime.upsert(record('a2', 'a', 'high'));
    expect(runtime.has('a1')).toBe(false);
    expect(runtime.has('a2')).toBe(true);
    expect(runtime.has('b1')).toBe(true);
  });

  it('replaces entries without leaking byte accounting or layer membership', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxBytes: 100 });
    runtime.upsert(record('same', 'old', 'normal', 40));
    runtime.upsert(record('same', 'new', 'high', 15));
    expect(runtime.snapshot()).toMatchObject({ entries: 1, estimatedBytes: 15, layers: 1 });
    expect(runtime.query({ bounds: bounds(0, 0, 10, 10), layerIds: new Set(['old']) })).toHaveLength(0);
    expect(runtime.query({ bounds: bounds(0, 0, 10, 10), layerIds: new Set(['new']) })).toHaveLength(1);
  });

  it('removes a complete layer', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert(record('a', 'one'));
    runtime.upsert(record('b', 'one'));
    runtime.upsert(record('c', 'two'));
    expect(runtime.removeLayer('one')).toBe(2);
    expect(runtime.snapshot()).toMatchObject({ entries: 1, layers: 1 });
  });

  it('returns nearest bounds using point-to-rectangle distance', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert({ ...record('near'), bounds: bounds(10, 10, 20, 20) });
    runtime.upsert({ ...record('far'), bounds: bounds(100, 100, 110, 110) });
    expect(runtime.nearest({ x: 0, y: 0 }, 1).map((item) => item.id)).toEqual(['near']);
  });

  it('returns zero-distance containing bounds before remote bounds', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert({ ...record('contains', 'a', 'normal'), bounds: bounds(-1, -1, 1, 1) });
    runtime.upsert({ ...record('remote', 'a', 'critical'), bounds: bounds(2, 2, 3, 3) });
    expect(runtime.nearest({ x: 0, y: 0 }, 1)[0]?.id).toBe('contains');
  });

  it('uses priority to break equal-distance nearest ties', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert({ ...record('normal', 'a', 'normal'), bounds: bounds(1, 0, 2, 1) });
    runtime.upsert({ ...record('critical', 'a', 'critical'), bounds: bounds(-2, 0, -1, 1) });
    expect(runtime.nearest({ x: 0, y: 0 }, 1)[0]?.id).toBe('critical');
  });

  it('bounds mutation history', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxHistory: 2 });
    runtime.upsert(record('a'));
    runtime.upsert(record('b'));
    runtime.remove('a');
    expect(runtime.history()).toHaveLength(2);
    expect(runtime.history().map((item) => item.kind)).toEqual(['upsert', 'remove']);
  });

  it('records evictions in history', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>({ maxEntries: 1 });
    runtime.upsert(record('a', 'x', 'background'));
    runtime.upsert(record('b', 'x', 'critical'));
    expect(runtime.history().some((item) => item.kind === 'evict' && item.id === 'a')).toBe(true);
  });

  it('clear resets records and bytes but preserves bounded audit evidence', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert(record('a', 'x', 'normal', 50));
    runtime.clear();
    expect(runtime.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, layers: 0 });
    expect(runtime.history().at(-1)?.kind).toBe('clear');
  });

  it('normalizes negative zero in bounds', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    const inserted = runtime.upsert({ ...record('a'), bounds: bounds(-0, -0, 1, 1) });
    expect(Object.is(inserted?.bounds.xmin, -0)).toBe(false);
  });

  it('rejects inverted bounds', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    expect(() => runtime.upsert({ ...record('bad'), bounds: bounds(2, 0, 1, 1) })).toThrow(/minimum/);
  });

  it('rejects non-finite query coordinates', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    expect(() => runtime.query({ bounds: bounds(0, 0, Number.POSITIVE_INFINITY, 1) })).toThrow(/finite/);
  });

  it('rejects invalid constructor budgets', () => {
    expect(() => new SpatialSelectionIndexRuntime({ maxEntries: 0 })).toThrow(/positive/);
    expect(() => new SpatialSelectionIndexRuntime({ maxBytes: -1 })).toThrow(/positive/);
  });

  it('rejects empty identifiers', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    expect(() => runtime.upsert({ ...record('x'), id: ' ' })).toThrow(/empty/);
    expect(() => runtime.upsert({ ...record('x'), layerId: ' ' })).toThrow(/empty/);
  });

  it('increments revisions across mutations', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    const first = runtime.upsert(record('a'));
    const second = runtime.upsert(record('b'));
    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(2);
    runtime.remove('a');
    expect(runtime.snapshot().revision).toBe(3);
  });

  it('does not increment revision for a missing removal', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    expect(runtime.remove('missing')).toBe(false);
    expect(runtime.snapshot().revision).toBe(0);
  });

  it('does not mutate caller layer filters', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert(record('a', 'layer'));
    const filter = new Set(['layer']);
    runtime.query({ bounds: bounds(0, 0, 10, 10), layerIds: filter });
    expect([...filter]).toEqual(['layer']);
  });

  it('disposes deterministically and rejects later access', () => {
    const runtime = new SpatialSelectionIndexRuntime<{ id: string }>();
    runtime.upsert(record('a'));
    runtime.dispose();
    expect(runtime.disposed).toBe(true);
    expect(() => runtime.get('a')).toThrow(/disposed/);
    expect(runtime.history()).toEqual([]);
  });

  it('dispose is idempotent', () => {
    const runtime = new SpatialSelectionIndexRuntime();
    runtime.dispose();
    expect(() => runtime.dispose()).not.toThrow();
  });
});
