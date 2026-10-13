import { apiClient } from '../platform/http/httpClient';
import { LayerBusiness } from './LayerBusiness';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

vi.mock('../platform/runtime/runtimeDiagnostics', () => ({ runtimeDiagnostics: { captureError: vi.fn() } }));

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
    expect(apiClient.get).toHaveBeenCalledWith('/Gis/Layer/ListGrouped', { cache: true, dedupe: true, cacheTtlMs: 60_000 });
  });

  test('preserves the legacy null contract and reports transport failure', async () => {
    const error = new Error('offline');
    const reportError = vi.fn();
    vi.stubGlobal('reportError', reportError);
    apiClient.get.mockRejectedValue(error);

    await expect(LayerBusiness.GetLayers()).resolves.toBeNull();
    expect(runtimeDiagnostics.captureError).toHaveBeenCalledWith(error, { source: 'layer-business.catalog' }, 'warn');
    expect(reportError).not.toHaveBeenCalled();
  });
  test('keeps a transport failure recoverable even when diagnostic reporting fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(runtimeDiagnostics.captureError).mockImplementationOnce(() => { throw new Error('reporter failure'); });
    apiClient.get.mockRejectedValue(new Error('internal transport detail'));
    try {
      await expect(LayerBusiness.GetLayers()).resolves.toBeNull();
      expect(warning).toHaveBeenCalledWith('Layer catalog diagnostic reporting failed.');
    } finally { warning.mockRestore(); }
  });
});
