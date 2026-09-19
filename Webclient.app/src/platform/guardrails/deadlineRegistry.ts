export interface DeadlinePolicy {
  readonly defaultTimeoutMs: number;
  readonly minimumTimeoutMs: number;
  readonly maximumTimeoutMs: number;
  readonly maxTracked: number;
}

export interface DeadlineToken {
  readonly id: number;
  readonly label: string;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly timeoutMs: number;
}

export interface DeadlineSnapshot extends DeadlineToken {
  readonly remainingMs: number;
  readonly expired: boolean;
  readonly completed: boolean;
  readonly completedAt: number | null;
}

export interface DeadlineRegistrySnapshot {
  readonly active: number;
  readonly completed: number;
  readonly expired: number;
  readonly rejected: number;
  readonly deadlines: readonly DeadlineSnapshot[];
}

export interface DeadlineRegistry {
  readonly begin: (label: string, timeoutMs?: number, at?: number) => DeadlineToken | null;
  readonly remaining: (id: number, at?: number) => number;
  readonly expired: (id: number, at?: number) => boolean;
  readonly complete: (id: number, at?: number) => DeadlineSnapshot;
  readonly sweep: (at?: number) => readonly DeadlineSnapshot[];
  readonly snapshot: (at?: number) => DeadlineRegistrySnapshot;
  readonly clearCompleted: () => void;
  readonly dispose: () => void;
}

export const DEFAULT_DEADLINE_POLICY: DeadlinePolicy = Object.freeze({
  defaultTimeoutMs: 30_000,
  minimumTimeoutMs: 50,
  maximumTimeoutMs: 120_000,
  maxTracked: 1_024,
});

interface MutableDeadline extends DeadlineToken {
  completed: boolean;
  completedAt: number | null;
}

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

export const normalizeDeadlinePolicy = (
  input: Partial<DeadlinePolicy> = {},
): DeadlinePolicy => {
  const minimumTimeoutMs = positiveInt(
    input.minimumTimeoutMs ?? DEFAULT_DEADLINE_POLICY.minimumTimeoutMs,
    DEFAULT_DEADLINE_POLICY.minimumTimeoutMs,
  );
  const maximumTimeoutMs = Math.max(
    minimumTimeoutMs,
    positiveInt(
      input.maximumTimeoutMs ?? DEFAULT_DEADLINE_POLICY.maximumTimeoutMs,
      DEFAULT_DEADLINE_POLICY.maximumTimeoutMs,
    ),
  );
  const defaultTimeoutMs = Math.max(
    minimumTimeoutMs,
    Math.min(
      maximumTimeoutMs,
      positiveInt(
        input.defaultTimeoutMs ?? DEFAULT_DEADLINE_POLICY.defaultTimeoutMs,
        DEFAULT_DEADLINE_POLICY.defaultTimeoutMs,
      ),
    ),
  );
  return Object.freeze({
    defaultTimeoutMs,
    minimumTimeoutMs,
    maximumTimeoutMs,
    maxTracked: positiveInt(
      input.maxTracked ?? DEFAULT_DEADLINE_POLICY.maxTracked,
      DEFAULT_DEADLINE_POLICY.maxTracked,
    ),
  });
};

const clampTimeout = (value: number | undefined, policy: DeadlinePolicy): number => {
  if (value === undefined || !Number.isFinite(value)) return policy.defaultTimeoutMs;
  return Math.max(
    policy.minimumTimeoutMs,
    Math.min(policy.maximumTimeoutMs, Math.floor(value)),
  );
};

export const createDeadlineRegistry = (
  policyInput: Partial<DeadlinePolicy> = {},
  now: () => number = Date.now,
): DeadlineRegistry => {
  const policy = normalizeDeadlinePolicy(policyInput);
  const deadlines = new Map<number, MutableDeadline>();
  let nextId = 1;
  let completedCount = 0;
  let expiredCount = 0;
  let rejectedCount = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('Deadline registry is disposed.');
  };

  const timestamp = (value?: number): number => {
    if (value !== undefined && Number.isFinite(value)) return value;
    return now();
  };

  const begin = (
    labelInput: string,
    timeoutInput?: number,
    atInput?: number,
  ): DeadlineToken | null => {
    assertActive();
    if (deadlines.size >= policy.maxTracked) {
      rejectedCount += 1;
      return null;
    }

    const label = labelInput.trim().slice(0, 256);
    if (!label) {
      rejectedCount += 1;
      return null;
    }

    const startedAt = timestamp(atInput);
    const timeoutMs = clampTimeout(timeoutInput, policy);
    const id = nextId;
    nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    const deadline: MutableDeadline = {
      id,
      label,
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      timeoutMs,
      completed: false,
      completedAt: null,
    };
    deadlines.set(id, deadline);

    return Object.freeze({
      id,
      label,
      startedAt,
      deadlineAt: deadline.deadlineAt,
      timeoutMs,
    });
  };

  const requireDeadline = (id: number): MutableDeadline => {
    const deadline = deadlines.get(id);
    if (!deadline) throw new Error('Unknown deadline token.');
    return deadline;
  };

  const remaining = (id: number, atInput?: number): number => {
    assertActive();
    const deadline = requireDeadline(id);
    if (deadline.completed) return 0;
    return Math.max(0, deadline.deadlineAt - timestamp(atInput));
  };

  const expired = (id: number, atInput?: number): boolean => {
    assertActive();
    const deadline = requireDeadline(id);
    if (deadline.completed) return false;
    return timestamp(atInput) >= deadline.deadlineAt;
  };

  const toSnapshot = (
    deadline: MutableDeadline,
    at: number,
  ): DeadlineSnapshot => {
    const isExpired = !deadline.completed && at >= deadline.deadlineAt;
    return Object.freeze({
      id: deadline.id,
      label: deadline.label,
      startedAt: deadline.startedAt,
      deadlineAt: deadline.deadlineAt,
      timeoutMs: deadline.timeoutMs,
      remainingMs: deadline.completed
        ? 0
        : Math.max(0, deadline.deadlineAt - at),
      expired: isExpired,
      completed: deadline.completed,
      completedAt: deadline.completedAt,
    });
  };

  const complete = (
    id: number,
    atInput?: number,
  ): DeadlineSnapshot => {
    assertActive();
    const deadline = requireDeadline(id);
    const at = timestamp(atInput);
    if (!deadline.completed) {
      deadline.completed = true;
      deadline.completedAt = Math.max(deadline.startedAt, at);
      completedCount += 1;
    }
    return toSnapshot(deadline, at);
  };

  const sweep = (
    atInput?: number,
  ): readonly DeadlineSnapshot[] => {
    assertActive();
    const at = timestamp(atInput);
    const expiredSnapshots: DeadlineSnapshot[] = [];
    for (const deadline of deadlines.values()) {
      if (deadline.completed || at < deadline.deadlineAt) continue;
      deadline.completed = true;
      deadline.completedAt = at;
      expiredCount += 1;
      expiredSnapshots.push(toSnapshot(deadline, at));
    }
    return Object.freeze(expiredSnapshots);
  };

  const snapshot = (
    atInput?: number,
  ): DeadlineRegistrySnapshot => {
    assertActive();
    const at = timestamp(atInput);
    const values = [...deadlines.values()]
      .sort((left, right) => left.startedAt - right.startedAt || left.id - right.id)
      .map((deadline) => toSnapshot(deadline, at));
    return Object.freeze({
      active: values.filter((deadline) => !deadline.completed).length,
      completed: completedCount,
      expired: expiredCount,
      rejected: rejectedCount,
      deadlines: Object.freeze(values),
    });
  };

  const clearCompleted = (): void => {
    assertActive();
    for (const [id, deadline] of deadlines) {
      if (deadline.completed) deadlines.delete(id);
    }
  };

  const dispose = (): void => {
    deadlines.clear();
    disposed = true;
  };

  return Object.freeze({
    begin,
    remaining,
    expired,
    complete,
    sweep,
    snapshot,
    clearCompleted,
    dispose,
  });
};
