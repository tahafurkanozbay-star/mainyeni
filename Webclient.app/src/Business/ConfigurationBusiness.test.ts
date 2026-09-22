import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ConfigurationBusiness,
  resolveLocalBootstrapPreviewEnabled,
} from './ConfigurationBusiness';
import { apiClient } from '../platform/http/httpClient';

vi.mock('../platform/http/httpClient', () => ({
  apiClient: {
    get: vi.fn(),
  },
}));

const mockedGet = vi.mocked(apiClient.get);

describe('local bootstrap preview policy', () => {
  test('defaults to enabled in Vite development when the env flag is missing', () => {
    expect(resolveLocalBootstrapPreviewEnabled(true, 'development', undefined)).toBe(true);
  });

  test.each(['false', '0', 'off', 'disabled'])(
    'supports explicit local preview opt-out with %s',
    (value) => {
      expect(resolveLocalBootstrapPreviewEnabled(true, 'development', value)).toBe(false);
    },
  );

  test('stays disabled in production and test mode', () => {
    expect(resolveLocalBootstrapPreviewEnabled(false, 'production', 'true')).toBe(false);
    expect(resolveLocalBootstrapPreviewEnabled(true, 'test', 'true')).toBe(false);
  });
});

describe('ConfigurationBusiness platform integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('loads map configuration through the same-origin platform client with bounded cache', async () => {
    const response = { isSuccess: true, data: { configValue: '{}' } };
    mockedGet.mockResolvedValue(response);

    await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toEqual(response);
    expect(mockedGet).toHaveBeenCalledWith('/AppSettings/List', expect.objectContaining({
      params: { key: 'GisMapConfig' },
      cache: true,
      dedupe: true,
      cacheTtlMs: 120_000,
    }));
  });

  test('forwards abort signals and disables request deduplication for cancellable bootstrap calls', async () => {
    const controller = new AbortController();
    const response = { isSuccess: true, data: [] };
    mockedGet.mockResolvedValue(response);

    await ConfigurationBusiness.GetConfigServices({ signal: controller.signal, cacheTtlMs: 5_000 });

    expect(mockedGet).toHaveBeenCalledWith('/Gis/ConfigService/List', expect.objectContaining({
      signal: controller.signal,
      cache: true,
      dedupe: false,
      cacheTtlMs: 5_000,
    }));
  });

  test('rejects malformed service envelopes instead of accepting ambiguous configuration data', async () => {
    mockedGet.mockResolvedValue({ data: [] });

    await expect(ConfigurationBusiness.GetConfigServices()).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
  });

  test('propagates normalized platform transport failures', async () => {
    const failure = Object.assign(new Error('Ağ bağlantısı kurulamadı.'), { code: 'NETWORK_ERROR' });
    mockedGet.mockRejectedValue(failure);

    await expect(ConfigurationBusiness.GetMapConfiguration()).rejects.toBe(failure);
  });
});
