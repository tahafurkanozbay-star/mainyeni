import type {
  PerformanceBaselineComparison,
  PerformanceRuntimeSnapshot,
} from './contracts';
import { boundedInteger } from './normalization';

export interface PerformanceHistorySummary {
  readonly size: number;
  readonly readyCount: number;
  readonly blockedCount: number;
  readonly warningCount: number;
  readonly latestFingerprint: string | null;
  readonly regressionCount: number;
}

export interface PerformanceHistory {
  readonly add: (snapshot: PerformanceRuntimeSnapshot) => void;
  readonly values: () => readonly PerformanceRuntimeSnapshot[];
  readonly latest: () => PerformanceRuntimeSnapshot | null;
  readonly comparisons: () => readonly PerformanceBaselineComparison[];
  readonly summary: () => PerformanceHistorySummary;
  readonly clear: () => number;
  readonly capacity: number;
}

export const createPerformanceHistory = (capacityValue: unknown = 32): PerformanceHistory => {
  const capacity = boundedInteger(capacityValue, 1, 256, 32);
  const snapshots: PerformanceRuntimeSnapshot[] = [];

  const trim = (): void => {
    if (snapshots.length > capacity) snapshots.splice(0, snapshots.length - capacity);
  };

  return Object.freeze({
    add(snapshot: PerformanceRuntimeSnapshot) {
      snapshots.push(snapshot);
      trim();
    },
    values: () => Object.freeze(snapshots.slice()),
    latest: () => snapshots.at(-1) ?? null,
    comparisons: () => Object.freeze(
      snapshots
        .map(snapshot => snapshot.comparison)
        .filter((comparison): comparison is PerformanceBaselineComparison => comparison !== null),
    ),
    summary() {
      const readyCount = snapshots.filter(snapshot => snapshot.report.ready).length;
      const blockedCount = snapshots.filter(snapshot => snapshot.report.level === 'block').length;
      const warningCount = snapshots.filter(snapshot => snapshot.report.level === 'warning').length;
      const regressionCount = snapshots.reduce(
        (total, snapshot) => total + (snapshot.comparison?.regressions.length ?? 0),
        0,
      );
      return Object.freeze({
        size: snapshots.length,
        readyCount,
        blockedCount,
        warningCount,
        latestFingerprint: snapshots.at(-1)?.report.fingerprint ?? null,
        regressionCount,
      });
    },
    clear() {
      const count = snapshots.length;
      snapshots.length = 0;
      return count;
    },
    capacity,
  });
};
