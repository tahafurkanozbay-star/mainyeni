import { describe, expect, it } from 'vitest';
import type { PerformanceSnapshot } from '../platform/performance/performanceMonitor';
import { createAdaptiveRuntimePolicy } from './adaptivePolicy';
import { createPerformanceBaseline, comparePerformanceBaseline } from './baseline';
import { DEFAULT_PERFORMANCE_BUDGET, normalizePerformanceBudget } from './budgets';
import type { PerformanceEvidence } from './contracts';
import { evaluatePerformanceReadiness } from './readiness';
import { summarizeLongTasks } from './longTasks';
import { summarizeResourceTimings } from './resources';

const monitorSnapshot = (overrides: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot => ({
  timestamp: 1,
  startup: {
    firstRenderMs: 500,
    firstContentfulPaintMs: 700,
    ttfbMs: 100,
    domContentLoadedMs: 900,
    loadMs: 1_200,
  },
  coreWebVitals: {
    lcp: { value: 1_500, rating: 'good' },
    cls: { value: 0.05, rating: 'good' },
    inp: { value: 100, rating: 'good' },
  },
  longTasks: {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  },
  resources: {
    count: 10,
    transferBytes: 100_000,
    encodedBytes: 90_000,
    decodedBytes: 150_000,
    totalDurationMs: 200,
    zeroTransferCount: 2,
    cacheLikeRatio: 0.2,
  },
  memory: {
    usedBytes: 100_000,
    totalBytes: 200_000,
    limitBytes: 1_000_000,
    utilization: 0.1,
  },
  network: {
    effectiveType: '4g',
    downlinkMbps: 10,
    rttMs: 50,
    saveData: false,
  },
  ...overrides,
});

const evidence = (monitor = monitorSnapshot()): PerformanceEvidence => ({
  monitor,
  resources: summarizeResourceTimings([]),
  longTasks: summarizeLongTasks([]),
  vitals: {},
});

describe('performance budgets', () => {
  it('normalizes nested partial budgets without invalid threshold inversions', () => {
    const budget = normalizePerformanceBudget({
      vitals: {
        lcpGoodMs: 4_000,
        lcpBlockMs: 1_000,
        clsGood: 0.2,
        clsBlock: 0.1,
      },
      resources: {
        minimumCacheLikeRatio: 4,
      },
    });

    expect(budget.vitals.lcpBlockMs).toBeGreaterThanOrEqual(budget.vitals.lcpGoodMs);
    expect(budget.vitals.clsBlock).toBeGreaterThanOrEqual(budget.vitals.clsGood);
    expect(budget.resources.minimumCacheLikeRatio).toBe(1);
  });

  it('retains stable production defaults', () => {
    expect(DEFAULT_PERFORMANCE_BUDGET.vitals.lcpGoodMs).toBe(2_500);
    expect(DEFAULT_PERFORMANCE_BUDGET.vitals.clsGood).toBe(0.1);
    expect(DEFAULT_PERFORMANCE_BUDGET.vitals.inpGoodMs).toBe(200);
  });
});

describe('runtime readiness', () => {
  it('passes healthy runtime evidence', () => {
    const report = evaluatePerformanceReadiness(evidence());
    expect(report.ready).toBe(true);
    expect(report.level).toBe('pass');
    expect(report.blockerCodes).toEqual([]);
  });

  it('blocks poor core web vitals', () => {
    const report = evaluatePerformanceReadiness(evidence(monitorSnapshot({
      coreWebVitals: {
        lcp: { value: 5_000, rating: 'poor' },
        cls: { value: 0.4, rating: 'poor' },
        inp: { value: 800, rating: 'poor' },
      },
    })));

    expect(report.ready).toBe(false);
    expect(report.level).toBe('block');
    expect(report.blockerCodes).toContain('lcp-block');
    expect(report.blockerCodes).toContain('cls-block');
    expect(report.blockerCodes).toContain('inp-block');
  });

  it('blocks startup, resource, task and memory pressure independently', () => {
    const report = evaluatePerformanceReadiness({
      monitor: monitorSnapshot({
        startup: {
          firstRenderMs: 10_000,
          firstContentfulPaintMs: 700,
          ttfbMs: 100,
          domContentLoadedMs: 12_000,
          loadMs: 20_000,
        },
        memory: {
          usedBytes: 800 * 1024 * 1024,
          totalBytes: 900 * 1024 * 1024,
          limitBytes: 900 * 1024 * 1024,
          utilization: 0.95,
        },
      }),
      resources: {
        ...summarizeResourceTimings([]),
        count: 500,
        transferBytes: 20 * 1024 * 1024,
        decodedBytes: 80 * 1024 * 1024,
        crossOriginCount: 20,
      },
      longTasks: {
        ...summarizeLongTasks([]),
        count: 20,
        blockingTimeMs: 2_000,
        duration: {
          ...summarizeLongTasks([]).duration,
          count: 1,
          minimum: 500,
          maximum: 500,
          sum: 500,
          average: 500,
          p50: 500,
          p75: 500,
          p90: 500,
          p95: 500,
          p99: 500,
          latest: 500,
        },
      },
      vitals: {},
    });

    expect(report.blockerCodes).toContain('first-render-block');
    expect(report.blockerCodes).toContain('resource-count-block');
    expect(report.blockerCodes).toContain('long-task-count-block');
    expect(report.blockerCodes).toContain('memory-utilization-block');
  });
});

describe('baseline and adaptive runtime policy', () => {
  it('detects worse and better metrics with metric-aware direction', () => {
    const baselineReport = evaluatePerformanceReadiness(evidence(), {}, 10);
    const baseline = createPerformanceBaseline(baselineReport, 'known-good');

    const current = evaluatePerformanceReadiness(evidence(monitorSnapshot({
      startup: {
        ...monitorSnapshot().startup,
        firstRenderMs: 800,
      },
      resources: {
        ...monitorSnapshot().resources,
        cacheLikeRatio: 0.5,
      },
    })), {}, 20);

    const comparison = comparePerformanceBaseline(baseline, current);
    expect(comparison.regressions.some(item => item.metric === 'firstRender')).toBe(true);
  });

  it('selects economy policy under blocked runtime and constrained network', () => {
    const report = evaluatePerformanceReadiness(evidence(monitorSnapshot({
      coreWebVitals: {
        lcp: { value: 5_000, rating: 'poor' },
        cls: { value: 0.05, rating: 'good' },
        inp: { value: 100, rating: 'good' },
      },
      network: {
        effectiveType: '2g',
        downlinkMbps: 0.3,
        rttMs: 900,
        saveData: true,
      },
      memory: {
        usedBytes: 850,
        totalBytes: 900,
        limitBytes: 1_000,
        utilization: 0.85,
      },
    })));

    const policy = createAdaptiveRuntimePolicy({
      report,
      hardwareConcurrency: 2,
      deviceMemoryGb: 2,
    });
    expect(policy.tier).toBe('economy');
    expect(policy.prefetch).toBe(false);
    expect(policy.highCost3dEffects).toBe(false);
    expect(policy.reasons).toContain('save-data');
  });

  it('selects full policy for a healthy unconstrained runtime', () => {
    const report = evaluatePerformanceReadiness(evidence());
    const policy = createAdaptiveRuntimePolicy({
      report,
      hardwareConcurrency: 12,
      deviceMemoryGb: 16,
    });
    expect(policy.tier).toBe('full');
    expect(policy.prefetch).toBe(true);
    expect(policy.highCost3dEffects).toBe(true);
  });
});
