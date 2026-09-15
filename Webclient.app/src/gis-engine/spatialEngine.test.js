import { loadModules } from 'esri-loader';
import {
  area,
  createTimeSlider,
  distance,
  queryByGeometry,
  stableQueryKey,
} from './spatialEngine';

jest.mock('esri-loader', () => ({
  loadModules: jest.fn(),
}));

describe('spatialEngine runtime', () => {
  test('loads each ArcGIS module once and reuses the resolved module', async () => {
    const geometryEngine = {
      geodesicDistance: jest.fn(() => 12),
      geodesicArea: jest.fn(() => 42),
    };
    loadModules.mockResolvedValue([geometryEngine]);

    await expect(distance({ id: 1 }, { id: 2 })).resolves.toBe(12);
    await expect(distance({ id: 3 }, { id: 4 })).resolves.toBe(12);
    await expect(area({ id: 5 })).resolves.toBe(42);

    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(loadModules).toHaveBeenCalledWith(['esri/geometry/geometryEngine']);
  });

  test('creates stable keys regardless of object property order', () => {
    const first = stableQueryKey({ where: '1=1', page: 2, fields: ['A', 'B'] });
    const second = stableQueryKey({ fields: ['A', 'B'], page: 2, where: '1=1' });

    expect(first).toBe(second);
  });

  test('passes AbortSignal to FeatureLayer-like query calls', async () => {
    const signal = { aborted: false };
    const layer = { queryFeatures: jest.fn().mockResolvedValue({ features: [] }) };

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
    const layer = { queryFeatures: jest.fn() };

    await expect(queryByGeometry(layer, { signal: { aborted: true } })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(layer.queryFeatures).not.toHaveBeenCalled();
  });

  test('clamps an invalid current time to the beginning of the time extent', () => {
    expect(createTimeSlider('2026-01-01', '2026-01-10', 1000, 'not-a-date').current)
      .toBe('2026-01-01T00:00:00.000Z');
  });
});
