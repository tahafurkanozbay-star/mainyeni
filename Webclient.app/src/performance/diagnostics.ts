import type { RuntimeSeverity } from '../platform/runtime/runtimeDiagnostics';
import type { PerformanceRuntimeSnapshot } from './contracts';
import { createAdaptiveRuntimePolicy } from './adaptivePolicy';
import { boundedInteger, finiteNumber } from './normalization';

export interface PerformanceDiagnosticSink {
  readonly record: (
    type: string,
    details?: Record<string, unknown>,
    options?: { severity?: RuntimeSeverity; message?: unknown },
  ) => unknown;
}

export interface PerformanceDiagnosticEnvironment {
  readonly hardwareConcurrency?: unknown;
  readonly deviceMemoryGb?: unknown;
}

export interface PerformanceDiagnosticPayload {
  readonly level: string;
  readonly ready: boolean;
  readonly fingerprint: string;
  readonly blockerCount: number;
  readonly warningCount: number;
  readonly adaptiveTier: string;
  readonly adaptiveReasons: readonly string[];
  readonly startup: Readonly<{
    firstRenderMs: number | null;
    fcpMs: number | null;
    ttfbMs: number | null;
    loadMs: number | null;
  }>;
  readonly vitals: Readonly<{
    lcp: number | null;
    cls: number | null;
    inp: number | null;
  }>;
  readonly mainThread: Readonly<{
    longTaskCount: number;
    blockingTimeMs: number;
    longestTaskMs: number | null;
  }>;
  readonly resources: Readonly<{
    count: number;
    transferBytes: number;
    decodedBytes: number;
    crossOriginCount: number;
    cacheLikeRatio: number | null;
  }>;
  readonly memory: Readonly<{
    usedBytes: number | null;
    utilization: number | null;
  }>;
  readonly baseline: Readonly<{
    active: boolean;
    regressionCount: number;
    improvementCount: number;
  }>;
}

const latestVital = (
  snapshot: PerformanceRuntimeSnapshot,
  name: 'LCP' | 'CLS' | 'INP',
  fallback: number | null,
): number | null => finiteNumber(snapshot.report.evidence.vitals[name]?.value, fallback);

export const createPerformanceDiagnosticPayload = (
  snapshot: PerformanceRuntimeSnapshot,
  environment: PerformanceDiagnosticEnvironment = {},
): PerformanceDiagnosticPayload => {
  const evidence = snapshot.report.evidence;
  const adaptive = createAdaptiveRuntimePolicy({
    report: snapshot.report,
    hardwareConcurrency: boundedInteger(environment.hardwareConcurrency, 1, 64, 4),
    deviceMemoryGb: finiteNumber(environment.deviceMemoryGb, 0) ?? 0,
  });

  return Object.freeze({
    level: snapshot.report.level,
    ready: snapshot.report.ready,
    fingerprint: snapshot.report.fingerprint,
    blockerCount: snapshot.report.blockerCodes.length,
    warningCount: snapshot.report.warningCodes.length,
    adaptiveTier: adaptive.tier,
    adaptiveReasons: Object.freeze(adaptive.reasons.slice(0, 12)),
    startup: Object.freeze({
      firstRenderMs: evidence.monitor.startup.firstRenderMs,
      fcpMs: evidence.monitor.startup.firstContentfulPaintMs,
      ttfbMs: evidence.monitor.startup.ttfbMs,
      loadMs: evidence.monitor.startup.loadMs,
    }),
    vitals: Object.freeze({
      lcp: latestVital(snapshot, 'LCP', evidence.monitor.coreWebVitals.lcp.value),
      cls: latestVital(snapshot, 'CLS', evidence.monitor.coreWebVitals.cls.value),
      inp: latestVital(snapshot, 'INP', evidence.monitor.coreWebVitals.inp.value),
    }),
    mainThread: Object.freeze({
      longTaskCount: evidence.longTasks.count,
      blockingTimeMs: evidence.longTasks.blockingTimeMs,
      longestTaskMs: evidence.longTasks.duration.maximum,
    }),
    resources: Object.freeze({
      count: evidence.resources.count,
      transferBytes: evidence.resources.transferBytes,
      decodedBytes: evidence.resources.decodedBytes,
      crossOriginCount: evidence.resources.crossOriginCount,
      cacheLikeRatio: evidence.resources.cacheLikeRatio,
    }),
    memory: Object.freeze({
      usedBytes: evidence.monitor.memory?.usedBytes ?? null,
      utilization: evidence.monitor.memory?.utilization ?? null,
    }),
    baseline: Object.freeze({
      active: snapshot.baseline !== null,
      regressionCount: snapshot.comparison?.regressions.length ?? 0,
      improvementCount: snapshot.comparison?.improvements.length ?? 0,
    }),
  });
};

export const recordPerformanceDiagnostic = (
  sink: PerformanceDiagnosticSink,
  snapshot: PerformanceRuntimeSnapshot,
  environment: PerformanceDiagnosticEnvironment = {},
): unknown => {
  const payload = createPerformanceDiagnosticPayload(snapshot, environment);
  const severity: RuntimeSeverity = snapshot.report.level === 'block'
    ? 'warn'
    : snapshot.report.level === 'warning'
      ? 'info'
      : 'debug';

  return sink.record('performance.readiness', payload as unknown as Record<string, unknown>, {
    severity,
    message: snapshot.report.ready
      ? 'Runtime performance snapshot is within blocking budgets.'
      : 'Runtime performance snapshot exceeded one or more blocking budgets.',
  });
};

export const browserPerformanceDiagnosticEnvironment = (): PerformanceDiagnosticEnvironment => {
  if (typeof navigator === 'undefined') return {};
  const extended = navigator as Navigator & { readonly deviceMemory?: number };
  return Object.freeze({
    hardwareConcurrency: extended.hardwareConcurrency,
    deviceMemoryGb: extended.deviceMemory,
  });
};
