import { performanceMonitor } from '../platform/performance/performanceMonitor';
import type {
  PerformanceBaseline,
  PerformanceLifecycleDependencies,
  PerformanceLifecycleHandle,
  PerformanceRuntime,
  PerformanceRuntimeDependencies,
  PerformanceRuntimeSnapshot,
  WebVitalMeasurement,
} from './contracts';
import { comparePerformanceBaseline } from './baseline';
import { collectLongTasks } from './longTasks';
import { collectResourceTimings } from './resources';
import { evaluatePerformanceReadiness } from './readiness';
import { latestVitalMap } from './vitals';

export const createPerformanceRuntime = (
  dependencies: PerformanceRuntimeDependencies = {},
): PerformanceRuntime => {
  const monitor = dependencies.monitor ?? performanceMonitor;
  const now = dependencies.now ?? Date.now;
  const vitalMeasurements: WebVitalMeasurement[] = [];
  let baseline: PerformanceBaseline | null = null;
  let lastSnapshot: PerformanceRuntimeSnapshot | null = null;

  const recordVital = (measurement: WebVitalMeasurement): void => {
    vitalMeasurements.push(measurement);
    if (vitalMeasurements.length > 64) {
      vitalMeasurements.splice(0, vitalMeasurements.length - 64);
    }
  };

  const capture = (): PerformanceRuntimeSnapshot => {
    monitor.start();
    const evidence = Object.freeze({
      monitor: monitor.snapshot(),
      resources: collectResourceTimings({
        performanceRef: dependencies.performanceRef,
        locationOrigin: dependencies.locationOrigin,
      }),
      longTasks: collectLongTasks({ performanceRef: dependencies.performanceRef }),
      vitals: latestVitalMap(vitalMeasurements),
    });
    const report = evaluatePerformanceReadiness(
      evidence,
      dependencies.budget,
      now(),
    );
    const comparison = baseline ? comparePerformanceBaseline(baseline, report) : null;
    lastSnapshot = Object.freeze({ report, baseline, comparison });
    return lastSnapshot;
  };

  return Object.freeze({
    recordVital,
    capture,
    setBaseline(nextBaseline) {
      baseline = nextBaseline;
    },
    getBaseline: () => baseline,
    getLastSnapshot: () => lastSnapshot,
    reset() {
      vitalMeasurements.length = 0;
      baseline = null;
      lastSnapshot = null;
    },
  });
};

export const performanceRuntime = createPerformanceRuntime();

export const installPerformanceLifecycleCapture = (
  runtime: PerformanceRuntime = performanceRuntime,
  dependencies: PerformanceLifecycleDependencies = {},
): PerformanceLifecycleHandle => {
  const documentRef = dependencies.documentRef === undefined
    ? (typeof document !== 'undefined' ? document : null)
    : dependencies.documentRef;
  const windowRef = dependencies.windowRef === undefined
    ? (typeof window !== 'undefined' ? window : null)
    : dependencies.windowRef;

  let disposed = false;
  const capture = (): PerformanceRuntimeSnapshot => {
    const snapshot = runtime.capture();
    try {
      dependencies.onCapture?.(snapshot);
    } catch {
      // Diagnostics observers are best-effort and must never break navigation.
    }
    return snapshot;
  };

  const onVisibilityChange = (): void => {
    if (!disposed && documentRef?.visibilityState === 'hidden') capture();
  };
  const onPageHide = (): void => {
    if (!disposed) capture();
  };

  documentRef?.addEventListener('visibilitychange', onVisibilityChange);
  windowRef?.addEventListener('pagehide', onPageHide);

  return Object.freeze({
    capture,
    dispose() {
      if (disposed) return;
      disposed = true;
      documentRef?.removeEventListener('visibilitychange', onVisibilityChange);
      windowRef?.removeEventListener('pagehide', onPageHide);
    },
  });
};
