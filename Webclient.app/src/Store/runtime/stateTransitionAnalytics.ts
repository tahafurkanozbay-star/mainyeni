import type {
  StoreHistorySnapshot,
  StoreSliceName,
  StoreTransitionDescriptor,
} from './contracts';

export interface StoreTransitionAnalytics {
  readonly totalTransitions: number;
  readonly changedTransitions: number;
  readonly noopTransitions: number;
  readonly failedTransitions: number;
  readonly noopRatio: number;
  readonly averageDurationMs: number;
  readonly maxDurationMs: number;
  readonly actionCounts: Readonly<Record<string, number>>;
  readonly changedSliceCounts: Readonly<Record<StoreSliceName, number>>;
  readonly failureCodeCounts: Readonly<Record<string, number>>;
  readonly hottestActions: readonly Readonly<{ actionType: string; count: number }>[];
  readonly slowestActions: readonly Readonly<{ actionType: string; maxDurationMs: number }>[];
}

const emptySliceCounts = (): Record<StoreSliceName, number> => ({
  Common: 0,
  Map: 0,
  ContextMenu: 0,
  DynamicLayers: 0,
});

const increment = (target: Record<string, number>, key: string): void => {
  target[key] = (target[key] ?? 0) + 1;
};

const boundedTop = (
  source: Readonly<Record<string, number>>,
  limit: number,
  valueKey: 'count' | 'maxDurationMs',
): readonly Readonly<Record<string, string | number>>[] =>
  Object.freeze(
    Object.entries(source)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'))
      .slice(0, limit)
      .map(([actionType, value]) => Object.freeze({
        actionType,
        [valueKey]: value,
      })),
  );

export const analyzeStoreTransitions = (
  history: Pick<StoreHistorySnapshot, 'entries' | 'totalRecorded' | 'changed' | 'noop' | 'failed'>,
  topLimit = 8,
): StoreTransitionAnalytics => {
  const actionCounts: Record<string, number> = {};
  const failureCodeCounts: Record<string, number> = {};
  const changedSliceCounts = emptySliceCounts();
  const maxDurationByAction: Record<string, number> = {};
  let durationTotal = 0;
  let maxDurationMs = 0;

  for (const entry of history.entries) {
    increment(actionCounts, entry.actionType);
    durationTotal += entry.durationMs;
    maxDurationMs = Math.max(maxDurationMs, entry.durationMs);
    maxDurationByAction[entry.actionType] = Math.max(
      maxDurationByAction[entry.actionType] ?? 0,
      entry.durationMs,
    );

    for (const slice of entry.changedSlices) {
      changedSliceCounts[slice] += 1;
    }

    if (entry.errorCode) increment(failureCodeCounts, entry.errorCode);
  }

  const retained = history.entries.length;
  const safeTopLimit = Number.isFinite(topLimit)
    ? Math.min(100, Math.max(1, Math.trunc(topLimit)))
    : 8;
  const hottest = boundedTop(actionCounts, safeTopLimit, 'count') as readonly Readonly<{
    actionType: string;
    count: number;
  }>[];
  const slowest = boundedTop(maxDurationByAction, safeTopLimit, 'maxDurationMs') as readonly Readonly<{
    actionType: string;
    maxDurationMs: number;
  }>[];

  return Object.freeze({
    totalTransitions: history.totalRecorded,
    changedTransitions: history.changed,
    noopTransitions: history.noop,
    failedTransitions: history.failed,
    noopRatio: history.totalRecorded > 0 ? history.noop / history.totalRecorded : 0,
    averageDurationMs: retained > 0 ? durationTotal / retained : 0,
    maxDurationMs,
    actionCounts: Object.freeze(actionCounts),
    changedSliceCounts: Object.freeze(changedSliceCounts),
    failureCodeCounts: Object.freeze(failureCodeCounts),
    hottestActions: hottest,
    slowestActions: slowest,
  });
};

export const analyzeTransitionEntries = (
  entries: readonly StoreTransitionDescriptor[],
  topLimit = 8,
): StoreTransitionAnalytics => {
  let changed = 0;
  let noop = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.status === 'changed') changed += 1;
    else if (entry.status === 'noop') noop += 1;
    else failed += 1;
  }
  return analyzeStoreTransitions({
    entries,
    totalRecorded: entries.length,
    changed,
    noop,
    failed,
  }, topLimit);
};
