import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';

/** A single immutable click intent shared by map tools and managed windows.
 * ArcGIS geometry is cloned through the SDK; plain test/legacy points are copied
 * without retaining a mutable global click event. No coordinate is logged. */
export interface MapSelectionEvent {
  readonly x?: number;
  readonly y?: number;
  readonly mapPoint: unknown;
}
const coordinateFields = ['x', 'y', 'z', 'm', 'latitude', 'longitude', 'type', 'spatialReference'] as const;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const snapshotMapPoint = (value: unknown): unknown | null => {
  if (!isObject(value)) return null;
  try {
    const clone = value.clone;
    if (typeof clone === 'function') {
      const copied: unknown = clone.call(value);
      if (isObject(copied) && copied !== value) return copied;
    }
  } catch {
    // Fixed-stage local diagnostic; no exception text or map coordinates retained.
    runtimeDiagnostics.record('gis.map-selection.snapshot-fallback', { stage: 'clone' }, { severity: 'warn' });
  }
  const copy: Record<string, unknown> = {};
  for (const key of coordinateFields) {
    try {
      const field = value[key];
      if (field === undefined || (typeof field === 'number' && !Number.isFinite(field))) continue;
      if (key === 'spatialReference' && isObject(field)) {
        const spatialReference: Record<string, unknown> = {};
        for (const name of ['wkid', 'latestWkid', 'wkt', 'isGeographic', 'isWebMercator']) {
          try { if (field[name] !== undefined) spatialReference[name] = field[name]; } catch {
            runtimeDiagnostics.record('gis.map-selection.snapshot-fallback', { stage: 'spatial-reference' }, { severity: 'warn' });
          }
        }
        copy[key] = Object.freeze(spatialReference);
      } else {
        copy[key] = field;
      }
    } catch {
      // Never retain live getters or log values from untrusted adapters.
      runtimeDiagnostics.record('gis.map-selection.snapshot-fallback', { stage: 'coordinate-accessor' }, { severity: 'warn' });
    }
  }
  if (!['x', 'y', 'latitude', 'longitude'].some((key) => typeof copy[key] === 'number')) return null;
  return Object.freeze(copy);
};

export const snapshotMapSelection = (event: unknown): MapSelectionEvent | null => {
  if (!isObject(event)) return null;
  const mapPoint = snapshotMapPoint(event.mapPoint);
  if (!mapPoint) return null;
  const x = typeof event.x === 'number' && Number.isFinite(event.x) ? event.x : undefined;
  const y = typeof event.y === 'number' && Number.isFinite(event.y) ? event.y : undefined;
  return Object.freeze({ ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), mapPoint });
};

export const selectionFromWindowQuery = (query: unknown): MapSelectionEvent | null =>
  isObject(query) ? snapshotMapSelection(query.selectionEvent) : null;
