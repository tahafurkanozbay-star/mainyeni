import type {
  LongTaskDependencies,
  LongTaskSample,
  LongTaskSummary,
} from './contracts';
import { nonNegativeNumber } from './normalization';
import { summarizeNumbers } from './statistics';

interface LongTaskLike extends PerformanceEntry {
  readonly attribution?: readonly unknown[];
}

export const normalizeLongTask = (entry: PerformanceEntry): LongTaskSample | null => {
  if (entry.entryType !== 'longtask') return null;
  const task = entry as LongTaskLike;
  return Object.freeze({
    durationMs: nonNegativeNumber(task.duration, 0),
    startTimeMs: nonNegativeNumber(task.startTime, 0),
    attributionCount: Array.isArray(task.attribution) ? task.attribution.length : 0,
  });
};

export const summarizeLongTasks = (samples: readonly LongTaskSample[]): LongTaskSummary => {
  const durations = samples.map(sample => sample.durationMs);
  const totalDurationMs = durations.reduce((total, value) => total + value, 0);
  const blockingTimeMs = durations.reduce((total, duration) => total + Math.max(0, duration - 50), 0);

  return Object.freeze({
    count: samples.length,
    totalDurationMs,
    blockingTimeMs,
    duration: summarizeNumbers(durations),
  });
};

export const collectLongTasks = (
  dependencies: LongTaskDependencies = {},
): LongTaskSummary => {
  const performanceRef = dependencies.performanceRef === undefined
    ? (typeof performance !== 'undefined' ? performance : null)
    : dependencies.performanceRef;
  if (!performanceRef?.getEntriesByType) return summarizeLongTasks([]);

  const samples = performanceRef
    .getEntriesByType('longtask')
    .map(normalizeLongTask)
    .filter((sample): sample is LongTaskSample => sample !== null);

  return summarizeLongTasks(samples);
};
