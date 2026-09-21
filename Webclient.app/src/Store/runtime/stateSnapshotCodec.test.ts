import { describe, expect, it } from 'vitest';
import type { StoreStateProjection } from './contracts';
import { decodeStoreSnapshot, encodeStoreSnapshot } from './stateSnapshotCodec';

const projection = (generatedAt = 1_000): StoreStateProjection => ({
  schemaVersion: 1,
  generatedAt,
  common: {
    moduleSelectBarVisible: false,
    windows: [],
    mapConfiguration: null,
    services: [],
    message: null,
  },
  map: {
    isUpdating: false,
    mobileRightClickEnabled: false,
    graphicsCount: 0,
    hasMapView: false,
    hasMapClickHandler: true,
  },
  contextMenu: { activeOnLeftClick: false },
  dynamicLayers: { count: 0 },
});

describe('stateSnapshotCodec', () => {
  it('round-trips a valid projection', () => {
    const encoded = encodeStoreSnapshot(projection());
    const decoded = decodeStoreSnapshot(encoded, { maxSnapshotAgeMs: 10_000 }, 2_000);
    expect(decoded.projection).toEqual(projection());
  });

  it('rejects expired snapshots', () => {
    const encoded = encodeStoreSnapshot(projection(1_000));
    expect(() => decodeStoreSnapshot(encoded, { maxSnapshotAgeMs: 500 }, 2_000))
      .toThrow(/maximum age/);
  });

  it('rejects future snapshots outside the allowed clock skew', () => {
    const encoded = encodeStoreSnapshot(projection(100_000));
    expect(() => decodeStoreSnapshot(encoded, {}, 1))
      .toThrow(/future/);
  });

  it('rejects unsupported schema versions', () => {
    const encoded = JSON.stringify({
      schemaVersion: 2,
      generatedAt: 100,
      projection: projection(100),
    });
    expect(() => decodeStoreSnapshot(encoded, {}, 100))
      .toThrow(/schema/);
  });

  it('rejects invalid JSON and malformed projection shapes', () => {
    expect(() => decodeStoreSnapshot('{broken', {}, 1)).toThrow(/valid JSON/);
    expect(() => decodeStoreSnapshot(JSON.stringify({
      schemaVersion: 1,
      generatedAt: 1,
      projection: { schemaVersion: 1 },
    }), {}, 1)).toThrow(/projection/);
  });

  it('enforces encoded and decoded byte budgets', () => {
    const huge: StoreStateProjection = {
      ...projection(1),
      common: {
        ...projection(1).common,
        mapConfiguration: { text: 'x'.repeat(10_000) },
      },
    };
    expect(() => encodeStoreSnapshot(huge, { maxSnapshotBytes: 1_024 }))
      .toThrow(/byte budget/);

    const payload = JSON.stringify({
      schemaVersion: 1,
      generatedAt: 1,
      projection: huge,
    });
    expect(() => decodeStoreSnapshot(payload, { maxSnapshotBytes: 1_024 }, 1))
      .toThrow(/byte budget/);
  });
});
