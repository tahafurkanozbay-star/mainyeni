import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import { arcgisProxyPolicy, resolveConfigurationServiceUrl } from '../network/arcgisProxyPolicy';
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

vi.mock('../network/arcgisProxyPolicy', () => ({
  resolveConfigurationServiceUrl: vi.fn(),
  arcgisProxyPolicy: {
    register: vi.fn()
  }
}));

vi.mock('../../Store/Managers/MapManager', () => ({
  __esModule: true,
  default: {
    SetMapConfiguration: vi.fn(),
    SetConfigurationServices: vi.fn()
  }
}));

const mapConfiguration = {
  center: [32.85, 39.92],
  zoom: 10,
  spatialReference: { wkid: 4326 }
};

const services = [
  { id: 1, title: 'Parcels', eg: 'https://gis.example.test/parcels' },
  { id: 2, title: 'Roads', eg: 'https://gis.example.test/roads' }
];

const resetSuccessfulDefaults = () => {
  ConfigurationBusiness.GetMapConfiguration.mockResolvedValue({
    isSuccess: true,
    data: { configValue: JSON.stringify(mapConfiguration) }
  });
  ConfigurationBusiness.GetConfigServices.mockResolvedValue({
    isSuccess: true,
    data: services
  });
  vi.mocked(resolveConfigurationServiceUrl).mockImplementation((service) => typeof service.eg === 'string' ? service.eg : null);
  vi.mocked(arcgisProxyPolicy.register).mockResolvedValue(undefined);
  MapManager.SetMapConfiguration.mockReturnValue(undefined);
  MapManager.SetConfigurationServices.mockReturnValue(undefined);
};

describe('applicationBootstrapDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSuccessfulDefaults();
  });

  test('loads map configuration through ConfigurationBusiness', async () => {
    const signal = { aborted: false };
    await applicationBootstrapDependencies.loadMapConfiguration({ signal });
    expect(ConfigurationBusiness.GetMapConfiguration).toHaveBeenCalledWith({ signal });
  });

  test('loads GIS service configuration through ConfigurationBusiness', async () => {
    const signal = { aborted: false };
    await applicationBootstrapDependencies.loadConfigurationServices({ signal });
    expect(ConfigurationBusiness.GetConfigServices).toHaveBeenCalledWith({ signal });
  });

  test('resolves service URLs through the typed proxy policy', () => {
    const value = applicationBootstrapDependencies.generateServiceUrl(services[0]);
    expect(value).toBe(services[0].eg);
    expect(resolveConfigurationServiceUrl).toHaveBeenCalledWith(services[0]);
  });

  test('installs proxy rules through the typed proxy policy', async () => {
    await applicationBootstrapDependencies.addProxyRule('https://gis.example.test/a', 'source');
    expect(arcgisProxyPolicy.register).toHaveBeenCalledWith('https://gis.example.test/a');
  });

  test('commits map configuration through MapManager', async () => {
    await applicationBootstrapDependencies.setMapConfiguration(mapConfiguration);
    expect(MapManager.SetMapConfiguration).toHaveBeenCalledWith(mapConfiguration);
  });

  test('commits service configuration through MapManager', async () => {
    await applicationBootstrapDependencies.setConfigurationServices(services);
    expect(MapManager.SetConfigurationServices).toHaveBeenCalledWith(services);
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
    expect(ConfigurationBusiness.GetMapConfiguration).toHaveBeenCalledTimes(1);
    expect(ConfigurationBusiness.GetConfigServices).toHaveBeenCalledTimes(1);
    expect(resolveConfigurationServiceUrl).toHaveBeenCalledTimes(2);
    expect(arcgisProxyPolicy.register).toHaveBeenCalledTimes(2);
    expect(MapManager.SetMapConfiguration).toHaveBeenCalledWith(mapConfiguration);
    expect(MapManager.SetConfigurationServices).toHaveBeenCalledWith(services);
  });

  test('passes a caller cancellation signal to both network loaders', async () => {
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    await bootstrapApplication({ signal });

    expect(ConfigurationBusiness.GetMapConfiguration).toHaveBeenCalledWith({ signal });
    expect(ConfigurationBusiness.GetConfigServices).toHaveBeenCalledWith({ signal });
  });

  test('does not commit configuration when the map request fails', async () => {
    ConfigurationBusiness.GetMapConfiguration.mockResolvedValue({
      isSuccess: false,
      message: 'map unavailable'
    });

    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_MAP_REQUEST_FAILED'
    });
    expect(arcgisProxyPolicy.register).not.toHaveBeenCalled();
    expect(MapManager.SetMapConfiguration).not.toHaveBeenCalled();
    expect(MapManager.SetConfigurationServices).not.toHaveBeenCalled();
  });

  test('does not commit configuration when the service request fails', async () => {
    ConfigurationBusiness.GetConfigServices.mockResolvedValue({
      isSuccess: false,
      message: 'services unavailable'
    });

    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_SERVICE_REQUEST_FAILED'
    });
    expect(arcgisProxyPolicy.register).not.toHaveBeenCalled();
    expect(MapManager.SetMapConfiguration).not.toHaveBeenCalled();
  });

  test('waits for asynchronous proxy setup before committing MapManager state', async () => {
    let resolveProxy;
    const proxyPromise = new Promise((resolve) => { resolveProxy = resolve; });
    arcgisProxyPolicy.register
      .mockReturnValueOnce(proxyPromise)
      .mockResolvedValueOnce(undefined);

    const execution = bootstrapApplication();
    await Promise.resolve();
    await Promise.resolve();
    expect(MapManager.SetMapConfiguration).not.toHaveBeenCalled();

    resolveProxy();
    await execution;
    expect(MapManager.SetMapConfiguration).toHaveBeenCalledTimes(1);
  });

  test('deduplicates identical proxy endpoints while retaining both services', async () => {
    const sharedServices = [
      { id: 1, title: 'A', eg: 'https://gis.example.test/shared' },
      { id: 2, title: 'B', eg: 'https://gis.example.test/shared' }
    ];
    ConfigurationBusiness.GetConfigServices.mockResolvedValue({
      isSuccess: true,
      data: sharedServices
    });

    const result = await bootstrapApplication();
    expect(result.serviceCount).toBe(2);
    expect(result.proxyRuleCount).toBe(1);
    expect(arcgisProxyPolicy.register).toHaveBeenCalledTimes(1);
    expect(MapManager.SetConfigurationServices).toHaveBeenCalledWith(sharedServices);
  });

  test('supports a deployment with no configured GIS services', async () => {
    ConfigurationBusiness.GetConfigServices.mockResolvedValue({
      isSuccess: true,
      data: []
    });

    const result = await bootstrapApplication();
    expect(result.serviceCount).toBe(0);
    expect(result.proxyRuleCount).toBe(0);
    expect(arcgisProxyPolicy.register).not.toHaveBeenCalled();
    expect(MapManager.SetConfigurationServices).toHaveBeenCalledWith([]);
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
    vi.mocked(arcgisProxyPolicy.register).mockRejectedValue(new Error('proxy failed'));
    await expect(bootstrapApplication()).rejects.toMatchObject({
      code: 'BOOTSTRAP_PROXY_SETUP_FAILED'
    });
    expect(MapManager.SetMapConfiguration).not.toHaveBeenCalled();
    expect(MapManager.SetConfigurationServices).not.toHaveBeenCalled();
    expect(getApplicationBootstrapDiagnosticSummary().counters['bootstrap.failed']).toBe(1);
  });
});
