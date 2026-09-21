import { resetArcgisModuleRuntimeCache, setArcgisModuleTransport } from './arcgisModuleRuntime';
import {
  area,
  createTimeSlider,
  distance,
  project,
  queryByGeometry,
  spatialFilter,
  stableQueryKey,
} from './spatialEngine';

const loadModules = vi.fn();
const arcgisTestTransport = { name: 'spatial-engine-test', loadModules };

describe('spatialEngine runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setArcgisModuleTransport(arcgisTestTransport);
    resetArcgisModuleRuntimeCache();
  });
  test('loads each ArcGIS module once and reuses the resolved module', async () => {
    const geometryEngine = {
      geodesicDistance: vi.fn(() => 12),
      geodesicArea: vi.fn(() => 42),
    };
    loadModules.mockResolvedValue([geometryEngine]);

    await expect(distance({ id: 1 }, { id: 2 })).resolves.toBe(12);
    await expect(distance({ id: 3 }, { id: 4 })).resolves.toBe(12);
    await expect(area({ id: 5 })).resolves.toBe(42);

    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(loadModules).toHaveBeenCalledWith(['esri/geometry/geometryEngine']);
  });

  test('rejects invalid geometry before loading ArcGIS modules', async () => {
    loadModules.mockClear();

    await expect(distance(null, { id: 2 })).rejects.toThrow('Two geometries are required.');
    await expect(area(null)).rejects.toThrow('Geometry is required.');

    expect(loadModules).not.toHaveBeenCalled();
  });

  test('creates stable keys regardless of object property order', () => {
    const first = stableQueryKey({ where: '1=1', page: 2, fields: ['A', 'B'] });
    const second = stableQueryKey({ fields: ['A', 'B'], page: 2, where: '1=1' });

    expect(first).toBe(second);
  });

  test('passes AbortSignal to FeatureLayer-like query calls', async () => {
    const signal = { aborted: false };
    const layer = { queryFeatures: vi.fn().mockResolvedValue({ features: [] }) };

    await queryByGeometry(layer, {
      geometry: { type: 'point' },
      outFields: ['OBJECTID'],
      signal,
    });

    expect(layer.queryFeatures).toHaveBeenCalledWith(
      {
        geometry: { type: 'point' },
        where: '1=1',
        outFields: ['OBJECTID'],
        returnGeometry: true,
      },
      { signal },
    );
  });

  test('rejects an already cancelled query before touching the layer', async () => {
    const layer = { queryFeatures: vi.fn() };

    await expect(queryByGeometry(layer, { signal: { aborted: true } })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(layer.queryFeatures).not.toHaveBeenCalled();
  });

  test('rejects a query that becomes cancelled while the layer request is resolving', async () => {
    const signal = { aborted: false };
    const layer = {
      queryFeatures: vi.fn().mockImplementation(async () => {
        signal.aborted = true;
        return { features: [{ id: 1 }] };
      }),
    };

    await expect(queryByGeometry(layer, { signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  test('rejects arbitrary geometryEngine method access as a spatial relation', async () => {
    loadModules.mockClear();

    await expect(spatialFilter({ type: 'point' }, [], 'constructor')).rejects.toThrow(
      'Unsupported relation: constructor',
    );
    expect(loadModules).not.toHaveBeenCalled();
  });

  test('validates projection WKID before loading projection modules', async () => {
    loadModules.mockClear();

    await expect(project({ type: 'point' }, 0)).rejects.toThrow('A valid positive integer WKID is required.');
    await expect(project({ type: 'point' }, 4326.5)).rejects.toThrow('A valid positive integer WKID is required.');
    expect(loadModules).not.toHaveBeenCalled();
  });

  test('clamps an invalid current time to the beginning of the time extent', () => {
    expect(createTimeSlider('2026-01-01', '2026-01-10', 1000, 'not-a-date').current)
      .toBe('2026-01-01T00:00:00.000Z');
  });
});
