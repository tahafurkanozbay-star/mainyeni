import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import MapManager from '../../Store/Managers/MapManager';
import {
  applicationBootstrapDependencies,
  bootstrapApplication,
  clearApplicationBootstrapDiagnostics,
  getApplicationBootstrapDiagnostics,
  getApplicationBootstrapDiagnosticSummary,
} from './bootstrapApplication';

vi.mock('../../Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: vi.fn(),
    GetConfigServices: vi.fn(),
  },
}));

vi.mock('../../Store/Managers/MapManager', () => ({
  default: {
    SetMapConfiguration: vi.fn(),
    SetConfigurationServices: vi.fn(),
  },
}));

const getMapConfiguration = vi.mocked(ConfigurationBusiness.GetMapConfiguration);
const getConfigServices = vi.mocked(ConfigurationBusiness.GetConfigServices);
const setMapConfiguration = vi.mocked(MapManager.SetMapConfiguration);
const setConfigurationServices = vi.mocked(MapManager.SetConfigurationServices);

const mapConfiguration = Object.freeze({
  Centerx: 32.854,
  Centery: 39.92,
  Zoom: 12,
});

const resetSuccessfulDefaults = (): void => {
  getMapConfiguration.mockResolvedValue({
    isSuccess: true,
    data: { configValue: JSON.stringify(mapConfiguration) },
  });
  getConfigServices.mockResolvedValue({ isSuccess: true, data: [] });
  setMapConfiguration.mockReturnValue(undefined);
  setConfigurationServices.mockReturnValue(undefined);
};

describe('applicationBootstrapDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSuccessfulDefaults();
  });

  test('loads the static map configuration through ConfigurationBusiness', async () => {
    const signal = new AbortController().signal;
    await applicationBootstrapDependencies.loadMapConfiguration({ signal });
    expect(getMapConfiguration).toHaveBeenCalledWith({ signal });
  });

  test('returns an empty legacy-service catalogue without proxy URLs', async () => {
    const signal = new AbortController().signal;
    await applicationBootstrapDependencies.loadConfigurationServices({ signal });
    expect(getConfigServices).toHaveBeenCalledWith({ signal });
    expect(applicationBootstrapDependencies.generateServiceUrl({ title: 'legacy GIS service' })).toBeNull();
    expect(applicationBootstrapDependencies.addProxyRule('https://example.invalid/gis', 'test')).toBeUndefined();
  });

  test('commits the selected local map configuration through MapManager', async () => {
    await applicationBootstrapDependencies.setMapConfiguration(mapConfiguration);
    expect(setMapConfiguration).toHaveBeenCalledWith(mapConfiguration);
  });

  test('commits the empty legacy-service catalogue through MapManager', async () => {
    await applicationBootstrapDependencies.setConfigurationServices([]);
    expect(setConfigurationServices).toHaveBeenCalledWith([]);
  });
});

describe('bootstrapApplication integration adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearApplicationBootstrapDiagnostics();
    resetSuccessfulDefaults();
  });

  test('executes the local bootstrap pipeline without registering API proxy rules', async () => {
    const result = await bootstrapApplication();

    expect(result.status).toBe('completed');
    expect(result.serviceCount).toBe(0);
    expect(result.proxyRuleCount).toBe(0);
    expect(getMapConfiguration).toHaveBeenCalledTimes(1);
    expect(getConfigServices).toHaveBeenCalledTimes(1);
    expect(setMapConfiguration).toHaveBeenCalledWith(mapConfiguration);
    expect(setConfigurationServices).toHaveBeenCalledWith([]);
  });

  test('passes caller cancellation through the local bootstrap operations', async () => {
    const signal = new AbortController().signal;
    await bootstrapApplication({ signal });
    expect(getMapConfiguration).toHaveBeenCalledWith({ signal });
    expect(getConfigServices).toHaveBeenCalledWith({ signal });
  });

  test('does not commit configuration when the map request fails', async () => {
    getMapConfiguration.mockResolvedValue({ isSuccess: false, message: 'map unavailable' } as never);

    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_MAP_REQUEST_FAILED',
    });
    expect(setMapConfiguration).not.toHaveBeenCalled();
    expect(setConfigurationServices).not.toHaveBeenCalled();
  });

  test('does not commit configuration when the service catalogue fails', async () => {
    getConfigServices.mockResolvedValue({ isSuccess: false, message: 'services unavailable' } as never);

    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_SERVICE_REQUEST_FAILED',
    });
    expect(setMapConfiguration).not.toHaveBeenCalled();
    expect(setConfigurationServices).not.toHaveBeenCalled();
  });

  test('uses a caller-provided diagnostics collector instead of the shared collector', async () => {
    const diagnostics = { record: vi.fn() };
    await bootstrapApplication({ diagnostics });
    expect(diagnostics.record).toHaveBeenCalledWith('bootstrap.started', expect.any(Object));
    expect(getApplicationBootstrapDiagnostics()).toEqual([]);
  });

  test('stores bounded default diagnostics for support inspection', async () => {
    await bootstrapApplication();
    const events = getApplicationBootstrapDiagnostics();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.name === 'bootstrap.completed')).toBe(true);
  });

  test('exposes and clears a compact diagnostics summary', async () => {
    await bootstrapApplication();
    expect(getApplicationBootstrapDiagnosticSummary().counters['bootstrap.completed']).toBe(1);

    clearApplicationBootstrapDiagnostics();
    expect(getApplicationBootstrapDiagnostics()).toEqual([]);
    expect(getApplicationBootstrapDiagnosticSummary().totalRecorded).toBe(0);
  });
});
