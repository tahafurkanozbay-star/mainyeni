import { boundedInteger, finiteNumber, safeText } from './normalization';
import { summarizeNumbers, type BoundedSampleWindow, createBoundedSampleWindow } from './statistics';

export interface UserTimingPerformanceLike {
  readonly now?: () => number;
  readonly mark?: (name: string) => PerformanceMark;
  readonly measure?: (
    name: string,
    startOrMeasureOptions?: string | PerformanceMeasureOptions,
    endMark?: string,
  ) => PerformanceMeasure;
  readonly clearMarks?: (name?: string) => void;
  readonly clearMeasures?: (name?: string) => void;
}

export interface UserTimingMeasurement {
  readonly name: string;
  readonly count: number;
  readonly duration: ReturnType<typeof summarizeNumbers>;
}

export interface UserTimingProfiler {
  readonly begin: (name: string) => string | null;
  readonly end: (name: string) => number | null;
  readonly record: (name: string, durationMs: unknown) => boolean;
  readonly snapshot: () => readonly UserTimingMeasurement[];
  readonly dispose: () => void;
  readonly activeMarks: () => number;
  readonly nativeFailureCount: () => number;
}

interface ActiveMark {
  readonly logicalName: string;
  readonly markName: string;
  readonly startedAt: number;
}

interface TimingState {
  readonly window: BoundedSampleWindow;
}

const markName = (logicalName: string): string => `kent-rehberi:${logicalName}:start`;
const measureName = (logicalName: string): string => `kent-rehberi:${logicalName}`;

export const createUserTimingProfiler = (
  performanceRef: UserTimingPerformanceLike | null | undefined =
    typeof performance !== 'undefined' ? performance : null,
  sampleCapacityValue: unknown = 128,
): UserTimingProfiler => {
  const sampleCapacity = boundedInteger(sampleCapacityValue, 1, 2_048, 128);
  const active = new Map<string, ActiveMark>();
  const states = new Map<string, TimingState>();
  let disposed = false;
  let nativeFailures = 0;

  const recordNativeFailure = (): void => {
    nativeFailures = Math.min(Number.MAX_SAFE_INTEGER, nativeFailures + 1);
  };

  const now = (): number => {
    const value = performanceRef?.now?.();
    return Math.max(0, finiteNumber(value, 0) ?? 0);
  };

  const stateFor = (name: string): TimingState => {
    const existing = states.get(name);
    if (existing) return existing;
    const created = { window: createBoundedSampleWindow(sampleCapacity) };
    states.set(name, created);
    return created;
  };

  const record = (rawName: string, durationMs: unknown): boolean => {
    if (disposed) return false;
    const name = safeText(rawName, 100);
    const duration = finiteNumber(durationMs, null);
    if (!name || duration === null || duration < 0) return false;
    return stateFor(name).window.add(duration);
  };

  const clearNative = (logicalName: string): void => {
    try {
      performanceRef?.clearMarks?.(markName(logicalName));
      performanceRef?.clearMeasures?.(measureName(logicalName));
    } catch {
      recordNativeFailure();
    }
  };

  return Object.freeze({
    begin(rawName: string): string | null {
      if (disposed) return null;
      const logicalName = safeText(rawName, 100);
      if (!logicalName || active.has(logicalName)) return null;
      const nativeMark = markName(logicalName);
      clearNative(logicalName);
      try {
        performanceRef?.mark?.(nativeMark);
      } catch {
        recordNativeFailure();
      }
      active.set(logicalName, {
        logicalName,
        markName: nativeMark,
        startedAt: now(),
      });
      return nativeMark;
    },

    end(rawName: string): number | null {
      if (disposed) return null;
      const logicalName = safeText(rawName, 100);
      const started = active.get(logicalName);
      if (!started) return null;

      active.delete(logicalName);
      let duration = Math.max(0, now() - started.startedAt);
      try {
        const measured = performanceRef?.measure?.(
          measureName(logicalName),
          started.markName,
        );
        const nativeDuration = finiteNumber(measured?.duration, null);
        if (nativeDuration !== null && nativeDuration >= 0) duration = nativeDuration;
      } catch {
        recordNativeFailure();
      }

      record(logicalName, duration);
      clearNative(logicalName);
      return duration;
    },

    record,

    snapshot() {
      return Object.freeze(
        Array.from(states.entries())
          .map(([name, state]) => Object.freeze({
            name,
            count: state.window.size(),
            duration: state.window.summary(),
          }))
          .sort((left, right) => left.name.localeCompare(right.name, 'en')),
      );
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const logicalName of active.keys()) clearNative(logicalName);
      active.clear();
      for (const logicalName of states.keys()) clearNative(logicalName);
      states.clear();
    },

    activeMarks: () => active.size,
    nativeFailureCount: () => nativeFailures,
  });
};

export const userTimingProfiler = createUserTimingProfiler();
