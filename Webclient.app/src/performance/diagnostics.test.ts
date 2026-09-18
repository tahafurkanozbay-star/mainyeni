import { describe, expect, it, vi } from 'vitest';
import type { PerformanceRuntimeSnapshot } from './contracts';
import {
  browserPerformanceDiagnosticEnvironment,
  createPerformanceDiagnosticPayload,
  recordPerformanceDiagnostic,
} from './diagnostics';

const snapshot = (level: 'pass' | 'warning' | 'block' = 'pass'): PerformanceRuntimeSnapshot => ({
  report: {
    level,
    ready: level !== 'block',
    findings: [],
    blockerCodes: level === 'block' ? ['lcp-block'] : [],
    warningCodes: level === 'warning' ? ['lcp-warning'] : [],
    fingerprint: 'abc123',
    generatedAt: 1,
    budget: {} as never,
    evidence: {
      monitor: {
        timestamp: 1,
        startup: {
          firstRenderMs: 300,
          firstContentfulPaintMs: 500,
          ttfbMs: 80,
          domContentLoadedMs: 700,
          loadMs: 900,
        },
        coreWebVitals: {
          lcp: { value: 1200, rating: 'good' },
          cls: { value: 0.02, rating: 'good' },
          inp: { value: 80, rating: 'good' },
        },
        longTasks: { count: 1, totalDurationMs: 60, maxDurationMs: 60 },
        resources: {
          count: 20,
          transferBytes: 1000,
          encodedBytes: 900,
          decodedBytes: 1200,
          totalDurationMs: 100,
          zeroTransferCount: 5,
          cacheLikeRatio: 0.25,
        },
        memory: {
          usedBytes: 1000,
          totalBytes: 2000,
          limitBytes: 10000,
          utilization: 0.1,
        },
        network: {
          effectiveType: '4g',
          downlinkMbps: 10,
          rttMs: 50,
          saveData: false,
        },
      },
      resources: {
        count: 20,
        sameOriginCount: 18,
        crossOriginCount: 2,
        opaqueCount: 0,
        transferBytes: 1000,
        encodedBytes: 900,
        decodedBytes: 1200,
        cacheLikeCount: 5,
        cacheLikeRatio: 0.25,
        renderBlockingCount: 2,
        duration: {} as never,
        transfer: {} as never,
        categoryCounts: {} as never,
        crossOriginOrigins: ['https://cdn.example.net'],
      },
      longTasks: {
        count: 1,
        totalDurationMs: 60,
        blockingTimeMs: 10,
        duration: {
          count: 1,
          minimum: 60,
          maximum: 60,
          sum: 60,
          average: 60,
          p50: 60,
          p75: 60,
          p90: 60,
          p95: 60,
          p99: 60,
          latest: 60,
        },
      },
      vitals: {},
    },
  },
  baseline: null,
  comparison: null,
});

describe('performance diagnostics bridge', () => {
  it('retains only bounded aggregate performance metadata', () => {
    const payload = createPerformanceDiagnosticPayload(snapshot(), {
      hardwareConcurrency: 8,
      deviceMemoryGb: 16,
    });

    expect(payload.level).toBe('pass');
    expect(payload.vitals.lcp).toBe(1200);
    expect(payload.resources.crossOriginCount).toBe(2);
    expect(payload.resources).not.toHaveProperty('crossOriginOrigins');
    expect(payload.adaptiveTier).toBe('full');
    expect(JSON.stringify(payload)).not.toContain('cdn.example.net');
  });

  it('maps blocking readiness to warning diagnostics without throwing', () => {
    const record = vi.fn(() => ({ id: 1 }));
    const result = recordPerformanceDiagnostic({ record }, snapshot('block'), {
      hardwareConcurrency: 2,
      deviceMemoryGb: 2,
    });

    expect(result).toEqual({ id: 1 });
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toBe('performance.readiness');
    expect(record.mock.calls[0]?.[2]).toMatchObject({ severity: 'warn' });
  });

  it('builds a browser environment without requiring non-standard APIs', () => {
    const environment = browserPerformanceDiagnosticEnvironment();
    expect(environment).toBeTypeOf('object');
  });
});
