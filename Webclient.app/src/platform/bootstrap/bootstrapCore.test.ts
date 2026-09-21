import { vi as jest } from 'vitest';
import { AppError } from '../errors/appError';
import {
  BootstrapErrorCode,
  BootstrapStage,
  assertSuccessfulServiceResult,
  bootstrapDurationBucket,
  createBootstrapDependencies,
  createBootstrapPlan,
  isBootstrapAbortError,
  normalizeConfigurationServices,
  normalizeProxyUrl,
  parseMapConfiguration,
  runApplicationBootstrap,
  throwIfBootstrapAborted
} from './bootstrapCore';
import type { BootstrapDependencies, ConfigurationService, MapConfiguration } from './bootstrapCore';

const successfulMapResult = (configuration: MapConfiguration = { wkid: 4326, zoom: 9 }) => ({
  isSuccess: true,
  data: {
    configValue: JSON.stringify(configuration)
  }
});

const successfulServicesResult = (services: readonly unknown[] = []) => ({
  isSuccess: true,
  data: services
});

const service = (id: number | string, url = `https://gis.example.test/${id}`): ConfigurationService => ({
  id,
  title: `Service ${id}`,
  eg: url
});

const createSignal = (aborted = false): AbortSignal => {
  const controller = new AbortController();
  if (aborted) controller.abort('bootstrap-test-abort');
  return controller.signal;
};

const createDependencies = (
  overrides: Partial<BootstrapDependencies> = {},
): BootstrapDependencies => {
  const defaults: BootstrapDependencies = {
    loadMapConfiguration: jest.fn().mockResolvedValue(successfulMapResult()),
    loadConfigurationServices: jest.fn().mockResolvedValue(successfulServicesResult([
      service(1),
      service(2),
    ])),
    generateServiceUrl: jest.fn((item: ConfigurationService) => item.eg),
    addProxyRule: jest.fn().mockResolvedValue(undefined),
    setMapConfiguration: jest.fn().mockResolvedValue(undefined),
    setConfigurationServices: jest.fn().mockResolvedValue(undefined),
  };
  return { ...defaults, ...overrides };
};

const createDiagnostics = () => ({
  record: jest.fn<(event: string, payload?: Readonly<Record<string, unknown>>) => void>(),
});

const requireAppError = (error: unknown): AppError => {
  expect(error).toBeInstanceOf(AppError);
  if (!(error instanceof AppError)) throw error;
  return error;
};

describe('assertSuccessfulServiceResult', () => {
  test('returns the same successful result object', () => {
    const result = { isSuccess: true, data: { value: 1 } };
    expect(assertSuccessfulServiceResult(result)).toBe(result);
  });

  test('rejects null service results', () => {
    expect(() => assertSuccessfulServiceResult(null, {
      code: 'MISSING',
      message: 'missing'
    })).toThrow(AppError);
  });

  test('rejects undefined service results', () => {
    expect(() => assertSuccessfulServiceResult(undefined)).toThrow(AppError);
  });

  test('rejects service results without explicit success', () => {
    expect(() => assertSuccessfulServiceResult({ data: [] })).toThrow(AppError);
  });

  test('preserves a controlled service failure message', () => {
    try {
      assertSuccessfulServiceResult({ isSuccess: false, message: 'Controlled failure' }, {
        code: 'CONTROLLED'
      });
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.message).toBe('Controlled failure');
      expect(appError.code).toBe('CONTROLLED');
      expect(appError.retryable).toBe(true);
    }
  });

  test('uses the provided fallback when the service message is blank', () => {
    expect(() => assertSuccessfulServiceResult({
      isSuccess: false,
      message: '   '
    }, {
      message: 'Fallback message'
    })).toThrow('Fallback message');
  });
});

describe('parseMapConfiguration', () => {
  test('parses a JSON configuration object', () => {
    const configuration = { center: [32.8, 39.9], zoom: 10 };
    expect(parseMapConfiguration(successfulMapResult(configuration))).toEqual(configuration);
  });

  test('accepts an already materialized configuration object', () => {
    const configuration = { spatialReference: { wkid: 3857 } };
    expect(parseMapConfiguration({
      isSuccess: true,
      data: { configValue: configuration }
    })).toBe(configuration);
  });

  test('supports legacy ConfigValue casing', () => {
    expect(parseMapConfiguration({
      isSuccess: true,
      data: { ConfigValue: '{"zoom":12}' }
    })).toEqual({ zoom: 12 });
  });

  test.each([
    { isSuccess: true, data: {} },
    { isSuccess: true, data: { configValue: null } },
    { isSuccess: true, data: { configValue: '   ' } }
  ])('rejects missing map payload %#', (result) => {
    try {
      parseMapConfiguration(result);
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.MAP_PAYLOAD_MISSING);
    }
  });

  test.each([
    'not-json',
    '[]',
    'null',
    '42',
    '"map"'
  ])('rejects invalid map JSON shape %s', (configValue) => {
    try {
      parseMapConfiguration({ isSuccess: true, data: { configValue } });
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.MAP_PAYLOAD_INVALID);
      expect(appError.retryable).toBe(false);
    }
  });

  test('maps failed service result to map request error', () => {
    try {
      parseMapConfiguration({ isSuccess: false, message: 'Map unavailable' });
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.MAP_REQUEST_FAILED);
      expect(appError.message).toBe('Map unavailable');
    }
  });
});

describe('normalizeConfigurationServices', () => {
  test('returns an empty list for a successful null payload', () => {
    expect(normalizeConfigurationServices({ isSuccess: true, data: null })).toEqual([]);
  });

  test('returns an empty list for a successful undefined payload', () => {
    expect(normalizeConfigurationServices({ isSuccess: true })).toEqual([]);
  });

  test('keeps service order stable', () => {
    const services = [service(3), service(1), service(2)];
    expect(normalizeConfigurationServices(successfulServicesResult(services))).toEqual(services);
  });

  test('deduplicates services by stable id', () => {
    const first = service(7, 'https://gis.example.test/a');
    const second = { ...first, eg: 'https://gis.example.test/b' };
    expect(normalizeConfigurationServices(successfulServicesResult([first, second]))).toEqual([first]);
  });

  test('deduplicates services by legacy Id casing', () => {
    const first = { Id: 4, Title: 'A', Eg: 'https://gis.example.test/a' };
    const second = { Id: 4, Title: 'B', Eg: 'https://gis.example.test/b' };
    expect(normalizeConfigurationServices(successfulServicesResult([first, second]))).toEqual([first]);
  });

  test('rejects non-array service payloads', () => {
    try {
      normalizeConfigurationServices({ isSuccess: true, data: { id: 1 } });
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.SERVICE_PAYLOAD_INVALID);
    }
  });

  test.each([null, 'service', 17, true])('rejects invalid service entry %p', (invalidEntry) => {
    try {
      normalizeConfigurationServices(successfulServicesResult([invalidEntry]));
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.SERVICE_PAYLOAD_INVALID);
    }
  });

  test('maps failed service result to service request error', () => {
    try {
      normalizeConfigurationServices({ isSuccess: false, message: 'Services unavailable' });
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.SERVICE_REQUEST_FAILED);
      expect(appError.message).toBe('Services unavailable');
    }
  });
});

describe('normalizeProxyUrl', () => {
  test('trims a service URL without rewriting it', () => {
    expect(normalizeProxyUrl('  https://gis.example.test/MapServer  '))
      .toBe('https://gis.example.test/MapServer');
  });

  test.each([null, undefined, '', '   '])('rejects missing service URL %p', (value) => {
    expect(() => normalizeProxyUrl(value)).toThrow(AppError);
  });

  test('can explicitly allow an empty optional URL', () => {
    expect(normalizeProxyUrl('', { allowEmpty: true })).toBeNull();
  });

  test.each([
    'https://gis.example.test/a\r\nInjected: true',
    '\nhttps://gis.example.test/a'
  ])('rejects control characters in service URL %p', (value) => {
    try {
      normalizeProxyUrl(value, { serviceIndex: 5 });
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.SERVICE_URL_INVALID);
      expect(appError.details?.serviceIndex).toBe(5);
    }
  });
});

describe('createBootstrapPlan', () => {
  test('creates one proxy rule for each unique generated URL', () => {
    const services = [
      service(1, 'https://gis.example.test/shared'),
      service(2, 'https://gis.example.test/shared'),
      service(3, 'https://gis.example.test/other')
    ];

    const plan = createBootstrapPlan({
      mapConfiguration: { zoom: 9 },
      configurationServices: services,
      generateServiceUrl: (item: ConfigurationService) => item.eg
    });

    expect(plan.summary).toEqual({ serviceCount: 3, proxyRuleCount: 2 });
    expect(plan.proxyRules.map((rule) => rule.url)).toEqual([
      'https://gis.example.test/shared',
      'https://gis.example.test/other'
    ]);
  });

  test('does not mutate the source service array', () => {
    const services = [service(1), service(2)];
    const snapshot = [...services];
    createBootstrapPlan({
      mapConfiguration: { zoom: 9 },
      configurationServices: services,
      generateServiceUrl: (item: ConfigurationService) => item.eg
    });
    expect(services).toEqual(snapshot);
  });

  test('freezes the plan collections to prevent accidental bootstrap mutation', () => {
    const plan = createBootstrapPlan({
      mapConfiguration: { zoom: 9 },
      configurationServices: [service(1)],
      generateServiceUrl: (item: ConfigurationService) => item.eg
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.configurationServices)).toBe(true);
    expect(Object.isFrozen(plan.proxyRules)).toBe(true);
    expect(Object.isFrozen(plan.summary)).toBe(true);
  });

  test('requires a URL generator', () => {
    expect(() => createBootstrapPlan({
      mapConfiguration: {},
      configurationServices: []
    })).toThrow(AppError);
  });

  test('rejects an invalid generated URL before any runtime side effect', () => {
    expect(() => createBootstrapPlan({
      mapConfiguration: {},
      configurationServices: [service(1)],
      generateServiceUrl: () => null
    })).toThrow(AppError);
  });
});

describe('bootstrap cancellation helpers', () => {
  test('does nothing for an active signal', () => {
    expect(() => throwIfBootstrapAborted(createSignal(false), BootstrapStage.LOAD)).not.toThrow();
  });

  test('throws a typed error for an aborted signal', () => {
    try {
      throwIfBootstrapAborted(createSignal(true), BootstrapStage.PROXY);
      throw new Error('expected failure');
    } catch (error) {
      const appError = requireAppError(error);
      expect(appError.code).toBe(BootstrapErrorCode.ABORTED);
      expect(appError.details?.stage).toBe(BootstrapStage.PROXY);
      expect(isBootstrapAbortError(appError)).toBe(true);
    }
  });

  test('recognizes generic AbortError values', () => {
    expect(isBootstrapAbortError(Object.assign(new Error('cancelled'), {
      name: 'AbortError'
    }))).toBe(true);
  });

  test('does not classify ordinary application errors as cancellation', () => {
    expect(isBootstrapAbortError(new AppError('boom', { code: 'OTHER' }))).toBe(false);
  });
});

describe('runApplicationBootstrap', () => {
  test('loads map and service configuration concurrently', async () => {
    let mapResolve!: (value: ReturnType<typeof successfulMapResult>) => void;
    let servicesResolve!: (value: ReturnType<typeof successfulServicesResult>) => void;
    const mapPromise = new Promise<ReturnType<typeof successfulMapResult>>((resolve) => { mapResolve = resolve; });
    const servicesPromise = new Promise<ReturnType<typeof successfulServicesResult>>((resolve) => { servicesResolve = resolve; });
    const dependencies = createDependencies({
      loadMapConfiguration: jest.fn(() => mapPromise),
      loadConfigurationServices: jest.fn(() => servicesPromise)
    });

    const execution = runApplicationBootstrap(dependencies);
    expect(dependencies.loadMapConfiguration).toHaveBeenCalledTimes(1);
    expect(dependencies.loadConfigurationServices).toHaveBeenCalledTimes(1);

    mapResolve(successfulMapResult());
    servicesResolve(successfulServicesResult([]));
    await execution;
  });

  test('passes the same cancellation signal to both configuration loaders', async () => {
    const signal = createSignal(false);
    const dependencies = createDependencies({
      loadConfigurationServices: jest.fn().mockResolvedValue(successfulServicesResult([]))
    });

    await runApplicationBootstrap(dependencies, { signal });

    expect(dependencies.loadMapConfiguration).toHaveBeenCalledWith({ signal });
    expect(dependencies.loadConfigurationServices).toHaveBeenCalledWith({ signal });
  });

  test('awaits every proxy rule before committing configuration', async () => {
    const calls: string[] = [];
    const dependencies = createDependencies({
      addProxyRule: jest.fn(async (url: string) => {
        calls.push(`proxy:${url}`);
      }),
      setMapConfiguration: jest.fn(async () => {
        calls.push('commit:map');
      }),
      setConfigurationServices: jest.fn(async () => {
        calls.push('commit:services');
      })
    });

    await runApplicationBootstrap(dependencies);

    expect(calls).toEqual([
      'proxy:https://gis.example.test/1',
      'proxy:https://gis.example.test/2',
      'commit:map',
      'commit:services'
    ]);
  });

  test('returns a completed immutable result summary', async () => {
    const result = await runApplicationBootstrap(createDependencies());
    expect(result.status).toBe(BootstrapStage.COMPLETED);
    expect(result.serviceCount).toBe(2);
    expect(result.proxyRuleCount).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('commits the parsed map configuration rather than the service wrapper', async () => {
    const configuration = { center: [32, 40], zoom: 11 };
    const dependencies = createDependencies({
      loadMapConfiguration: jest.fn().mockResolvedValue(successfulMapResult(configuration))
    });

    await runApplicationBootstrap(dependencies);
    expect(dependencies.setMapConfiguration).toHaveBeenCalledWith(configuration);
  });

  test('commits normalized configuration services', async () => {
    const first = service(1);
    const duplicate = { ...first, title: 'Duplicate' };
    const dependencies = createDependencies({
      loadConfigurationServices: jest.fn().mockResolvedValue(
        successfulServicesResult([first, duplicate])
      )
    });

    await runApplicationBootstrap(dependencies);
    expect(dependencies.setConfigurationServices).toHaveBeenCalledWith([first]);
  });

  test('does not commit state when proxy setup fails', async () => {
    const dependencies = createDependencies({
      addProxyRule: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('proxy unavailable'))
    });

    await expect(runApplicationBootstrap(dependencies)).rejects.toMatchObject({
      code: BootstrapErrorCode.PROXY_SETUP_FAILED
    });
    expect(dependencies.setMapConfiguration).not.toHaveBeenCalled();
    expect(dependencies.setConfigurationServices).not.toHaveBeenCalled();
  });

  test('does not start loaders if the signal is already aborted', async () => {
    const dependencies = createDependencies();
    await expect(runApplicationBootstrap(dependencies, {
      signal: createSignal(true)
    })).rejects.toMatchObject({ code: BootstrapErrorCode.ABORTED });
    expect(dependencies.loadMapConfiguration).not.toHaveBeenCalled();
    expect(dependencies.loadConfigurationServices).not.toHaveBeenCalled();
  });

  test('stops before proxy setup when cancellation arrives after loading', async () => {
    const controller = new AbortController();
    const dependencies = createDependencies({
      loadConfigurationServices: jest.fn(async () => {
        controller.abort('after-load');
        return successfulServicesResult([service(1)]);
      })
    });

    await expect(runApplicationBootstrap(dependencies, { signal: controller.signal }))
      .rejects.toMatchObject({ code: BootstrapErrorCode.ABORTED });
    expect(dependencies.addProxyRule).not.toHaveBeenCalled();
    expect(dependencies.setMapConfiguration).not.toHaveBeenCalled();
  });

  test('stops between proxy rules when cancellation arrives during setup', async () => {
    const controller = new AbortController();
    const dependencies = createDependencies({
      addProxyRule: jest.fn(async () => {
        controller.abort('during-proxy');
      })
    });

    await expect(runApplicationBootstrap(dependencies, { signal: controller.signal }))
      .rejects.toMatchObject({ code: BootstrapErrorCode.ABORTED });
    expect(dependencies.addProxyRule).toHaveBeenCalledTimes(1);
    expect(dependencies.setMapConfiguration).not.toHaveBeenCalled();
  });

  test('classifies map transport failure as a map request failure', async () => {
    const dependencies = createDependencies({
      loadMapConfiguration: jest.fn().mockResolvedValue({
        isSuccess: false,
        message: 'map failed'
      })
    });

    await expect(runApplicationBootstrap(dependencies)).rejects.toMatchObject({
      code: BootstrapErrorCode.MAP_REQUEST_FAILED,
      message: 'map failed'
    });
  });

  test('classifies service transport failure as a service request failure', async () => {
    const dependencies = createDependencies({
      loadConfigurationServices: jest.fn().mockResolvedValue({
        isSuccess: false,
        message: 'services failed'
      })
    });

    await expect(runApplicationBootstrap(dependencies)).rejects.toMatchObject({
      code: BootstrapErrorCode.SERVICE_REQUEST_FAILED,
      message: 'services failed'
    });
  });

  test('classifies unexpected commit exceptions as commit failures', async () => {
    const dependencies = createDependencies({
      setMapConfiguration: jest.fn(() => {
        throw new Error('store failed');
      })
    });

    await expect(runApplicationBootstrap(dependencies)).rejects.toMatchObject({
      code: BootstrapErrorCode.COMMIT_FAILED
    });
  });

  test('records deterministic stage transitions for a successful bootstrap', async () => {
    const diagnostics = createDiagnostics();
    await runApplicationBootstrap(createDependencies(), { diagnostics });

    const stages = diagnostics.record.mock.calls
      .filter(([eventName]) => eventName === 'bootstrap.stage')
      .map(([, metadata]) => metadata?.stage);

    expect(stages).toEqual([
      BootstrapStage.LOAD,
      BootstrapStage.VALIDATE,
      BootstrapStage.PREPARE,
      BootstrapStage.PROXY,
      BootstrapStage.COMMIT,
      BootstrapStage.COMPLETED
    ]);
  });

  test('records a failed event without exposing the raw thrown error', async () => {
    const diagnostics = createDiagnostics();
    const dependencies = createDependencies({
      addProxyRule: jest.fn().mockRejectedValue(new Error('secret upstream details'))
    });

    await expect(runApplicationBootstrap(dependencies, { diagnostics })).rejects.toBeInstanceOf(AppError);

    const failedCall = diagnostics.record.mock.calls.find(([name]) => name === 'bootstrap.failed');
    expect(failedCall).toBeDefined();
    if (!failedCall) throw new TypeError('expected bootstrap.failed diagnostic');
    expect(failedCall[1]).toMatchObject({
      failedStage: BootstrapStage.PROXY,
      errorCode: BootstrapErrorCode.PROXY_SETUP_FAILED,
      retryable: true
    });
    expect(JSON.stringify(failedCall[1])).not.toContain('secret upstream details');
  });

  test('records cancellation distinctly from failures', async () => {
    const diagnostics = createDiagnostics();
    await expect(runApplicationBootstrap(createDependencies(), {
      signal: createSignal(true),
      diagnostics
    })).rejects.toMatchObject({ code: BootstrapErrorCode.ABORTED });

    expect(diagnostics.record).toHaveBeenCalledWith('bootstrap.cancelled', expect.objectContaining({
      failedStage: BootstrapStage.LOAD,
      errorCode: BootstrapErrorCode.ABORTED
    }));
    expect(diagnostics.record.mock.calls.some(([name]) => name === 'bootstrap.failed')).toBe(false);
  });

  test('supports a successful bootstrap with zero configuration services', async () => {
    const dependencies = createDependencies({
      loadConfigurationServices: jest.fn().mockResolvedValue(successfulServicesResult([]))
    });
    const result = await runApplicationBootstrap(dependencies);
    expect(result.serviceCount).toBe(0);
    expect(result.proxyRuleCount).toBe(0);
    expect(dependencies.addProxyRule).not.toHaveBeenCalled();
    expect(dependencies.setConfigurationServices).toHaveBeenCalledWith([]);
  });
});

describe('createBootstrapDependencies', () => {
  test('returns all required dependency functions', () => {
    const dependencies = createDependencies();
    const normalized = createBootstrapDependencies(dependencies);
    expect(normalized.loadMapConfiguration).toBe(dependencies.loadMapConfiguration);
    expect(normalized.loadConfigurationServices).toBe(dependencies.loadConfigurationServices);
    expect(normalized.generateServiceUrl).toBe(dependencies.generateServiceUrl);
    expect(normalized.addProxyRule).toBe(dependencies.addProxyRule);
    expect(normalized.setMapConfiguration).toBe(dependencies.setMapConfiguration);
    expect(normalized.setConfigurationServices).toBe(dependencies.setConfigurationServices);
  });

  test.each([
    'loadMapConfiguration',
    'loadConfigurationServices',
    'generateServiceUrl',
    'addProxyRule',
    'setMapConfiguration',
    'setConfigurationServices',
  ] as const)('rejects missing dependency %s', (key) => {
    const dependencies: Partial<BootstrapDependencies> = { ...createDependencies() };
    delete dependencies[key];
    expect(() => createBootstrapDependencies(dependencies)).toThrow(AppError);
  });
});

describe('bootstrapDurationBucket', () => {
  test.each([
    [0, 'lt-250ms'],
    [249, 'lt-250ms'],
    [250, '250ms-1s'],
    [999, '250ms-1s'],
    [1000, '1s-3s'],
    [2999, '1s-3s'],
    [3000, '3s-10s'],
    [9999, '3s-10s'],
    [10000, 'gte-10s'],
    [60000, 'gte-10s']
  ])('buckets %pms as %s', (durationMs, expected) => {
    expect(bootstrapDurationBucket(durationMs)).toBe(expected);
  });

  test('clamps negative durations into the fastest bucket', () => {
    expect(bootstrapDurationBucket(-100)).toBe('lt-250ms');
  });

  test('handles invalid durations defensively', () => {
    expect(bootstrapDurationBucket('not-a-number')).toBe('lt-250ms');
  });
});
