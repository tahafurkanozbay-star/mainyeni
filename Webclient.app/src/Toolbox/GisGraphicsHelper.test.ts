import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetArcgisModuleRuntimeCache,
  resetArcgisModuleTransport,
  setArcgisModuleTransport,
  type ArcgisModuleTransport,
} from "../gis-engine/arcgisModuleRuntime";
import { GisGraphicsHelper, type GraphicLike, type MapViewLike } from "./GisGraphicsHelper";

class FakeGraphic implements GraphicLike {
  [key: string]: unknown;
  id?: string;
  geometry;
  symbol;
  constructor(properties: { geometry: unknown; symbol?: unknown }) {
    this.geometry = properties.geometry;
    this.symbol = properties.symbol;
  }
}
class FakePoint {
  constructor(public readonly properties: Record<string, unknown>) {}
}
class FakePolygon {
  constructor(public readonly properties: Record<string, unknown>) {}
}
class FakePolyline {
  constructor(public readonly properties: Record<string, unknown>) {}
}
class FakeSpatialReference {
  constructor(public readonly properties: { wkid: number }) {}
}

const projection = {
  load: vi.fn(async () => undefined),
  project: vi.fn((geometry, spatialReference) => ({ geometry, spatialReference })),
};

const modules: Record<string, unknown> = {
  "esri/Graphic": FakeGraphic,
  "esri/geometry/Point": FakePoint,
  "esri/geometry/Polygon": FakePolygon,
  "esri/geometry/Polyline": FakePolyline,
  "esri/geometry/projection": projection,
  "esri/geometry/SpatialReference": FakeSpatialReference,
};

const transport: ArcgisModuleTransport = {
  name: "gis-graphics-helper-test",
  loadModules: vi.fn(async (moduleIds) => moduleIds.map((moduleId) => modules[moduleId])),
};

const createView = (items: GraphicLike[] = []) => {
  const add = vi.fn((graphic: GraphicLike) => items.push(graphic));
  const remove = vi.fn((graphic: GraphicLike) => {
    const index = items.indexOf(graphic);
    if (index >= 0) items.splice(index, 1);
  });
  const goTo = vi.fn(async () => undefined);
  const view: MapViewLike = { graphics: { items, add, remove }, goTo };
  return { view, items, add, remove, goTo };
};

describe("GisGraphicsHelper", () => {
  beforeEach(() => {
    resetArcgisModuleTransport();
    setArcgisModuleTransport(transport);
    resetArcgisModuleRuntimeCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetArcgisModuleTransport();
    resetArcgisModuleRuntimeCache();
  });

  it("adds graphics with generated ids and removes matching ids", () => {
    const existing: GraphicLike = { id: "existing" };
    const { view, items, add, remove } = createView([existing]);
    const incoming: GraphicLike = {};

    GisGraphicsHelper.AddGraphics(view, incoming);
    expect(incoming.id).toMatch(/^[0-9a-f-]+$/u);
    expect(add).toHaveBeenCalledWith(incoming);
    expect(items).toContain(incoming);

    GisGraphicsHelper.RemoveGraphics(view, { id: "existing" });
    expect(remove).toHaveBeenCalledWith(existing);
    expect(items).not.toContain(existing);
  });

  it("removes every graphic even when the underlying collection mutates", () => {
    const first: GraphicLike = { id: "first" };
    const second: GraphicLike = { id: "second" };
    const third: GraphicLike = { id: "third" };
    const { view, items, remove } = createView([first, second, third]);

    GisGraphicsHelper.RemoveAllGraphics(view);

    expect(remove).toHaveBeenCalledTimes(3);
    expect(items).toEqual([]);
  });

  it("chooses deterministic default symbols by geometry type", async () => {
    const point = await GisGraphicsHelper.CreateGraphicFromGeometry({ type: "point" });
    const polyline = await GisGraphicsHelper.CreateGraphicFromGeometry({ type: "polyline" });
    const polygon = await GisGraphicsHelper.CreateGraphicFromGeometry({ type: "polygon" });

    expect(point?.symbol).toMatchObject({ type: "picture-marker", width: "48px", height: "48px" });
    expect(polyline?.symbol).toMatchObject({ type: "simple-line", width: 4 });
    expect(polygon?.symbol).toMatchObject({ type: "simple-line", width: 4 });
  });

  it("creates WGS84 polygon and polyline geometry from coordinate pairs", async () => {
    const points = [[[32.8, 39.9], [32.9, 40.0]]] as const;
    const polygon = await GisGraphicsHelper.CreatePolygonFromXYPoints(points) as FakePolygon;
    const polyline = await GisGraphicsHelper.CreatePolylineFromXYPoints(points) as FakePolyline;

    expect(polygon.properties).toEqual({
      rings: [[32.8, 39.9], [32.9, 40]],
      spatialReference: { wkid: 4326 },
    });
    expect(polyline.properties).toEqual({
      paths: [[32.8, 39.9], [32.9, 40]],
      spatialReference: { wkid: 4326 },
    });
  });

  it("loads projection support before projecting into the requested spatial reference", async () => {
    const geometry = { type: "point" };
    const result = await GisGraphicsHelper.ProjectGeometry(geometry, 3857);

    expect(projection.load).toHaveBeenCalledTimes(1);
    expect(projection.project).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      geometry,
      spatialReference: { properties: { wkid: 3857 } },
    });
  });

  it("keeps zoom semantics for explicit and implicit zoom levels", async () => {
    const { view, goTo } = createView();
    const geometry = { type: "point" };

    await GisGraphicsHelper.ZoomToGeometry(view, geometry, 14);
    await GisGraphicsHelper.ZoomToGeometry(view, geometry);

    expect(goTo).toHaveBeenNthCalledWith(1, { target: geometry, zoom: 14 });
    expect(goTo).toHaveBeenNthCalledWith(2, geometry);
  });
});
