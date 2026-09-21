import { apiClient } from '../platform/http/httpClient';
import { LayerBusiness } from './LayerBusiness';

vi.mock('../platform/http/httpClient', () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

describe('LayerBusiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('loads grouped layers through the same-origin platform client', async () => {
    const payload = [{ id: 'transport' }];
    apiClient.get.mockResolvedValue(payload);

    await expect(LayerBusiness.GetLayers()).resolves.toBe(payload);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith('/Gis/Layer/ListGrouped');
  });

  test('preserves the legacy null contract and reports transport failure', async () => {
    const error = new Error('offline');
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    apiClient.get.mockRejectedValue(error);

    await expect(LayerBusiness.GetLayers()).resolves.toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(error);
  });
});
