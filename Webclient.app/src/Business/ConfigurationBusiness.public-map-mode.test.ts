import { describe, expect, it } from 'vitest';
import { ConfigurationBusiness } from './ConfigurationBusiness';

describe('PlanASKI-only bootstrap', () => {
  it('provides deterministic map configuration regardless of runtime flags', async () => {
    await expect(ConfigurationBusiness.GetMapConfiguration()).resolves.toEqual({
      isSuccess: true,
      data: { configValue: JSON.stringify({ Centerx: 32.854, Centery: 39.92, Zoom: 12 }) },
    });
  });
  it('never advertises the removed backend GIS service catalogue', async () => {
    await expect(ConfigurationBusiness.GetConfigServices()).resolves.toEqual({ isSuccess: true, data: [] });
  });
});
