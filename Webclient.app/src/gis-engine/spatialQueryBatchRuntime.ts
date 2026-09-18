import {
  type SpatialQuerySession,
  type SpatialQuerySessionRequest,
  type SpatialQuerySessionResult,
} from "./spatialQuerySessionRuntime";

export type SpatialQueryBatchFailureMode = "fail-fast" | "collect-errors";

export interface SpatialQueryBatchTask {
  readonly id: string;
  readonly session: SpatialQuerySession;
  readonly request: SpatialQuerySessionRequest;
  readonly priority?: number;
  readonly estimatedBytes?: number;
}

export interface SpatialQueryBatchOptions {
  readonly maxTasks?: number;
  readonly maxConcurrent?: number;
  readonly maxEstimatedBytes?: number;
  readonly maxIdentifierLength?: number;
  readonly failureMode?: SpatialQueryBatchFailureMode;
  readonly signal?: AbortSignal;
}

export interface SpatialQueryBatchTaskResult {
  readonly id: string;
  readonly status: "fulfilled" | "rejected" | "cancelled";
  readonly result?: SpatialQuerySessionResult;
  readonly error?: unknown;
}

export interface SpatialQueryBatchResult {
  readonly tasks: readonly SpatialQueryBatchTaskResult[];
  readonly fulfilled: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly estimatedBytes: number;
}

const DEFAULT_MAX_TASKS = 128;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_ESTIMATED_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_IDENTIFIER_LENGTH = 256;

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function normalizeId(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new RangeError("batch task id has invalid length");
  }
  return normalized;
}

function normalizePriority(value: number | undefined): number {
  const priority = value ?? 0;
  if (!Number.isFinite(priority)) {
    throw new TypeError("batch task priority must be finite");
  }
  return priority;
}

function normalizeEstimatedBytes(value: number | undefined): number {
  const bytes = value ?? 0;
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("batch estimatedBytes must be finite and non-negative");
  }
  return Math.floor(bytes);
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("spatial query batch aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export async function executeSpatialQueryBatch(
  input: readonly SpatialQueryBatchTask[],
  options: SpatialQueryBatchOptions = {},
): Promise<SpatialQueryBatchResult> {
  const maxTasks = positiveInteger(options.maxTasks, DEFAULT_MAX_TASKS, "maxTasks");
  const maxConcurrent = positiveInteger(
    options.maxConcurrent,
    DEFAULT_MAX_CONCURRENT,
    "maxConcurrent",
  );
  const maxEstimatedBytes = positiveInteger(
    options.maxEstimatedBytes,
    DEFAULT_MAX_ESTIMATED_BYTES,
    "maxEstimatedBytes",
  );
  const maxIdentifierLength = positiveInteger(
    options.maxIdentifierLength,
    DEFAULT_MAX_IDENTIFIER_LENGTH,
    "maxIdentifierLength",
  );

  if (input.length > maxTasks) {
    throw new RangeError("spatial query batch exceeds task budget");
  }

  const ids = new Set<string>();
  let estimatedBytes = 0;
  const tasks = input.map((task, inputIndex) => {
    const id = normalizeId(task.id, maxIdentifierLength);
    if (ids.has(id)) {
      throw new TypeError("spatial query batch task ids must be unique");
    }
    ids.add(id);
    const bytes = normalizeEstimatedBytes(task.estimatedBytes);
    estimatedBytes += bytes;
    if (estimatedBytes > maxEstimatedBytes) {
      throw new RangeError("spatial query batch exceeds estimated-byte budget");
    }
    return Object.freeze({
      task,
      id,
      inputIndex,
      priority: normalizePriority(task.priority),
    });
  });

  if (options.signal?.aborted) {
    throw abortError(options.signal.reason);
  }

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const queue = [...tasks].sort((left, right) => {
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.inputIndex - right.inputIndex;
  });

  const results: Array<SpatialQueryBatchTaskResult | undefined> = Array.from({ length: input.length });
  let cursor = 0;
  let firstFailure: unknown;

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted && cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const entry = queue[index];
      if (!entry) {
        return;
      }
      try {
        const result = await entry.task.session.query({
          ...entry.task.request,
          signal: controller.signal,
        });
        results[entry.inputIndex] = Object.freeze({
          id: entry.id,
          status: "fulfilled",
          result,
        });
      } catch (error) {
        const cancelled = isAbort(error, controller.signal);
        results[entry.inputIndex] = Object.freeze({
          id: entry.id,
          status: cancelled ? "cancelled" : "rejected",
          error,
        });
        if (!cancelled && options.failureMode !== "collect-errors") {
          firstFailure = error;
          controller.abort(error);
          return;
        }
      }
    }
  };

  try {
    const workerCount = Math.min(maxConcurrent, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    for (const entry of queue) {
      if (results[entry.inputIndex]) {
        continue;
      }
      results[entry.inputIndex] = Object.freeze({
        id: entry.id,
        status: "cancelled",
        error: abortError(controller.signal.reason),
      });
    }

    if (firstFailure !== undefined && options.failureMode !== "collect-errors") {
      throw firstFailure;
    }

    const completed = results.map((result) => result!);
    let fulfilled = 0;
    let rejected = 0;
    let cancelled = 0;
    for (const result of completed) {
      if (result.status === "fulfilled") {
        fulfilled += 1;
      } else if (result.status === "rejected") {
        rejected += 1;
      } else {
        cancelled += 1;
      }
    }

    return Object.freeze({
      tasks: Object.freeze(completed),
      fulfilled,
      rejected,
      cancelled,
      estimatedBytes,
    });
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
