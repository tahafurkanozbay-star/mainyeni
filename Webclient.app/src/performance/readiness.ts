import type {
  PerformanceBudget,
  PerformanceEvidence,
  PerformanceFinding,
  PerformanceFindingLevel,
  PerformanceReadinessReport,
  WebVitalMeasurement,
} from './contracts';
import { normalizePerformanceBudget } from './budgets';
import { finiteNumber, hashString, stableObjectString } from './normalization';

const finding = (
  level: PerformanceFindingLevel,
  code: string,
  area: PerformanceFinding['area'],
  message: string,
  actual: PerformanceFinding['actual'],
  threshold: PerformanceFinding['threshold'],
): PerformanceFinding => Object.freeze({ level, code, area, message, actual, threshold });

const evaluateUpper = (
  findings: PerformanceFinding[],
  code: string,
  area: PerformanceFinding['area'],
  actual: number | null,
  warning: number,
  block: number,
  message: string,
): void => {
  if (actual === null) return;
  if (actual > block) {
    findings.push(finding('block', `${code}-block`, area, message, actual, block));
  } else if (actual > warning) {
    findings.push(finding('warning', `${code}-warning`, area, message, actual, warning));
  }
};

const evaluateLower = (
  findings: PerformanceFinding[],
  code: string,
  area: PerformanceFinding['area'],
  actual: number | null,
  warning: number,
  message: string,
): void => {
  if (actual === null) return;
  if (actual < warning) {
    findings.push(finding('warning', `${code}-warning`, area, message, actual, warning));
  }
};

const vitalValue = (
  evidence: PerformanceEvidence,
  name: keyof PerformanceEvidence['vitals'],
  fallback: number | null,
): number | null => finiteNumber(evidence.vitals[name]?.value, fallback);

const evaluateVitals = (
  findings: PerformanceFinding[],
  evidence: PerformanceEvidence,
  budget: PerformanceBudget,
): void => {
  evaluateUpper(
    findings,
    'lcp',
    'vitals',
    vitalValue(evidence, 'LCP', evidence.monitor.coreWebVitals.lcp.value),
    budget.vitals.lcpGoodMs,
    budget.vitals.lcpBlockMs,
    'Largest Contentful Paint exceeds the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'cls',
    'vitals',
    vitalValue(evidence, 'CLS', evidence.monitor.coreWebVitals.cls.value),
    budget.vitals.clsGood,
    budget.vitals.clsBlock,
    'Cumulative Layout Shift exceeds the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'inp',
    'vitals',
    vitalValue(evidence, 'INP', evidence.monitor.coreWebVitals.inp.value),
    budget.vitals.inpGoodMs,
    budget.vitals.inpBlockMs,
    'Interaction to Next Paint exceeds the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'fcp',
    'vitals',
    vitalValue(evidence, 'FCP', evidence.monitor.startup.firstContentfulPaintMs),
    budget.vitals.fcpWarningMs,
    budget.vitals.fcpBlockMs,
    'First Contentful Paint exceeds the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'ttfb',
    'vitals',
    vitalValue(evidence, 'TTFB', evidence.monitor.startup.ttfbMs),
    budget.vitals.ttfbWarningMs,
    budget.vitals.ttfbBlockMs,
    'Time to First Byte exceeds the configured runtime budget.',
  );

  const required: Array<[boolean, keyof PerformanceEvidence['vitals'], string]> = [
    [budget.evidence.requireLcp, 'LCP', 'lcp'],
    [budget.evidence.requireCls, 'CLS', 'cls'],
    [budget.evidence.requireInp, 'INP', 'inp'],
  ];
  for (const [requiredMetric, name, code] of required) {
    if (!requiredMetric) continue;
    const explicit = evidence.vitals[name] as WebVitalMeasurement | undefined;
    const monitorFallback = name === 'LCP'
      ? evidence.monitor.coreWebVitals.lcp.value
      : name === 'CLS'
        ? evidence.monitor.coreWebVitals.cls.value
        : evidence.monitor.coreWebVitals.inp.value;
    if (!explicit && monitorFallback === null) {
      findings.push(finding(
        'warning',
        `evidence-${code}-missing`,
        'evidence',
        `Required ${name} evidence is not available in the current runtime snapshot.`,
        false,
        true,
      ));
    }
  }
};

const evaluateStartup = (
  findings: PerformanceFinding[],
  evidence: PerformanceEvidence,
  budget: PerformanceBudget,
): void => {
  const startup = evidence.monitor.startup;
  evaluateUpper(
    findings,
    'first-render',
    'startup',
    startup.firstRenderMs,
    budget.startup.firstRenderWarningMs,
    budget.startup.firstRenderBlockMs,
    'First application render exceeds the configured startup budget.',
  );
  evaluateUpper(
    findings,
    'dom-content-loaded',
    'startup',
    startup.domContentLoadedMs,
    budget.startup.domContentLoadedWarningMs,
    budget.startup.domContentLoadedBlockMs,
    'DOMContentLoaded exceeds the configured startup budget.',
  );
  evaluateUpper(
    findings,
    'load',
    'startup',
    startup.loadMs,
    budget.startup.loadWarningMs,
    budget.startup.loadBlockMs,
    'Window load exceeds the configured startup budget.',
  );
};

const evaluateLongTasks = (
  findings: PerformanceFinding[],
  evidence: PerformanceEvidence,
  budget: PerformanceBudget,
): void => {
  const tasks = evidence.longTasks;
  evaluateUpper(
    findings,
    'long-task-count',
    'long-task',
    tasks.count,
    budget.longTasks.countWarning,
    budget.longTasks.countBlock,
    'Long task count exceeds the configured interaction budget.',
  );
  evaluateUpper(
    findings,
    'long-task-max',
    'long-task',
    tasks.duration.maximum,
    budget.longTasks.maxDurationWarningMs,
    budget.longTasks.maxDurationBlockMs,
    'Longest main-thread task exceeds the configured interaction budget.',
  );
  evaluateUpper(
    findings,
    'total-blocking-time',
    'long-task',
    tasks.blockingTimeMs,
    budget.longTasks.totalBlockingWarningMs,
    budget.longTasks.totalBlockingBlockMs,
    'Estimated total blocking time exceeds the configured interaction budget.',
  );
};

const evaluateResources = (
  findings: PerformanceFinding[],
  evidence: PerformanceEvidence,
  budget: PerformanceBudget,
): void => {
  const resources = evidence.resources;
  evaluateUpper(
    findings,
    'resource-count',
    'resource',
    resources.count,
    budget.resources.countWarning,
    budget.resources.countBlock,
    'Resource request count exceeds the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'resource-transfer',
    'resource',
    resources.transferBytes,
    budget.resources.transferWarningBytes,
    budget.resources.transferBlockBytes,
    'Transferred resource bytes exceed the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'resource-decoded',
    'resource',
    resources.decodedBytes,
    budget.resources.decodedWarningBytes,
    budget.resources.decodedBlockBytes,
    'Decoded resource bytes exceed the configured memory budget.',
  );
  evaluateUpper(
    findings,
    'cross-origin-resource-count',
    'resource',
    resources.crossOriginCount,
    budget.resources.crossOriginWarningCount,
    budget.resources.crossOriginBlockCount,
    'Cross-origin resource count exceeds the configured privacy/cache budget.',
  );
  if (resources.count >= 10) {
    evaluateLower(
      findings,
      'cache-like-ratio',
      'resource',
      resources.cacheLikeRatio,
      budget.resources.minimumCacheLikeRatio,
      'Cache-like resource reuse is below the configured minimum.',
    );
  }
};

const evaluateMemory = (
  findings: PerformanceFinding[],
  evidence: PerformanceEvidence,
  budget: PerformanceBudget,
): void => {
  const memory = evidence.monitor.memory;
  if (!memory) return;
  evaluateUpper(
    findings,
    'memory-utilization',
    'memory',
    memory.utilization,
    budget.memory.utilizationWarning,
    budget.memory.utilizationBlock,
    'JavaScript heap utilization exceeds the configured runtime budget.',
  );
  evaluateUpper(
    findings,
    'memory-used',
    'memory',
    memory.usedBytes,
    budget.memory.usedWarningBytes,
    budget.memory.usedBlockBytes,
    'Used JavaScript heap exceeds the configured runtime budget.',
  );
};

const fingerprintReport = (
  evidence: PerformanceEvidence,
  budget: PerformanceBudget,
  findings: readonly PerformanceFinding[],
): string => {
  const values: Readonly<Record<string, unknown>> = {
    lcp: vitalValue(evidence, 'LCP', evidence.monitor.coreWebVitals.lcp.value),
    cls: vitalValue(evidence, 'CLS', evidence.monitor.coreWebVitals.cls.value),
    inp: vitalValue(evidence, 'INP', evidence.monitor.coreWebVitals.inp.value),
    fcp: vitalValue(evidence, 'FCP', evidence.monitor.startup.firstContentfulPaintMs),
    ttfb: vitalValue(evidence, 'TTFB', evidence.monitor.startup.ttfbMs),
    render: evidence.monitor.startup.firstRenderMs,
    tasks: evidence.longTasks.count,
    blocking: evidence.longTasks.blockingTimeMs,
    resources: evidence.resources.count,
    transfer: evidence.resources.transferBytes,
    decoded: evidence.resources.decodedBytes,
    memory: evidence.monitor.memory?.usedBytes ?? null,
    budgetLcp: budget.vitals.lcpBlockMs,
    findingCodes: findings.map(item => item.code).join(','),
  };
  return hashString(stableObjectString(values));
};

export const evaluatePerformanceReadiness = (
  evidence: PerformanceEvidence,
  budgetInput = {},
  generatedAt = Date.now(),
): PerformanceReadinessReport => {
  const budget = normalizePerformanceBudget(budgetInput);
  const findings: PerformanceFinding[] = [];
  evaluateVitals(findings, evidence, budget);
  evaluateStartup(findings, evidence, budget);
  evaluateLongTasks(findings, evidence, budget);
  evaluateResources(findings, evidence, budget);
  evaluateMemory(findings, evidence, budget);

  const blockers = findings.filter(item => item.level === 'block');
  const warnings = findings.filter(item => item.level === 'warning');
  const level = blockers.length > 0 ? 'block' : warnings.length > 0 ? 'warning' : 'pass';

  return Object.freeze({
    level,
    ready: blockers.length === 0,
    findings: Object.freeze(findings),
    blockerCodes: Object.freeze(blockers.map(item => item.code)),
    warningCodes: Object.freeze(warnings.map(item => item.code)),
    evidence,
    budget,
    fingerprint: fingerprintReport(evidence, budget, findings),
    generatedAt,
  });
};
