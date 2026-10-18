import { describe, expect, test } from 'vitest';
import { ConfigurationBusiness } from './ConfigurationBusiness';

describe('static application bootstrap configuration', () => {
  test('returns the fixed Ankara view without a network dependency', async () => {
    await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toEqual({
      isSuccess: true,
      data: { configValue: JSON.stringify({ Centerx: 32.854, Centery: 39.92, Zoom: 12 }) },
    });
  });
  test('returns no legacy GIS service catalogue because PlanASKI is the sole data source', async () => {
    await expect(ConfigurationBusiness.GetConfigServices()).resolves.toEqual({ isSuccess: true, data: [] });
  });
  test('preserves cancellation for local bootstrap operations', async () => {
    const owner = new AbortController();
    const reason = new Error('cancelled');
    owner.abort(reason);
    await expect(ConfigurationBusiness.GetMapConfiguration({ signal: owner.signal })).rejects.toBe(reason);
    await expect(ConfigurationBusiness.GetConfigServices({ signal: owner.signal })).rejects.toBe(reason);
  });
});
