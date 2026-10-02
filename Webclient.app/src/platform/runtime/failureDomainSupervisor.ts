export type FailureDomainState = 'closed' | 'open' | 'half-open';
export type FailureSeverity = 'transient' | 'degraded' | 'fatal';

export interface FailureDomainPolicy {
  readonly failureThreshold: number;
  readonly successThreshold: number;
  readonly openDurationMs: number;
  readonly halfOpenMaxConcurrent: number;
  readonly rollingWindowMs: number;
  readonly maxDomains: number;
  readonly maxIdentifierLength: number;
}

export interface FailureDomainSupervisorOptions {
  readonly policy?: Partial<FailureDomainPolicy>;
  readonly now?: () => number;
}

export interface FailureDomainPermit {
  readonly domain: string;
  readonly generation: number;
  readonly probe: boolean;
  readonly acquiredAt: number;
}

export interface FailureDomainSnapshot {
  readonly domain: string;
  readonly state: FailureDomainState;
  readonly generation: number;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly rollingFailures: number;
  readonly activeProbes: number;
  readonly openedAt: number | null;
  readonly retryAt: number | null;
  readonly lastTransitionAt: number;
}

export interface SupervisorSnapshot {
  readonly disposed: boolean;
  readonly domainCount: number;
  readonly domains: readonly FailureDomainSnapshot[];
}

interface FailureEvent {
  readonly at: number;
  readonly severity: FailureSeverity;
}

interface DomainRecord {
  readonly domain: string;
  state: FailureDomainState;
  generation: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  activeProbes: number;
  openedAt: number | null;
  retryAt: number | null;
  lastTransitionAt: number;
  lastTouchedAt: number;
  failures: FailureEvent[];
}

const DEFAULT_POLICY: FailureDomainPolicy = Object.freeze({
  failureThreshold: 5,
  successThreshold: 2,
  openDurationMs: 15_000,
  halfOpenMaxConcurrent: 1,
  rollingWindowMs: 60_000,
  maxDomains: 256,
  maxIdentifierLength: 96,
});

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizePolicy(input: Partial<FailureDomainPolicy> | undefined): FailureDomainPolicy {
  return Object.freeze({
    failureThreshold: positiveInteger(input?.failureThreshold, DEFAULT_POLICY.failureThreshold),
    successThreshold: positiveInteger(input?.successThreshold, DEFAULT_POLICY.successThreshold),
    openDurationMs: nonNegativeInteger(input?.openDurationMs, DEFAULT_POLICY.openDurationMs),
    halfOpenMaxConcurrent: positiveInteger(input?.halfOpenMaxConcurrent, DEFAULT_POLICY.halfOpenMaxConcurrent),
    rollingWindowMs: positiveInteger(input?.rollingWindowMs, DEFAULT_POLICY.rollingWindowMs),
    maxDomains: positiveInteger(input?.maxDomains, DEFAULT_POLICY.maxDomains),
    maxIdentifierLength: positiveInteger(input?.maxIdentifierLength, DEFAULT_POLICY.maxIdentifierLength),
  });
}

function normalizeDomain(value: string, maxLength: number): string | null {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > maxLength) return null;
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(normalized)) return null;
  return normalized;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export class FailureDomainSupervisor {
  readonly #policy: FailureDomainPolicy;
  readonly #now: () => number;
  readonly #domains = new Map<string, DomainRecord>();
  #disposed = false;

  constructor(options: FailureDomainSupervisorOptions = {}) {
    this.#policy = normalizePolicy(options.policy);
    this.#now = options.now ?? Date.now;
  }

  get policy(): FailureDomainPolicy {
    return this.#policy;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  acquire(domain: string): FailureDomainPermit | null {
    if (this.#disposed) return null;
    const key = normalizeDomain(domain, this.#policy.maxIdentifierLength);
    if (!key) return null;
    const now = this.#time();
    const record = this.#getOrCreate(key, now);
    if (!record) return null;
    this.#prune(record, now);
    this.#advance(record, now);
    record.lastTouchedAt = now;
    if (record.state === 'open') return null;
    if (record.state === 'half-open') {
      if (record.activeProbes >= this.#policy.halfOpenMaxConcurrent) return null;
      record.activeProbes += 1;
      return Object.freeze({ domain: key, generation: record.generation, probe: true, acquiredAt: now });
    }
    return Object.freeze({ domain: key, generation: record.generation, probe: false, acquiredAt: now });
  }

  succeed(permit: FailureDomainPermit): boolean {
    if (this.#disposed) return false;
    const record = this.#domains.get(permit.domain);
    if (!record || permit.generation !== record.generation) return false;
    const now = this.#time();
    this.#prune(record, now);
    if (permit.probe) {
      if (record.state !== 'half-open' || record.activeProbes < 1) return false;
      record.activeProbes -= 1;
      record.consecutiveSuccesses += 1;
      record.consecutiveFailures = 0;
      if (record.consecutiveSuccesses >= this.#policy.successThreshold) this.#close(record, now);
    } else if (record.state === 'closed') {
      record.consecutiveSuccesses += 1;
      record.consecutiveFailures = 0;
    } else {
      return false;
    }
    record.lastTouchedAt = now;
    return true;
  }

  fail(permit: FailureDomainPermit, severity: FailureSeverity = 'transient'): boolean {
    if (this.#disposed) return false;
    const record = this.#domains.get(permit.domain);
    if (!record || permit.generation !== record.generation) return false;
    const now = this.#time();
    this.#prune(record, now);
    if (permit.probe) {
      if (record.state !== 'half-open' || record.activeProbes < 1) return false;
      record.activeProbes -= 1;
    } else if (record.state !== 'closed') {
      return false;
    }
    record.failures.push({ at: now, severity });
    record.consecutiveFailures += 1;
    record.consecutiveSuccesses = 0;
    record.lastTouchedAt = now;
    if (severity === 'fatal' || permit.probe || record.consecutiveFailures >= this.#policy.failureThreshold) {
      this.#open(record, now);
    }
    return true;
  }

  cancel(permit: FailureDomainPermit): boolean {
    if (this.#disposed || !permit.probe) return false;
    const record = this.#domains.get(permit.domain);
    if (!record || permit.generation !== record.generation || record.state !== 'half-open' || record.activeProbes < 1) return false;
    record.activeProbes -= 1;
    record.lastTouchedAt = this.#time();
    return true;
  }

  forceOpen(domain: string): boolean {
    if (this.#disposed) return false;
    const key = normalizeDomain(domain, this.#policy.maxIdentifierLength);
    if (!key) return false;
    const now = this.#time();
    const record = this.#getOrCreate(key, now);
    if (!record) return false;
    this.#open(record, now);
    return true;
  }

  reset(domain: string): boolean {
    if (this.#disposed) return false;
    const key = normalizeDomain(domain, this.#policy.maxIdentifierLength);
    if (!key) return false;
    const record = this.#domains.get(key);
    if (!record) return false;
    this.#close(record, this.#time());
    return true;
  }

  retire(domain: string): boolean {
    if (this.#disposed) return false;
    const key = normalizeDomain(domain, this.#policy.maxIdentifierLength);
    if (!key) return false;
    return this.#domains.delete(key);
  }

  sweep(): number {
    if (this.#disposed) return 0;
    const now = this.#time();
    let transitions = 0;
    for (const record of this.#domains.values()) {
      this.#prune(record, now);
      if (record.state === 'open' && record.retryAt !== null && now >= record.retryAt) {
        this.#halfOpen(record, now);
        transitions += 1;
      }
    }
    return transitions;
  }

  snapshot(): SupervisorSnapshot {
    const now = this.#time();
    const domains: FailureDomainSnapshot[] = [];
    for (const record of this.#domains.values()) {
      this.#prune(record, now);
      this.#advance(record, now);
      domains.push(Object.freeze({
        domain: record.domain,
        state: record.state,
        generation: record.generation,
        consecutiveFailures: record.consecutiveFailures,
        consecutiveSuccesses: record.consecutiveSuccesses,
        rollingFailures: record.failures.length,
        activeProbes: record.activeProbes,
        openedAt: record.openedAt,
        retryAt: record.retryAt,
        lastTransitionAt: record.lastTransitionAt,
      }));
    }
    domains.sort((left, right) => left.domain.localeCompare(right.domain));
    return Object.freeze({ disposed: this.#disposed, domainCount: domains.length, domains: Object.freeze(domains) });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#domains.clear();
  }

  #time(): number {
    return finiteTime(this.#now());
  }

  #getOrCreate(domain: string, now: number): DomainRecord | null {
    const existing = this.#domains.get(domain);
    if (existing) return existing;
    if (this.#domains.size >= this.#policy.maxDomains) this.#evictOne();
    if (this.#domains.size >= this.#policy.maxDomains) return null;
    const created: DomainRecord = {
      domain,
      state: 'closed',
      generation: 1,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      activeProbes: 0,
      openedAt: null,
      retryAt: null,
      lastTransitionAt: now,
      lastTouchedAt: now,
      failures: [],
    };
    this.#domains.set(domain, created);
    return created;
  }

  #evictOne(): void {
    let candidate: DomainRecord | null = null;
    for (const record of this.#domains.values()) {
      if (record.activeProbes > 0) continue;
      if (!candidate || record.lastTouchedAt < candidate.lastTouchedAt ||
          (record.lastTouchedAt === candidate.lastTouchedAt && record.domain.localeCompare(candidate.domain) < 0)) {
        candidate = record;
      }
    }
    if (candidate) this.#domains.delete(candidate.domain);
  }

  #prune(record: DomainRecord, now: number): void {
    const cutoff = now - this.#policy.rollingWindowMs;
    let firstLive = 0;
    while (firstLive < record.failures.length && record.failures[firstLive]!.at < cutoff) firstLive += 1;
    if (firstLive > 0) record.failures.splice(0, firstLive);
  }

  #advance(record: DomainRecord, now: number): void {
    if (record.state === 'open' && record.retryAt !== null && now >= record.retryAt) this.#halfOpen(record, now);
  }

  #open(record: DomainRecord, now: number): void {
    record.state = 'open';
    record.generation += 1;
    record.activeProbes = 0;
    record.consecutiveSuccesses = 0;
    record.openedAt = now;
    record.retryAt = now + this.#policy.openDurationMs;
    record.lastTransitionAt = now;
    record.lastTouchedAt = now;
  }

  #halfOpen(record: DomainRecord, now: number): void {
    record.state = 'half-open';
    record.generation += 1;
    record.activeProbes = 0;
    record.consecutiveFailures = 0;
    record.consecutiveSuccesses = 0;
    record.lastTransitionAt = now;
    record.lastTouchedAt = now;
  }

  #close(record: DomainRecord, now: number): void {
    record.state = 'closed';
    record.generation += 1;
    record.activeProbes = 0;
    record.consecutiveFailures = 0;
    record.consecutiveSuccesses = 0;
    record.openedAt = null;
    record.retryAt = null;
    record.failures.length = 0;
    record.lastTransitionAt = now;
    record.lastTouchedAt = now;
  }
}

export function createFailureDomainSupervisor(options: FailureDomainSupervisorOptions = {}): FailureDomainSupervisor {
  return new FailureDomainSupervisor(options);
}
