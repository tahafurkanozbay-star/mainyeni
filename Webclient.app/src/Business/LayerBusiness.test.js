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

  test('loads grouped layers through the same-origin platform client', async () => {
    const payload = [{ id: 'transport' }];
    apiClient.get.mockResolvedValue(payload);

    await expect(LayerBusiness.GetLayers()).resolves.toBe(payload);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith('/Gis/Layer/ListGrouped');
  });

  test('preserves the legacy null contract when the request fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    apiClient.get.mockRejectedValue(new Error('offline'));

    await expect(LayerBusiness.GetLayers()).resolves.toBeNull();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});
