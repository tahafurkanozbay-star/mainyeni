import type {
  PerformanceBaseline,
  PerformanceBaselineComparison,
  PerformanceReadinessReport,
  PerformanceRegression,
} from './contracts';
import { finiteNumber, safeText } from './normalization';

const reportMetrics = (
  report: PerformanceReadinessReport,
): Readonly<Record<string, number | null>> => Object.freeze({
  lcp: finiteNumber(report.evidence.vitals.LCP?.value, report.evidence.monitor.coreWebVitals.lcp.value),
  cls: finiteNumber(report.evidence.vitals.CLS?.value, report.evidence.monitor.coreWebVitals.cls.value),
  inp: finiteNumber(report.evidence.vitals.INP?.value, report.evidence.monitor.coreWebVitals.inp.value),
  fcp: finiteNumber(report.evidence.vitals.FCP?.value, report.evidence.monitor.startup.firstContentfulPaintMs),
  ttfb: finiteNumber(report.evidence.vitals.TTFB?.value, report.evidence.monitor.startup.ttfbMs),
  firstRender: finiteNumber(report.evidence.monitor.startup.firstRenderMs, null),
  domContentLoaded: finiteNumber(report.evidence.monitor.startup.domContentLoadedMs, null),
  load: finiteNumber(report.evidence.monitor.startup.loadMs, null),
  longTaskCount: report.evidence.longTasks.count,
  longTaskMax: report.evidence.longTasks.duration.maximum,
  blockingTime: report.evidence.longTasks.blockingTimeMs,
  resourceCount: report.evidence.resources.count,
  transferBytes: report.evidence.resources.transferBytes,
  decodedBytes: report.evidence.resources.decodedBytes,
  crossOriginCount: report.evidence.resources.crossOriginCount,
  cacheLikeRatio: report.evidence.resources.cacheLikeRatio,
  memoryUsed: report.evidence.monitor.memory?.usedBytes ?? null,
  memoryUtilization: report.evidence.monitor.memory?.utilization ?? null,
});

export const createPerformanceBaseline = (
  report: PerformanceReadinessReport,
  label = 'baseline',
): PerformanceBaseline => Object.freeze({
  schemaVersion: 1,
  label: safeText(label, 120) || 'baseline',
  fingerprint: report.fingerprint,
  capturedAt: report.generatedAt,
  metrics: reportMetrics(report),
});

const LOWER_IS_BETTER = new Set([
  'lcp',
  'cls',
  'inp',
  'fcp',
  'ttfb',
  'firstRender',
  'domContentLoaded',
  'load',
  'longTaskCount',
  'longTaskMax',
  'blockingTime',
  'resourceCount',
  'transferBytes',
  'decodedBytes',
  'crossOriginCount',
  'memoryUsed',
  'memoryUtilization',
]);

const HIGHER_IS_BETTER = new Set(['cacheLikeRatio']);

const compareMetric = (
  metric: string,
  baseline: number | null,
  current: number | null,
): PerformanceRegression => {
  if (baseline === null || current === null) {
    return { metric, baseline, current, delta: null, deltaRatio: null, direction: 'unknown' };
  }

  const delta = current - baseline;
  const deltaRatio = baseline !== 0 ? delta / Math.abs(baseline) : delta === 0 ? 0 : null;
  const epsilon = Math.max(0.0001, Math.abs(baseline) * 0.005);
  if (Math.abs(delta) <= epsilon) {
    return { metric, baseline, current, delta, deltaRatio, direction: 'same' };
  }

  if (LOWER_IS_BETTER.has(metric)) {
    return { metric, baseline, current, delta, deltaRatio, direction: delta > 0 ? 'worse' : 'better' };
  }
  if (HIGHER_IS_BETTER.has(metric)) {
    return { metric, baseline, current, delta, deltaRatio, direction: delta < 0 ? 'worse' : 'better' };
  }
  return { metric, baseline, current, delta, deltaRatio, direction: 'unknown' };
};

export const comparePerformanceBaseline = (
  baseline: PerformanceBaseline,
  report: PerformanceReadinessReport,
): PerformanceBaselineComparison => {
  const current = reportMetrics(report);
  const keys = Array.from(new Set([
    ...Object.keys(baseline.metrics),
    ...Object.keys(current),
  ])).sort((left, right) => left.localeCompare(right, 'en'));

  const comparisons = keys.map(metric => compareMetric(
    metric,
    baseline.metrics[metric] ?? null,
    current[metric] ?? null,
  ));

  return Object.freeze({
    baselineLabel: baseline.label,
    currentFingerprint: report.fingerprint,
    regressions: Object.freeze(comparisons.filter(item => item.direction === 'worse')),
    improvements: Object.freeze(comparisons.filter(item => item.direction === 'better')),
    unchanged: Object.freeze(comparisons.filter(item =>
      item.direction === 'same' || item.direction === 'unknown')),
  });
};
