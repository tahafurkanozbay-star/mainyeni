import {
  boundedInteger,
  normalizeHealthStatus,
  normalizeIdentifier,
  normalizeOptionalText,
  safeObserver,
  type ComponentHealthSnapshot,
  type HealthSignal,
  type HealthStatus,
  type NormalizedHealthSignal,
  type ReadinessReport,
} from './contracts';

export interface HealthRegistryPolicy {
  readonly defaultTtlMs?: number;
  readonly minimumFreshnessMs?: number;
  readonly readinessRequired?: readonly string[];
  readonly degradedBlocksReadiness?: boolean;
  readonly staleBlocksReadiness?: boolean;
  readonly disabledBlocksReadiness?: boolean;
}

export interface HealthRegistryOptions extends HealthRegistryPolicy {
  readonly now?: () => number;
  readonly onChange?: (snapshot: ComponentHealthSnapshot) => void;
}

export interface HealthRegistrySnapshot {
  readonly revision: number;
  readonly generatedAt: number;
  readonly components: readonly ComponentHealthSnapshot[];
  readonly readiness: ReadinessReport;
}

export type HealthListener = (snapshot: HealthRegistrySnapshot) => void;

const EMPTY_DETAILS: Readonly<Record<string, string | number | boolean | null>> = Object.freeze({});

const normalizeDetails = (
  details: HealthSignal['details'],
): Readonly<Record<string, string | number | boolean | null>> => {
  if (!details) return EMPTY_DETAILS;
  const output: Record<string, string | number | boolean | null> = {};
  const keys = Object.keys(details).sort().slice(0, 32);
  for (const key of keys) {
    let normalizedKey: string;
    try {
      normalizedKey = normalizeIdentifier(key, 'health detail key');
    } catch {
      continue;
    }
    const value = details[key];
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || value === null
    ) {
      output[normalizedKey] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  }
  return Object.freeze(output);
};

const statusRank = (status: HealthStatus): number => {
  switch (status) {
    case 'healthy': return 0;
    case 'disabled': return 1;
    case 'degraded': return 2;
    case 'unknown': return 3;
    case 'unhealthy': return 4;
  }
};

const snapshotComparator = (left: ComponentHealthSnapshot, right: ComponentHealthSnapshot): number => {
  const rank = statusRank(right.status) - statusRank(left.status);
  if (rank !== 0) return rank;
  return left.componentId.localeCompare(right.componentId);
};

const reportSummary = (
  healthy: readonly string[],
  degraded: readonly string[],
  unhealthy: readonly string[],
  unknown: readonly string[],
  disabled: readonly string[],
  stale: readonly string[],
): string => [
  `${healthy.length} healthy`,
  `${degraded.length} degraded`,
  `${unhealthy.length} unhealthy`,
  `${unknown.length} unknown`,
  `${disabled.length} disabled`,
  `${stale.length} stale`,
].join(', ');

export class HealthRegistry {
  readonly #signals = new Map<string, NormalizedHealthSignal>();
  readonly #listeners = new Set<HealthListener>();
  readonly #now: () => number;
  readonly #defaultTtlMs: number;
  readonly #minimumFreshnessMs: number;
  readonly #degradedBlocksReadiness: boolean;
  readonly #staleBlocksReadiness: boolean;
  readonly #disabledBlocksReadiness: boolean;
  readonly #onChange: ((snapshot: ComponentHealthSnapshot) => void) | undefined;
  #readinessRequired: readonly string[];
  #revision = 0;

  constructor(options: HealthRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#defaultTtlMs = boundedInteger(options.defaultTtlMs, 30_000, 0, 24 * 60 * 60 * 1000);
    this.#minimumFreshnessMs = boundedInteger(
      options.minimumFreshnessMs,
      0,
      0,
      24 * 60 * 60 * 1000,
    );
    this.#degradedBlocksReadiness = options.degradedBlocksReadiness === true;
    this.#staleBlocksReadiness = options.staleBlocksReadiness !== false;
    this.#disabledBlocksReadiness = options.disabledBlocksReadiness === true;
    this.#onChange = options.onChange;
    this.#readinessRequired = this.#normalizeRequired(options.readinessRequired ?? []);
  }

  get revision(): number {
    return this.#revision;
  }

  get size(): number {
    return this.#signals.size;
  }

  setReadinessRequired(componentIds: readonly string[]): void {
    const next = this.#normalizeRequired(componentIds);
    if (
      next.length === this.#readinessRequired.length
      && next.every((value, index) => value === this.#readinessRequired[index])
    ) {
      return;
    }
    this.#readinessRequired = next;
    this.#revision += 1;
    this.#emitSnapshot();
  }

  report(signal: HealthSignal): ComponentHealthSnapshot {
    const normalized = this.#normalizeSignal(signal);
    this.#signals.set(normalized.componentId, normalized);
    this.#revision += 1;
    const snapshot = this.#toSnapshot(normalized, this.#now());
    safeObserver(this.#onChange, snapshot);
    this.#emitSnapshot();
    return snapshot;
  }

  healthy(componentId: string, message?: string, ttlMs?: number): ComponentHealthSnapshot {
    return this.report({ componentId, status: 'healthy', ...(message === undefined ? {} : { message }), ...(ttlMs === undefined ? {} : { ttlMs }) });
  }

  degraded(componentId: string, message?: string, ttlMs?: number): ComponentHealthSnapshot {
    return this.report({ componentId, status: 'degraded', ...(message === undefined ? {} : { message }), ...(ttlMs === undefined ? {} : { ttlMs }) });
  }

  unhealthy(componentId: string, message?: string, ttlMs?: number): ComponentHealthSnapshot {
    return this.report({ componentId, status: 'unhealthy', ...(message === undefined ? {} : { message }), ...(ttlMs === undefined ? {} : { ttlMs }) });
  }

  disabled(componentId: string, message?: string): ComponentHealthSnapshot {
    return this.report({ componentId, status: 'disabled', ttlMs: 0, ...(message === undefined ? {} : { message }) });
  }

  unknown(componentId: string, message?: string, ttlMs?: number): ComponentHealthSnapshot {
    return this.report({ componentId, status: 'unknown', ...(message === undefined ? {} : { message }), ...(ttlMs === undefined ? {} : { ttlMs }) });
  }

  remove(componentId: string): boolean {
    const id = normalizeIdentifier(componentId, 'component id');
    const removed = this.#signals.delete(id);
    if (removed) {
      this.#revision += 1;
      this.#emitSnapshot();
    }
    return removed;
  }

  clear(): void {
    if (this.#signals.size === 0) return;
    this.#signals.clear();
    this.#revision += 1;
    this.#emitSnapshot();
  }

  get(componentId: string, now = this.#now()): ComponentHealthSnapshot | null {
    let id: string;
    try {
      id = normalizeIdentifier(componentId, 'component id');
    } catch {
      return null;
    }
    const signal = this.#signals.get(id);
    return signal ? this.#toSnapshot(signal, now) : null;
  }

  list(now = this.#now()): readonly ComponentHealthSnapshot[] {
    return Object.freeze(
      [...this.#signals.values()]
        .map((signal) => this.#toSnapshot(signal, now))
        .sort(snapshotComparator),
    );
  }

  readiness(now = this.#now()): ReadinessReport {
    const required = this.#readinessRequired;
    const snapshots = new Map(this.list(now).map((snapshot) => [snapshot.componentId, snapshot]));
    const healthy: string[] = [];
    const degraded: string[] = [];
    const unhealthy: string[] = [];
    const unknown: string[] = [];
    const disabled: string[] = [];
    const stale: string[] = [];

    for (const id of required) {
      const snapshot = snapshots.get(id);
      if (!snapshot) {
        unknown.push(id);
        continue;
      }
      if (snapshot.stale) stale.push(id);
      switch (snapshot.status) {
        case 'healthy': healthy.push(id); break;
        case 'degraded': degraded.push(id); break;
        case 'unhealthy': unhealthy.push(id); break;
        case 'unknown': unknown.push(id); break;
        case 'disabled': disabled.push(id); break;
      }
    }

    const hardBlocked = unhealthy.length > 0
      || unknown.length > 0
      || (this.#staleBlocksReadiness && stale.length > 0)
      || (this.#disabledBlocksReadiness && disabled.length > 0)
      || (this.#degradedBlocksReadiness && degraded.length > 0);
    const degradedOnly = !hardBlocked && (degraded.length > 0 || stale.length > 0 || disabled.length > 0);
    const status = hardBlocked ? 'not-ready' : degradedOnly ? 'degraded' : 'ready';

    return Object.freeze({
      status,
      generatedAt: now,
      required,
      healthy: Object.freeze(healthy),
      degraded: Object.freeze(degraded),
      unhealthy: Object.freeze(unhealthy),
      unknown: Object.freeze(unknown),
      disabled: Object.freeze(disabled),
      stale: Object.freeze(stale),
      summary: reportSummary(healthy, degraded, unhealthy, unknown, disabled, stale),
    });
  }

  snapshot(now = this.#now()): HealthRegistrySnapshot {
    return Object.freeze({
      revision: this.#revision,
      generatedAt: now,
      components: this.list(now),
      readiness: this.readiness(now),
    });
  }

  subscribe(listener: HealthListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('Health listener must be a function.');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pruneExpired(now = this.#now()): readonly string[] {
    const removed: string[] = [];
    for (const [id, signal] of this.#signals) {
      if (signal.expiresAt === null || signal.expiresAt > now) continue;
      this.#signals.delete(id);
      removed.push(id);
    }
    if (removed.length > 0) {
      removed.sort();
      this.#revision += 1;
      this.#emitSnapshot();
    }
    return Object.freeze(removed);
  }

  worstStatus(now = this.#now()): HealthStatus {
    let worst: HealthStatus = 'healthy';
    let rank = statusRank(worst);
    for (const snapshot of this.list(now)) {
      const nextRank = snapshot.stale ? statusRank('unknown') : statusRank(snapshot.status);
      if (nextRank > rank) {
        rank = nextRank;
        worst = snapshot.stale ? 'unknown' : snapshot.status;
      }
    }
    return worst;
  }

  #normalizeSignal(signal: HealthSignal): NormalizedHealthSignal {
    const componentId = normalizeIdentifier(signal.componentId, 'component id');
    const status = normalizeHealthStatus(signal.status);
    const observedAt = Number.isFinite(signal.observedAt)
      ? Math.max(0, Math.trunc(signal.observedAt ?? this.#now()))
      : this.#now();
    const ttlMs = boundedInteger(signal.ttlMs, this.#defaultTtlMs, 0, 24 * 60 * 60 * 1000);
    const expiresAt = ttlMs === 0 ? null : observedAt + ttlMs;
    return Object.freeze({
      componentId,
      status,
      observedAt,
      expiresAt,
      message: normalizeOptionalText(signal.message, 1000),
      source: normalizeOptionalText(signal.source, 200),
      details: normalizeDetails(signal.details),
    });
  }

  #toSnapshot(signal: NormalizedHealthSignal, now: number): ComponentHealthSnapshot {
    const ageMs = Math.max(0, now - signal.observedAt);
    const expired = signal.expiresAt !== null && signal.expiresAt <= now;
    const freshnessViolation = this.#minimumFreshnessMs > 0 && ageMs > this.#minimumFreshnessMs;
    return Object.freeze({
      ...signal,
      stale: expired || freshnessViolation,
      ageMs,
    });
  }

  #normalizeRequired(values: readonly string[]): readonly string[] {
    const result = new Set<string>();
    for (const value of values) result.add(normalizeIdentifier(value, 'readiness component id'));
    return Object.freeze([...result].sort());
  }

  #emitSnapshot(): void {
    if (this.#listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) safeObserver(listener, snapshot);
  }
}
