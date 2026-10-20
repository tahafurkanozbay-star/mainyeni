import { describe, expect, it, vi } from 'vitest';
import { GisGraphicsHelper } from './GisGraphicsHelper';

describe('GisGraphicsHelper.ZoomToGeometry', () => {
  it('centers a Kent Rehberi WGS84 point on the exact coordinates at the requested zoom', () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    const view = { goTo } as never;
    const geometry = {
      type: 'point',
      longitude: 32.854,
      latitude: 39.920,
      x: 32.854,
      y: 39.920,
      spatialReference: { wkid: 4326 },
    };

    GisGraphicsHelper.ZoomToGeometry(view, geometry, 18);

    expect(goTo).toHaveBeenCalledExactlyOnceWith({
      center: [32.854, 39.920],
      zoom: 18,
    });
  });

  it('accepts GeoJSON Point coordinates and goes to the matching center', () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    const view = { goTo } as never;

    GisGraphicsHelper.ZoomToGeometry(view, {
      type: 'Point',
      coordinates: [32.854, 39.920],
    }, 17);

    expect(goTo).toHaveBeenCalledExactlyOnceWith({
      center: [32.854, 39.920],
      zoom: 17,
    });
  });

  it('preserves target-based navigation for points in projected coordinate systems', () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    const view = { goTo } as never;
    const geometry = {
      type: 'point',
      x: 355000,
      y: 4400000,
      spatialReference: { wkid: 32636 },
    };

    GisGraphicsHelper.ZoomToGeometry(view, geometry, 18);

    expect(goTo).toHaveBeenCalledExactlyOnceWith({ target: geometry, zoom: 18 });
  });
});
