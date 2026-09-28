export type ArcGisServiceRequestClass = 'interactive' | 'foreground' | 'background';
export type ArcGisServiceDeadlineState = 'active' | 'expired' | 'completed' | 'cancelled';

export interface ArcGisServiceDeadlinePolicy {
  readonly maxRequests: number;
  readonly maxRequestsPerService: number;
  readonly maxServiceKeyLength: number;
  readonly maxRequestKeyLength: number;
  readonly maxDurationMs: number;
  readonly maxClockSkewMs: number;
  readonly completedRetentionMs: number;
}

export interface ArcGisServiceDeadlineEntry {
  readonly serviceKey: string;
  readonly requestKey: string;
  readonly requestClass: ArcGisServiceRequestClass;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly terminalAtMs: number | null;
  readonly state: ArcGisServiceDeadlineState;
  readonly generation: number;
}

export interface ArcGisServiceDeadlineDecision {
  readonly admitted: boolean;
  readonly state: ArcGisServiceDeadlineState | 'missing';
  readonly remainingMs: number;
  readonly shouldCancelTransport: boolean;
}

export interface ArcGisServiceDeadlineSnapshot {
  readonly generation: number;
  readonly entries: readonly ArcGisServiceDeadlineEntry[];
}

const safeInteger = (value: number, name: string, zero = false): number => {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedKey = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0') || normalized.includes('\u0001')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const freezeEntry = (entry: ArcGisServiceDeadlineEntry): ArcGisServiceDeadlineEntry => Object.freeze({ ...entry });

/**
 * Primitive-only deadline/cancellation authority for verified ArcGIS REST adapters.
 * Transport ownership stays outside this coordinator: callers translate
 * shouldCancelTransport into their injected AbortController/request adapter.
 */
export class ArcGisServiceDeadlineCoordinator {
  private readonly policy: Readonly<ArcGisServiceDeadlinePolicy>;
  private readonly entries = new Map<string, ArcGisServiceDeadlineEntry>();
  private generation = 0;
  private lastClockMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceDeadlinePolicy) {
    this.policy = Object.freeze({
      maxRequests: safeInteger(policy.maxRequests, 'maxRequests'),
      maxRequestsPerService: safeInteger(policy.maxRequestsPerService, 'maxRequestsPerService'),
      maxServiceKeyLength: safeInteger(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxRequestKeyLength: safeInteger(policy.maxRequestKeyLength, 'maxRequestKeyLength'),
      maxDurationMs: safeInteger(policy.maxDurationMs, 'maxDurationMs'),
      maxClockSkewMs: safeInteger(policy.maxClockSkewMs, 'maxClockSkewMs', true),
      completedRetentionMs: safeInteger(policy.completedRetentionMs, 'completedRetentionMs', true),
    });
    if (this.policy.maxRequestsPerService > this.policy.maxRequests) throw new Error('per-service request capacity exceeds global capacity');
  }

  begin(input: {
    readonly serviceKey: string;
    readonly requestKey: string;
    readonly requestClass: ArcGisServiceRequestClass;
    readonly startedAtMs: number;
    readonly durationMs: number;
  }): ArcGisServiceDeadlineEntry {
    this.assertUsable();
    const now = this.clock(input.startedAtMs);
    const serviceKey = boundedKey(input.serviceKey, this.policy.maxServiceKeyLength, 'service key');
    const requestKey = boundedKey(input.requestKey, this.policy.maxRequestKeyLength, 'request key');
    this.assertClass(input.requestClass);
    const durationMs = safeInteger(input.durationMs, 'durationMs');
    if (durationMs > this.policy.maxDurationMs) throw new Error('request duration exceeds policy');
    const deadlineAtMs = now + durationMs;
    if (!Number.isSafeInteger(deadlineAtMs)) throw new Error('deadline timestamp overflow');
    const key = this.key(serviceKey, requestKey);
    const previous = this.entries.get(key);
    if (previous?.state === 'active') throw new Error('request deadline already active');
    if (!previous) this.ensureCapacity(serviceKey);
    const entry = freezeEntry({ serviceKey, requestKey, requestClass: input.requestClass, startedAtMs: now, deadlineAtMs, terminalAtMs: null, state: 'active', generation: (previous?.generation ?? 0) + 1 });
    this.entries.set(key, entry);
    this.generation += 1;
    return entry;
  }

  decide(serviceKeyValue: string, requestKeyValue: string, timestampMs: number): ArcGisServiceDeadlineDecision {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const serviceKey = boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const requestKey = boundedKey(requestKeyValue, this.policy.maxRequestKeyLength, 'request key');
    const key = this.key(serviceKey, requestKey);
    const current = this.entries.get(key);
    if (!current) return Object.freeze({ admitted: false, state: 'missing', remainingMs: 0, shouldCancelTransport: false });
    if (current.state !== 'active') return Object.freeze({ admitted: false, state: current.state, remainingMs: 0, shouldCancelTransport: current.state === 'expired' || current.state === 'cancelled' });
    if (now < current.deadlineAtMs) return Object.freeze({ admitted: true, state: 'active', remainingMs: current.deadlineAtMs - now, shouldCancelTransport: false });
    const expired = this.terminal(current, 'expired', now);
    this.entries.set(key, expired);
    this.generation += 1;
    return Object.freeze({ admitted: false, state: 'expired', remainingMs: 0, shouldCancelTransport: true });
  }

  complete(serviceKeyValue: string, requestKeyValue: string, timestampMs: number): ArcGisServiceDeadlineEntry {
    return this.finish(serviceKeyValue, requestKeyValue, timestampMs, 'completed');
  }

  cancel(serviceKeyValue: string, requestKeyValue: string, timestampMs: number): ArcGisServiceDeadlineEntry {
    return this.finish(serviceKeyValue, requestKeyValue, timestampMs, 'cancelled');
  }

  expire(timestampMs: number): number {
    this.assertUsable();
    const now = this.clock(timestampMs);
    let changed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state === 'active' && now >= entry.deadlineAtMs) {
        this.entries.set(key, this.terminal(entry, 'expired', now));
        changed += 1;
      }
    }
    if (changed) this.generation += 1;
    return changed;
  }

  prune(timestampMs: number): number {
    this.assertUsable();
    const now = this.clock(timestampMs);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.state !== 'active' && entry.terminalAtMs !== null && now - entry.terminalAtMs > this.policy.completedRetentionMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed) this.generation += 1;
    return removed;
  }

  snapshot(timestampMs: number): ArcGisServiceDeadlineSnapshot {
    this.assertUsable();
    this.clock(timestampMs);
    const entries = [...this.entries.values()]
      .sort((a, b) => a.serviceKey.localeCompare(b.serviceKey) || a.requestKey.localeCompare(b.requestKey))
      .map(freezeEntry);
    return Object.freeze({ generation: this.generation, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisServiceDeadlineSnapshot, 'entries'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.clock(timestampMs);
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxRequests) throw new Error('invalid deadline snapshot capacity');
    const next = new Map<string, ArcGisServiceDeadlineEntry>();
    const perService = new Map<string, number>();
    for (const raw of snapshot.entries) {
      const serviceKey = boundedKey(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key');
      const requestKey = boundedKey(raw.requestKey, this.policy.maxRequestKeyLength, 'request key');
      this.assertClass(raw.requestClass);
      this.assertState(raw.state);
      const startedAtMs = safeInteger(raw.startedAtMs, 'startedAtMs', true);
      const deadlineAtMs = safeInteger(raw.deadlineAtMs, 'deadlineAtMs', true);
      const generation = safeInteger(raw.generation, 'generation');
      if (startedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future request start');
      if (deadlineAtMs <= startedAtMs || deadlineAtMs - startedAtMs > this.policy.maxDurationMs) throw new Error('invalid deadline chronology');
      const terminalAtMs = raw.terminalAtMs === null ? null : safeInteger(raw.terminalAtMs, 'terminalAtMs', true);
      if (raw.state === 'active' && terminalAtMs !== null) throw new Error('active deadline cannot be terminal');
      if (raw.state !== 'active' && terminalAtMs === null) throw new Error('terminal deadline missing timestamp');
      if (terminalAtMs !== null && (terminalAtMs < startedAtMs || terminalAtMs > now + this.policy.maxClockSkewMs)) throw new Error('invalid terminal timestamp');
      const key = this.key(serviceKey, requestKey);
      if (next.has(key)) throw new Error('duplicate deadline entry');
      const count = (perService.get(serviceKey) ?? 0) + 1;
      if (count > this.policy.maxRequestsPerService) throw new Error('per-service deadline capacity exceeded');
      perService.set(serviceKey, count);
      next.set(key, freezeEntry({ serviceKey, requestKey, requestClass: raw.requestClass, startedAtMs, deadlineAtMs, terminalAtMs, state: raw.state, generation }));
    }
    this.entries.clear();
    for (const [key, entry] of next) this.entries.set(key, entry);
    this.lastClockMs = now;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.generation += 1;
  }

  private finish(serviceKeyValue: string, requestKeyValue: string, timestampMs: number, state: 'completed' | 'cancelled'): ArcGisServiceDeadlineEntry {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const serviceKey = boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const requestKey = boundedKey(requestKeyValue, this.policy.maxRequestKeyLength, 'request key');
    const key = this.key(serviceKey, requestKey);
    const current = this.entries.get(key);
    if (!current) throw new Error('request deadline not found');
    if (current.state !== 'active') throw new Error('request deadline already terminal');
    const nextState: ArcGisServiceDeadlineState = now >= current.deadlineAtMs ? 'expired' : state;
    const next = this.terminal(current, nextState, now);
    this.entries.set(key, next);
    this.generation += 1;
    return next;
  }

  private terminal(entry: ArcGisServiceDeadlineEntry, state: 'expired' | 'completed' | 'cancelled', now: number): ArcGisServiceDeadlineEntry {
    return freezeEntry({ ...entry, state, terminalAtMs: now });
  }

  private ensureCapacity(serviceKey: string): void {
    while ([...this.entries.values()].filter((entry) => entry.serviceKey === serviceKey).length >= this.policy.maxRequestsPerService) this.evict((entry) => entry.serviceKey === serviceKey);
    while (this.entries.size >= this.policy.maxRequests) this.evict(() => true);
  }

  private evict(predicate: (entry: ArcGisServiceDeadlineEntry) => boolean): void {
    const rank = (entry: ArcGisServiceDeadlineEntry): number => entry.state === 'active' ? 1 : 0;
    const candidate = [...this.entries.values()].filter(predicate).sort((a, b) => rank(a) - rank(b) || (a.terminalAtMs ?? a.startedAtMs) - (b.terminalAtMs ?? b.startedAtMs) || a.serviceKey.localeCompare(b.serviceKey) || a.requestKey.localeCompare(b.requestKey))[0];
    if (!candidate) throw new Error('deadline capacity invariant failed');
    if (candidate.state === 'active') throw new Error('deadline capacity exhausted by active requests');
    this.entries.delete(this.key(candidate.serviceKey, candidate.requestKey));
    this.generation += 1;
  }

  private key(serviceKey: string, requestKey: string): string { return `${serviceKey}\u0001${requestKey}`; }
  private assertClass(value: string): asserts value is ArcGisServiceRequestClass { if (value !== 'interactive' && value !== 'foreground' && value !== 'background') throw new Error('invalid request class'); }
  private assertState(value: string): asserts value is ArcGisServiceDeadlineState { if (value !== 'active' && value !== 'expired' && value !== 'completed' && value !== 'cancelled') throw new Error('invalid deadline state'); }
  private clock(value: number): number { const now = safeInteger(value, 'timestampMs', true); if (now + this.policy.maxClockSkewMs < this.lastClockMs) throw new Error('stale deadline clock'); this.lastClockMs = Math.max(this.lastClockMs, now); return now; }
  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisServiceDeadlineCoordinator is disposed'); }
}
