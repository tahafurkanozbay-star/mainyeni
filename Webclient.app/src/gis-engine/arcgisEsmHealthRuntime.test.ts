import { describe, expect, it } from 'vitest';
import {
  assertArcgisEsmProductionHealthy,
  evaluateArcgisEsmHealth,
  summarizeArcgisEsmHealth,
  type ArcgisEsmHealthInput,
} from './arcgisEsmHealthRuntime';

const healthyInput = (): ArcgisEsmHealthInput => ({
  catalog: {
    catalogSpecifiers: ['@arcgis/core/Map.js'],
    registeredSpecifiers: ['@arcgis/core/Map.js'],
    missingFromCatalog: [],
    missingFromTransport: [],
    valid: true,
  },
  moduleRuntime: {
    backend: 'arcgis-core-esm',
    configured: true,
    version: '5.1.24',
    cachedModules: 1,
    loadRequests: 1,
    cacheHits: 0,
    failures: 0,
    transportChanges: 0,
  },
  lifecycle: {
    disposed: false,
    featureRequests: 1,
    directRequests: 0,
    incompletePlans: 0,
    failedRequests: 0,
    loadedSpecifiers: 1,
    coverageValid: true,
    retainedEvents: 1,
    governor: {
      disposed: false,
      queued: 0,
      running: 0,
      loadedModules: 1,
      retainedHistory: 1,
      submitted: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
      deduped: 0,
    },
  },
});

describe('arcgisEsmHealthRuntime', () => {
  it('reports ready only when production backend and catalog are healthy', () => {
    const assessment = evaluateArcgisEsmHealth(healthyInput());
    expect(assessment).toMatchObject({
      status: 'ready',
      ready: true,
      reasons: [],
    });
    expect(assertArcgisEsmProductionHealthy(assessment)).toBe(true);
  });

  it('reports warming while bounded module work is active', () => {
    const input = healthyInput();
    const assessment = evaluateArcgisEsmHealth({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        governor: {
          ...input.lifecycle.governor,
          queued: 2,
          running: 1,
        },
      },
    });
    expect(assessment.status).toBe('warming');
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons.map((item) => item.code)).toEqual(['load-queue-active']);
    expect(summarizeArcgisEsmHealth(assessment).activeLoads).toBe(3);
  });

  it('reports degraded after recoverable runtime failures or budget deferrals', () => {
    const input = healthyInput();
    const assessment = evaluateArcgisEsmHealth({
      ...input,
      moduleRuntime: { ...input.moduleRuntime, failures: 2 },
      lifecycle: {
        ...input.lifecycle,
        failedRequests: 1,
        incompletePlans: 3,
      },
    });
    expect(assessment.status).toBe('degraded');
    expect(assessment.reasons.map((item) => item.code)).toEqual([
      'runtime-load-failure',
      'lifecycle-request-failure',
      'bundle-budget-defer',
    ]);
    expect(assertArcgisEsmProductionHealthy(assessment)).toBe(true);
  });

  it('blocks production readiness on catalog drift', () => {
    const input = healthyInput();
    const assessment = evaluateArcgisEsmHealth({
      ...input,
      catalog: {
        ...input.catalog,
        valid: false,
        missingFromTransport: ['@arcgis/core/views/SceneView.js'],
      },
    });
    expect(assessment.status).toBe('blocked');
    expect(assessment.counters.catalogMissing).toBe(1);
    expect(() => assertArcgisEsmProductionHealthy(assessment))
      .toThrow(/production readiness is blocked/);
  });

  it('blocks production readiness when a test or legacy backend is still active', () => {
    const input = healthyInput();
    const assessment = evaluateArcgisEsmHealth({
      ...input,
      moduleRuntime: { ...input.moduleRuntime, backend: 'legacy-amd' },
    });
    expect(assessment.status).toBe('blocked');
    expect(assessment.reasons).toEqual([
      expect.objectContaining({ code: 'unexpected-backend', severity: 'error' }),
    ]);
  });

  it('reports disposed independently of historical warnings', () => {
    const input = healthyInput();
    const assessment = evaluateArcgisEsmHealth({
      ...input,
      moduleRuntime: { ...input.moduleRuntime, failures: 1 },
      lifecycle: {
        ...input.lifecycle,
        disposed: true,
        failedRequests: 1,
        governor: { ...input.lifecycle.governor, disposed: true },
      },
    });
    expect(assessment.status).toBe('disposed');
    expect(assessment.reasons.map((item) => item.code)).toContain('lifecycle-disposed');
  });

  it('produces a privacy-safe local summary without module values or URLs', () => {
    const assessment = evaluateArcgisEsmHealth(healthyInput());
    expect(summarizeArcgisEsmHealth(assessment)).toEqual({
      status: 'ready',
      reasonCodes: [],
      loadedSpecifiers: 1,
      activeLoads: 0,
    });
  });
});
