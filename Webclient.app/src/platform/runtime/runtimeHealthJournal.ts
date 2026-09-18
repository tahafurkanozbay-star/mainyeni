export type RuntimeHealthSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';
export type RuntimeHealthKind =
  | 'admission'
  | 'pressure'
  | 'lifecycle'
  | 'resource'
  | 'latency'
  | 'failure'
  | 'recovery';

export interface RuntimeHealthEvent {
  readonly at: number;
  readonly kind: RuntimeHealthKind;
  readonly severity: RuntimeHealthSeverity;
  readonly code: string;
  readonly message?: string;
  readonly lane?: string;
  readonly durationMs?: number;
  readonly value?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface RuntimeHealthJournalPolicy {
  readonly capacity: number;
  readonly maxMessageLength: number;
  readonly maxTagsPerEvent: number;
  readonly maxTagLength: number;
  readonly retentionMs: number;
  readonly latencyWindowSize: number;
  readonly failureWindowSize: number;
}

export interface RuntimeHealthQuery {
  readonly since?: number;
  readonly until?: number;
  readonly kinds?: readonly RuntimeHealthKind[];
  readonly severities?: readonly RuntimeHealthSeverity[];
  readonly codes?: readonly string[];
  readonly lane?: string;
  readonly limit?: number;
}

export interface RuntimeHealthSummary {
  readonly total: number;
  readonly retained: number;
  readonly dropped: number;
  readonly pruned: number;
  readonly failures: number;
  readonly failureRate: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly p99LatencyMs: number | null;
  readonly lastEventAt: number | null;
  readonly bySeverity: Readonly<Record<RuntimeHealthSeverity, number>>;
  readonly byKind: Readonly<Record<RuntimeHealthKind, number>>;
}

export interface RuntimeHealthJournalSnapshot {
  readonly events: readonly RuntimeHealthEvent[];
  readonly summary: RuntimeHealthSummary;
}

export interface RuntimeHealthJournal {
  readonly record: (event: RuntimeHealthEvent) => RuntimeHealthEvent;
  readonly query: (query?: RuntimeHealthQuery) => readonly RuntimeHealthEvent[];
  readonly summary: () => RuntimeHealthSummary;
  readonly snapshot: (query?: RuntimeHealthQuery) => RuntimeHealthJournalSnapshot;
  readonly clear: () => void;
  readonly dispose: () => void;
}

const DEFAULT_POLICY: RuntimeHealthJournalPolicy = Object.freeze({
  capacity: 256,
  maxMessageLength: 512,
  maxTagsPerEvent: 12,
  maxTagLength: 96,
  retentionMs: 15 * 60_000,
  latencyWindowSize: 128,
  failureWindowSize: 128,
});

const KINDS: readonly RuntimeHealthKind[] = Object.freeze([
  'admission', 'pressure', 'lifecycle', 'resource', 'latency', 'failure', 'recovery',
]);
const SEVERITIES: readonly RuntimeHealthSeverity[] = Object.freeze([
  'debug', 'info', 'warning', 'error', 'critical',
]);

const positiveInt = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;

const finiteNonNegative = (value: number | undefined): number | undefined =>
  Number.isFinite(value) && Number(value) >= 0 ? Number(value) : undefined;

const percentile = (values: readonly number[], ratio: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
};

const boundedText = (value: string | undefined, limit: number): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
};

const normalizeTags = (
  tags: Readonly<Record<string, string>> | undefined,
  policy: RuntimeHealthJournalPolicy,
): Readonly<Record<string, string>> | undefined => {
  if (!tags) return undefined;
  const normalized: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(tags)) {
    if (count >= policy.maxTagsPerEvent) break;
    const key = boundedText(rawKey, policy.maxTagLength);
    const value = boundedText(rawValue, policy.maxTagLength);
    if (!key || !value) continue;
    normalized[key] = value;
    count += 1;
  }
  return count > 0 ? Object.freeze(normalized) : undefined;
};

const normalizePolicy = (input: Partial<RuntimeHealthJournalPolicy>): RuntimeHealthJournalPolicy =>
  Object.freeze({
    capacity: positiveInt(input.capacity, DEFAULT_POLICY.capacity),
    maxMessageLength: positiveInt(input.maxMessageLength, DEFAULT_POLICY.maxMessageLength),
    maxTagsPerEvent: positiveInt(input.maxTagsPerEvent, DEFAULT_POLICY.maxTagsPerEvent),
    maxTagLength: positiveInt(input.maxTagLength, DEFAULT_POLICY.maxTagLength),
    retentionMs: positiveInt(input.retentionMs, DEFAULT_POLICY.retentionMs),
    latencyWindowSize: positiveInt(input.latencyWindowSize, DEFAULT_POLICY.latencyWindowSize),
    failureWindowSize: positiveInt(input.failureWindowSize, DEFAULT_POLICY.failureWindowSize),
  });

const emptySeverityCounts = (): Record<RuntimeHealthSeverity, number> => ({
  debug: 0, info: 0, warning: 0, error: 0, critical: 0,
});
const emptyKindCounts = (): Record<RuntimeHealthKind, number> => ({
  admission: 0, pressure: 0, lifecycle: 0, resource: 0, latency: 0, failure: 0, recovery: 0,
});

export const createRuntimeHealthJournal = (
  options: Partial<RuntimeHealthJournalPolicy> = {},
  now: () => number = Date.now,
): RuntimeHealthJournal => {
  const policy = normalizePolicy(options);
  const events: RuntimeHealthEvent[] = [];
  const latencyWindow: number[] = [];
  const failureWindow: boolean[] = [];
  let total = 0;
  let dropped = 0;
  let pruned = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('Runtime health journal is disposed.');
  };

  const prune = (): void => {
    const cutoff = now() - policy.retentionMs;
    let removeCount = 0;
    while (removeCount < events.length && (events[removeCount]?.at ?? cutoff) < cutoff) removeCount += 1;
    if (removeCount === 0) return;
    events.splice(0, removeCount);
    pruned += removeCount;
  };

  const pushWindow = <T>(window: T[], value: T, capacity: number): void => {
    window.push(value);
    if (window.length > capacity) window.splice(0, window.length - capacity);
  };

  const normalizeEvent = (event: RuntimeHealthEvent): RuntimeHealthEvent => {
    const at = Number.isFinite(event.at) ? event.at : now();
    const code = boundedText(event.code, policy.maxTagLength) ?? 'unknown';
    const message = boundedText(event.message, policy.maxMessageLength);
    const lane = boundedText(event.lane, policy.maxTagLength);
    const durationMs = finiteNonNegative(event.durationMs);
    const value = Number.isFinite(event.value) ? Number(event.value) : undefined;
    const tags = normalizeTags(event.tags, policy);
    return Object.freeze({
      at,
      kind: KINDS.includes(event.kind) ? event.kind : 'lifecycle',
      severity: SEVERITIES.includes(event.severity) ? event.severity : 'warning',
      code,
      ...(message ? { message } : {}),
      ...(lane ? { lane } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(tags ? { tags } : {}),
    });
  };

  const record = (event: RuntimeHealthEvent): RuntimeHealthEvent => {
    assertActive();
    prune();
    const normalized = normalizeEvent(event);
    events.push(normalized);
    total += 1;
    if (normalized.durationMs !== undefined) {
      pushWindow(latencyWindow, normalized.durationMs, policy.latencyWindowSize);
    }
    pushWindow(
      failureWindow,
      normalized.kind === 'failure' || normalized.severity === 'error' || normalized.severity === 'critical',
      policy.failureWindowSize,
    );
    if (events.length > policy.capacity) {
      const overflow = events.length - policy.capacity;
      events.splice(0, overflow);
      dropped += overflow;
    }
    return normalized;
  };

  const query = (input: RuntimeHealthQuery = {}): readonly RuntimeHealthEvent[] => {
    assertActive();
    prune();
    const kinds = input.kinds?.length ? new Set(input.kinds) : null;
    const severities = input.severities?.length ? new Set(input.severities) : null;
    const codes = input.codes?.length ? new Set(input.codes) : null;
    const lane = input.lane?.trim();
    const limit = positiveInt(input.limit, policy.capacity);
    const matches = events.filter((event) => {
      if (input.since !== undefined && event.at < input.since) return false;
      if (input.until !== undefined && event.at > input.until) return false;
      if (kinds && !kinds.has(event.kind)) return false;
      if (severities && !severities.has(event.severity)) return false;
      if (codes && !codes.has(event.code)) return false;
      return !lane || event.lane === lane;
    });
    return Object.freeze(matches.slice(Math.max(0, matches.length - limit)));
  };

  const summary = (): RuntimeHealthSummary => {
    assertActive();
    prune();
    const bySeverity = emptySeverityCounts();
    const byKind = emptyKindCounts();
    for (const event of events) {
      bySeverity[event.severity] += 1;
      byKind[event.kind] += 1;
    }
    const failures = failureWindow.filter(Boolean).length;
    return Object.freeze({
      total,
      retained: events.length,
      dropped,
      pruned,
      failures,
      failureRate: failureWindow.length > 0 ? failures / failureWindow.length : 0,
      p50LatencyMs: percentile(latencyWindow, 0.5),
      p95LatencyMs: percentile(latencyWindow, 0.95),
      p99LatencyMs: percentile(latencyWindow, 0.99),
      lastEventAt: events.at(-1)?.at ?? null,
      bySeverity: Object.freeze(bySeverity),
      byKind: Object.freeze(byKind),
    });
  };

  const snapshot = (input: RuntimeHealthQuery = {}): RuntimeHealthJournalSnapshot => Object.freeze({
    events: query(input),
    summary: summary(),
  });

  const clear = (): void => {
    assertActive();
    events.splice(0);
    latencyWindow.splice(0);
    failureWindow.splice(0);
    total = 0;
    dropped = 0;
    pruned = 0;
  };

  const dispose = (): void => {
    if (disposed) return;
    events.splice(0);
    latencyWindow.splice(0);
    failureWindow.splice(0);
    disposed = true;
  };

  return Object.freeze({ record, query, summary, snapshot, clear, dispose });
};
