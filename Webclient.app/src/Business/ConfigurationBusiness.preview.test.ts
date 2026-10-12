import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../platform/http/httpClient', () => ({ apiClient: client }));

beforeEach(() => {
  vi.resetModules();
  client.get.mockReset();
  vi.stubEnv('DEV', true);
  vi.stubEnv('MODE', 'development');
  vi.stubEnv('VITE_LOCAL_BOOTSTRAP_PREVIEW', 'true');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('local bootstrap API priority', () => {
  it('uses real configured services even when local preview is enabled', async () => {
    const payload = { isSuccess: true, data: [{ title: 'YeniParklarQeryUrl', eg: 'https://public.gissrv.org' }] };
    client.get.mockResolvedValue(payload);
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');
    await expect(ConfigurationBusiness.GetConfigServices()).resolves.toBe(payload);
    expect(client.get).toHaveBeenCalledWith('/Gis/ConfigService/List', expect.objectContaining({ timeout: 3000, maxRetries: 0 }));
  });

  it('uses actual map configuration before considering the preview fallback', async () => {
    const payload = { isSuccess: true, data: { configValue: '{"Zoom":15}' } };
    client.get.mockResolvedValue(payload);
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');
    await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toBe(payload);
  });

  it('falls back only after the API fails in local development', async () => {
    client.get.mockRejectedValue(new Error('offline'));
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');
    const [map, services] = await Promise.all([
      ConfigurationBusiness.GetMapConfiguration(), ConfigurationBusiness.GetConfigServices(),
    ]);
    expect(map.isSuccess).toBe(true);
    expect(JSON.parse(map.data?.configValue ?? '{}')).toMatchObject({ Zoom: 12 });
    expect(services).toEqual({ isSuccess: true, data: [] });
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('never converts an explicitly cancelled bootstrap into successful preview data', async () => {
    const abort = new AbortController();
    abort.abort();
    client.get.mockRejectedValue(abort.signal.reason);
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');
    await expect(ConfigurationBusiness.GetConfigServices({ signal: abort.signal })).rejects.toBe(abort.signal.reason);
  });

  it('propagates production failures even if the preview flag is present', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    const error = new Error('offline');
    client.get.mockRejectedValue(error);
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');
    await expect(ConfigurationBusiness.GetMapConfiguration()).rejects.toBe(error);
  });
});
