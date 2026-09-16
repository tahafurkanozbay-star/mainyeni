import {
  GIS_PERFORMANCE_PROFILE,
  createAdaptivePerformanceRuntime,
  detectGisDeviceCapabilities,
  performanceBudgetForProfile,
} from './adaptivePerformanceRuntime';

describe('adaptivePerformanceRuntime', () => {
  test('detects constrained devices without depending on browser-only globals', () => {
    const environment = {
      navigator: { deviceMemory: 2, hardwareConcurrency: 2, connection: { saveData: true, effectiveType: '2g' } },
      matchMedia: () => ({ matches: false }),
    };
    expect(detectGisDeviceCapabilities(environment)).toMatchObject({
      memoryGb: 2,
      logicalCores: 2,
      constrainedNetwork: true,
      profile: GIS_PERFORMANCE_PROFILE.ECO,
    });
  });

  test('scales cache and residency budgets with device memory', () => {
    const low = performanceBudgetForProfile(GIS_PERFORMANCE_PROFILE.BALANCED, { memoryGb: 2 });
    const high = performanceBudgetForProfile(GIS_PERFORMANCE_PROFILE.BALANCED, { memoryGb: 16 });
    expect(high.maxQueryCacheBytes).toBeGreaterThan(low.maxQueryCacheBytes);
    expect(high.maxResidentLayers).toBeGreaterThan(low.maxResidentLayers);
  });

  test('degrades quality under sustained frame pressure', () => {
    let time = 10000;
    const runtime = createAdaptivePerformanceRuntime({
      now: () => time,
      profile: GIS_PERFORMANCE_PROFILE.QUALITY,
      capabilities: { memoryGb: 16, logicalCores: 12, constrainedNetwork: false, reducedMotion: false },
      settings: { minSamples: 4, sampleWindow: 8, cooldownMs: 0 },
    });
    [16, 90, 95, 85].forEach((sample) => { time += 20; runtime.recordFrame(sample); });
    expect(runtime.getProfile()).toBe(GIS_PERFORMANCE_PROFILE.BALANCED);
    [80, 90, 85, 95].forEach((sample) => { time += 20; runtime.recordFrame(sample); });
    expect(runtime.getProfile()).toBe(GIS_PERFORMANCE_PROFILE.ECO);
    expect(runtime.getSnapshot().metrics.transitions).toBe(2);
  });

  test('recovers conservatively when samples become healthy', () => {
    let time = 0;
    const runtime = createAdaptivePerformanceRuntime({
      now: () => time,
      profile: GIS_PERFORMANCE_PROFILE.ECO,
      capabilities: { memoryGb: 8, logicalCores: 8, constrainedNetwork: false, reducedMotion: false },
      settings: { minSamples: 4, sampleWindow: 4, cooldownMs: 0, recoveryRatio: 0.1, recoveryFrameMs: 20 },
    });
    [12, 13, 14, 15].forEach((sample) => { time += 20; runtime.recordFrame(sample); });
    expect(runtime.getProfile()).toBe(GIS_PERFORMANCE_PROFILE.BALANCED);
  });

  test('does not promote reduced-motion clients to quality profile', () => {
    let time = 0;
    const runtime = createAdaptivePerformanceRuntime({
      now: () => time,
      profile: GIS_PERFORMANCE_PROFILE.BALANCED,
      capabilities: { memoryGb: 16, logicalCores: 16, constrainedNetwork: false, reducedMotion: true },
      settings: { minSamples: 4, sampleWindow: 4, cooldownMs: 0 },
    });
    [10, 10, 10, 10].forEach((sample) => { time += 20; runtime.recordFrame(sample); });
    expect(runtime.getProfile()).toBe(GIS_PERFORMANCE_PROFILE.BALANCED);
  });

  test('subscriber failures cannot break runtime transitions', () => {
    let time = 0;
    const onListenerError = jest.fn();
    const runtime = createAdaptivePerformanceRuntime({
      now: () => time,
      profile: GIS_PERFORMANCE_PROFILE.QUALITY,
      capabilities: { memoryGb: 8, logicalCores: 8, constrainedNetwork: false, reducedMotion: false },
      settings: { minSamples: 2, sampleWindow: 2, cooldownMs: 0 },
      onListenerError,
    });
    runtime.subscribe(() => { throw new Error('observer'); });
    [100, 100].forEach((sample) => { time += 20; runtime.recordFrame(sample); });
    expect(runtime.getProfile()).toBe(GIS_PERFORMANCE_PROFILE.BALANCED);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  test('rejects unknown manual profiles', () => {
    const runtime = createAdaptivePerformanceRuntime({ capabilities: { memoryGb: 4, logicalCores: 4 } });
    expect(() => runtime.setProfile('ultra')).toThrow('Unknown GIS performance profile');
  });
});
