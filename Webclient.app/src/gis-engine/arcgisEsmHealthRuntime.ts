import type { ArcgisModuleCatalogAudit } from './arcgisEsmModuleCatalog';
import type { ArcgisEsmLifecycleSnapshot } from './arcgisEsmLifecycleRuntime';
import type { ArcgisModuleRuntimeSnapshot } from './arcgisModuleRuntime';

export type ArcgisEsmHealthStatus =
  | 'ready'
  | 'warming'
  | 'degraded'
  | 'blocked'
  | 'disposed';

export type ArcgisEsmHealthReasonCode =
  | 'catalog-drift'
  | 'unexpected-backend'
  | 'runtime-load-failure'
  | 'lifecycle-request-failure'
  | 'bundle-budget-defer'
  | 'load-queue-active'
  | 'lifecycle-disposed';

export type ArcgisEsmHealthReason = Readonly<{
  code: ArcgisEsmHealthReasonCode;
  severity: 'info' | 'warning' | 'error';
  detail: string;
}>;

export type ArcgisEsmHealthInput = Readonly<{
  catalog: ArcgisModuleCatalogAudit;
  moduleRuntime: ArcgisModuleRuntimeSnapshot;
  lifecycle: ArcgisEsmLifecycleSnapshot;
}>;

export type ArcgisEsmHealthAssessment = Readonly<{
  status: ArcgisEsmHealthStatus;
  ready: boolean;
  reasons: readonly ArcgisEsmHealthReason[];
  counters: Readonly<{
    catalogMissing: number;
    runtimeFailures: number;
    lifecycleFailures: number;
    incompletePlans: number;
    queuedLoads: number;
    runningLoads: number;
    loadedSpecifiers: number;
  }>;
}>;

const reason = (
  code: ArcgisEsmHealthReasonCode,
  severity: ArcgisEsmHealthReason['severity'],
  detail: string,
): ArcgisEsmHealthReason => Object.freeze({ code, severity, detail });

const decideStatus = (
  input: ArcgisEsmHealthInput,
  reasons: readonly ArcgisEsmHealthReason[],
): ArcgisEsmHealthStatus => {
  if (input.lifecycle.disposed) return 'disposed';
  if (reasons.some((item) => item.severity === 'error')) return 'blocked';
  if (reasons.some((item) => item.severity === 'warning')) return 'degraded';
  if (input.lifecycle.governor.queued > 0 || input.lifecycle.governor.running > 0) return 'warming';
  return 'ready';
};

export const evaluateArcgisEsmHealth = (
  input: ArcgisEsmHealthInput,
): ArcgisEsmHealthAssessment => {
  const reasons: ArcgisEsmHealthReason[] = [];

  if (!input.catalog.valid) {
    const missing = input.catalog.missingFromCatalog.length + input.catalog.missingFromTransport.length;
    reasons.push(reason(
      'catalog-drift',
      'error',
      \`ArcGIS ESM catalog/transport registry drift detected (\${missing} mismatched specifier(s)).\`,
    ));
  }

  if (input.moduleRuntime.backend !== 'arcgis-core-esm') {
    reasons.push(reason(
      'unexpected-backend',
      'error',
      \`ArcGIS module runtime backend is \${input.moduleRuntime.backend}; production ESM backend is required.\`,
    ));
  }

  if (input.moduleRuntime.failures > 0) {
    reasons.push(reason(
      'runtime-load-failure',
      'warning',
      \`ArcGIS module runtime recorded \${input.moduleRuntime.failures} load failure(s).\`,
    ));
  }

  if (input.lifecycle.failedRequests > 0) {
    reasons.push(reason(
      'lifecycle-request-failure',
      'warning',
      \`ArcGIS ESM lifecycle recorded \${input.lifecycle.failedRequests} failed request(s).\`,
    ));
  }

  if (input.lifecycle.incompletePlans > 0) {
    reasons.push(reason(
      'bundle-budget-defer',
      'warning',
      \`ArcGIS ESM bundle budgeting deferred \${input.lifecycle.incompletePlans} plan(s).\`,
    ));
  }

  if (input.lifecycle.governor.queued > 0 || input.lifecycle.governor.running > 0) {
    reasons.push(reason(
      'load-queue-active',
      'info',
      \`ArcGIS ESM loader has \${input.lifecycle.governor.running} running and \${input.lifecycle.governor.queued} queued job(s).\`,
    ));
  }

  if (input.lifecycle.disposed) {
    reasons.push(reason(
      'lifecycle-disposed',
      'info',
      'ArcGIS ESM lifecycle has been disposed and will not accept new work.',
    ));
  }

  const status = decideStatus(input, reasons);
  return Object.freeze({
    status,
    ready: status === 'ready',
    reasons: Object.freeze(reasons),
    counters: Object.freeze({
      catalogMissing: input.catalog.missingFromCatalog.length + input.catalog.missingFromTransport.length,
      runtimeFailures: input.moduleRuntime.failures,
      lifecycleFailures: input.lifecycle.failedRequests,
      incompletePlans: input.lifecycle.incompletePlans,
      queuedLoads: input.lifecycle.governor.queued,
      runningLoads: input.lifecycle.governor.running,
      loadedSpecifiers: input.lifecycle.loadedSpecifiers,
    }),
  });
};

export const assertArcgisEsmProductionHealthy = (
  assessment: ArcgisEsmHealthAssessment,
): true => {
  if (assessment.status === 'blocked') {
    const details = assessment.reasons
      .filter((item) => item.severity === 'error')
      .map((item) => item.code)
      .join(', ');
    throw Object.assign(
      new Error(\`ArcGIS ESM production readiness is blocked: \${details || 'unknown'}\`),
      { code: 'ARCGIS_ESM_BLOCKED' },
    );
  }
  return true;
};

export const summarizeArcgisEsmHealth = (
  assessment: ArcgisEsmHealthAssessment,
): Readonly<{
  status: ArcgisEsmHealthStatus;
  reasonCodes: readonly ArcgisEsmHealthReasonCode[];
  loadedSpecifiers: number;
  activeLoads: number;
}> => Object.freeze({
  status: assessment.status,
  reasonCodes: Object.freeze(assessment.reasons.map((item) => item.code)),
  loadedSpecifiers: assessment.counters.loadedSpecifiers,
  activeLoads: assessment.counters.runningLoads + assessment.counters.queuedLoads,
});
