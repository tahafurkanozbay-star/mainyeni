import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigurationBusiness } from './ConfigurationBusiness';
import { apiClient } from '../platform/http/httpClient';

vi.mock('../platform/http/httpClient', () => ({
  apiClient: { get: vi.fn() },
}));

const mockedGet = vi.mocked(apiClient.get);

describe('API-free public map bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses the local Ankara map configuration without requesting AppSettings', async () => {
    const result = await ConfigurationBusiness.GetMapConfiguration();
    expect(result.isSuccess).toBe(true);
    expect(JSON.parse(result.data?.configValue ?? '{}')).toEqual({
      Centerx: 32.854,
      Centery: 39.92,
      Zoom: 12,
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  test('does not request a private GIS service catalogue', async () => {
    await expect(ConfigurationBusiness.GetConfigServices()).resolves.toEqual({
      isSuccess: true,
      data: [],
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  test('honours cancellation before producing local configuration', async () => {
    const owner = new AbortController();
    owner.abort();
    await expect(ConfigurationBusiness.GetMapConfiguration({ signal: owner.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(ConfigurationBusiness.GetConfigServices({ signal: owner.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
