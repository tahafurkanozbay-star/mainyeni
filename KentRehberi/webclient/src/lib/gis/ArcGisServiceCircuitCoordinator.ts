export type ArcGisCircuitState = 'closed' | 'open' | 'half-open';
export type ArcGisCircuitOutcome = 'success' | 'failure';

export interface ArcGisServiceCircuitPolicy {
  readonly maxServices: number;
  readonly maxServiceKeyLength: number;
  readonly failureThreshold: number;
  readonly successThreshold: number;
  readonly openDurationMs: number;
  readonly maxOpenDurationMs: number;
  readonly backoffMultiplier: number;
  readonly maxClockSkewMs: number;
  readonly retentionMs: number;
}

export interface ArcGisServiceCircuitSnapshotItem {
  readonly serviceKey: string;
  readonly state: ArcGisCircuitState;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly openedAtMs: number | null;
  readonly retryAtMs: number | null;
  readonly lastObservedAtMs: number;
  readonly openCount: number;
  readonly revision: number;
}

export interface ArcGisServiceCircuitSnapshot {
  readonly generation: number;
  readonly circuits: readonly ArcGisServiceCircuitSnapshotItem[];
}

export interface ArcGisCircuitAdmission {
  readonly serviceKey: string;
  readonly admitted: boolean;
  readonly state: ArcGisCircuitState;
  readonly retryAtMs: number | null;
  readonly revision: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}

function boundedKey(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('service key must be a string');
  const key = value.trim();
  if (!key || key.length > maxLength || key.includes('\0')) throw new Error('service key outside configured bounds');
  return key;
}

function freezeItem(item: ArcGisServiceCircuitSnapshotItem): ArcGisServiceCircuitSnapshotItem {
  return Object.freeze({ ...item });
}

/**
 * Primitive-only circuit state for already-governed ArcGIS service adapters.
 * This class intentionally owns no URL, fetch/request object, timer, response,
 * credential, ArcGIS Layer or LayerView. Callers decide how admitted work is
 * transported and feed only bounded outcomes back into this authority.
 */
export class ArcGisServiceCircuitCoordinator {
  private readonly policy: Readonly<ArcGisServiceCircuitPolicy>;
  private readonly circuits = new Map<string, ArcGisServiceCircuitSnapshotItem>();
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceCircuitPolicy) {
    this.policy = Object.freeze({
      maxServices: positiveInteger(policy.maxServices, 'maxServices'),
      maxServiceKeyLength: positiveInteger(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      failureThreshold: positiveInteger(policy.failureThreshold, 'failureThreshold'),
      successThreshold: positiveInteger(policy.successThreshold, 'successThreshold'),
      openDurationMs: positiveInteger(policy.openDurationMs, 'openDurationMs'),
      maxOpenDurationMs: positiveInteger(policy.maxOpenDurationMs, 'maxOpenDurationMs'),
      backoffMultiplier: finiteNonNegative(policy.backoffMultiplier, 'backoffMultiplier'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
    });
    if (this.policy.backoffMultiplier < 1) throw new Error('backoffMultiplier must be >= 1');
    if (this.policy.openDurationMs > this.policy.maxOpenDurationMs) throw new Error('openDurationMs cannot exceed maxOpenDurationMs');
  }

  admit(serviceKeyValue: string, timestampMs: number): ArcGisCircuitAdmission {
    this.assertUsable();
    const now = finiteNonNegative(timestampMs, 'timestampMs');
    const serviceKey = boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength);
    this.prune(now);
    const existing = this.circuits.get(serviceKey);
    if (!existing) return Object.freeze({ serviceKey, admitted: true, state: 'closed', retryAtMs: null, revision: 0 });
    this.assertFresh(existing, now);
    if (existing.state !== 'open') {
      return Object.freeze({ serviceKey, admitted: true, state: existing.state, retryAtMs: existing.retryAtMs, revision: existing.revision });
    }
    if (existing.retryAtMs === null || now < existing.retryAtMs) {
      return Object.freeze({ serviceKey, admitted: false, state: 'open', retryAtMs: existing.retryAtMs, revision: existing.revision });
    }
    const halfOpen = freezeItem({
      ...existing,
      state: 'half-open',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      retryAtMs: null,
      lastObservedAtMs: now,
      revision: existing.revision + 1,
    });
    this.circuits.set(serviceKey, halfOpen);
    this.generation += 1;
    return Object.freeze({ serviceKey, admitted: true, state: 'half-open', retryAtMs: null, revision: halfOpen.revision });
  }

  record(serviceKeyValue: string, outcome: ArcGisCircuitOutcome, timestampMs: number): ArcGisServiceCircuitSnapshotItem {
    this.assertUsable();
    const now = finiteNonNegative(timestampMs, 'timestampMs');
    const serviceKey = boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength);
    if (outcome !== 'success' && outcome !== 'failure') throw new Error('invalid circuit outcome');
    this.prune(now);
    const existing = this.circuits.get(serviceKey);
    if (existing) this.assertFresh(existing, now);
    const current = existing ?? freezeItem({ serviceKey, state: 'closed', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: now, openCount: 0, revision: 0 });
    const next = outcome === 'success' ? this.onSuccess(current, now) : this.onFailure(current, now);
    this.circuits.set(serviceKey, next);
    this.enforceCapacity(serviceKey);
    this.generation += 1;
    return next;
  }

  get(serviceKeyValue: string, timestampMs: number): ArcGisServiceCircuitSnapshotItem | null {
    this.assertUsable();
    const now = finiteNonNegative(timestampMs, 'timestampMs');
    this.prune(now);
    return this.circuits.get(boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength)) ?? null;
  }

  snapshot(timestampMs: number): ArcGisServiceCircuitSnapshot {
    this.assertUsable();
    this.prune(finiteNonNegative(timestampMs, 'timestampMs'));
    const circuits = [...this.circuits.values()]
      .sort((a, b) => a.lastObservedAtMs - b.lastObservedAtMs || a.serviceKey.localeCompare(b.serviceKey))
      .map(freezeItem);
    return Object.freeze({ generation: this.generation, circuits: Object.freeze(circuits) });
  }

  restore(snapshot: Pick<ArcGisServiceCircuitSnapshot, 'circuits'>, timestampMs: number): void {
    this.assertUsable();
    const now = finiteNonNegative(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.circuits) || snapshot.circuits.length > this.policy.maxServices) throw new Error('circuit snapshot exceeds capacity');
    const replacement = new Map<string, ArcGisServiceCircuitSnapshotItem>();
    for (const raw of snapshot.circuits) {
      const item = this.validateRestored(raw, now);
      if (replacement.has(item.serviceKey)) throw new Error('duplicate service key in circuit snapshot');
      if (now - item.lastObservedAtMs <= this.policy.retentionMs) replacement.set(item.serviceKey, item);
    }
    this.circuits.clear();
    for (const [key, item] of replacement) this.circuits.set(key, item);
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.circuits.clear();
    this.generation += 1;
  }

  private onSuccess(current: ArcGisServiceCircuitSnapshotItem, now: number): ArcGisServiceCircuitSnapshotItem {
    if (current.state === 'open') throw new Error('cannot record outcome while circuit admission is denied');
    if (current.state === 'closed') {
      return freezeItem({ ...current, consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: now, revision: current.revision + 1 });
    }
    const successes = current.consecutiveSuccesses + 1;
    if (successes >= this.policy.successThreshold) {
      return freezeItem({ ...current, state: 'closed', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAtMs: null, retryAtMs: null, lastObservedAtMs: now, revision: current.revision + 1 });
    }
    return freezeItem({ ...current, consecutiveFailures: 0, consecutiveSuccesses: successes, lastObservedAtMs: now, revision: current.revision + 1 });
  }

  private onFailure(current: ArcGisServiceCircuitSnapshotItem, now: number): ArcGisServiceCircuitSnapshotItem {
    if (current.state === 'open') throw new Error('cannot record outcome while circuit admission is denied');
    const failures = current.state === 'half-open' ? this.policy.failureThreshold : current.consecutiveFailures + 1;
    if (failures < this.policy.failureThreshold) {
      return freezeItem({ ...current, consecutiveFailures: failures, consecutiveSuccesses: 0, lastObservedAtMs: now, revision: current.revision + 1 });
    }
    const openCount = current.openCount + 1;
    const duration = this.openDuration(openCount);
    return freezeItem({
      ...current,
      state: 'open',
      consecutiveFailures: this.policy.failureThreshold,
      consecutiveSuccesses: 0,
      openedAtMs: now,
      retryAtMs: now + duration,
      lastObservedAtMs: now,
      openCount,
      revision: current.revision + 1,
    });
  }

  private openDuration(openCount: number): number {
    const exponent = Math.max(0, openCount - 1);
    const raw = this.policy.openDurationMs * Math.pow(this.policy.backoffMultiplier, exponent);
    if (!Number.isFinite(raw)) return this.policy.maxOpenDurationMs;
    return Math.min(this.policy.maxOpenDurationMs, Math.max(this.policy.openDurationMs, Math.floor(raw)));
  }

  private validateRestored(raw: ArcGisServiceCircuitSnapshotItem, now: number): ArcGisServiceCircuitSnapshotItem {
    if (!raw || typeof raw !== 'object') throw new Error('invalid circuit snapshot item');
    const serviceKey = boundedKey(raw.serviceKey, this.policy.maxServiceKeyLength);
    if (raw.state !== 'closed' && raw.state !== 'open' && raw.state !== 'half-open') throw new Error('invalid circuit state');
    const consecutiveFailures = finiteNonNegative(raw.consecutiveFailures, 'consecutiveFailures');
    const consecutiveSuccesses = finiteNonNegative(raw.consecutiveSuccesses, 'consecutiveSuccesses');
    const lastObservedAtMs = finiteNonNegative(raw.lastObservedAtMs, 'lastObservedAtMs');
    const openCount = finiteNonNegative(raw.openCount, 'openCount');
    const revision = positiveInteger(raw.revision, 'revision');
    if (!Number.isSafeInteger(consecutiveFailures) || !Number.isSafeInteger(consecutiveSuccesses) || !Number.isSafeInteger(openCount)) throw new Error('circuit counters must be safe integers');
    if (lastObservedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future circuit observation');
    const openedAtMs = raw.openedAtMs === null ? null : finiteNonNegative(raw.openedAtMs, 'openedAtMs');
    const retryAtMs = raw.retryAtMs === null ? null : finiteNonNegative(raw.retryAtMs, 'retryAtMs');
    if (raw.state === 'open') {
      if (openedAtMs === null || retryAtMs === null || retryAtMs <= openedAtMs || consecutiveFailures !== this.policy.failureThreshold) throw new Error('inconsistent open circuit snapshot');
      if (retryAtMs - openedAtMs > this.policy.maxOpenDurationMs) throw new Error('open duration exceeds configured bound');
    } else if (openedAtMs !== null || retryAtMs !== null) {
      throw new Error('non-open circuit cannot carry open timestamps');
    }
    if (raw.state === 'closed' && (consecutiveSuccesses !== 0 || consecutiveFailures >= this.policy.failureThreshold)) throw new Error('inconsistent closed circuit snapshot');
    if (raw.state === 'half-open' && consecutiveFailures !== 0) throw new Error('half-open circuit cannot carry failures');
    return freezeItem({ serviceKey, state: raw.state, consecutiveFailures, consecutiveSuccesses, openedAtMs, retryAtMs, lastObservedAtMs, openCount, revision });
  }

  private assertFresh(existing: ArcGisServiceCircuitSnapshotItem, now: number): void {
    if (now + this.policy.maxClockSkewMs < existing.lastObservedAtMs) throw new Error('stale circuit observation');
  }

  private prune(now: number): void {
    let changed = false;
    for (const [key, item] of this.circuits) {
      if (now > item.lastObservedAtMs && now - item.lastObservedAtMs > this.policy.retentionMs) {
        this.circuits.delete(key);
        changed = true;
      }
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedKey: string): void {
    while (this.circuits.size > this.policy.maxServices) {
      const victim = [...this.circuits.values()]
        .filter(item => item.serviceKey !== protectedKey)
        .sort((a, b) => a.lastObservedAtMs - b.lastObservedAtMs || a.serviceKey.localeCompare(b.serviceKey))[0];
      if (!victim) throw new Error('unable to enforce circuit capacity');
      this.circuits.delete(victim.serviceKey);
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisServiceCircuitCoordinator is disposed');
  }
}
