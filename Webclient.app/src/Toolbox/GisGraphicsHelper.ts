import { loadArcgisModule, loadArcgisModules } from "../gis-engine/arcgisModuleRuntime";
import { ArrayHelper } from "./ArrayHelper";
import { IsNull } from "./ObjectHelper";
import { TextHelper } from "./TextHelper";

type UnknownRecord = Record<string, unknown>;
type CoordinatePair = readonly [number, number];

export interface GraphicLike extends UnknownRecord {
  id?: string;
  geometry?: GeometryLike | null;
  symbol?: unknown;
}

export interface GeometryExtentLike {
  expand: (factor: unknown) => unknown;
}

export interface GeometryLike extends UnknownRecord {
  type?: string;
  extent?: GeometryExtentLike;
}

export interface GraphicsCollectionLike {
  items?: GraphicLike[];
  add: (graphic: GraphicLike) => unknown;
  remove: (graphic: GraphicLike) => unknown;
}

export interface MapViewLike {
  graphics?: GraphicsCollectionLike;
  goTo: (target: unknown) => unknown | Promise<unknown>;
}

interface PointCtor {
  new (properties?: UnknownRecord): unknown;
}

interface GraphicCtor {
  new (properties: { geometry: GeometryLike; symbol?: unknown }): GraphicLike;
}

interface PolygonCtor {
  new (properties: { rings: number[][]; spatialReference: { wkid: number } }): unknown;
}

interface PolylineCtor {
  new (properties: { paths: number[][]; spatialReference: { wkid: number } }): unknown;
}

interface SpatialReferenceCtor {
  new (properties: { wkid: number }): unknown;
}

interface ProjectionModule {
  load: () => Promise<unknown> | unknown;
  project: (geometry: unknown, spatialReference: unknown) => unknown;
}

const isNil = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const toGraphics = (value: GraphicLike | readonly GraphicLike[] | null | undefined): GraphicLike[] =>
  Array.isArray(value) ? [...value] : value ? [value] : [];

const firstRing = (points: readonly (readonly CoordinatePair[])[] | null | undefined): readonly CoordinatePair[] =>
  points?.[0] ?? [];

export const GisGraphicsHelper = Object.freeze({
  RemoveAllGraphics: (mapView: MapViewLike | null | undefined): void => {
    const items = [...(mapView?.graphics?.items ?? [])];
    items.forEach((graphic) => mapView?.graphics?.remove(graphic));
  },

  RemoveGraphics: (
    mapView: MapViewLike,
    graphicsInput: GraphicLike | readonly GraphicLike[] | null | undefined,
  ): void => {
    const graphics = toGraphics(graphicsInput);
    graphics.forEach((graphic) => {
      const target = ArrayHelper.Find(mapView.graphics?.items, "id", graphic.id);
      if (target) mapView.graphics?.remove(target);
    });
  },

  AddGraphics: (
    mapView: MapViewLike | null | undefined,
    graphicsInput: GraphicLike | readonly GraphicLike[] | null | undefined,
  ): void => {
    const graphics = toGraphics(graphicsInput);
    graphics.forEach((graphic) => {
      graphic.id = TextHelper.CreateGuid();
      mapView?.graphics?.add(graphic);
    });
  },

  CreatePoint: async (properties: UnknownRecord = {}): Promise<unknown> => {
    const Point = await loadArcgisModule<PointCtor>("esri/geometry/Point");
    return new Point(properties);
  },

  ZoomToGeometry: (
    mapView: MapViewLike,
    geometry: unknown,
    zoomLevel?: unknown,
  ): unknown | Promise<unknown> => {
    if (!IsNull(zoomLevel)) return mapView.goTo({ target: geometry, zoom: zoomLevel });
    return mapView.goTo(geometry);
  },

  ZoomToGeometryExtent: (
    mapView: MapViewLike,
    geometry: GeometryLike,
    expand: unknown,
  ): unknown | Promise<unknown> => {
    if (!geometry.extent || typeof geometry.extent.expand !== "function") {
      throw new TypeError("Geometry extent with expand() is required.");
    }
    return mapView.goTo({
      target: geometry,
      extent: geometry.extent.expand(expand),
    });
  },

  CreateCustomGraphicFromGeometry: async (
    geometry: GeometryLike | null | undefined,
    symbol?: unknown,
  ): Promise<GraphicLike> => {
    if (isNil(geometry)) return Promise.reject(null);
    const Graphic = await loadArcgisModule<GraphicCtor>("esri/Graphic");
    return new Graphic({ geometry, symbol });
  },

  CreateGraphicFromGeometry: async (
    geometry: GeometryLike | null | undefined,
    symbol?: unknown,
  ): Promise<GraphicLike | null> => {
    if (isNil(geometry)) return null;
    const Graphic = await loadArcgisModule<GraphicCtor>("esri/Graphic");
    const pointSymbol = {
      type: "picture-marker",
      url: "images/icons/map/pictureMarker.png",
      width: "48px",
      height: "48px",
    };
    const polylineSymbol = { type: "simple-line", color: [78, 229, 255], width: 4 };
    const polygonSymbol = { type: "simple-line", color: [78, 229, 255], width: 4 };

    let resolvedSymbol = symbol;
    if (!resolvedSymbol && geometry.type === "point") resolvedSymbol = pointSymbol;
    if (!resolvedSymbol && (geometry.type === "line" || geometry.type === "polyline")) resolvedSymbol = polylineSymbol;
    if (!resolvedSymbol && geometry.type === "polygon") resolvedSymbol = polygonSymbol;
    return new Graphic({ geometry, symbol: resolvedSymbol });
  },

  ZoomToGeometries: async (
    mapView: MapViewLike,
    geometries: readonly unknown[] | null | undefined,
    zoomLevel?: unknown,
  ): Promise<readonly unknown[] | null | undefined> => {
    if (!geometries?.length) return geometries;
    try {
      if (!isNil(zoomLevel)) await mapView.goTo({ target: geometries, zoom: zoomLevel });
      else await mapView.goTo(geometries);
    } catch (error) {
      console.error(error);
    }
    return geometries;
  },

  CreatePolygonFromXYPoints: async (
    points: readonly (readonly CoordinatePair[])[] | null | undefined,
  ): Promise<unknown> => {
    const Polygon = await loadArcgisModule<PolygonCtor>("esri/geometry/Polygon");
    const rings = firstRing(points).map((point) => [point[0], point[1]]);
    return new Polygon({ rings, spatialReference: { wkid: 4326 } });
  },

  CreatePolylineFromXYPoints: async (
    points: readonly (readonly CoordinatePair[])[] | null | undefined,
  ): Promise<unknown> => {
    const Polyline = await loadArcgisModule<PolylineCtor>("esri/geometry/Polyline");
    const paths = firstRing(points).map((point) => [point[0], point[1]]);
    return new Polyline({ paths, spatialReference: { wkid: 4326 } });
  },

  ProjectGeometry: async (geometry: unknown, wkid: number): Promise<unknown> => {
    const [projection, SpatialReference] = await loadArcgisModules<
      readonly [ProjectionModule, SpatialReferenceCtor]
    >(["esri/geometry/projection", "esri/geometry/SpatialReference"]);
    await projection.load();
    return projection.project(geometry, new SpatialReference({ wkid }));
  },
});
