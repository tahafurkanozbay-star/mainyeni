export type ArcGisRetryClass = 'interactive' | 'foreground' | 'background';
export type ArcGisRetryDecisionReason = 'admitted' | 'attempt-limit' | 'window-budget' | 'service-budget' | 'backoff' | 'deadline';

export interface ArcGisServiceRetryBudgetPolicy {
  readonly maxServices: number;
  readonly maxAttemptsPerRequest: number;
  readonly maxRetriesPerWindow: number;
  readonly maxRetriesPerServiceWindow: number;
  readonly windowMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxJitterMs: number;
  readonly maxRequestLifetimeMs: number;
  readonly maxServiceKeyLength: number;
  readonly maxRequestIdLength: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisRetryServiceState {
  readonly serviceKey: string;
  readonly windowStartedAtMs: number;
  readonly retriesInWindow: number;
  readonly lastRetryAtMs: number | null;
}

export interface ArcGisRetryAdmission {
  readonly admitted: boolean;
  readonly reason: ArcGisRetryDecisionReason;
  readonly retryAtMs: number | null;
  readonly attempt: number;
}

export interface ArcGisServiceRetryBudgetSnapshot {
  readonly generation: number;
  readonly globalWindowStartedAtMs: number;
  readonly globalRetriesInWindow: number;
  readonly services: readonly ArcGisRetryServiceState[];
}

const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
};
const nonNegative = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
};
const text = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};
const freezeState = (state: ArcGisRetryServiceState): ArcGisRetryServiceState => Object.freeze({ ...state });

/**
 * Primitive-only retry admission authority for verified ArcGIS REST adapters.
 * The coordinator deliberately does not execute retries, own timers, transports,
 * URLs, credentials, response bodies, AbortControllers or ArcGIS SDK objects.
 */
export class ArcGisServiceRetryBudgetCoordinator {
  private readonly policy: Readonly<ArcGisServiceRetryBudgetPolicy>;
  private readonly services = new Map<string, ArcGisRetryServiceState>();
  private generation = 0;
  private globalWindowStartedAtMs = 0;
  private globalRetriesInWindow = 0;
  private lastObservedAtMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceRetryBudgetPolicy) {
    const baseBackoffMs = positive(policy.baseBackoffMs, 'baseBackoffMs');
    const maxBackoffMs = positive(policy.maxBackoffMs, 'maxBackoffMs');
    if (baseBackoffMs > maxBackoffMs) throw new Error('baseBackoffMs cannot exceed maxBackoffMs');
    this.policy = Object.freeze({
      maxServices: positive(policy.maxServices, 'maxServices'),
      maxAttemptsPerRequest: positive(policy.maxAttemptsPerRequest, 'maxAttemptsPerRequest'),
      maxRetriesPerWindow: positive(policy.maxRetriesPerWindow, 'maxRetriesPerWindow'),
      maxRetriesPerServiceWindow: positive(policy.maxRetriesPerServiceWindow, 'maxRetriesPerServiceWindow'),
      windowMs: positive(policy.windowMs, 'windowMs'),
      baseBackoffMs,
      maxBackoffMs,
      maxJitterMs: nonNegative(policy.maxJitterMs, 'maxJitterMs'),
      maxRequestLifetimeMs: positive(policy.maxRequestLifetimeMs, 'maxRequestLifetimeMs'),
      maxServiceKeyLength: positive(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxRequestIdLength: positive(policy.maxRequestIdLength, 'maxRequestIdLength'),
      maxClockSkewMs: positive(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  admit(serviceKeyValue: string, requestIdValue: string, attemptValue: number, requestStartedAtMs: number, timestampMs: number, retryClass: ArcGisRetryClass, jitterSeed = 0): ArcGisRetryAdmission {
    this.assertUsable();
    const now = this.time(timestampMs);
    const serviceKey = text(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    text(requestIdValue, this.policy.maxRequestIdLength, 'request id');
    const attempt = positive(attemptValue, 'attempt');
    const started = nonNegative(requestStartedAtMs, 'requestStartedAtMs');
    if (started > now + this.policy.maxClockSkewMs) throw new Error('request start is in the future');
    if (retryClass !== 'interactive' && retryClass !== 'foreground' && retryClass !== 'background') throw new Error('invalid retry class');
    this.rollGlobalWindow(now);
    const state = this.serviceState(serviceKey, now);
    if (attempt > this.policy.maxAttemptsPerRequest) return this.decision(false, 'attempt-limit', null, attempt);
    if (now >= started && now - started > this.policy.maxRequestLifetimeMs) return this.decision(false, 'deadline', null, attempt);
    if (this.globalRetriesInWindow >= this.policy.maxRetriesPerWindow) return this.decision(false, 'window-budget', null, attempt);
    if (state.retriesInWindow >= this.policy.maxRetriesPerServiceWindow) return this.decision(false, 'service-budget', null, attempt);

    const delay = this.backoff(attempt, retryClass, jitterSeed);
    const retryAtMs = now + delay;
    if (!Number.isSafeInteger(retryAtMs) || retryAtMs - started > this.policy.maxRequestLifetimeMs) return this.decision(false, 'deadline', null, attempt);
    if (state.lastRetryAtMs !== null && now < state.lastRetryAtMs) throw new Error('retry state clock inversion');

    this.services.set(serviceKey, freezeState({ ...state, retriesInWindow: state.retriesInWindow + 1, lastRetryAtMs: now }));
    this.globalRetriesInWindow += 1;
    this.generation += 1;
    return this.decision(true, delay === 0 ? 'admitted' : 'backoff', retryAtMs, attempt);
  }

  snapshot(timestampMs: number): ArcGisServiceRetryBudgetSnapshot {
    this.assertUsable();
    const now = this.time(timestampMs);
    this.rollGlobalWindow(now);
    this.rollServiceWindows(now);
    const services = [...this.services.values()].sort((a, b) => a.serviceKey.localeCompare(b.serviceKey)).map(freezeState);
    return Object.freeze({ generation: this.generation, globalWindowStartedAtMs: this.globalWindowStartedAtMs, globalRetriesInWindow: this.globalRetriesInWindow, services: Object.freeze(services) });
  }

  restore(snapshot: Pick<ArcGisServiceRetryBudgetSnapshot, 'globalWindowStartedAtMs' | 'globalRetriesInWindow' | 'services'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.time(timestampMs);
    const globalStart = nonNegative(snapshot.globalWindowStartedAtMs, 'globalWindowStartedAtMs');
    const globalRetries = nonNegative(snapshot.globalRetriesInWindow, 'globalRetriesInWindow');
    if (globalStart > now + this.policy.maxClockSkewMs) throw new Error('future global retry window');
    if (globalRetries > this.policy.maxRetriesPerWindow) throw new Error('global retry budget exceeded');
    if (!Array.isArray(snapshot.services) || snapshot.services.length > this.policy.maxServices) throw new Error('invalid retry service capacity');
    const next = new Map<string, ArcGisRetryServiceState>();
    for (const raw of snapshot.services) {
      const serviceKey = text(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key');
      if (next.has(serviceKey)) throw new Error('duplicate retry service');
      const windowStartedAtMs = nonNegative(raw.windowStartedAtMs, 'windowStartedAtMs');
      const retriesInWindow = nonNegative(raw.retriesInWindow, 'retriesInWindow');
      if (windowStartedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future service retry window');
      if (retriesInWindow > this.policy.maxRetriesPerServiceWindow) throw new Error('service retry budget exceeded');
      const lastRetryAtMs = raw.lastRetryAtMs === null ? null : nonNegative(raw.lastRetryAtMs, 'lastRetryAtMs');
      if (lastRetryAtMs !== null && (lastRetryAtMs < windowStartedAtMs || lastRetryAtMs > now + this.policy.maxClockSkewMs)) throw new Error('invalid last retry timestamp');
      next.set(serviceKey, freezeState({ serviceKey, windowStartedAtMs, retriesInWindow, lastRetryAtMs }));
    }
    this.services.clear();
    for (const [key, value] of next) this.services.set(key, value);
    this.globalWindowStartedAtMs = globalStart;
    this.globalRetriesInWindow = globalRetries;
    this.lastObservedAtMs = now;
    this.rollGlobalWindow(now);
    this.rollServiceWindows(now);
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.services.clear();
    this.globalRetriesInWindow = 0;
    this.generation += 1;
  }

  private serviceState(serviceKey: string, now: number): ArcGisRetryServiceState {
    const current = this.services.get(serviceKey);
    if (current) {
      if (now >= current.windowStartedAtMs && now - current.windowStartedAtMs >= this.policy.windowMs) {
        const reset = freezeState({ serviceKey, windowStartedAtMs: now, retriesInWindow: 0, lastRetryAtMs: current.lastRetryAtMs });
        this.services.set(serviceKey, reset);
        this.generation += 1;
        return reset;
      }
      return current;
    }
    if (this.services.size >= this.policy.maxServices) this.evictService();
    const created = freezeState({ serviceKey, windowStartedAtMs: now, retriesInWindow: 0, lastRetryAtMs: null });
    this.services.set(serviceKey, created);
    this.generation += 1;
    return created;
  }

  private evictService(): void {
    const candidate = [...this.services.values()].sort((a, b) => (a.lastRetryAtMs ?? a.windowStartedAtMs) - (b.lastRetryAtMs ?? b.windowStartedAtMs) || a.serviceKey.localeCompare(b.serviceKey))[0];
    if (!candidate) throw new Error('retry service capacity invariant failed');
    this.services.delete(candidate.serviceKey);
    this.generation += 1;
  }

  private rollGlobalWindow(now: number): void {
    if (this.globalWindowStartedAtMs === 0) { this.globalWindowStartedAtMs = now; return; }
    if (now >= this.globalWindowStartedAtMs && now - this.globalWindowStartedAtMs >= this.policy.windowMs) {
      this.globalWindowStartedAtMs = now;
      this.globalRetriesInWindow = 0;
      this.generation += 1;
    }
  }

  private rollServiceWindows(now: number): void {
    for (const [key, state] of this.services) {
      if (now >= state.windowStartedAtMs && now - state.windowStartedAtMs >= this.policy.windowMs) {
        this.services.set(key, freezeState({ ...state, windowStartedAtMs: now, retriesInWindow: 0 }));
        this.generation += 1;
      }
    }
  }

  private backoff(attempt: number, retryClass: ArcGisRetryClass, seedValue: number): number {
    const exponent = Math.min(30, Math.max(0, attempt - 1));
    const raw = Math.min(this.policy.maxBackoffMs, this.policy.baseBackoffMs * (2 ** exponent));
    const classFactor = retryClass === 'interactive' ? 0.5 : retryClass === 'foreground' ? 1 : 1.5;
    const base = Math.min(this.policy.maxBackoffMs, Math.max(0, Math.floor(raw * classFactor)));
    const seed = nonNegative(seedValue, 'jitterSeed');
    const jitter = this.policy.maxJitterMs === 0 ? 0 : seed % (this.policy.maxJitterMs + 1);
    return Math.min(this.policy.maxBackoffMs, base + jitter);
  }

  private decision(admitted: boolean, reason: ArcGisRetryDecisionReason, retryAtMs: number | null, attempt: number): ArcGisRetryAdmission {
    return Object.freeze({ admitted, reason, retryAtMs, attempt });
  }

  private time(value: number): number {
    const now = nonNegative(value, 'timestampMs');
    if (now + this.policy.maxClockSkewMs < this.lastObservedAtMs) throw new Error('stale retry clock');
    this.lastObservedAtMs = Math.max(this.lastObservedAtMs, now);
    return now;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisServiceRetryBudgetCoordinator is disposed');
  }
}
