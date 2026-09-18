import { createBoundedSampleWindow, type BoundedSampleWindow } from './statistics';
import { boundedInteger, finiteNumber, safeText } from './normalization';

export interface OperationBudget {
  readonly warningMs: number;
  readonly blockMs: number;
  readonly sampleCapacity: number;
}

export interface OperationProfile {
  readonly name: string;
  readonly count: number;
  readonly failures: number;
  readonly cancellations: number;
  readonly duration: ReturnType<BoundedSampleWindow['summary']>;
  readonly warningMs: number;
  readonly blockMs: number;
  readonly level: 'pass' | 'warning' | 'block';
}

export interface ProfileOperationOptions {
  readonly signal?: AbortSignal | null | undefined;
  readonly now?: (() => number) | undefined;
}

export interface OperationProfiler {
  readonly measure: <T>(
    name: string,
    operation: () => T | Promise<T>,
    options?: ProfileOperationOptions,
  ) => Promise<T>;
  readonly record: (
    name: string,
    durationMs: unknown,
    outcome?: 'success' | 'failure' | 'cancelled',
  ) => void;
  readonly snapshot: () => readonly OperationProfile[];
  readonly reset: () => void;
}

interface MutableOperationState {
  readonly name: string;
  readonly samples: BoundedSampleWindow;
  failures: number;
  cancellations: number;
}

const DEFAULT_OPERATION_BUDGET: OperationBudget = Object.freeze({
  warningMs: 100,
  blockMs: 500,
  sampleCapacity: 128,
});

export const normalizeOperationBudget = (
  input: Partial<OperationBudget> | null | undefined,
): OperationBudget => {
  const value = input ?? {};
  const warningMs = Math.max(1, finiteNumber(value.warningMs, DEFAULT_OPERATION_BUDGET.warningMs) ?? DEFAULT_OPERATION_BUDGET.warningMs);
  const blockMs = Math.max(warningMs, finiteNumber(value.blockMs, DEFAULT_OPERATION_BUDGET.blockMs) ?? DEFAULT_OPERATION_BUDGET.blockMs);
  return Object.freeze({
    warningMs,
    blockMs,
    sampleCapacity: boundedInteger(value.sampleCapacity, 1, 4_096, DEFAULT_OPERATION_BUDGET.sampleCapacity),
  });
};

export const createOperationProfiler = (
  budgetInput: Partial<OperationBudget> = {},
): OperationProfiler => {
  const budget = normalizeOperationBudget(budgetInput);
  const states = new Map<string, MutableOperationState>();

  const getState = (rawName: string): MutableOperationState => {
    const name = safeText(rawName, 120) || 'anonymous';
    const existing = states.get(name);
    if (existing) return existing;
    const created: MutableOperationState = {
      name,
      samples: createBoundedSampleWindow(budget.sampleCapacity),
      failures: 0,
      cancellations: 0,
    };
    states.set(name, created);
    return created;
  };

  const record: OperationProfiler['record'] = (name, durationMs, outcome = 'success') => {
    const state = getState(name);
    state.samples.add(Math.max(0, finiteNumber(durationMs, 0) ?? 0));
    if (outcome === 'failure') state.failures += 1;
    else if (outcome === 'cancelled') state.cancellations += 1;
  };

  return Object.freeze({
    async measure(name, operation, options = {}) {
      if (typeof operation !== 'function') throw new TypeError('Profiled operation must be a function.');
      if (options.signal?.aborted) {
        record(name, 0, 'cancelled');
        throw options.signal.reason ?? new DOMException('Operation aborted', 'AbortError');
      }

      const now = options.now ?? (() => performance.now());
      const startedAt = now();
      try {
        const result = await operation();
        const duration = Math.max(0, now() - startedAt);
        record(name, duration, options.signal?.aborted ? 'cancelled' : 'success');
        return result;
      } catch (error) {
        const duration = Math.max(0, now() - startedAt);
        const cancelled = options.signal?.aborted
          || (error instanceof DOMException && error.name === 'AbortError');
        record(name, duration, cancelled ? 'cancelled' : 'failure');
        throw error;
      }
    },

    record,

    snapshot() {
      return Object.freeze(
        Array.from(states.values())
          .map<OperationProfile>(state => {
            const duration = state.samples.summary();
            const p95 = duration.p95 ?? 0;
            return Object.freeze({
              name: state.name,
              count: duration.count,
              failures: state.failures,
              cancellations: state.cancellations,
              duration,
              warningMs: budget.warningMs,
              blockMs: budget.blockMs,
              level: p95 > budget.blockMs ? 'block' : p95 > budget.warningMs ? 'warning' : 'pass',
            });
          })
          .sort((left, right) => left.name.localeCompare(right.name, 'en')),
      );
    },

    reset() {
      states.clear();
    },
  });
};

export const operationProfiler = createOperationProfiler();
