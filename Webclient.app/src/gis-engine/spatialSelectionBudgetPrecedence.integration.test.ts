import { describe, expect, it } from 'vitest';
import { createSpatialSelectionIndexRuntime } from './spatialSelectionIndexRuntime';

const make = (
  id: string,
  layerId: string,
  estimatedBytes: number,
  priority: 'background' | 'normal' | 'high' | 'critical',
) => ({
  id,
  layerId,
  bounds: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
  priority,
  payload: { id },
  estimatedBytes,
});

const evictionReasons = (
  runtime: ReturnType<typeof createSpatialSelectionIndexRuntime<{ id: string }>>,
) => runtime.history()
  .filter((event) => event.kind === 'evict')
  .map((event) => event.reason);

describe('spatial selection budget precedence integration', () => {
  it('keeps global entry attribution stable when the admitted record belongs to another layer', () => {
    const runtime = createSpatialSelectionIndexRuntime<{ id: string }>({
      maxEntries: 2,
    });
    runtime.upsert(make('background', 'layer-a', 10, 'background'));
    runtime.upsert(make('critical', 'layer-a', 10, 'critical'));
    runtime.upsert(make('high', 'layer-b', 10, 'high'));

    expect(evictionReasons(runtime)).toEqual(['global-entry-budget']);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('high')).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ entries: 2, evictions: 1 });
  });

  it('keeps global byte attribution stable when the admitted record belongs to another layer', () => {
    const runtime = createSpatialSelectionIndexRuntime<{ id: string }>({
      maxEntries: 10,
      maxBytes: 200,
    });
    runtime.upsert(make('background', 'layer-a', 100, 'background'));
    runtime.upsert(make('critical', 'layer-a', 100, 'critical'));
    runtime.upsert(make('high', 'layer-b', 100, 'high'));

    expect(evictionReasons(runtime)).toEqual(['global-byte-budget']);
    expect(runtime.has('background')).toBe(false);
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('high')).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ estimatedBytes: 200, evictions: 1 });
  });

  it('does not turn independent layer entry pressure into global attribution', () => {
    const runtime = createSpatialSelectionIndexRuntime<{ id: string }>({
      maxEntries: 6,
      maxEntriesPerLayer: 2,
    });
    runtime.upsert(make('a-background', 'layer-a', 10, 'background'));
    runtime.upsert(make('a-critical', 'layer-a', 10, 'critical'));
    runtime.upsert(make('b-normal', 'layer-b', 10, 'normal'));
    runtime.upsert(make('a-high', 'layer-a', 10, 'high'));

    expect(evictionReasons(runtime)).toEqual(['layer-entry-budget']);
    expect(runtime.has('a-background')).toBe(false);
    expect(runtime.has('a-critical')).toBe(true);
    expect(runtime.has('a-high')).toBe(true);
    expect(runtime.has('b-normal')).toBe(true);
  });

  it('does not turn independent layer byte pressure into global attribution', () => {
    const runtime = createSpatialSelectionIndexRuntime<{ id: string }>({
      maxEntries: 10,
      maxBytes: 1_000,
      maxBytesPerLayer: 200,
    });
    runtime.upsert(make('a-background', 'layer-a', 120, 'background'));
    runtime.upsert(make('b-normal', 'layer-b', 120, 'normal'));
    runtime.upsert(make('a-critical', 'layer-a', 120, 'critical'));

    expect(evictionReasons(runtime)).toEqual(['layer-byte-budget']);
    expect(runtime.has('a-background')).toBe(false);
    expect(runtime.has('a-critical')).toBe(true);
    expect(runtime.has('b-normal')).toBe(true);
    expect(runtime.snapshot().estimatedBytes).toBe(240);
  });

  it('keeps layer-count eviction orthogonal to simultaneous global capacity', () => {
    const runtime = createSpatialSelectionIndexRuntime<{ id: string }>({
      maxEntries: 2,
      maxLayers: 2,
    });
    runtime.upsert(make('critical', 'critical-layer', 10, 'critical'));
    runtime.upsert(make('background', 'background-layer', 10, 'background'));
    runtime.upsert(make('normal', 'normal-layer', 10, 'normal'));

    expect(evictionReasons(runtime)[0]).toBe('layer-count-budget');
    expect(runtime.has('background')).toBe(false);
    expect(runtime.has('critical')).toBe(true);
    expect(runtime.has('normal')).toBe(true);
    expect(runtime.snapshot().entries).toBe(2);
  });
});
