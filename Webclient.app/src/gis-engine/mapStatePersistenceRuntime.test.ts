import { describe, expect, it, vi } from 'vitest';

import {
  createGisMapStatePersistenceRuntime,
  type GisMapStateStorage,
} from './mapStatePersistenceRuntime';

const createMemoryStorage = () => {
  const values = new Map<string, string>();
  const storage: GisMapStateStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { values, storage };
};

const baseInput = () => ({
  view: {
    mode: '2d' as const,
    center: [32.85, 39.93] as const,
    spatialReferenceWkid: 4326,
    scale: 50_000,
    zoom: 12,
    rotation: 5,
  },
  basemapId: 'osm',
  layers: [
    {
      layerId: 'roads',
      visible: true,
      opacity: 0.8,
      order: 2,
    },
    {
      layerId: 'parks',
      visible: false,
      opacity: 1,
      order: 1,
    },
  ],
  temporal: {
    cursor: 50,
    start: 0,
    end: 100,
    playing: false,
    direction: 1 as const,
    stepMs: 10,
    windowMs: 20,
  },
  selections: [
    {
      layerId: 'roads',
      featureIds: [0, 2, 'A-3'],
    },
  ],
  workspace: 'operations',
  metadata: {
    theme: 'dark',
    panel: {
      active: 'layers',
    },
  },
});

describe('createGisMapStatePersistenceRuntime', () => {
  it('captures immutable versioned map session state', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
    });

    const state = runtime.capture(baseInput());

    expect(state.schemaVersion).toBe(1);
    expect(state.capturedAt).toBe(1000);
    expect(state.expiresAt).toBeNull();
    expect(state.view).toEqual({
      mode: '2d',
      center: [32.85, 39.93],
      spatialReferenceWkid: 4326,
      scale: 50_000,
      zoom: 12,
      rotation: 5,
    });
    expect(state.basemapId).toBe('osm');
    expect(state.workspace).toBe('operations');
    expect(state.fingerprint).toBeTruthy();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.view)).toBe(true);
    expect(Object.isFrozen(state.layers)).toBe(true);
    expect(Object.isFrozen(state.metadata)).toBe(true);
  });

  it('sorts persisted layers by visual order and id', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture(baseInput());

    expect(state.layers.map((layer) => layer.layerId)).toEqual([
      'parks',
      'roads',
    ]);
  });

  it('sorts selections by layer id while preserving feature id order', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture({
      ...baseInput(),
      selections: [
        { layerId: 'zeta', featureIds: [3, 2, 1] },
        { layerId: 'alpha', featureIds: ['a', 'b'] },
      ],
    });

    expect(state.selections.map((selection) => selection.layerId)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(state.selections[1]?.featureIds).toEqual([3, 2, 1]);
  });

  it('preserves numeric zero selection ids without string coercion', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture(baseInput());

    expect(state.selections[0]?.featureIds[0]).toBe(0);
  });

  it('normalizes 3D view rotation and tilt', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture({
      view: {
        mode: '3d',
        center: [32.85, 39.93, 1200],
        spatialReferenceWkid: 4326,
        rotation: -10,
        tilt: 250,
      },
    });

    expect(state.view.rotation).toBe(350);
    expect(state.view.tilt).toBe(180);
    expect(state.view.center).toEqual([32.85, 39.93, 1200]);
  });

  it('omits tilt from 2D view snapshots', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 3857,
        tilt: 45,
      },
    });

    expect('tilt' in state.view).toBe(false);
  });

  it('clamps layer opacity into the ArcGIS-compatible unit range', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 3857,
      },
      layers: [
        { layerId: 'low', visible: true, opacity: -5, order: 0 },
        { layerId: 'high', visible: true, opacity: 5, order: 1 },
      ],
    });

    expect(state.layers[0]?.opacity).toBe(0);
    expect(state.layers[1]?.opacity).toBe(1);
  });

  it('clamps temporal cursor to its declared range', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 3857,
      },
      temporal: {
        cursor: 999,
        start: 10,
        end: 20,
      },
    });

    expect(state.temporal?.cursor).toBe(20);
  });

  it('rejects inverted temporal ranges', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 3857,
      },
      temporal: {
        cursor: 10,
        start: 20,
        end: 10,
      },
    })).toThrow(/end cannot be earlier/i);
  });

  it('redacts secret-like metadata keys recursively', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    const state = runtime.capture({
      ...baseInput(),
      metadata: {
        theme: 'light',
        apiKey: 'should-not-survive',
        nested: {
          token: 'redacted',
          safe: 'kept',
          authorization: 'redacted',
          deeper: {
            ['client' + '_secret']: 'redacted',
            label: 'visible',
          },
        },
      },
    });

    expect(state.metadata).toEqual({
      theme: 'light',
      nested: {
        safe: 'kept',
        deeper: {
          label: 'visible',
        },
      },
    });
  });

  it('rejects non-finite metadata numbers', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      ...baseInput(),
      metadata: {
        invalid: Number.NaN,
      },
    })).toThrow(/metadata numbers must be finite/i);
  });

  it('rejects non-serializable metadata functions', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      ...baseInput(),
      metadata: {
        callback: () => true,
      },
    })).toThrow(/non-serializable/i);
  });

  it('rejects cyclic metadata', () => {
    const runtime = createGisMapStatePersistenceRuntime();
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;

    expect(() => runtime.capture({
      ...baseInput(),
      metadata,
    })).toThrow(/cannot contain cycles/i);
  });

  it('enforces metadata depth budgets', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxMetadataDepth: 2,
    });

    expect(() => runtime.capture({
      ...baseInput(),
      metadata: {
        one: {
          two: {
            three: {
              value: 1,
            },
          },
        },
      },
    })).toThrow(/nesting budget/i);
  });

  it('enforces metadata key budgets globally', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxMetadataKeys: 2,
    });

    expect(() => runtime.capture({
      ...baseInput(),
      metadata: {
        one: 1,
        two: 2,
        three: 3,
      },
    })).toThrow(/key budget/i);
  });

  it('truncates metadata strings to the configured safe persistence size', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxMetadataStringLength: 4,
    });

    const state = runtime.capture({
      ...baseInput(),
      metadata: {
        label: 'abcdefgh',
      },
    });

    expect(state.metadata.label).toBe('abcd');
  });

  it('enforces layer count budgets', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxLayers: 1,
    });

    expect(() => runtime.capture(baseInput())).toThrow(/layer budget exceeded/i);
  });

  it('enforces selection layer budgets', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxSelections: 1,
    });

    expect(() => runtime.capture({
      ...baseInput(),
      selections: [
        { layerId: 'a', featureIds: [1] },
        { layerId: 'b', featureIds: [2] },
      ],
    })).toThrow(/selection-layer budget/i);
  });

  it('enforces per-layer selection id budgets', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxSelectionIdsPerLayer: 2,
    });

    expect(() => runtime.capture({
      ...baseInput(),
      selections: [
        { layerId: 'a', featureIds: [1, 2, 3] },
      ],
    })).toThrow(/selection id budget/i);
  });

  it('rejects blank selected feature ids', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      ...baseInput(),
      selections: [
        { layerId: 'a', featureIds: [' '] },
      ],
    })).toThrow(/cannot be blank/i);
  });

  it('rejects invalid view modes', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      view: {
        mode: '4d' as '2d',
        center: [0, 0],
        spatialReferenceWkid: 4326,
      },
    })).toThrow(/mode must be either 2d or 3d/i);
  });

  it('rejects malformed map centers', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      view: {
        mode: '2d',
        center: [0] as unknown as readonly [number, number],
        spatialReferenceWkid: 4326,
      },
    })).toThrow(/two or three/i);
  });

  it('rejects invalid spatial reference wkids', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 0,
      },
    })).toThrow(/wkid/i);
  });

  it('rejects non-positive scales and negative zoom levels', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 4326,
        scale: 0,
      },
    })).toThrow(/scale must be positive/i);

    expect(() => runtime.capture({
      view: {
        mode: '2d',
        center: [0, 0],
        spatialReferenceWkid: 4326,
        zoom: -1,
      },
    })).toThrow(/zoom cannot be negative/i);
  });

  it('round-trips encoded states with fingerprint integrity', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());

    const encoded = runtime.encode(state);
    const decoded = runtime.decode(encoded);

    expect(decoded.expired).toBe(false);
    expect(decoded.state).toEqual(state);
  });

  it('rejects malformed URI encoding', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.decode('%E0%A4%A')).toThrow(/URI data/i);
  });

  it('rejects malformed JSON encoding', () => {
    const runtime = createGisMapStatePersistenceRuntime();

    expect(() => runtime.decode(encodeURIComponent('{nope'))).toThrow(/valid JSON/i);
  });

  it('rejects unsupported schema versions', () => {
    const runtime = createGisMapStatePersistenceRuntime();
    const encoded = encodeURIComponent(JSON.stringify({
      schemaVersion: 99,
    }));

    expect(() => runtime.decode(encoded)).toThrow(/unsupported/i);
  });

  it('rejects tampered persisted state through deterministic fingerprint validation', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());
    const raw = JSON.parse(decodeURIComponent(runtime.encode(state))) as Record<string, unknown>;
    raw.workspace = 'tampered';

    expect(() => runtime.decode(encodeURIComponent(JSON.stringify(raw))))
      .toThrow(/fingerprint validation failed/i);
  });

  it('enforces encoded-state length budgets on both write and read', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      maxEncodedLength: 128,
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());

    expect(() => runtime.encode(state)).toThrow(/length budget/i);
    expect(() => runtime.decode('x'.repeat(129))).toThrow(/length budget/i);
  });

  it('applies TTL to newly captured states', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
      ttlMs: 500,
    });

    const state = runtime.capture(baseInput());

    expect(state.expiresAt).toBe(1500);
  });

  it('rejects expired states by default', () => {
    let clock = 1000;
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => clock,
      ttlMs: 100,
    });
    const state = runtime.capture(baseInput());
    const encoded = runtime.encode(state);

    clock = 1101;

    expect(() => runtime.decode(encoded)).toThrow(/expired/i);
  });

  it('can decode expired state explicitly for recovery workflows', () => {
    let clock = 1000;
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => clock,
      ttlMs: 100,
    });
    const state = runtime.capture(baseInput());
    const encoded = runtime.encode(state);

    clock = 1200;

    const decoded = runtime.decode(encoded, { allowExpired: true });

    expect(decoded.expired).toBe(true);
    expect(decoded.state.fingerprint).toBe(state.fingerprint);
  });

  it('uses a deterministic prefixed storage key', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      keyPrefix: 'gis:',
    });

    expect(runtime.storageKey('session-1')).toBe('gis:session-1');
  });

  it('saves and loads through an injected sync storage adapter', async () => {
    const { values, storage } = createMemoryStorage();
    const runtime = createGisMapStatePersistenceRuntime({
      storage,
      keyPrefix: 'gis:',
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());

    const target = await runtime.save('one', state);

    expect(target).toBe('gis:one');
    expect(values.has('gis:one')).toBe(true);

    const loaded = await runtime.load('one');

    expect(loaded?.state).toEqual(state);
  });

  it('supports asynchronous storage adapters', async () => {
    const values = new Map<string, string>();
    const storage: GisMapStateStorage = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    };
    const runtime = createGisMapStatePersistenceRuntime({
      storage,
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());

    await runtime.save('async', state);
    expect((await runtime.load('async'))?.state).toEqual(state);

    await runtime.remove('async');
    expect(await runtime.load('async')).toBeNull();
  });

  it('returns null when configured storage has no matching session', async () => {
    const { storage } = createMemoryStorage();
    const runtime = createGisMapStatePersistenceRuntime({ storage });

    expect(await runtime.load('missing')).toBeNull();
  });

  it('throws a clear error when persistence is requested without storage', async () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());

    await expect(runtime.save('one', state)).rejects.toThrow(/storage adapter/i);
    await expect(runtime.load('one')).rejects.toThrow(/storage adapter/i);
    await expect(runtime.remove('one')).rejects.toThrow(/storage adapter/i);
  });

  it('removes stored state using the same key normalization policy', async () => {
    const { values, storage } = createMemoryStorage();
    const removeSpy = vi.spyOn(storage, 'removeItem');
    const runtime = createGisMapStatePersistenceRuntime({
      storage,
      keyPrefix: 'state:',
      now: () => 1000,
    });
    const state = runtime.capture(baseInput());

    await runtime.save('workspace', state);
    expect(values.has('state:workspace')).toBe(true);

    await runtime.remove('workspace');

    expect(removeSpy).toHaveBeenCalledWith('state:workspace');
    expect(values.has('state:workspace')).toBe(false);
  });

  it('generates different fingerprints when visible layer state changes', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
    });

    const first = runtime.capture(baseInput());
    const second = runtime.capture({
      ...baseInput(),
      layers: baseInput().layers.map((layer) => (
        layer.layerId === 'roads'
          ? { ...layer, visible: false }
          : layer
      )),
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('generates stable fingerprints for semantically identical sorted layer inputs', () => {
    const runtime = createGisMapStatePersistenceRuntime({
      now: () => 1000,
    });

    const first = runtime.capture(baseInput());
    const input = baseInput();
    const second = runtime.capture({
      ...input,
      layers: [...input.layers].reverse(),
    });

    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
