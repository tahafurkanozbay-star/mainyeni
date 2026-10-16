import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../platform/http/httpClient', () => ({ apiClient: client }));

beforeEach(() => {
  vi.resetModules();
  client.get.mockReset();
  vi.stubEnv('DEV', false);
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_PUBLIC_MAP_ONLY_MODE', 'true');
  vi.stubEnv('VITE_LOCAL_BOOTSTRAP_PREVIEW', 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('explicit public map-only mode', () => {
  it('returns a safe Ankara map configuration without depending on legacy API settings', async () => {
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');

    await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toEqual({
      isSuccess: true,
      data: { configValue: JSON.stringify({ Centerx: 32.854, Centery: 39.92, Zoom: 12 }) },
    });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('provides an empty, valid GIS configuration list without issuing an API request', async () => {
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');

    await expect(ConfigurationBusiness.GetConfigServices()).resolves.toEqual({
      isSuccess: true,
      data: [],
    });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('honors cancellation rather than turning an aborted bootstrap into a success', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');

    await expect(ConfigurationBusiness.GetConfigServices({ signal: controller.signal })).rejects.toBe(reason);
    expect(client.get).not.toHaveBeenCalled();
  });

  it.each(['1', 'true', 'YES', 'on', 'enabled'])('enables only when explicitly configured: %s', async (value) => {
    const { resolvePublicMapOnlyMode } = await import('./ConfigurationBusiness');
    expect(resolvePublicMapOnlyMode(value)).toBe(true);
  });

  it.each([undefined, '', 'false', '0', 'off', 'disabled', 'unexpected'])('does not enable the production fallback by default: %s', async (value) => {
    const { resolvePublicMapOnlyMode } = await import('./ConfigurationBusiness');
    expect(resolvePublicMapOnlyMode(value)).toBe(false);
  });

  it('preserves the normal production API contract when map-only mode is disabled', async () => {
    vi.stubEnv('VITE_PUBLIC_MAP_ONLY_MODE', 'false');
    const unauthorized = Object.assign(new Error('HTTP 401'), { status: 401 });
    client.get.mockRejectedValue(unauthorized);
    const { ConfigurationBusiness } = await import('./ConfigurationBusiness');

    await expect(ConfigurationBusiness.GetMapConfiguration()).rejects.toBe(unauthorized);
    await expect(ConfigurationBusiness.GetConfigServices()).rejects.toBe(unauthorized);
    expect(client.get).toHaveBeenCalledTimes(2);
  });
});
