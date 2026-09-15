import { executeFeatureCount } from './queryClient';

const mockExecuteForCount = jest.fn(() => Promise.resolve(37));
const mockExecute = jest.fn(() => Promise.resolve({ features: new Array(37).fill({}), exceededTransferLimit: false }));

jest.mock('esri-loader', () => ({
  loadModules: jest.fn((modules) => Promise.resolve(modules.map((name) => {
    if (name === 'esri/tasks/QueryTask') {
      return class QueryTask {
        constructor(options) { Object.assign(this, options); }
        executeForCount(...args) { return mockExecuteForCount(...args); }
        execute(...args) { return mockExecute(...args); }
      };
    }
    if (name === 'esri/tasks/support/Query') return class Query { };
    return class Module { };
  })),
}));

jest.mock('../Business/CommonBusiness', () => ({
  CommonBusiness: { GenerateUrl: jest.fn((service) => service.url) },
}));

jest.mock('./networkPolicy', () => ({
  assertBrowserGisEndpoint: jest.fn((value) => value),
}));

describe('GIS query count runtime', () => {
  beforeEach(() => {
    mockExecuteForCount.mockClear();
    mockExecute.mockClear();
  });

  test('uses ArcGIS executeForCount instead of a one-feature query', async () => {
    const count = await executeFeatureCount({
      id: 'parks',
      url: 'http://localhost/api/Gis/Proxy?https://eg.gissrv.org/parks/FeatureServer/0',
    }, { where: '1=1' });

    expect(count).toBe(37);
    expect(mockExecuteForCount).toHaveBeenCalledTimes(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
