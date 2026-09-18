import { loadArcgisModule, loadArcgisModules } from '../gis-engine/arcgisModuleRuntime';
import { ArrayHelper } from './ArrayHelper';
import { DebugHelper } from './DebugHelper';
import { IsNull } from './ObjectHelper';
import { TextHelper } from './TextHelper';

interface GraphicLike {
  id?: string;
  geometry?: unknown;
  symbol?: unknown;
}

interface GraphicsCollectionLike {
  readonly items?: readonly GraphicLike[];
  add?: (graphic: GraphicLike) => unknown;
  remove?: (graphic: GraphicLike) => unknown;
}

interface MapViewLike {
  readonly graphics?: GraphicsCollectionLike;
  goTo?: (target: unknown) => Promise<unknown> | unknown;
}

interface GeometryLike {
  readonly type?: string;
  readonly extent?: {
    expand?: (factor: number) => unknown;
  } | null;
}

type GenericConstructor<TValue = unknown> = new (
  options: Readonly<Record<string, unknown>>,
) => TValue;

interface ProjectionLike {
  load(): Promise<unknown>;
  project(geometry: unknown, spatialReference: unknown): unknown;
}

const isNil = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const asMapView = (value: unknown): MapViewLike | null =>
  value !== null && typeof value === 'object'
    ? value as MapViewLike
    : null;

const asGraphic = (value: unknown): GraphicLike | null =>
  value !== null && typeof value === 'object'
    ? value as GraphicLike
    : null;

const graphicList = (value: unknown): readonly GraphicLike[] => {
  const source = Array.isArray(value) ? value : [value];
  return source.map(asGraphic).filter((item): item is GraphicLike => item !== null);
};

export const GisGraphicsHelper = Object.freeze({
  RemoveAllGraphics: (mapViewInput: unknown): void => {
    const mapView = asMapView(mapViewInput);
    const items = mapView?.graphics?.items;
    if (!items || typeof mapView.graphics?.remove !== 'function') return;
    [...items].forEach((graphic) => mapView.graphics?.remove?.(graphic));
  },

  RemoveGraphics: (mapViewInput: unknown, graphicsInput: unknown): void => {
    const mapView = asMapView(mapViewInput);
    if (!mapView?.graphics || typeof mapView.graphics.remove !== 'function') return;
    const existing = mapView.graphics.items ?? Object.freeze([]);

    graphicList(graphicsInput).forEach((graphic) => {
      if (!graphic.id) return;
      const target = ArrayHelper.Find(
        existing as readonly Record<string, unknown>[],
        'id',
        graphic.id,
      ) as GraphicLike | null;
      if (target) mapView.graphics?.remove?.(target);
    });
  },

  AddGraphics: (mapViewInput: unknown, graphicsInput: unknown): readonly GraphicLike[] => {
    const mapView = asMapView(mapViewInput);
    const added: GraphicLike[] = [];
    if (!mapView?.graphics || typeof mapView.graphics.add !== 'function') {
      return Object.freeze(added);
    }

    graphicList(graphicsInput).forEach((graphic) => {
      graphic.id = TextHelper.CreateGuid();
      mapView.graphics?.add?.(graphic);
      added.push(graphic);
    });
    return Object.freeze(added);
  },

  CreatePoint: async (
    props: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    const Point = await loadArcgisModule<GenericConstructor>('esri/geometry/Point');
    return new Point(props);
  },

  ZoomToGeometry: (
    mapViewInput: unknown,
    geometry: unknown,
    zoomLevel?: unknown,
  ): Promise<unknown> | unknown => {
    const mapView = asMapView(mapViewInput);
    if (!mapView?.goTo) return null;
    if (!IsNull(zoomLevel)) {
      return mapView.goTo({ target: geometry, zoom: zoomLevel });
    }
    return mapView.goTo(geometry);
  },

  ZoomToGeometryExtent: (
    mapViewInput: unknown,
    geometryInput: GeometryLike,
    expand: number,
  ): Promise<unknown> | unknown => {
    const mapView = asMapView(mapViewInput);
    if (!mapView?.goTo) return null;
    const extent = geometryInput?.extent?.expand?.(expand);
    return mapView.goTo({
      target: geometryInput,
      ...(extent === undefined ? {} : { extent }),
    });
  },

  CreateCustomGraphicFromGeometry: async (
    geometry: unknown,
    symbol: unknown,
  ): Promise<unknown> => {
    if (isNil(geometry)) return Promise.reject(new TypeError('Geometry is required.'));
    const Graphic = await loadArcgisModule<GenericConstructor>('esri/Graphic');
    return new Graphic({ geometry, symbol });
  },

  CreateGraphicFromGeometry: async (
    geometryInput: GeometryLike | null | undefined,
    symbolInput?: unknown,
  ): Promise<unknown | null> => {
    if (isNil(geometryInput)) return null;
    const Graphic = await loadArcgisModule<GenericConstructor>('esri/Graphic');
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
      type: 'simple-line',
      color: Object.freeze([78, 229, 255]),
      width: 4,
    });

    let symbol = symbolInput;
    if (!symbol && geometryInput.type === 'point') symbol = pointSymbol;
    if (!symbol && (geometryInput.type === 'line' || geometryInput.type === 'polyline')) {
      symbol = polylineSymbol;
    }
    if (!symbol && geometryInput.type === 'polygon') symbol = polygonSymbol;
    return new Graphic({ geometry: geometryInput, symbol });
  },

  ZoomToGeometries: async (
    mapViewInput: unknown,
    geometries: readonly unknown[] | null | undefined,
    zoomLevel?: unknown,
  ): Promise<readonly unknown[] | null | undefined> => {
    if (!geometries?.length) return geometries;
    const mapView = asMapView(mapViewInput);
    if (!mapView?.goTo) return geometries;

    try {
      if (!IsNull(zoomLevel)) {
        await mapView.goTo({ target: geometries, zoom: zoomLevel });
      } else {
        await mapView.goTo(geometries);
      }
    } catch (error) {
      DebugHelper.Log(error);
    }
    return geometries;
  },

  CreatePolygonFromXYPoints: async (
    points: readonly (readonly (readonly [number, number])[])[],
  ): Promise<unknown> => {
    const Polygon = await loadArcgisModule<GenericConstructor>('esri/geometry/Polygon');
    const rings = (points?.[0] ?? Object.freeze([])).map((point) => [point[0], point[1]]);
    return new Polygon({
      rings,
      spatialReference: Object.freeze({ wkid: 4326 }),
    });
  },

  CreatePolylineFromXYPoints: async (
    points: readonly (readonly (readonly [number, number])[])[],
  ): Promise<unknown> => {
    const Polyline = await loadArcgisModule<GenericConstructor>('esri/geometry/Polyline');
    const paths = (points?.[0] ?? Object.freeze([])).map((point) => [point[0], point[1]]);
    return new Polyline({
      paths,
      spatialReference: Object.freeze({ wkid: 4326 }),
    });
  },

  ProjectGeometry: async (
    geometry: unknown,
    wkid: number,
  ): Promise<unknown> => {
    const [projection, SpatialReference] = await loadArcgisModules<
      readonly [ProjectionLike, GenericConstructor]
    >([
      'esri/geometry/projection',
      'esri/geometry/SpatialReference',
    ]);
    await projection.load();
    return projection.project(
      geometry,
      new SpatialReference({ wkid }),
    );
  },
});
