import { describe, expect, it } from 'vitest';
import type { StoreStateProjection } from './contracts';
import { fingerprintSafeValue, fingerprintStoreProjection, stableStoreProjectionText } from './stateFingerprint';

const projection = (generatedAt: number): StoreStateProjection => ({
  schemaVersion: 1,
  generatedAt,
  common: {
    moduleSelectBarVisible: false,
    windows: [],
    mapConfiguration: { b: 2, a: 1 },
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

describe('stateFingerprint', () => {
  it('ignores generatedAt when fingerprinting equivalent state', () => {
    expect(fingerprintStoreProjection(projection(1)))
      .toBe(fingerprintStoreProjection(projection(999)));
  });

  it('changes when projected state changes', () => {
    const base = projection(1);
    const changed: StoreStateProjection = {
      ...base,
      map: { ...base.map, graphicsCount: 1 },
    };
    expect(fingerprintStoreProjection(base)).not.toBe(fingerprintStoreProjection(changed));
  });

  it('serializes object keys deterministically', () => {
    expect(fingerprintSafeValue({ a: 1, b: 2 }))
      .toBe(fingerprintSafeValue({ b: 2, a: 1 }));
  });

  it('produces stable text without timestamp noise', () => {
    expect(stableStoreProjectionText(projection(1)))
      .toBe(stableStoreProjectionText(projection(2)));
  });
});
