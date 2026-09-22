import { describe, expect, it } from 'vitest';
import {
  createSpatialSelectionIndexRuntime,
  type SelectionBounds,
  type SpatialSelectionRecord,
} from './spatialSelectionIndexRuntime';

type Payload = Readonly<{ ordinal: number }>;
const bounds = (n = 0): SelectionBounds => ({ xmin: n, ymin: n, xmax: n + 1, ymax: n + 1 });
const record = (id: string, layerId: string, estimatedBytes: number, priority: 'background' | 'normal' | 'high' | 'critical' = 'normal'): Omit<SpatialSelectionRecord<Payload>, 'revision'> => ({ id, layerId, bounds: bounds(Number(id.replace(/\D/gu, '')) || 0), priority, payload: { ordinal: Number(id.replace(/\D/gu, '')) || 0 }, estimatedBytes });
const reasons = (runtime: ReturnType<typeof createSpatialSelectionIndexRuntime<Payload>>): readonly (string | null)[] => runtime.history().filter((event) => event.kind === 'evict').map((event) => event.reason);
const ids = (runtime: ReturnType<typeof createSpatialSelectionIndexRuntime<Payload>>, layerId: string): readonly string[] => runtime.recordsForLayer(layerId).map((entry) => entry.id);

describe('SpatialSelectionIndexRuntime budget precedence', () => {
  it('attributes simultaneous normalized entry pressure to the global budget', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2 });
    runtime.upsert(record('r1', 'same', 10, 'background'));
    runtime.upsert(record('r2', 'same', 10, 'critical'));
    runtime.upsert(record('r3', 'same', 10, 'high'));
    expect(reasons(runtime)).toContain('global-entry-budget');
    expect(reasons(runtime)).not.toContain('layer-entry-budget');
    expect(runtime.snapshot().entries).toBe(2);
    expect(ids(runtime, 'same')).toEqual(['r2', 'r3']);
  });

  it('attributes simultaneous normalized byte pressure to the global budget', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 10, maxBytes: 200 });
    runtime.upsert(record('r1', 'same', 100, 'background'));
    runtime.upsert(record('r2', 'same', 100, 'critical'));
    runtime.upsert(record('r3', 'same', 100, 'high'));
    expect(reasons(runtime)).toContain('global-byte-budget');
    expect(reasons(runtime)).not.toContain('layer-byte-budget');
    expect(runtime.snapshot().estimatedBytes).toBe(200);
    expect(ids(runtime, 'same')).toEqual(['r2', 'r3']);
  });

  it('keeps explicit per-layer entry pressure independently attributable', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 8, maxEntriesPerLayer: 2 });
    runtime.upsert(record('a1', 'a', 10, 'background'));
    runtime.upsert(record('b1', 'b', 10));
    runtime.upsert(record('a2', 'a', 10, 'critical'));
    runtime.upsert(record('a3', 'a', 10, 'high'));
    expect(reasons(runtime)).toContain('layer-entry-budget');
    expect(reasons(runtime)).not.toContain('global-entry-budget');
    expect(ids(runtime, 'a')).toEqual(['a2', 'a3']);
    expect(ids(runtime, 'b')).toEqual(['b1']);
  });

  it('keeps explicit per-layer byte pressure independently attributable', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 8, maxBytes: 1_000, maxBytesPerLayer: 200 });
    runtime.upsert(record('a1', 'a', 120, 'background'));
    runtime.upsert(record('b1', 'b', 120));
    runtime.upsert(record('a2', 'a', 120, 'critical'));
    expect(reasons(runtime)).toContain('layer-byte-budget');
    expect(reasons(runtime)).not.toContain('global-byte-budget');
    expect(ids(runtime, 'a')).toEqual(['a2']);
    expect(ids(runtime, 'b')).toEqual(['b1']);
  });

  it('preserves layer-count precedence as an orthogonal ownership invariant', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2, maxLayers: 2 });
    runtime.upsert(record('r1', 'critical-layer', 10, 'critical'));
    runtime.upsert(record('r2', 'background-layer', 10, 'background'));
    runtime.upsert(record('r3', 'normal-layer', 10, 'normal'));
    expect(reasons(runtime)[0]).toBe('layer-count-budget');
    expect(runtime.layerSnapshots().map((layer) => layer.layerId).sort()).toEqual(['critical-layer', 'normal-layer']);
    expect(runtime.snapshot().entries).toBe(2);
  });

  it('uses global entry attribution across layers when global capacity alone binds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 3, maxEntriesPerLayer: 3 });
    runtime.upsert(record('r1', 'a', 10, 'background'));
    runtime.upsert(record('r2', 'a', 10, 'critical'));
    runtime.upsert(record('r3', 'b', 10, 'high'));
    runtime.upsert(record('r4', 'b', 10, 'normal'));
    expect(reasons(runtime)).toEqual(['global-entry-budget']);
    expect(runtime.has('r1')).toBe(false);
    expect(runtime.has('r2')).toBe(true);
    expect(runtime.has('r3')).toBe(true);
    expect(runtime.has('r4')).toBe(true);
  });

  it('uses global byte attribution across layers when global memory alone binds', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 10, maxBytes: 300, maxBytesPerLayer: 300 });
    runtime.upsert(record('r1', 'a', 100, 'background'));
    runtime.upsert(record('r2', 'a', 100, 'critical'));
    runtime.upsert(record('r3', 'b', 100, 'high'));
    runtime.upsert(record('r4', 'b', 100, 'normal'));
    expect(reasons(runtime)).toEqual(['global-byte-budget']);
    expect(runtime.snapshot().estimatedBytes).toBe(300);
    expect(runtime.has('r1')).toBe(false);
  });

  it('keeps deterministic priority ordering under repeated global entry pressure', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 3 });
    runtime.upsert(record('r1', 'same', 10, 'background'));
    runtime.upsert(record('r2', 'same', 10, 'normal'));
    runtime.upsert(record('r3', 'same', 10, 'high'));
    runtime.upsert(record('r4', 'same', 10, 'critical'));
    runtime.upsert(record('r5', 'same', 10, 'normal'));
    expect(ids(runtime, 'same')).toEqual(['r4', 'r3', 'r5']);
    expect(reasons(runtime)).toEqual(['global-entry-budget', 'global-entry-budget']);
  });

  it('keeps deterministic priority ordering under repeated global byte pressure', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 10, maxBytes: 300 });
    runtime.upsert(record('r1', 'same', 100, 'background'));
    runtime.upsert(record('r2', 'same', 100, 'normal'));
    runtime.upsert(record('r3', 'same', 100, 'high'));
    runtime.upsert(record('r4', 'same', 100, 'critical'));
    runtime.upsert(record('r5', 'same', 100, 'normal'));
    expect(ids(runtime, 'same')).toEqual(['r4', 'r3', 'r5']);
    expect(reasons(runtime)).toEqual(['global-byte-budget', 'global-byte-budget']);
  });

  it('does not misattribute replacement accounting as a budget eviction', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2, maxBytes: 200 });
    runtime.upsert(record('r1', 'same', 100));
    runtime.upsert(record('r2', 'same', 100, 'high'));
    runtime.upsert(record('r1', 'same', 80, 'critical'));
    expect(reasons(runtime)).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({ entries: 2, estimatedBytes: 180, evictions: 0 });
    expect(ids(runtime, 'same')).toEqual(['r1', 'r2']);
  });

  it('re-evaluates global bytes after a smaller replacement without stale accounting', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 4, maxBytes: 250 });
    runtime.upsert(record('r1', 'a', 120, 'high'));
    runtime.upsert(record('r2', 'b', 120, 'critical'));
    runtime.upsert(record('r1', 'a', 40, 'high'));
    runtime.upsert(record('r3', 'a', 90, 'normal'));
    expect(runtime.snapshot().estimatedBytes).toBe(250);
    expect(runtime.snapshot().evictions).toBe(0);
    expect(reasons(runtime)).toEqual([]);
  });

  it('records global entry pressure in bounded history without changing survivors', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 2, maxHistory: 3 });
    runtime.upsert(record('r1', 'same', 10, 'background'));
    runtime.upsert(record('r2', 'same', 10, 'normal'));
    runtime.upsert(record('r3', 'same', 10, 'high'));
    runtime.upsert(record('r4', 'same', 10, 'critical'));
    expect(runtime.history().length).toBeLessThanOrEqual(3);
    expect(reasons(runtime)).toContain('global-entry-budget');
    expect(ids(runtime, 'same')).toEqual(['r4', 'r3']);
  });

  it('records global byte pressure in bounded history without changing accounting', () => {
    const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 10, maxBytes: 200, maxHistory: 3 });
    runtime.upsert(record('r1', 'same', 100, 'background'));
    runtime.upsert(record('r2', 'same', 100, 'normal'));
    runtime.upsert(record('r3', 'same', 100, 'high'));
    runtime.upsert(record('r4', 'same', 100, 'critical'));
    expect(runtime.history().length).toBeLessThanOrEqual(3);
    expect(reasons(runtime)).toContain('global-byte-budget');
    expect(runtime.snapshot().estimatedBytes).toBe(200);
    expect(ids(runtime, 'same')).toEqual(['r4', 'r3']);
  });

  it('keeps global precedence deterministic across identical admission sequences', () => {
    const execute = () => {
      const runtime = createSpatialSelectionIndexRuntime<Payload>({ maxEntries: 3, maxBytes: 300 });
      runtime.upsert(record('r1', 'same', 100, 'background'));
      runtime.upsert(record('r2', 'same', 100, 'normal'));
      runtime.upsert(record('r3', 'same', 100, 'high'));
      runtime.upsert(record('r4', 'same', 100, 'critical'));
      runtime.upsert(record('r5', 'same', 100, 'normal'));
      return { reasons: reasons(runtime), survivors: ids(runtime, 'same') };
    };
    expect(execute()).toEqual(execute());
    expect(execute().survivors).toEqual(['r4', 'r3', 'r5']);
    expect(execute().reasons.every((reason) => reason === 'global-entry-budget')).toBe(true);
  });
});
