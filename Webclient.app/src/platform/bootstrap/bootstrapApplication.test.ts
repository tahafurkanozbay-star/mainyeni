import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import { CommonBusiness } from '../../Business/CommonBusiness';
import MapManager from '../../Store/Managers/MapManager';
import {
  applicationBootstrapDependencies,
  bootstrapApplication,
  clearApplicationBootstrapDiagnostics,
  getApplicationBootstrapDiagnostics,
  getApplicationBootstrapDiagnosticSummary
} from './bootstrapApplication';

vi.mock('../../Business/ConfigurationBusiness', () => ({
  ConfigurationBusiness: {
    GetMapConfiguration: vi.fn(),
    GetConfigServices: vi.fn()
  }
}));

vi.mock('../../Business/CommonBusiness', () => ({
  CommonBusiness: {
    GenerateUrl: vi.fn(),
    AddProxyRule: vi.fn()
  }
}));

vi.mock('../../Store/Managers/MapManager', () => ({
  default: {
    SetMapConfiguration: vi.fn(),
    SetConfigurationServices: vi.fn()
  }
}));

const getMapConfiguration = vi.mocked(ConfigurationBusiness.GetMapConfiguration);
const getConfigServices = vi.mocked(ConfigurationBusiness.GetConfigServices);
const generateUrl = vi.mocked(CommonBusiness.GenerateUrl);
const addProxyRule = vi.mocked(CommonBusiness.AddProxyRule);
const setMapConfiguration = vi.mocked(MapManager.SetMapConfiguration);
const setConfigurationServices = vi.mocked(MapManager.SetConfigurationServices);

const mapConfiguration = {
  center: [32.85, 39.92],
  zoom: 10,
  spatialReference: { wkid: 4326 }
};

const services = [
  { id: 1, title: 'Parcels', eg: 'https://gis.example.test/parcels' },
  { id: 2, title: 'Roads', eg: 'https://gis.example.test/roads' }
];

const resetSuccessfulDefaults = (): void => {
  getMapConfiguration.mockResolvedValue({
    isSuccess: true,
    data: { configValue: JSON.stringify(mapConfiguration) }
  });
  getConfigServices.mockResolvedValue({
    isSuccess: true,
    data: services
  });
  generateUrl.mockImplementation((service) => service.eg);
  addProxyRule.mockResolvedValue(undefined);
  setMapConfiguration.mockReturnValue(undefined);
  setConfigurationServices.mockReturnValue(undefined);
};

describe('applicationBootstrapDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSuccessfulDefaults();
  });

  test('loads map configuration through ConfigurationBusiness', async () => {
    const signal = new AbortController().signal;
    await applicationBootstrapDependencies.loadMapConfiguration({ signal });
    expect(getMapConfiguration).toHaveBeenCalledWith({ signal });
  });

  test('loads GIS service configuration through ConfigurationBusiness', async () => {
    const signal = new AbortController().signal;
    await applicationBootstrapDependencies.loadConfigurationServices({ signal });
    expect(getConfigServices).toHaveBeenCalledWith({ signal });
  });

  test('generates proxy URLs through CommonBusiness', () => {
    const value = applicationBootstrapDependencies.generateServiceUrl(services[0]);
    expect(value).toBe(services[0].eg);
    expect(generateUrl).toHaveBeenCalledWith(services[0]);
  });

  test('installs proxy rules through CommonBusiness', async () => {
    await applicationBootstrapDependencies.addProxyRule('https://gis.example.test/a', 'source');
    expect(addProxyRule).toHaveBeenCalledWith('https://gis.example.test/a', 'source');
  });

  test('commits map configuration through MapManager', async () => {
    await applicationBootstrapDependencies.setMapConfiguration(mapConfiguration);
    expect(setMapConfiguration).toHaveBeenCalledWith(mapConfiguration);
  });

  test('commits service configuration through MapManager', async () => {
    await applicationBootstrapDependencies.setConfigurationServices(services);
    expect(setConfigurationServices).toHaveBeenCalledWith(services);
  });
});

describe('bootstrapApplication integration adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearApplicationBootstrapDiagnostics();
    resetSuccessfulDefaults();
  });

  test('executes the complete bootstrap pipeline', async () => {
    const result = await bootstrapApplication();

    expect(result.status).toBe('completed');
    expect(result.serviceCount).toBe(2);
    expect(result.proxyRuleCount).toBe(2);
    expect(getMapConfiguration).toHaveBeenCalledTimes(1);
    expect(getConfigServices).toHaveBeenCalledTimes(1);
    expect(generateUrl).toHaveBeenCalledTimes(2);
    expect(addProxyRule).toHaveBeenCalledTimes(2);
    expect(setMapConfiguration).toHaveBeenCalledWith(mapConfiguration);
    expect(setConfigurationServices).toHaveBeenCalledWith(services);
  });

  test('passes a caller cancellation signal to both network loaders', async () => {
    const signal = new AbortController().signal;

    await bootstrapApplication({ signal });

    expect(getMapConfiguration).toHaveBeenCalledWith({ signal });
    expect(getConfigServices).toHaveBeenCalledWith({ signal });
  });

  test('does not commit configuration when the map request fails', async () => {
    getMapConfiguration.mockResolvedValue({
      isSuccess: false,
      message: 'map unavailable'
    });

    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_MAP_REQUEST_FAILED'
    });
    expect(addProxyRule).not.toHaveBeenCalled();
    expect(setMapConfiguration).not.toHaveBeenCalled();
    expect(setConfigurationServices).not.toHaveBeenCalled();
  });

  test('does not commit configuration when the service request fails', async () => {
    getConfigServices.mockResolvedValue({
      isSuccess: false,
      message: 'services unavailable'
    });

    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_SERVICE_REQUEST_FAILED'
    });
    expect(addProxyRule).not.toHaveBeenCalled();
    expect(setMapConfiguration).not.toHaveBeenCalled();
  });

  test('waits for asynchronous proxy setup before committing MapManager state', async () => {
    let resolveProxy!: () => void;
    const proxyPromise = new Promise<void>((resolve) => { resolveProxy = resolve; });
    addProxyRule
      .mockReturnValueOnce(proxyPromise)
      .mockResolvedValueOnce(undefined);

    const execution = bootstrapApplication();
    await Promise.resolve();
    await Promise.resolve();
    expect(setMapConfiguration).not.toHaveBeenCalled();

    resolveProxy();
    await execution;
    expect(setMapConfiguration).toHaveBeenCalledTimes(1);
  });

  test('deduplicates identical proxy endpoints while retaining both services', async () => {
    const sharedServices = [
      { id: 1, title: 'A', eg: 'https://gis.example.test/shared' },
      { id: 2, title: 'B', eg: 'https://gis.example.test/shared' }
    ];
    getConfigServices.mockResolvedValue({
      isSuccess: true,
      data: sharedServices
    });

    const result = await bootstrapApplication();
    expect(result.serviceCount).toBe(2);
    expect(result.proxyRuleCount).toBe(1);
    expect(addProxyRule).toHaveBeenCalledTimes(1);
    expect(setConfigurationServices).toHaveBeenCalledWith(sharedServices);
  });

  test('supports a deployment with no configured GIS services', async () => {
    getConfigServices.mockResolvedValue({
      isSuccess: true,
      data: []
    });

    const result = await bootstrapApplication();
    expect(result.serviceCount).toBe(0);
    expect(result.proxyRuleCount).toBe(0);
    expect(addProxyRule).not.toHaveBeenCalled();
    expect(setConfigurationServices).toHaveBeenCalledWith([]);
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

  test('exposes a compact diagnostics summary', async () => {
    await bootstrapApplication();
    const summary = getApplicationBootstrapDiagnosticSummary();
    expect(summary.totalRecorded).toBeGreaterThan(0);
    expect(summary.lastStage).toBe('completed');
    expect(summary.counters['bootstrap.completed']).toBe(1);
  });

  test('can clear shared diagnostics between application sessions', async () => {
    await bootstrapApplication();
    expect(getApplicationBootstrapDiagnostics().length).toBeGreaterThan(0);
    clearApplicationBootstrapDiagnostics();
    expect(getApplicationBootstrapDiagnostics()).toEqual([]);
    expect(getApplicationBootstrapDiagnosticSummary().totalRecorded).toBe(0);
  });

  test('records proxy failures without committing application state', async () => {
    addProxyRule.mockRejectedValue(new Error('proxy failed'));
    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_PROXY_SETUP_FAILED'
    });
    expect(setMapConfiguration).not.toHaveBeenCalled();
    expect(setConfigurationServices).not.toHaveBeenCalled();
    expect(getApplicationBootstrapDiagnosticSummary().counters['bootstrap.failed']).toBe(1);
  });
});
