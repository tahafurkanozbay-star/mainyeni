import { describe, expect, it } from 'vitest';
import type { StoreStateProjection } from './contracts';
import { createStoreCheckpointRuntime } from './stateCheckpointRuntime';

const projection = (id: number, generatedAt = 1_000): StoreStateProjection => ({
  schemaVersion: 1,
  generatedAt,
  common: {
    moduleSelectBarVisible: id % 2 === 0,
    windows: [],
    mapConfiguration: { checkpoint: id },
    services: [],
    message: null,
  },
  map: {
    isUpdating: false,
    mobileRightClickEnabled: false,
    graphicsCount: id,
    hasMapView: false,
    hasMapClickHandler: true,
  },
  contextMenu: { activeOnLeftClick: false },
  dynamicLayers: { count: 0 },
});

describe('stateCheckpointRuntime', () => {
  it('saves and loads only encoded safe projections', () => {
    const checkpoints = createStoreCheckpointRuntime();
    const metadata = checkpoints.save('before-search', projection(1));
    expect(metadata.id).toBe('before-search');
    expect(metadata.bytes).toBeGreaterThan(0);
    expect(checkpoints.load('before-search', 1_500)).toEqual(projection(1));
  });

  it('replaces checkpoint ids without leaking byte accounting', () => {
    const checkpoints = createStoreCheckpointRuntime();
    checkpoints.save('x', projection(1));
    const firstBytes = checkpoints.totalBytes;
    checkpoints.save('x', projection(2));
    expect(checkpoints.size).toBe(1);
    expect(checkpoints.totalBytes).toBeGreaterThan(0);
    expect(checkpoints.totalBytes).not.toBe(firstBytes + checkpoints.list()[0]!.bytes);
  });

  it('evicts least-recently-used checkpoints by capacity', () => {
    const checkpoints = createStoreCheckpointRuntime({ maxCheckpoints: 2 });
    checkpoints.save('a', projection(1));
    checkpoints.save('b', projection(2));
    expect(checkpoints.load('a', 1_500)).not.toBeNull();
    checkpoints.save('c', projection(3));
    expect(checkpoints.load('b', 1_500)).toBeNull();
    expect(checkpoints.load('a', 1_500)).not.toBeNull();
    expect(checkpoints.load('c', 1_500)).not.toBeNull();
  });

  it('drops expired checkpoints on load', () => {
    const checkpoints = createStoreCheckpointRuntime({
      limits: { maxSnapshotAgeMs: 500 },
    });
    checkpoints.save('expired', projection(1, 1_000));
    expect(checkpoints.load('expired', 2_000)).toBeNull();
    expect(checkpoints.size).toBe(0);
  });

  it('supports remove, list and clear operations', () => {
    const checkpoints = createStoreCheckpointRuntime();
    checkpoints.save('a', projection(1));
    checkpoints.save('b', projection(2));
    expect(checkpoints.list().map((item) => item.id)).toEqual(['b', 'a']);
    expect(checkpoints.remove('a')).toBe(true);
    expect(checkpoints.remove('missing')).toBe(false);
    expect(checkpoints.clear()).toBe(1);
    expect(checkpoints.totalBytes).toBe(0);
  });

  it('rejects invalid checkpoint identifiers', () => {
    const checkpoints = createStoreCheckpointRuntime();
    expect(() => checkpoints.save('', projection(1))).toThrow(/id is required/);
    expect(() => checkpoints.load('x'.repeat(121))).toThrow(/length limit/);
  });
});
