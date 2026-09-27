export type ArcGisDedupePriority = 'interactive' | 'foreground' | 'background';

export interface ArcGisServiceRequestDedupePolicy {
  readonly maxEntries: number;
  readonly maxSubscribersPerEntry: number;
  readonly maxFingerprintLength: number;
  readonly maxServiceKeyLength: number;
  readonly maxSubscriberIdLength: number;
  readonly maxRequestAgeMs: number;
  readonly maxSettledRetentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisDedupeSubscriber {
  readonly subscriberId: string;
  readonly priority: ArcGisDedupePriority;
  readonly joinedAtMs: number;
}

export interface ArcGisDedupeEntry {
  readonly fingerprint: string;
  readonly serviceKey: string;
  readonly ownerRequestId: string;
  readonly createdAtMs: number;
  readonly settledAtMs: number | null;
  readonly outcome: 'pending' | 'fulfilled' | 'rejected' | 'cancelled';
  readonly subscribers: readonly ArcGisDedupeSubscriber[];
}

export interface ArcGisDedupeJoinResult {
  readonly fingerprint: string;
  readonly ownerRequestId: string;
  readonly joined: boolean;
  readonly owner: boolean;
  readonly reason: 'owner' | 'joined' | 'settled' | 'capacity' | 'subscriber-capacity';
}

export interface ArcGisServiceRequestDedupeSnapshot {
  readonly generation: number;
  readonly entries: readonly ArcGisDedupeEntry[];
}

const safePositive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
};

const safeNonNegative = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
};

const boundedText = (value: string, maxLength: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const priorityRank = (value: ArcGisDedupePriority): number => value === 'interactive' ? 0 : value === 'foreground' ? 1 : 2;
const freezeSubscriber = (value: ArcGisDedupeSubscriber): ArcGisDedupeSubscriber => Object.freeze({ ...value });
const freezeEntry = (value: ArcGisDedupeEntry): ArcGisDedupeEntry => Object.freeze({ ...value, subscribers: Object.freeze(value.subscribers.map(freezeSubscriber)) });

/**
 * Primitive-only single-flight authority for already-governed ArcGIS REST adapters.
 * It never owns fetch promises, AbortControllers, response bodies, credentials, URLs,
 * ArcGIS SDK objects, timers or transports. Adapters retain those runtime resources.
 */
export class ArcGisServiceRequestDedupeCoordinator {
  private readonly policy: Readonly<ArcGisServiceRequestDedupePolicy>;
  private readonly entries = new Map<string, ArcGisDedupeEntry>();
  private generation = 0;
  private disposed = false;
  private lastObservedAtMs = 0;

  constructor(policy: ArcGisServiceRequestDedupePolicy) {
    this.policy = Object.freeze({
      maxEntries: safePositive(policy.maxEntries, 'maxEntries'),
      maxSubscribersPerEntry: safePositive(policy.maxSubscribersPerEntry, 'maxSubscribersPerEntry'),
      maxFingerprintLength: safePositive(policy.maxFingerprintLength, 'maxFingerprintLength'),
      maxServiceKeyLength: safePositive(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxSubscriberIdLength: safePositive(policy.maxSubscriberIdLength, 'maxSubscriberIdLength'),
      maxRequestAgeMs: safePositive(policy.maxRequestAgeMs, 'maxRequestAgeMs'),
      maxSettledRetentionMs: safePositive(policy.maxSettledRetentionMs, 'maxSettledRetentionMs'),
      maxClockSkewMs: safePositive(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  join(
    fingerprintValue: string,
    serviceKeyValue: string,
    requestIdValue: string,
    subscriberIdValue: string,
    priority: ArcGisDedupePriority,
    timestampMs: number,
  ): ArcGisDedupeJoinResult {
    this.assertUsable();
    const now = this.time(timestampMs);
    this.prune(now);
    const fingerprint = boundedText(fingerprintValue, this.policy.maxFingerprintLength, 'fingerprint');
    const serviceKey = boundedText(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const requestId = boundedText(requestIdValue, 128, 'request id');
    const subscriberId = boundedText(subscriberIdValue, this.policy.maxSubscriberIdLength, 'subscriber id');
    this.assertPriority(priority);

    const existing = this.entries.get(fingerprint);
    if (existing) {
      if (existing.serviceKey !== serviceKey) throw new Error('fingerprint cannot cross service boundaries');
      if (existing.outcome !== 'pending') return this.result(existing, false, false, 'settled');
      if (existing.subscribers.some(item => item.subscriberId === subscriberId)) throw new Error('duplicate subscriber id');
      if (existing.subscribers.length >= this.policy.maxSubscribersPerEntry) return this.result(existing, false, false, 'subscriber-capacity');
      const subscribers = this.sortSubscribers([...existing.subscribers, freezeSubscriber({ subscriberId, priority, joinedAtMs: now })]);
      const updated = freezeEntry({ ...existing, subscribers });
      this.entries.set(fingerprint, updated);
      this.generation += 1;
      return this.result(updated, true, false, 'joined');
    }

    if (this.entries.size >= this.policy.maxEntries && !this.evictOne()) return Object.freeze({ fingerprint, ownerRequestId: requestId, joined: false, owner: false, reason: 'capacity' });
    const ownerSubscriber = freezeSubscriber({ subscriberId, priority, joinedAtMs: now });
    const entry = freezeEntry({ fingerprint, serviceKey, ownerRequestId: requestId, createdAtMs: now, settledAtMs: null, outcome: 'pending', subscribers: [ownerSubscriber] });
    this.entries.set(fingerprint, entry);
    this.generation += 1;
    return this.result(entry, true, true, 'owner');
  }

  leave(fingerprintValue: string, subscriberIdValue: string, timestampMs: number): boolean {
    this.assertUsable();
    const now = this.time(timestampMs);
    this.prune(now);
    const fingerprint = boundedText(fingerprintValue, this.policy.maxFingerprintLength, 'fingerprint');
    const subscriberId = boundedText(subscriberIdValue, this.policy.maxSubscriberIdLength, 'subscriber id');
    const existing = this.entries.get(fingerprint);
    if (!existing || existing.outcome !== 'pending') return false;
    const subscribers = existing.subscribers.filter(item => item.subscriberId !== subscriberId);
    if (subscribers.length === existing.subscribers.length) return false;
    if (subscribers.length === 0) {
      this.entries.set(fingerprint, freezeEntry({ ...existing, subscribers: [], outcome: 'cancelled', settledAtMs: now }));
    } else {
      this.entries.set(fingerprint, freezeEntry({ ...existing, subscribers: this.sortSubscribers(subscribers) }));
    }
    this.generation += 1;
    return true;
  }

  settle(fingerprintValue: string, outcome: 'fulfilled' | 'rejected' | 'cancelled', timestampMs: number): readonly ArcGisDedupeSubscriber[] {
    this.assertUsable();
    const now = this.time(timestampMs);
    this.prune(now);
    const fingerprint = boundedText(fingerprintValue, this.policy.maxFingerprintLength, 'fingerprint');
    const existing = this.entries.get(fingerprint);
    if (!existing) throw new Error('dedupe entry not found');
    if (existing.outcome !== 'pending') throw new Error('dedupe entry already settled');
    const updated = freezeEntry({ ...existing, outcome, settledAtMs: now });
    this.entries.set(fingerprint, updated);
    this.generation += 1;
    return Object.freeze(updated.subscribers.map(freezeSubscriber));
  }

  snapshot(timestampMs: number): ArcGisServiceRequestDedupeSnapshot {
    this.assertUsable();
    this.prune(this.time(timestampMs));
    const entries = [...this.entries.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.fingerprint.localeCompare(b.fingerprint))
      .map(freezeEntry);
    return Object.freeze({ generation: this.generation, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisServiceRequestDedupeSnapshot, 'entries'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.time(timestampMs);
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxEntries) throw new Error('invalid dedupe snapshot capacity');
    const next = new Map<string, ArcGisDedupeEntry>();
    for (const raw of snapshot.entries) {
      const entry = this.validateEntry(raw, now);
      if (next.has(entry.fingerprint)) throw new Error('duplicate fingerprint in snapshot');
      if (entry.outcome !== 'pending' && entry.settledAtMs !== null && now - entry.settledAtMs > this.policy.maxSettledRetentionMs) continue;
      if (entry.outcome === 'pending' && now - entry.createdAtMs > this.policy.maxRequestAgeMs) continue;
      next.set(entry.fingerprint, entry);
    }
    this.entries.clear();
    for (const [fingerprint, entry] of next) this.entries.set(fingerprint, entry);
    this.lastObservedAtMs = now;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.generation += 1;
  }

  private validateEntry(raw: ArcGisDedupeEntry, now: number): ArcGisDedupeEntry {
    const fingerprint = boundedText(raw.fingerprint, this.policy.maxFingerprintLength, 'fingerprint');
    const serviceKey = boundedText(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key');
    const ownerRequestId = boundedText(raw.ownerRequestId, 128, 'owner request id');
    const createdAtMs = safeNonNegative(raw.createdAtMs, 'createdAtMs');
    if (createdAtMs > now + this.policy.maxClockSkewMs) throw new Error('future dedupe entry');
    if (raw.outcome !== 'pending' && raw.outcome !== 'fulfilled' && raw.outcome !== 'rejected' && raw.outcome !== 'cancelled') throw new Error('invalid dedupe outcome');
    if (!Array.isArray(raw.subscribers) || raw.subscribers.length > this.policy.maxSubscribersPerEntry) throw new Error('invalid subscriber capacity');
    const ids = new Set<string>();
    const subscribers = raw.subscribers.map(item => {
      const subscriberId = boundedText(item.subscriberId, this.policy.maxSubscriberIdLength, 'subscriber id');
      this.assertPriority(item.priority);
      const joinedAtMs = safeNonNegative(item.joinedAtMs, 'joinedAtMs');
      if (joinedAtMs < createdAtMs || joinedAtMs > now + this.policy.maxClockSkewMs) throw new Error('invalid subscriber timestamp');
      if (ids.has(subscriberId)) throw new Error('duplicate subscriber in snapshot');
      ids.add(subscriberId);
      return freezeSubscriber({ subscriberId, priority: item.priority, joinedAtMs });
    });
    const settledAtMs = raw.settledAtMs === null ? null : safeNonNegative(raw.settledAtMs, 'settledAtMs');
    if (raw.outcome === 'pending' && settledAtMs !== null) throw new Error('pending entry cannot be settled');
    if (raw.outcome !== 'pending' && settledAtMs === null) throw new Error('terminal entry requires settledAtMs');
    if (settledAtMs !== null && (settledAtMs < createdAtMs || settledAtMs > now + this.policy.maxClockSkewMs)) throw new Error('invalid settlement timestamp');
    return freezeEntry({ fingerprint, serviceKey, ownerRequestId, createdAtMs, settledAtMs, outcome: raw.outcome, subscribers: this.sortSubscribers(subscribers) });
  }

  private evictOne(): boolean {
    const terminal = [...this.entries.values()]
      .filter(item => item.outcome !== 'pending')
      .sort((a, b) => (a.settledAtMs ?? 0) - (b.settledAtMs ?? 0) || a.fingerprint.localeCompare(b.fingerprint))[0];
    if (!terminal) return false;
    this.entries.delete(terminal.fingerprint);
    this.generation += 1;
    return true;
  }

  private prune(now: number): void {
    let changed = false;
    for (const [fingerprint, entry] of this.entries) {
      const expiredPending = entry.outcome === 'pending' && now > entry.createdAtMs && now - entry.createdAtMs > this.policy.maxRequestAgeMs;
      const expiredSettled = entry.outcome !== 'pending' && entry.settledAtMs !== null && now > entry.settledAtMs && now - entry.settledAtMs > this.policy.maxSettledRetentionMs;
      if (expiredPending || expiredSettled) { this.entries.delete(fingerprint); changed = true; }
    }
    if (changed) this.generation += 1;
  }

  private sortSubscribers(values: readonly ArcGisDedupeSubscriber[]): readonly ArcGisDedupeSubscriber[] {
    return Object.freeze([...values].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.joinedAtMs - b.joinedAtMs || a.subscriberId.localeCompare(b.subscriberId)).map(freezeSubscriber));
  }

  private result(entry: ArcGisDedupeEntry, joined: boolean, owner: boolean, reason: ArcGisDedupeJoinResult['reason']): ArcGisDedupeJoinResult {
    return Object.freeze({ fingerprint: entry.fingerprint, ownerRequestId: entry.ownerRequestId, joined, owner, reason });
  }

  private assertPriority(value: ArcGisDedupePriority): void {
    if (value !== 'interactive' && value !== 'foreground' && value !== 'background') throw new Error('invalid dedupe priority');
  }

  private time(value: number): number {
    const now = safeNonNegative(value, 'timestampMs');
    if (now + this.policy.maxClockSkewMs < this.lastObservedAtMs) throw new Error('stale dedupe clock');
    this.lastObservedAtMs = Math.max(this.lastObservedAtMs, now);
    return now;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisServiceRequestDedupeCoordinator is disposed');
  }
}
