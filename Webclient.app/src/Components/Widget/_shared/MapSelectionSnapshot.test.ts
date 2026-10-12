import { describe, expect, it, vi } from 'vitest';
import { selectionFromWindowQuery, snapshotMapPoint, snapshotMapSelection } from './MapSelectionSnapshot';

describe('map selection snapshots', () => {
  it('copies legacy coordinates without retaining the global click or spatial reference', () => {
    const point = { latitude: 39.93, longitude: 32.82, x: 32.82, y: 39.93, spatialReference: { wkid: 4326 } };
    const event = { x: 200, y: 120, mapPoint: point };
    const selected = snapshotMapSelection(event)!;
    point.latitude = 40.11;
    point.spatialReference.wkid = 3857;
    event.x = 300;
    expect(selected.x).toBe(200);
    expect(selected.mapPoint).toMatchObject({ latitude: 39.93, spatialReference: { wkid: 4326 } });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.mapPoint)).toBe(true);
  });

  it('uses the ArcGIS clone contract instead of spreading a live SDK geometry', () => {
    const clone = vi.fn(() => ({ latitude: 39.9, longitude: 32.8 }));
    const point = { clone, latitude: 40, longitude: 33 };
    expect(snapshotMapPoint(point)).toEqual({ latitude: 39.9, longitude: 32.8 });
    expect(clone).toHaveBeenCalledOnce();
  });

  it('fails closed for missing coordinates and extracts only an explicit window selection', () => {
    expect(snapshotMapSelection({ mapPoint: null })).toBeNull();
    expect(snapshotMapSelection({ mapPoint: { x: Infinity } })).toBeNull();
    expect(selectionFromWindowQuery({ arbitrary: { mapPoint: { x: 1 } } })).toBeNull();
    const query = { selectionEvent: { mapPoint: { x: 1, y: 2 }, x: 9, y: 8 } };
    expect(selectionFromWindowQuery(query)).toMatchObject({ x: 9, y: 8, mapPoint: { x: 1, y: 2 } });
  });
});
