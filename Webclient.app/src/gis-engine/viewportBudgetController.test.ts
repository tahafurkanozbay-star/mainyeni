import { describe, expect, it } from 'vitest';
import {
  ViewportBudgetController,
  createViewportBudgetController,
  deriveViewportPressure,
} from './viewportBudgetController';

describe('deriveViewportPressure', () => {
  it('keeps an idle healthy viewport at normal pressure', () => {
    expect(deriveViewportPressure({
      frameMs: 16.6,
      gpuPressure: 0.2,
      heapPressure: 0.3,
      queryLatencyMs: 120,
      networkBacklog: 2,
      inFlightQueries: 2,
    })).toBe('normal');
  });

  it('raises pressure from every supported elevated signal', () => {
    const samples = [
      { frameMs: 24 },
      { gpuPressure: 0.72 },
      { heapPressure: 0.72 },
      { queryLatencyMs: 750 },
      { networkBacklog: 16 },
      { inFlightQueries: 8 },
    ];

    for (const sample of samples) {
      expect(deriveViewportPressure(sample)).toBe('elevated');
    }
  });

  it('raises pressure from every supported critical signal', () => {
    const samples = [
      { frameMs: 42 },
      { gpuPressure: 0.9 },
      { heapPressure: 0.9 },
      { queryLatencyMs: 2_000 },
      { networkBacklog: 48 },
      { inFlightQueries: 18 },
    ];

    for (const sample of samples) {
      expect(deriveViewportPressure(sample)).toBe('critical');
    }
  });

  it('uses the most severe signal when mixed metrics disagree', () => {
    expect(deriveViewportPressure({
      frameMs: 17,
      gpuPressure: 0.25,
      heapPressure: 0.94,
      queryLatencyMs: 100,
      networkBacklog: 0,
    })).toBe('critical');
  });

  it('supports stricter project-specific thresholds', () => {
    expect(deriveViewportPressure(
      { frameMs: 20 },
      { elevatedFrameMs: 18, criticalFrameMs: 30 },
    )).toBe('elevated');
  });

  it('rejects malformed metric values instead of silently normalizing them', () => {
    expect(() => deriveViewportPressure({ frameMs: -1 })).toThrow(RangeError);
    expect(() => deriveViewportPressure({ gpuPressure: 1.01 })).toThrow(RangeError);
    expect(() => deriveViewportPressure({ heapPressure: Number.NaN })).toThrow(RangeError);
    expect(() => deriveViewportPressure({ queryLatencyMs: -1 })).toThrow(RangeError);
    expect(() => deriveViewportPressure({ networkBacklog: 1.5 })).toThrow(RangeError);
    expect(() => deriveViewportPressure({ inFlightQueries: -1 })).toThrow(RangeError);
  });

  it('rejects invalid configuration ordering', () => {
    expect(() => deriveViewportPressure({}, {
      elevatedFrameMs: 30,
      criticalFrameMs: 20,
    })).toThrow('criticalFrameMs must exceed elevatedFrameMs');

    expect(() => deriveViewportPressure({}, {
      elevatedGpuPressure: 0.9,
      criticalGpuPressure: 0.8,
    })).toThrow('criticalGpuPressure must exceed elevatedGpuPressure');

    expect(() => deriveViewportPressure({}, {
      elevatedHeapPressure: 0.8,
      criticalHeapPressure: 0.8,
    })).toThrow('criticalHeapPressure must exceed elevatedHeapPressure');

    expect(() => deriveViewportPressure({}, {
      elevatedQueryLatencyMs: 2_000,
      criticalQueryLatencyMs: 1_000,
    })).toThrow('criticalQueryLatencyMs must exceed elevatedQueryLatencyMs');
  });
});

describe('ViewportBudgetController pressure transitions', () => {
  it('escalates immediately so overload protection does not lag', () => {
    const controller = createViewportBudgetController({ recoverySamples: 3 });

    const elevated = controller.sample({
      frameMs: 30,
      timestamp: 1,
    });
    expect(elevated.pressure).toBe('elevated');

    const critical = controller.sample({
      frameMs: 50,
      timestamp: 2,
    });
    expect(critical.pressure).toBe('critical');
  });

  it('requires stable recovery samples before relaxing critical pressure', () => {
    const controller = new ViewportBudgetController({ recoverySamples: 3 });
    controller.sample({ frameMs: 50, timestamp: 1 });

    expect(controller.sample({ frameMs: 16, timestamp: 2 }).pressure).toBe('critical');
    expect(controller.sample({ frameMs: 16, timestamp: 3 }).pressure).toBe('critical');
    const recovered = controller.sample({ frameMs: 16, timestamp: 4 });

    expect(recovered.pressure).toBe('normal');
    expect(recovered.candidateSamples).toBe(0);
  });

  it('restarts recovery when the candidate level changes', () => {
    const controller = new ViewportBudgetController({ recoverySamples: 2 });
    controller.sample({ frameMs: 50, timestamp: 1 });
    controller.sample({ frameMs: 16, timestamp: 2 });

    const elevated = controller.sample({ frameMs: 30, timestamp: 3 });
    expect(elevated.pressure).toBe('critical');
    expect(elevated.candidatePressure).toBe('elevated');
    expect(elevated.candidateSamples).toBe(1);

    const recovered = controller.sample({ frameMs: 30, timestamp: 4 });
    expect(recovered.pressure).toBe('elevated');
  });

  it('cancels a recovery streak when pressure returns to the current level', () => {
    const controller = new ViewportBudgetController({ recoverySamples: 2 });
    controller.sample({ frameMs: 50, timestamp: 1 });
    controller.sample({ frameMs: 16, timestamp: 2 });

    const reset = controller.sample({ frameMs: 50, timestamp: 3 });
    expect(reset.pressure).toBe('critical');
    expect(reset.candidatePressure).toBe('critical');
    expect(reset.candidateSamples).toBe(0);
  });

  it('never requires hysteresis when moving to a more severe pressure', () => {
    const controller = new ViewportBudgetController({ recoverySamples: 20 });
    controller.sample({ frameMs: 30, timestamp: 1 });

    const critical = controller.sample({
      frameMs: 15,
      heapPressure: 0.95,
      timestamp: 2,
    });

    expect(critical.pressure).toBe('critical');
    expect(critical.candidateSamples).toBe(0);
  });
});

describe('ViewportBudgetController profiles', () => {
  it('keeps the full query budget in healthy stationary conditions', () => {
    const controller = new ViewportBudgetController();
    controller.sample({ frameMs: 16, moving: false, timestamp: 1 });

    expect(controller.profile()).toEqual({
      pressure: 'normal',
      maxFeaturesFactor: 1,
      maxFieldsFactor: 1,
      prefetchFactor: 1,
      concurrencyFactor: 1,
      cacheTtlFactor: 1,
      moving: false,
    });
  });

  it('reduces query and prefetch budgets while the view is moving', () => {
    const controller = new ViewportBudgetController({
      movingFeatureFactor: 0.5,
      movingPrefetchFactor: 0.25,
    });
    controller.sample({ frameMs: 16, moving: true, timestamp: 1 });

    expect(controller.profile()).toMatchObject({
      pressure: 'normal',
      maxFeaturesFactor: 0.5,
      prefetchFactor: 0.25,
      moving: true,
    });
  });

  it('combines movement and elevated resource pressure', () => {
    const controller = new ViewportBudgetController({
      movingFeatureFactor: 0.5,
      movingPrefetchFactor: 0.5,
    });
    controller.sample({
      frameMs: 30,
      moving: true,
      timestamp: 1,
    });

    expect(controller.profile()).toEqual({
      pressure: 'elevated',
      maxFeaturesFactor: 0.34,
      maxFieldsFactor: 0.8,
      prefetchFactor: 0.225,
      concurrencyFactor: 0.72,
      cacheTtlFactor: 1.15,
      moving: true,
    });
  });

  it('shrinks work substantially under critical pressure', () => {
    const controller = new ViewportBudgetController();
    controller.sample({
      gpuPressure: 0.95,
      timestamp: 1,
    });

    expect(controller.profile()).toMatchObject({
      pressure: 'critical',
      maxFeaturesFactor: 0.35,
      maxFieldsFactor: 0.55,
      prefetchFactor: 0.12,
      concurrencyFactor: 0.4,
      cacheTtlFactor: 1.35,
    });
  });

  it('restores the stationary profile after motion stops', () => {
    const controller = new ViewportBudgetController();
    controller.sample({ moving: true, timestamp: 1 });
    expect(controller.profile().moving).toBe(true);

    controller.sample({ moving: false, timestamp: 2 });
    expect(controller.profile()).toMatchObject({
      moving: false,
      maxFeaturesFactor: 1,
      prefetchFactor: 1,
    });
  });
});

describe('ViewportBudgetController metrics and bounds', () => {
  it('computes deterministic p50 and p95 metrics from bounded history', () => {
    const controller = new ViewportBudgetController({
      historySize: 10,
      maxSampleAgeMs: 10_000,
      elevatedFrameMs: 100,
      criticalFrameMs: 200,
      elevatedQueryLatencyMs: 10_000,
      criticalQueryLatencyMs: 20_000,
    });

    for (let index = 1; index <= 5; index += 1) {
      controller.sample({
        frameMs: index * 10,
        queryLatencyMs: index * 100,
        gpuPressure: index / 10,
        heapPressure: index / 20,
        networkBacklog: index,
        inFlightQueries: index + 1,
        timestamp: index,
      });
    }

    expect(controller.metrics()).toEqual({
      samples: 5,
      frameP50Ms: 30,
      frameP95Ms: 50,
      queryLatencyP50Ms: 300,
      queryLatencyP95Ms: 500,
      maximumGpuPressure: 0.5,
      maximumHeapPressure: 0.25,
      maximumNetworkBacklog: 5,
      maximumInFlightQueries: 6,
    });
  });

  it('evicts oldest samples when cardinality exceeds the configured history size', () => {
    const controller = new ViewportBudgetController({
      historySize: 3,
      maxSampleAgeMs: 10_000,
      elevatedFrameMs: 100,
      criticalFrameMs: 200,
    });

    controller.sample({ frameMs: 10, timestamp: 1 });
    controller.sample({ frameMs: 20, timestamp: 2 });
    controller.sample({ frameMs: 30, timestamp: 3 });
    controller.sample({ frameMs: 40, timestamp: 4 });

    expect(controller.metrics()).toMatchObject({
      samples: 3,
      frameP50Ms: 30,
      frameP95Ms: 40,
    });
  });

  it('evicts samples outside the age window without background timers', () => {
    const controller = new ViewportBudgetController({
      historySize: 20,
      maxSampleAgeMs: 100,
      elevatedFrameMs: 100,
      criticalFrameMs: 200,
    });

    controller.sample({ frameMs: 10, timestamp: 0 });
    controller.sample({ frameMs: 20, timestamp: 50 });
    controller.sample({ frameMs: 30, timestamp: 151 });

    expect(controller.metrics()).toMatchObject({
      samples: 1,
      frameP50Ms: 30,
      frameP95Ms: 30,
    });
  });

  it('rejects non-monotonic sample timestamps', () => {
    const controller = new ViewportBudgetController();
    controller.sample({ frameMs: 16, timestamp: 100 });

    expect(() => controller.sample({
      frameMs: 16,
      timestamp: 99,
    })).toThrow('viewport performance timestamps must be monotonic');
  });

  it('accepts repeated timestamps because multiple metrics can share one frame time', () => {
    const controller = new ViewportBudgetController();
    controller.sample({ frameMs: 16, timestamp: 100 });

    expect(() => controller.sample({
      queryLatencyMs: 100,
      timestamp: 100,
    })).not.toThrow();
  });

  it('bounds historySize to prevent diagnostics from becoming a memory leak', () => {
    expect(() => new ViewportBudgetController({
      historySize: 2_049,
    })).toThrow('historySize exceeds the bounded metrics budget');
  });

  it('rejects non-positive recovery and age settings', () => {
    expect(() => new ViewportBudgetController({ recoverySamples: 0 })).toThrow(RangeError);
    expect(() => new ViewportBudgetController({ maxSampleAgeMs: 0 })).toThrow(RangeError);
  });

  it('rejects motion factors outside the zero-to-one range', () => {
    expect(() => new ViewportBudgetController({ movingFeatureFactor: 1.2 })).toThrow(RangeError);
    expect(() => new ViewportBudgetController({ movingPrefetchFactor: -0.1 })).toThrow(RangeError);
  });

  it('resets pressure, metrics, movement, and timestamp deterministically', () => {
    const controller = new ViewportBudgetController();
    controller.sample({
      frameMs: 60,
      moving: true,
      queryLatencyMs: 3_000,
      timestamp: 123,
    });

    const reset = controller.reset();

    expect(reset).toEqual({
      revision: 2,
      pressure: 'normal',
      candidatePressure: 'normal',
      candidateSamples: 0,
      profile: {
        pressure: 'normal',
        maxFeaturesFactor: 1,
        maxFieldsFactor: 1,
        prefetchFactor: 1,
        concurrencyFactor: 1,
        cacheTtlFactor: 1,
        moving: false,
      },
      metrics: {
        samples: 0,
        frameP50Ms: 0,
        frameP95Ms: 0,
        queryLatencyP50Ms: 0,
        queryLatencyP95Ms: 0,
        maximumGpuPressure: 0,
        maximumHeapPressure: 0,
        maximumNetworkBacklog: 0,
        maximumInFlightQueries: 0,
      },
      lastSampleAt: null,
    });
  });
});
