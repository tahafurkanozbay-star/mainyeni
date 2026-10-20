import { loadArcgisModule, loadArcgisModules } from '../gis-engine/arcgisModuleRuntime';

interface GraphicLike {
  id?: string;
  geometry?: unknown;
  symbol?: unknown;
}

interface GraphicsCollectionLike {
  readonly items?: readonly GraphicLike[];
  add?: (graphic: GraphicLike) => void;
  remove?: (graphic: GraphicLike) => void;
}

interface MapViewLike {
  readonly graphics?: GraphicsCollectionLike;
  goTo?: (target: unknown) => Promise<unknown> | unknown;
}

interface GeometryExtentLike {
  expand?: (factor: number) => unknown;
}

export interface PointLike {
  readonly x?: number;
  readonly y?: number;
  readonly longitude?: number;
  readonly latitude?: number;
  readonly spatialReference?: unknown;
}

interface GeometryLike {
  readonly type?: string;
  readonly extent?: GeometryExtentLike;
}

type ArcgisConstructor<TInstance, TProperties extends object = Record<string, unknown>> =
  new (properties: TProperties) => TInstance;

interface ProjectionLike {
  load: () => Promise<void>;
  project: (geometry: unknown, spatialReference: unknown) => unknown;
}

type SpatialReferenceConstructor = ArcgisConstructor<unknown, { wkid: number }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asMapView = (value: unknown): MapViewLike | null =>
  isRecord(value) ? value as MapViewLike : null;

const asGraphic = (value: unknown): GraphicLike | null =>
  isRecord(value) ? value as GraphicLike : null;

const asGeometry = (value: unknown): GeometryLike | null =>
  isRecord(value) ? value as GeometryLike : null;

interface GeographicPointCoordinates {
  readonly longitude: number;
  readonly latitude: number;
}

const finiteCoordinate = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};

const isWgs84Coordinate = (longitude: number, latitude: number): boolean =>
  longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;

const getGeographicPointCoordinates = (value: unknown): GeographicPointCoordinates | null => {
  if (!isRecord(value) || String(value.type ?? '').toLowerCase() !== 'point') return null;

  // The Kent Rehberi adapter returns WGS84 points. Also accept plain GeoJSON
  // Point objects because some layers expose their row geometry in that form.
  const coordinates = value.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const longitude = finiteCoordinate(coordinates[0]);
    const latitude = finiteCoordinate(coordinates[1]);
    if (longitude !== null && latitude !== null && isWgs84Coordinate(longitude, latitude)) {
      return Object.freeze({ longitude, latitude });
    }
  }

  const longitude = finiteCoordinate(value.longitude);
  const latitude = finiteCoordinate(value.latitude);
  if (longitude !== null && latitude !== null && isWgs84Coordinate(longitude, latitude)) {
    return Object.freeze({ longitude, latitude });
  }

  const x = finiteCoordinate(value.x);
  const y = finiteCoordinate(value.y);
  const spatialReference = isRecord(value.spatialReference) ? value.spatialReference : null;
  const wkid = finiteCoordinate(spatialReference?.wkid ?? spatialReference?.latestWkid);
  if (
    x !== null
    && y !== null
    && (wkid === 4326 || wkid === null)
    && isWgs84Coordinate(x, y)
  ) {
    return Object.freeze({ longitude: x, latitude: y });
  }

  return null;
};

const toGraphicArray = (value: unknown): GraphicLike[] => {
  if (Array.isArray(value)) return value.map(asGraphic).filter((item): item is GraphicLike => item !== null);
  const single = asGraphic(value);
  return single ? [single] : [];
};

const reportRuntimeError = (error: unknown): void => {
  const reporter = (globalThis as typeof globalThis & {
    reportError?: (reason: unknown) => void;
  }).reportError;
  reporter?.(error);
};

const createGuid = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const values = new Uint32Array(4);
  cryptoApi?.getRandomValues?.(values);
  return [...values].map((value) => value.toString(16).padStart(8, '0')).join('-');
};

const normalizeCoordinateGroups = (input: unknown): readonly (readonly [number, number])[] => {
  if (!Array.isArray(input) || !Array.isArray(input[0])) return Object.freeze([]);
  const points: Array<readonly [number, number]> = [];
  for (const rawPoint of input[0]) {
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) continue;
    const x = Number(rawPoint[0]);
    const y = Number(rawPoint[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push(Object.freeze([x, y] as const));
  }
  return Object.freeze(points);
};

export const GisGraphicsHelper = Object.freeze({
  RemoveAllGraphics: (mapViewInput: unknown): void => {
    const mapView = asMapView(mapViewInput);
    const items = mapView?.graphics?.items ? [...mapView.graphics.items] : [];
    for (const graphic of items) mapView?.graphics?.remove?.(graphic);
  },

  RemoveGraphics: (mapViewInput: unknown, graphicsInput: unknown): void => {
    const mapView = asMapView(mapViewInput);
    if (!mapView?.graphics) return;
    for (const graphic of toGraphicArray(graphicsInput)) {
      const target = mapView.graphics.items?.find((item) => item.id && item.id === graphic.id);
      if (target) mapView.graphics.remove?.(target);
    }
  },

  AddGraphics: (mapViewInput: unknown, graphicsInput: unknown): void => {
    const mapView = asMapView(mapViewInput);
    if (!mapView?.graphics) return;
    for (const graphic of toGraphicArray(graphicsInput)) {
      graphic.id = createGuid();
      mapView.graphics.add?.(graphic);
    }
  },

  CreatePoint: async (properties: unknown): Promise<PointLike> => {
    const Point = await loadArcgisModule<ArcgisConstructor<PointLike>>('esri/geometry/Point');
    const normalized = isRecord(properties) ? { ...properties } : {};
    return new Point(normalized);
  },

  ZoomToGeometry: (
    mapViewInput: unknown,
    geometry: unknown,
    zoomLevel?: number | null,
  ): Promise<unknown> | unknown => {
    const mapView = asMapView(mapViewInput);
    if (!mapView?.goTo) return undefined;

    const point = getGeographicPointCoordinates(geometry);
    if (point) {
      const center: readonly [number, number] = [point.longitude, point.latitude];
      return zoomLevel !== null && zoomLevel !== undefined
        ? mapView.goTo({ center, zoom: zoomLevel })
        : mapView.goTo(center);
    }

    if (zoomLevel !== null && zoomLevel !== undefined) {
      return mapView.goTo({ target: geometry, zoom: zoomLevel });
    }
    return mapView.goTo(geometry);
  },

  ZoomToGeometryExtent: (
    mapViewInput: unknown,
    geometryInput: unknown,
    expand = 1,
  ): Promise<unknown> | unknown => {
    const mapView = asMapView(mapViewInput);
    const geometry = asGeometry(geometryInput);
    const extent = geometry?.extent?.expand?.(expand);
    if (!mapView?.goTo || !extent) return undefined;
    return mapView.goTo({ target: geometryInput, extent });
  },

  CreateCustomGraphicFromGeometry: async (
    geometry: unknown,
    symbol: unknown,
  ): Promise<GraphicLike> => {
    if (geometry === null || geometry === undefined) {
      throw new TypeError('A geometry is required to create a graphic.');
    }
    const Graphic = await loadArcgisModule<ArcgisConstructor<GraphicLike>>('esri/Graphic');
    return new Graphic({ geometry, symbol });
  },

  CreateGraphicFromGeometry: async (
    geometryInput: unknown,
    symbolInput?: unknown,
  ): Promise<GraphicLike | null> => {
    const geometry = asGeometry(geometryInput);
    if (!geometry) return null;
    const Graphic = await loadArcgisModule<ArcgisConstructor<GraphicLike>>('esri/Graphic');
    const pointSymbol = Object.freeze({
      type: 'picture-marker',
      url: 'images/icons/map/pictureMarker.png',
      width: '48px',
      height: '48px',
    });
    const polylineSymbol = Object.freeze({
      type: 'simple-line',
      color: Object.freeze([78, 229, 255]),
      width: 4,
    });
    const polygonSymbol = Object.freeze({
      type: 'simple-fill',
      color: Object.freeze([78, 229, 255, 0.16]),
      outline: Object.freeze({ color: Object.freeze([78, 229, 255]), width: 4 }),
    });

    let symbol = symbolInput;
    if (!symbol && geometry.type === 'point') symbol = pointSymbol;
    if (!symbol && (geometry.type === 'line' || geometry.type === 'polyline')) symbol = polylineSymbol;
    if (!symbol && geometry.type === 'polygon') symbol = polygonSymbol;
    return new Graphic({ geometry: geometryInput, symbol });
  },

  ZoomToGeometries: async (
    mapViewInput: unknown,
    geometriesInput: readonly unknown[] | null | undefined,
    zoomLevel?: number | null,
  ): Promise<readonly unknown[]> => {
    const geometries = Array.isArray(geometriesInput) ? geometriesInput : Object.freeze([]);
    if (geometries.length === 0) return geometries;
    const mapView = asMapView(mapViewInput);
    if (!mapView?.goTo) return geometries;
    try {
      if (zoomLevel !== null && zoomLevel !== undefined) {
        await mapView.goTo({ target: geometries, zoom: zoomLevel });
      } else {
        await mapView.goTo(geometries);
      }
    } catch (error: unknown) {
      reportRuntimeError(error);
    }
    return geometries;
  },

  CreatePolygonFromXYPoints: async (pointsInput: unknown): Promise<unknown> => {
    const Polygon = await loadArcgisModule<ArcgisConstructor<unknown>>('esri/geometry/Polygon');
    return new Polygon({
      rings: normalizeCoordinateGroups(pointsInput),
      spatialReference: { wkid: 4326 },
    });
  },

  CreatePolylineFromXYPoints: async (pointsInput: unknown): Promise<unknown> => {
    const Polyline = await loadArcgisModule<ArcgisConstructor<unknown>>('esri/geometry/Polyline');
    return new Polyline({
      paths: normalizeCoordinateGroups(pointsInput),
      spatialReference: { wkid: 4326 },
    });
  },

  ProjectGeometry: async (geometry: unknown, wkidInput: unknown): Promise<unknown> => {
    const wkid = Number(wkidInput);
    if (!Number.isInteger(wkid) || wkid <= 0) {
      throw new RangeError('WKID must be a positive integer.');
    }
    const [projection, SpatialReference] = await loadArcgisModules<
      readonly [ProjectionLike, SpatialReferenceConstructor]
    >(['esri/geometry/projection', 'esri/geometry/SpatialReference']);
    await projection.load();
    return projection.project(geometry, new SpatialReference({ wkid }));
  },
});
