const mocks = vi.hoisted(() => ({
  loadArcgisModule: vi.fn(),
  loadArcgisModules: vi.fn(),
}));

vi.mock('../gis-engine/arcgisModuleRuntime', () => ({
  loadArcgisModule: mocks.loadArcgisModule,
  loadArcgisModules: mocks.loadArcgisModules,
}));

import { GisGraphicsHelper } from './GisGraphicsHelper';

describe('GisGraphicsHelper strict TypeScript runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('removes only requested graphics and preserves unrelated map graphics', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    const remove = vi.fn();
    const mapView = {
      graphics: {
        items: [first, second],
        remove,
      },
    };

    GisGraphicsHelper.RemoveGraphics(mapView, { id: 'first' });

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(first);
    expect(remove).not.toHaveBeenCalledWith(second);
  });

  test('removes all graphics from a stable copy of the current collection', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    const remove = vi.fn();
    const mapView = {
      graphics: {
        items: [first, second],
        remove,
      },
    };

    GisGraphicsHelper.RemoveAllGraphics(mapView);

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, first);
    expect(remove).toHaveBeenNthCalledWith(2, second);
  });

  test('assigns ids before adding graphics and returns an immutable added list', () => {
    const add = vi.fn();
    const graphics = [{}, {}];
    const result = GisGraphicsHelper.AddGraphics({
      graphics: { items: [], add },
    }, graphics);

    expect(add).toHaveBeenCalledTimes(2);
    expect(graphics[0]?.id).toEqual(expect.any(String));
    expect(graphics[1]?.id).toEqual(expect.any(String));
    expect(graphics[0]?.id).not.toBe(graphics[1]?.id);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('does nothing when a map view has no graphics collection', () => {
    expect(GisGraphicsHelper.AddGraphics(null, { id: 'x' })).toEqual([]);
    expect(() => GisGraphicsHelper.RemoveGraphics({}, { id: 'x' })).not.toThrow();
    expect(() => GisGraphicsHelper.RemoveAllGraphics({})).not.toThrow();
  });

  test('creates ArcGIS points through the shared ESM module runtime', async () => {
    const Point = vi.fn(function PointMock(options: Record<string, unknown>) {
      return { ...options, type: 'point' };
    });
    mocks.loadArcgisModule.mockResolvedValueOnce(Point);

    await expect(GisGraphicsHelper.CreatePoint({
      x: 32.85,
      y: 39.92,
      spatialReference: { wkid: 4326 },
    })).resolves.toMatchObject({
      x: 32.85,
      y: 39.92,
      type: 'point',
    });

    expect(mocks.loadArcgisModule).toHaveBeenCalledWith('esri/geometry/Point');
  });

  test('selects the legacy default marker for point graphics', async () => {
    const Graphic = vi.fn(function GraphicMock(options: Record<string, unknown>) {
      return options;
    });
    mocks.loadArcgisModule.mockResolvedValueOnce(Graphic);

    const result = await GisGraphicsHelper.CreateGraphicFromGeometry({
      type: 'point',
    }) as Record<string, unknown>;

    expect(result.symbol).toMatchObject({
      type: 'picture-marker',
      url: 'images/icons/map/pictureMarker.png',
    });
  });

  test('selects line and polygon defaults without mutating input geometry', async () => {
    const Graphic = vi.fn(function GraphicMock(options: Record<string, unknown>) {
      return options;
    });
    mocks.loadArcgisModule.mockResolvedValue(Graphic);

    const line = { type: 'polyline' };
    const polygon = { type: 'polygon' };

    const lineResult = await GisGraphicsHelper.CreateGraphicFromGeometry(line) as Record<string, unknown>;
    const polygonResult = await GisGraphicsHelper.CreateGraphicFromGeometry(polygon) as Record<string, unknown>;

    expect(lineResult.symbol).toMatchObject({ type: 'simple-line', width: 4 });
    expect(polygonResult.symbol).toMatchObject({ type: 'simple-line', width: 4 });
    expect(line).toEqual({ type: 'polyline' });
    expect(polygon).toEqual({ type: 'polygon' });
  });

  test('uses an explicitly supplied symbol without replacing it', async () => {
    const Graphic = vi.fn(function GraphicMock(options: Record<string, unknown>) {
      return options;
    });
    mocks.loadArcgisModule.mockResolvedValueOnce(Graphic);
    const symbol = { type: 'simple-marker', color: 'red' };

    const result = await GisGraphicsHelper.CreateGraphicFromGeometry(
      { type: 'point' },
      symbol,
    ) as Record<string, unknown>;

    expect(result.symbol).toBe(symbol);
  });

  test('rejects custom graphic creation when geometry is missing', async () => {
    await expect(GisGraphicsHelper.CreateCustomGraphicFromGeometry(null, {}))
      .rejects.toThrow(/Geometry is required/u);
    expect(mocks.loadArcgisModule).not.toHaveBeenCalled();
  });

  test('uses bounded goTo shapes for zoom helpers', async () => {
    const goTo = vi.fn().mockResolvedValue(undefined);
    const mapView = { goTo };
    const geometry = {
      extent: {
        expand: vi.fn(() => ({ expanded: true })),
      },
    };

    await GisGraphicsHelper.ZoomToGeometry(mapView, geometry, 15);
    await GisGraphicsHelper.ZoomToGeometryExtent(mapView, geometry, 1.5);

    expect(goTo).toHaveBeenNthCalledWith(1, {
      target: geometry,
      zoom: 15,
    });
    expect(goTo).toHaveBeenNthCalledWith(2, {
      target: geometry,
      extent: { expanded: true },
    });
  });

  test('does not reject the caller when optional goTo animation fails', async () => {
    const goTo = vi.fn().mockRejectedValue(new Error('view interrupted'));
    const geometries = [{ type: 'point' }];

    await expect(GisGraphicsHelper.ZoomToGeometries(
      { goTo },
      geometries,
      12,
    )).resolves.toBe(geometries);
  });

  test('creates WGS84 polygon and polyline coordinate containers', async () => {
    const Polygon = vi.fn(function PolygonMock(options: Record<string, unknown>) {
      return options;
    });
    const Polyline = vi.fn(function PolylineMock(options: Record<string, unknown>) {
      return options;
    });
    mocks.loadArcgisModule
      .mockResolvedValueOnce(Polygon)
      .mockResolvedValueOnce(Polyline);

    const input = [[[32.8, 39.9], [32.9, 40.0]]] as const;
    const polygon = await GisGraphicsHelper.CreatePolygonFromXYPoints(input);
    const polyline = await GisGraphicsHelper.CreatePolylineFromXYPoints(input);

    expect(polygon).toMatchObject({
      rings: [[32.8, 39.9], [32.9, 40.0]],
      spatialReference: { wkid: 4326 },
    });
    expect(polyline).toMatchObject({
      paths: [[32.8, 39.9], [32.9, 40.0]],
      spatialReference: { wkid: 4326 },
    });
  });

  test('loads projection and builds the requested output spatial reference', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const project = vi.fn((_geometry, spatialReference) => ({
      projected: true,
      spatialReference,
    }));
    const projection = { load, project };
    const SpatialReference = vi.fn(function SpatialReferenceMock(options: Record<string, unknown>) {
      return options;
    });
    mocks.loadArcgisModules.mockResolvedValueOnce([
      projection,
      SpatialReference,
    ]);

    const geometry = { x: 1, y: 2 };
    const result = await GisGraphicsHelper.ProjectGeometry(geometry, 3857);

    expect(load).toHaveBeenCalledTimes(1);
    expect(SpatialReference).toHaveBeenCalledWith({ wkid: 3857 });
    expect(project).toHaveBeenCalledWith(geometry, { wkid: 3857 });
    expect(result).toMatchObject({ projected: true });
  });
});
