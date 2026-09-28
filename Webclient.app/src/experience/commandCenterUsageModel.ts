export interface CommandCenterUsageLimits {
  readonly maxTracked: number;
  readonly recentLimit: number;
  readonly frequentLimit: number;
}

export interface CommandCenterUsageRecord {
  readonly commandId: string;
  readonly executionCount: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
}

export interface CommandCenterUsageSnapshot {
  readonly revision: number;
  readonly sequence: number;
  readonly totalExecutions: number;
  readonly lastExecutedId: string | null;
  readonly trackedCount: number;
  readonly recentIds: readonly string[];
  readonly frequentIds: readonly string[];
  readonly records: readonly CommandCenterUsageRecord[];
}

export type CommandCenterUsageObserver = (
  snapshot: CommandCenterUsageSnapshot,
  previous: CommandCenterUsageSnapshot,
) => void;

export interface CommandCenterUsageOptions extends Partial<CommandCenterUsageLimits> {
  readonly onObserverError?: (error: unknown) => void;
}

export interface CommandCenterUsageModel {
  readonly limits: CommandCenterUsageLimits;
  snapshot(): CommandCenterUsageSnapshot;
  record(commandId: string): CommandCenterUsageSnapshot;
  reconcile(validCommandIds: readonly string[]): CommandCenterUsageSnapshot;
  clear(): CommandCenterUsageSnapshot;
  prioritize<T>(
    items: readonly T[],
    getId: (item: T) => string,
  ): readonly T[];
  subscribe(observer: CommandCenterUsageObserver): () => void;
  dispose(): void;
}

const DEFAULT_LIMITS: CommandCenterUsageLimits = Object.freeze({
  maxTracked: 64,
  recentLimit: 8,
  frequentLimit: 8,
});

const MAX_OBSERVERS = 24;
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

const clampInteger = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const normalizeLimits = (
  options: CommandCenterUsageOptions,
): CommandCenterUsageLimits => {
  const maxTracked = clampInteger(
    options.maxTracked ?? DEFAULT_LIMITS.maxTracked,
    1,
    256,
  );
  return Object.freeze({
    maxTracked,
    recentLimit: clampInteger(
      options.recentLimit ?? DEFAULT_LIMITS.recentLimit,
      1,
      maxTracked,
    ),
    frequentLimit: clampInteger(
      options.frequentLimit ?? DEFAULT_LIMITS.frequentLimit,
      1,
      maxTracked,
    ),
  });
};

const sanitizeCommandId = (value: string): string => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/g, '-')
  .replace(/[^\p{L}\p{N}_.:-]+/gu, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 128);

const saturatingIncrement = (value: number): number =>
  value >= MAX_SAFE_COUNTER ? MAX_SAFE_COUNTER : value + 1;

const reportObserverError = (
  reporter: CommandCenterUsageOptions['onObserverError'],
  error: unknown,
): void => {
  if (!reporter) {
    globalThis.reportError?.(error);
    return;
  }
  try {
    reporter(error);
  } catch (reportingError) {
    globalThis.reportError?.(reportingError);
  }
};

const recentComparator = (
  left: CommandCenterUsageRecord,
  right: CommandCenterUsageRecord,
): number => right.lastSequence - left.lastSequence
  || right.executionCount - left.executionCount
  || left.commandId.localeCompare(right.commandId, 'tr-TR');

const frequentComparator = (
  left: CommandCenterUsageRecord,
  right: CommandCenterUsageRecord,
): number => right.executionCount - left.executionCount
  || right.lastSequence - left.lastSequence
  || left.commandId.localeCompare(right.commandId, 'tr-TR');

const evictionComparator = (
  left: CommandCenterUsageRecord,
  right: CommandCenterUsageRecord,
): number => left.lastSequence - right.lastSequence
  || left.executionCount - right.executionCount
  || left.firstSequence - right.firstSequence
  || left.commandId.localeCompare(right.commandId, 'tr-TR');

const freezeRecord = (
  record: CommandCenterUsageRecord,
): CommandCenterUsageRecord => Object.freeze({ ...record });

const createSnapshot = (
  records: ReadonlyMap<string, CommandCenterUsageRecord>,
  revision: number,
  sequence: number,
  totalExecutions: number,
  lastExecutedId: string | null,
  limits: CommandCenterUsageLimits,
): CommandCenterUsageSnapshot => {
  const frozenRecords = Object.freeze(
    Array.from(records.values())
      .sort((left, right) => left.firstSequence - right.firstSequence
        || left.commandId.localeCompare(right.commandId, 'tr-TR'))
      .map(freezeRecord),
  );
  const recentIds = Object.freeze(
    Array.from(records.values())
      .sort(recentComparator)
      .slice(0, limits.recentLimit)
      .map(record => record.commandId),
  );
  const frequentIds = Object.freeze(
    Array.from(records.values())
      .sort(frequentComparator)
      .slice(0, limits.frequentLimit)
      .map(record => record.commandId),
  );

  return Object.freeze({
    revision,
    sequence,
    totalExecutions,
    lastExecutedId,
    trackedCount: records.size,
    recentIds,
    frequentIds,
    records: frozenRecords,
  });
};

const dedupeValidIds = (
  values: readonly string[],
): ReadonlySet<string> => {
  const valid = new Set<string>();
  for (const value of values) {
    const id = sanitizeCommandId(value);
    if (id) valid.add(id);
  }
  return valid;
};

export const createCommandCenterUsageModel = (
  options: CommandCenterUsageOptions = {},
): CommandCenterUsageModel => {
  const limits = normalizeLimits(options);
  const records = new Map<string, CommandCenterUsageRecord>();
  const observers = new Set<CommandCenterUsageObserver>();
  let disposed = false;
  let revision = 0;
  let sequence = 0;
  let totalExecutions = 0;
  let lastExecutedId: string | null = null;
  let current = createSnapshot(
    records,
    revision,
    sequence,
    totalExecutions,
    lastExecutedId,
    limits,
  );

  const notify = (previous: CommandCenterUsageSnapshot): void => {
    const observerSnapshot = Array.from(observers);
    for (const observer of observerSnapshot) {
      try {
        observer(current, previous);
      } catch (error) {
        reportObserverError(options.onObserverError, error);
      }
    }
  };

  const commit = (): CommandCenterUsageSnapshot => {
    if (disposed) return current;
    const previous = current;
    revision = saturatingIncrement(revision);
    current = createSnapshot(
      records,
      revision,
      sequence,
      totalExecutions,
      lastExecutedId,
      limits,
    );
    notify(previous);
    return current;
  };

  const evictOne = (): void => {
    if (records.size < limits.maxTracked) return;
    const victim = Array.from(records.values()).sort(evictionComparator)[0];
    if (victim) records.delete(victim.commandId);
  };

  return Object.freeze({
    limits,
    snapshot: () => current,
    record(commandId: string) {
      if (disposed) return current;
      const id = sanitizeCommandId(commandId);
      if (!id) return current;

      sequence = saturatingIncrement(sequence);
      totalExecutions = saturatingIncrement(totalExecutions);
      lastExecutedId = id;
      const existing = records.get(id);

      if (existing) {
        records.set(id, Object.freeze({
          ...existing,
          executionCount: saturatingIncrement(existing.executionCount),
          lastSequence: sequence,
        }));
      } else {
        evictOne();
        records.set(id, Object.freeze({
          commandId: id,
          executionCount: 1,
          firstSequence: sequence,
          lastSequence: sequence,
        }));
      }
      return commit();
    },
    reconcile(validCommandIds: readonly string[]) {
      if (disposed) return current;
      const valid = dedupeValidIds(validCommandIds);
      let changed = false;
      for (const id of records.keys()) {
        if (!valid.has(id)) {
          records.delete(id);
          changed = true;
        }
      }
      if (lastExecutedId && !valid.has(lastExecutedId)) {
        lastExecutedId = null;
        changed = true;
      }
      return changed ? commit() : current;
    },
    clear() {
      if (disposed || (records.size === 0 && lastExecutedId === null)) return current;
      records.clear();
      lastExecutedId = null;
      return commit();
    },
    prioritize<T>(
      items: readonly T[],
      getId: (item: T) => string,
    ): readonly T[] {
      const recentRank = new Map(
        current.recentIds.map((id, index) => [id, index] as const),
      );
      const frequentRank = new Map(
        current.frequentIds.map((id, index) => [id, index] as const),
      );
      const decorated = items.map((item, sourceIndex) => {
        const id = sanitizeCommandId(getId(item));
        return {
          item,
          sourceIndex,
          recentRank: recentRank.get(id) ?? Number.POSITIVE_INFINITY,
          frequentRank: frequentRank.get(id) ?? Number.POSITIVE_INFINITY,
        };
      });

      decorated.sort((left, right) => {
        const recentDelta = left.recentRank - right.recentRank;
        if (Number.isFinite(recentDelta) && recentDelta !== 0) return recentDelta;
        if (left.recentRank !== right.recentRank) {
          return Number.isFinite(left.recentRank) ? -1 : 1;
        }
        const frequentDelta = left.frequentRank - right.frequentRank;
        if (Number.isFinite(frequentDelta) && frequentDelta !== 0) return frequentDelta;
        if (left.frequentRank !== right.frequentRank) {
          return Number.isFinite(left.frequentRank) ? -1 : 1;
        }
        return left.sourceIndex - right.sourceIndex;
      });

      return Object.freeze(decorated.map(entry => entry.item));
    },
    subscribe(observer: CommandCenterUsageObserver) {
      if (disposed) return () => undefined;
      if (observers.size >= MAX_OBSERVERS && !observers.has(observer)) {
        throw new Error(`Command center usage observer capacity exceeded (${MAX_OBSERVERS}).`);
      }
      observers.add(observer);
      try {
        observer(current, current);
      } catch (error) {
        reportObserverError(options.onObserverError, error);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        observers.delete(observer);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observers.clear();
      records.clear();
    },
  });
};
