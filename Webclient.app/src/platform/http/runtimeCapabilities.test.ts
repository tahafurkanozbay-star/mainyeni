import { vi as jest } from 'vitest';
import {
  RuntimeCapabilityPolicy,
  assertRequiredNetworkCapabilities,
  createRuntimeCapabilityReport,
  createRuntimeSupportSummary,
  createRuntimeTuningProfile,
  getCoarseConnectionProfile,
  scaleTimeoutForRuntime
} from './runtimeCapabilities';
import type { ConnectionLike, NavigatorLike, RuntimeLike } from './runtimeCapabilities';

type TestConnection = ConnectionLike & Record<string, unknown>;
type TestNavigator = NavigatorLike & Record<string, unknown> & {
  connection: TestConnection;
  userAgent?: string;
  language?: string;
  platform?: string;
};
type TestRuntime = RuntimeLike & {
  navigator: TestNavigator;
  crypto: { subtle?: unknown };
  performance: { now?: unknown };
};

const createRuntime = (overrides: Partial<TestRuntime> = {}): TestRuntime => {
  const runtime: TestRuntime = {
    Promise,
    fetch: jest.fn(),
    AbortController,
    URL,
    URLSearchParams,
    FormData: typeof FormData === 'undefined' ? function FormDataStub() {} : FormData,
    Blob: typeof Blob === 'undefined' ? function BlobStub() {} : Blob,
    ArrayBuffer,
    structuredClone: jest.fn(),
    requestIdleCallback: jest.fn(),
    crypto: { subtle: {} },
    performance: { now: jest.fn(() => 1) },
    navigator: {
      onLine: true,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      connection: {
        saveData: false,
        effectiveType: '4g',
        downlink: 12,
        rtt: 60,
      },
    },
  };
  return { ...runtime, ...overrides };
};

const connectionOf = (runtime: TestRuntime): TestConnection => {
  const connection = runtime.navigator.connection;
  if (!connection) throw new TypeError('expected test network connection');
  return connection;
};

describe('runtime capability report', () => {
  test('reports modern essential capabilities as supported', () => {
    const report = createRuntimeCapabilityReport(createRuntime(), () => 1234);

    expect(report.supported).toBe(true);
    expect(report.generatedAt).toBe(1234);
    expect(report.missingEssential).toEqual([]);
    expect(report.essential).toEqual({
      Promise: true,
      fetch: true,
      AbortController: true,
      URL: true,
      URLSearchParams: true
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.essential)).toBe(true);
    expect(Object.isFrozen(report.optional)).toBe(true);
  });

  test.each(RuntimeCapabilityPolicy.required)(
    'detects missing essential capability %s',
    (capability) => {
      const runtime = createRuntime();
      runtime[capability] = undefined;
      const report = createRuntimeCapabilityReport(runtime);

      expect(report.supported).toBe(false);
      expect(report.missingEssential).toContain(capability);
    }
  );

  test('assertion returns supported report unchanged', () => {
    const report = createRuntimeCapabilityReport(createRuntime());
    expect(assertRequiredNetworkCapabilities(report)).toBe(report);
  });

  test('assertion fails closed with explicit missing capability list', () => {
    const runtime = createRuntime({ fetch: undefined, AbortController: undefined });
    const report = createRuntimeCapabilityReport(runtime);

    expect(() => assertRequiredNetworkCapabilities(report)).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_BROWSER_RUNTIME',
        retryable: false,
        details: { missing: expect.arrayContaining(['fetch', 'AbortController']) }
      })
    );
  });

  test('optional capabilities are informative and non-blocking', () => {
    const runtime = createRuntime({
      FormData: undefined,
      Blob: undefined,
      structuredClone: undefined,
      requestIdleCallback: undefined,
      crypto: {},
      performance: {}
    });
    runtime.navigator.connection = undefined;

    const report = createRuntimeCapabilityReport(runtime);
    expect(report.supported).toBe(true);
    expect(report.optional.FormData).toBe(false);
    expect(report.optional.Blob).toBe(false);
    expect(report.optional.structuredClone).toBe(false);
    expect(report.optional.cryptoSubtle).toBe(false);
    expect(report.optional.requestIdleCallback).toBe(false);
    expect(report.optional.performanceNow).toBe(false);
    expect(report.optional.connectionInfo).toBe(false);
  });

  test('does not expose user-agent, language, platform or identifiers', () => {
    const runtime = createRuntime();
    runtime.navigator.userAgent = 'secret-user-agent';
    runtime.navigator.language = 'tr-TR';
    runtime.navigator.platform = 'private-platform';
    const report = createRuntimeCapabilityReport(runtime);
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('secret-user-agent');
    expect(serialized).not.toContain('tr-TR');
    expect(serialized).not.toContain('private-platform');
    expect(serialized).not.toMatch(/userAgent|language|platform/);
  });
});

describe('coarse connection profile', () => {
  test('reports offline without consulting detailed connection values', () => {
    const runtime = createRuntime();
    runtime.navigator.onLine = false;
    const profile = getCoarseConnectionProfile(runtime);

    expect(profile.online).toBe(false);
    expect(profile.quality).toBe('offline');
  });

  test('save-data is always constrained', () => {
    const runtime = createRuntime();
    connectionOf(runtime).saveData = true;
    expect(getCoarseConnectionProfile(runtime).quality).toBe('constrained');
  });

  test.each([
    ['slow-2g', 'constrained'],
    ['2g', 'constrained'],
    ['3g', 'limited'],
    ['4g', 'fast'],
    ['5g', 'normal'],
    [undefined, 'normal']
  ])('maps effective type %p to %p', (effectiveType, expected) => {
    const runtime = createRuntime();
    connectionOf(runtime).effectiveType = effectiveType;
    if (effectiveType !== '4g') {
      connectionOf(runtime).downlink = undefined;
      connectionOf(runtime).rtt = undefined;
    }
    expect(getCoarseConnectionProfile(runtime).quality).toBe(expected);
  });

  test.each([
    [0.5, 'lt-1'],
    [1, '1-4'],
    [3.99, '1-4'],
    [4, '4-10'],
    [9.99, '4-10'],
    [10, 'gte-10'],
    [100, 'gte-10'],
    [-1, 'unknown'],
    ['bad', 'unknown']
  ])('buckets downlink %p as %p', (downlink, bucket) => {
    const runtime = createRuntime();
    connectionOf(runtime).downlink = downlink;
    expect(getCoarseConnectionProfile(runtime).downlinkBucket).toBe(bucket);
  });

  test.each([
    [20, 'lt-100'],
    [99, 'lt-100'],
    [100, '100-299'],
    [299, '100-299'],
    [300, '300-999'],
    [999, '300-999'],
    [1000, 'gte-1000'],
    [-2, 'unknown'],
    [undefined, 'unknown']
  ])('buckets RTT %p as %p', (rtt, bucket) => {
    const runtime = createRuntime();
    connectionOf(runtime).rtt = rtt;
    expect(getCoarseConnectionProfile(runtime).rttBucket).toBe(bucket);
  });

  test('uses mozConnection and webkitConnection fallbacks without requiring them', () => {
    const runtime = createRuntime();
    runtime.navigator.connection = undefined;
    runtime.navigator.mozConnection = {
      saveData: true,
      effectiveType: '4g',
      downlink: 20,
      rtt: 20
    };
    expect(getCoarseConnectionProfile(runtime).quality).toBe('constrained');

    runtime.navigator.mozConnection = undefined;
    runtime.navigator.webkitConnection = { effectiveType: '3g' };
    expect(getCoarseConnectionProfile(runtime).quality).toBe('limited');
  });
});

describe('adaptive runtime tuning', () => {
  test('fast capable runtime receives bounded high concurrency', () => {
    const tuning = createRuntimeTuningProfile(createRuntime());

    expect(tuning.network.quality).toBe('fast');
    expect(tuning.hardwareConcurrency).toBe(8);
    expect(tuning.memoryClass).toBe('high');
    expect(tuning.scheduler.maxConcurrent).toBeGreaterThanOrEqual(8);
    expect(tuning.scheduler.maxConcurrent).toBeLessThanOrEqual(16);
    expect(tuning.scheduler.maxConcurrentPerGroup).toBeLessThanOrEqual(6);
    expect(tuning.prefetchAllowed).toBe(true);
    expect(tuning.backgroundWorkAllowed).toBe(true);
  });

  test('constrained network lowers concurrency and disables prefetch/background work', () => {
    const runtime = createRuntime();
    connectionOf(runtime).saveData = true;
    const tuning = createRuntimeTuningProfile(runtime);

    expect(tuning.network.quality).toBe('constrained');
    expect(tuning.scheduler.maxConcurrent).toBeLessThanOrEqual(3);
    expect(tuning.prefetchAllowed).toBe(false);
    expect(tuning.backgroundWorkAllowed).toBe(false);
    expect(tuning.timeoutMultiplier).toBe(1.8);
  });

  test('3g/limited runtime caps concurrency without pretending to know exact throughput', () => {
    const runtime = createRuntime();
    runtime.navigator.connection = { effectiveType: '3g', downlink: 2.7, rtt: 450 };
    const tuning = createRuntimeTuningProfile(runtime);

    expect(tuning.network.quality).toBe('limited');
    expect(tuning.network.downlinkBucket).toBe('1-4');
    expect(tuning.network.rttBucket).toBe('300-999');
    expect(tuning.scheduler.maxConcurrent).toBeLessThanOrEqual(5);
    expect(tuning.prefetchAllowed).toBe(false);
  });

  test('low-memory devices cap concurrency even on fast network', () => {
    const runtime = createRuntime();
    runtime.navigator.deviceMemory = 1;
    runtime.navigator.hardwareConcurrency = 32;
    const tuning = createRuntimeTuningProfile(runtime);

    expect(tuning.memoryClass).toBe('low');
    expect(tuning.scheduler.maxConcurrent).toBeLessThanOrEqual(8);
    expect(tuning.backgroundWorkAllowed).toBe(false);
  });

  test.each([
    [1, 1],
    [2, 2],
    [8, 8],
    [128, 64],
    [0, 1],
    ['bad', 4]
  ])('bounds hardwareConcurrency %p to %p', (value, expected) => {
    const runtime = createRuntime();
    runtime.navigator.hardwareConcurrency = value;
    expect(createRuntimeTuningProfile(runtime).hardwareConcurrency).toBe(expected);
  });

  test.each([
    [undefined, 'unknown'],
    [0, 'unknown'],
    [1, 'low'],
    [2, 'low'],
    [3, 'medium'],
    [4, 'medium'],
    [8, 'high']
  ])('classifies device memory %p as %p', (value, expected) => {
    const runtime = createRuntime();
    runtime.navigator.deviceMemory = value;
    expect(createRuntimeTuningProfile(runtime).memoryClass).toBe(expected);
  });

  test('offline runtime minimizes concurrency and disables speculative work', () => {
    const runtime = createRuntime();
    runtime.navigator.onLine = false;
    const tuning = createRuntimeTuningProfile(runtime);

    expect(tuning.scheduler.maxConcurrent).toBe(1);
    expect(tuning.prefetchAllowed).toBe(false);
    expect(tuning.backgroundWorkAllowed).toBe(false);
  });

  test('tuning profile and nested scheduler/network values are immutable', () => {
    const tuning = createRuntimeTuningProfile(createRuntime());
    expect(Object.isFrozen(tuning)).toBe(true);
    expect(Object.isFrozen(tuning.scheduler)).toBe(true);
    expect(Object.isFrozen(tuning.network)).toBe(true);
  });
});

describe('timeout scaling and support summary', () => {
  test('normal network preserves timeout', () => {
    const runtime = createRuntime();
    runtime.navigator.connection = {};
    const tuning = createRuntimeTuningProfile(runtime);
    expect(tuning.network.quality).toBe('normal');
    expect(scaleTimeoutForRuntime(15000, tuning)).toBe(15000);
  });

  test('constrained network scales timeout but remains bounded', () => {
    const runtime = createRuntime();
    connectionOf(runtime).saveData = true;
    const tuning = createRuntimeTuningProfile(runtime);
    expect(scaleTimeoutForRuntime(15000, tuning)).toBe(27000);
    expect(scaleTimeoutForRuntime(60000, tuning)).toBe(60000);
  });

  test('offline network shortens failure window but keeps minimum', () => {
    const runtime = createRuntime();
    runtime.navigator.onLine = false;
    const tuning = createRuntimeTuningProfile(runtime);
    expect(scaleTimeoutForRuntime(10000, tuning)).toBe(5000);
    expect(scaleTimeoutForRuntime(1000, tuning)).toBe(1000);
  });

  test('invalid timeout falls back to a safe default', () => {
    const tuning = createRuntimeTuningProfile(createRuntime());
    expect(scaleTimeoutForRuntime('bad', tuning)).toBeGreaterThanOrEqual(1000);
    expect(scaleTimeoutForRuntime('bad', tuning)).toBeLessThanOrEqual(60000);
  });

  test('support summary contains only coarse operational facts', () => {
    const runtime = createRuntime();
    const report = createRuntimeCapabilityReport(runtime);
    const tuning = createRuntimeTuningProfile(runtime);
    const summary = createRuntimeSupportSummary(report, tuning);

    expect(summary).toMatchObject({
      supported: true,
      networkQuality: 'fast',
      saveData: false,
      prefetchAllowed: true,
      backgroundWorkAllowed: true
    });
    expect(summary.maxConcurrent).toBe(tuning.scheduler.maxConcurrent);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/userAgent|platform|language|downlink|rtt/);
  });
});
