export type ArcGisFreshnessClass = 'configuration' | 'metadata' | 'features' | 'tiles';
export type ArcGisFreshnessState = 'fresh' | 'stale' | 'expired' | 'missing';

export interface ArcGisServiceFreshnessPolicy {
  readonly maxEntries: number;
  readonly maxEntriesPerService: number;
  readonly maxServiceKeyLength: number;
  readonly maxResourceKeyLength: number;
  readonly maxEtagLength: number;
  readonly maxAgeMs: number;
  readonly maxStaleMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisServiceFreshnessObservation {
  readonly serviceKey: string;
  readonly resourceKey: string;
  readonly freshnessClass: ArcGisFreshnessClass;
  readonly observedAtMs: number;
  readonly validatedAtMs: number;
  readonly expiresAtMs: number;
  readonly staleUntilMs: number;
  readonly revision: number;
  readonly etag: string | null;
}

export interface ArcGisServiceFreshnessDecision {
  readonly state: ArcGisFreshnessState;
  readonly mayServe: boolean;
  readonly shouldRevalidate: boolean;
  readonly revision: number | null;
  readonly ageMs: number | null;
}

export interface ArcGisServiceFreshnessSnapshot {
  readonly generation: number;
  readonly entries: readonly ArcGisServiceFreshnessObservation[];
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedText = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const freezeObservation = (value: ArcGisServiceFreshnessObservation): ArcGisServiceFreshnessObservation => Object.freeze({ ...value });

/**
 * Primitive-only freshness/revalidation authority for verified ArcGIS REST adapters.
 * It owns no response body, URL, request, credential, timer, Promise or SDK object.
 */
export class ArcGisServiceFreshnessCoordinator {
  private readonly policy: Readonly<ArcGisServiceFreshnessPolicy>;
  private readonly entries = new Map<string, ArcGisServiceFreshnessObservation>();
  private generation = 0;
  private lastObservedAtMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceFreshnessPolicy) {
    const maxAgeMs = integer(policy.maxAgeMs, 'maxAgeMs');
    const maxStaleMs = integer(policy.maxStaleMs, 'maxStaleMs', true);
    this.policy = Object.freeze({
      maxEntries: integer(policy.maxEntries, 'maxEntries'),
      maxEntriesPerService: integer(policy.maxEntriesPerService, 'maxEntriesPerService'),
      maxServiceKeyLength: integer(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxResourceKeyLength: integer(policy.maxResourceKeyLength, 'maxResourceKeyLength'),
      maxEtagLength: integer(policy.maxEtagLength, 'maxEtagLength'),
      maxAgeMs,
      maxStaleMs,
      maxClockSkewMs: integer(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
    if (this.policy.maxEntriesPerService > this.policy.maxEntries) throw new Error('per-service capacity cannot exceed global capacity');
  }

  observe(input: {
    readonly serviceKey: string;
    readonly resourceKey: string;
    readonly freshnessClass: ArcGisFreshnessClass;
    readonly observedAtMs: number;
    readonly maxAgeMs?: number;
    readonly staleMs?: number;
    readonly etag?: string | null;
  }): ArcGisServiceFreshnessObservation {
    this.assertUsable();
    const now = this.time(input.observedAtMs);
    const serviceKey = boundedText(input.serviceKey, this.policy.maxServiceKeyLength, 'service key');
    const resourceKey = boundedText(input.resourceKey, this.policy.maxResourceKeyLength, 'resource key');
    this.assertClass(input.freshnessClass);
    const maxAgeMs = input.maxAgeMs === undefined ? this.policy.maxAgeMs : integer(input.maxAgeMs, 'maxAgeMs');
    const staleMs = input.staleMs === undefined ? this.policy.maxStaleMs : integer(input.staleMs, 'staleMs', true);
    if (maxAgeMs > this.policy.maxAgeMs || staleMs > this.policy.maxStaleMs) throw new Error('freshness duration exceeds policy');
    const etag = input.etag == null ? null : boundedText(input.etag, this.policy.maxEtagLength, 'etag');
    const key = this.key(serviceKey, resourceKey);
    const previous = this.entries.get(key);
    const revision = previous ? previous.revision + 1 : 1;
    if (!Number.isSafeInteger(revision)) throw new Error('freshness revision overflow');
    const expiresAtMs = now + maxAgeMs;
    const staleUntilMs = expiresAtMs + staleMs;
    if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(staleUntilMs)) throw new Error('freshness timestamp overflow');
    if (!previous) this.ensureCapacity(serviceKey);
    const observation = freezeObservation({ serviceKey, resourceKey, freshnessClass: input.freshnessClass, observedAtMs: now, validatedAtMs: now, expiresAtMs, staleUntilMs, revision, etag });
    this.entries.set(key, observation);
    this.generation += 1;
    return observation;
  }

  validate(serviceKeyValue: string, resourceKeyValue: string, timestampMs: number, etag?: string | null): ArcGisServiceFreshnessObservation {
    this.assertUsable();
    const now = this.time(timestampMs);
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const resourceKey = boundedText(resourceKeyValue, this.policy.maxResourceKeyLength, 'resource key');
    const key = this.key(serviceKey, resourceKey);
    const current = this.entries.get(key);
    if (!current) throw new Error('freshness entry not found');
    if (now < current.observedAtMs) throw new Error('validation clock inversion');
    const nextEtag = etag === undefined ? current.etag : etag === null ? null : boundedText(etag, this.policy.maxEtagLength, 'etag');
    const lifetime = current.expiresAtMs - current.observedAtMs;
    const staleLifetime = current.staleUntilMs - current.expiresAtMs;
    const expiresAtMs = now + lifetime;
    const staleUntilMs = expiresAtMs + staleLifetime;
    if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(staleUntilMs)) throw new Error('freshness timestamp overflow');
    const next = freezeObservation({ ...current, validatedAtMs: now, expiresAtMs, staleUntilMs, revision: current.revision + 1, etag: nextEtag });
    if (!Number.isSafeInteger(next.revision)) throw new Error('freshness revision overflow');
    this.entries.set(key, next);
    this.generation += 1;
    return next;
  }

  decide(serviceKeyValue: string, resourceKeyValue: string, timestampMs: number): ArcGisServiceFreshnessDecision {
    this.assertUsable();
    const now = this.time(timestampMs);
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const resourceKey = boundedText(resourceKeyValue, this.policy.maxResourceKeyLength, 'resource key');
    const current = this.entries.get(this.key(serviceKey, resourceKey));
    if (!current) return Object.freeze({ state: 'missing', mayServe: false, shouldRevalidate: true, revision: null, ageMs: null });
    if (now < current.observedAtMs) throw new Error('freshness clock inversion');
    const ageMs = now - current.observedAtMs;
    if (now < current.expiresAtMs) return Object.freeze({ state: 'fresh', mayServe: true, shouldRevalidate: false, revision: current.revision, ageMs });
    if (now <= current.staleUntilMs) return Object.freeze({ state: 'stale', mayServe: true, shouldRevalidate: true, revision: current.revision, ageMs });
    return Object.freeze({ state: 'expired', mayServe: false, shouldRevalidate: true, revision: current.revision, ageMs });
  }

  invalidateService(serviceKeyValue: string): number {
    this.assertUsable();
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    let removed = 0;
    for (const [key, entry] of this.entries) if (entry.serviceKey === serviceKey) { this.entries.delete(key); removed += 1; }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  prune(timestampMs: number): number {
    this.assertUsable();
    const now = this.time(timestampMs);
    let removed = 0;
    for (const [key, entry] of this.entries) if (now > entry.staleUntilMs) { this.entries.delete(key); removed += 1; }
    if (removed > 0) this.generation += 1;
    return removed;
  }

  snapshot(timestampMs: number): ArcGisServiceFreshnessSnapshot {
    this.assertUsable();
    this.time(timestampMs);
    const entries = [...this.entries.values()].sort((a, b) => a.serviceKey.localeCompare(b.serviceKey) || a.resourceKey.localeCompare(b.resourceKey)).map(freezeObservation);
    return Object.freeze({ generation: this.generation, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisServiceFreshnessSnapshot, 'entries'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.time(timestampMs);
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxEntries) throw new Error('invalid freshness capacity');
    const next = new Map<string, ArcGisServiceFreshnessObservation>();
    const perService = new Map<string, number>();
    for (const raw of snapshot.entries) {
      const serviceKey = boundedText(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key');
      const resourceKey = boundedText(raw.resourceKey, this.policy.maxResourceKeyLength, 'resource key');
      this.assertClass(raw.freshnessClass);
      const observedAtMs = integer(raw.observedAtMs, 'observedAtMs', true);
      const validatedAtMs = integer(raw.validatedAtMs, 'validatedAtMs', true);
      const expiresAtMs = integer(raw.expiresAtMs, 'expiresAtMs', true);
      const staleUntilMs = integer(raw.staleUntilMs, 'staleUntilMs', true);
      const revision = integer(raw.revision, 'revision');
      if (observedAtMs > now + this.policy.maxClockSkewMs || validatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future freshness timestamp');
      if (validatedAtMs < observedAtMs || expiresAtMs < validatedAtMs || staleUntilMs < expiresAtMs) throw new Error('invalid freshness chronology');
      if (expiresAtMs - validatedAtMs > this.policy.maxAgeMs || staleUntilMs - expiresAtMs > this.policy.maxStaleMs) throw new Error('freshness duration exceeds policy');
      const etag = raw.etag === null ? null : boundedText(raw.etag, this.policy.maxEtagLength, 'etag');
      const key = this.key(serviceKey, resourceKey);
      if (next.has(key)) throw new Error('duplicate freshness entry');
      const count = (perService.get(serviceKey) ?? 0) + 1;
      if (count > this.policy.maxEntriesPerService) throw new Error('per-service freshness capacity exceeded');
      perService.set(serviceKey, count);
      next.set(key, freezeObservation({ serviceKey, resourceKey, freshnessClass: raw.freshnessClass, observedAtMs, validatedAtMs, expiresAtMs, staleUntilMs, revision, etag }));
    }
    this.entries.clear();
    for (const [key, value] of next) this.entries.set(key, value);
    this.lastObservedAtMs = now;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.generation += 1;
  }

  private ensureCapacity(serviceKey: string): void {
    while ([...this.entries.values()].filter((entry) => entry.serviceKey === serviceKey).length >= this.policy.maxEntriesPerService) this.evict((entry) => entry.serviceKey === serviceKey);
    while (this.entries.size >= this.policy.maxEntries) this.evict(() => true);
  }

  private evict(predicate: (entry: ArcGisServiceFreshnessObservation) => boolean): void {
    const candidate = [...this.entries.values()].filter(predicate).sort((a, b) => a.validatedAtMs - b.validatedAtMs || a.observedAtMs - b.observedAtMs || a.serviceKey.localeCompare(b.serviceKey) || a.resourceKey.localeCompare(b.resourceKey))[0];
    if (!candidate) throw new Error('freshness capacity invariant failed');
    this.entries.delete(this.key(candidate.serviceKey, candidate.resourceKey));
    this.generation += 1;
  }

  private key(serviceKey: string, resourceKey: string): string { return `${serviceKey}\u0001${resourceKey}`; }

  private assertClass(value: string): asserts value is ArcGisFreshnessClass {
    if (value !== 'configuration' && value !== 'metadata' && value !== 'features' && value !== 'tiles') throw new Error('invalid freshness class');
  }

  private time(value: number): number {
    const now = integer(value, 'timestampMs', true);
    if (now + this.policy.maxClockSkewMs < this.lastObservedAtMs) throw new Error('stale freshness clock');
    this.lastObservedAtMs = Math.max(this.lastObservedAtMs, now);
    return now;
  }

  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisServiceFreshnessCoordinator is disposed'); }
}
