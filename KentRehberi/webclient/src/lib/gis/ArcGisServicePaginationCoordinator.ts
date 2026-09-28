export type ArcGisPaginationState = 'active' | 'complete' | 'cancelled' | 'failed';

export interface ArcGisServicePaginationPolicy {
  readonly maxSessions: number;
  readonly maxSessionsPerService: number;
  readonly maxServiceKeyLength: number;
  readonly maxSessionKeyLength: number;
  readonly maxPages: number;
  readonly maxFeatures: number;
  readonly maxBytes: number;
  readonly maxPageSize: number;
  readonly maxDurationMs: number;
  readonly terminalRetentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisPaginationSession {
  readonly serviceKey: string;
  readonly sessionKey: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly state: ArcGisPaginationState;
  readonly pages: number;
  readonly features: number;
  readonly bytes: number;
  readonly nextOffset: number;
  readonly generation: number;
  readonly terminalAtMs: number | null;
}

export interface ArcGisPaginationDecision {
  readonly admitted: boolean;
  readonly reason: 'ready' | 'missing' | 'terminal' | 'page-limit' | 'feature-limit' | 'byte-limit' | 'duration-limit';
  readonly nextOffset: number;
  readonly remainingPages: number;
  readonly remainingFeatures: number;
  readonly remainingBytes: number;
}

export interface ArcGisPaginationSnapshot {
  readonly generation: number;
  readonly sessions: readonly ArcGisPaginationSession[];
}

const integer = (value: number, name: string, zero = false): number => {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const keyPart = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0') || normalized.includes('\u0001')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const frozen = (value: ArcGisPaginationSession): ArcGisPaginationSession => Object.freeze({ ...value });

/**
 * Primitive-only pagination authority for verified ArcGIS REST query adapters.
 * It does not build endpoints or own response bodies. Adapters report page facts
 * after validating ArcGIS response metadata; this authority only bounds traversal.
 */
export class ArcGisServicePaginationCoordinator {
  private readonly policy: Readonly<ArcGisServicePaginationPolicy>;
  private readonly sessions = new Map<string, ArcGisPaginationSession>();
  private generation = 0;
  private lastClockMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServicePaginationPolicy) {
    this.policy = Object.freeze({
      maxSessions: integer(policy.maxSessions, 'maxSessions'),
      maxSessionsPerService: integer(policy.maxSessionsPerService, 'maxSessionsPerService'),
      maxServiceKeyLength: integer(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxSessionKeyLength: integer(policy.maxSessionKeyLength, 'maxSessionKeyLength'),
      maxPages: integer(policy.maxPages, 'maxPages'),
      maxFeatures: integer(policy.maxFeatures, 'maxFeatures'),
      maxBytes: integer(policy.maxBytes, 'maxBytes'),
      maxPageSize: integer(policy.maxPageSize, 'maxPageSize'),
      maxDurationMs: integer(policy.maxDurationMs, 'maxDurationMs'),
      terminalRetentionMs: integer(policy.terminalRetentionMs, 'terminalRetentionMs', true),
      maxClockSkewMs: integer(policy.maxClockSkewMs, 'maxClockSkewMs', true),
    });
    if (this.policy.maxSessionsPerService > this.policy.maxSessions) throw new Error('per-service pagination capacity exceeds global capacity');
    if (this.policy.maxPageSize > this.policy.maxFeatures) throw new Error('page size exceeds feature budget');
  }

  begin(serviceValue: string, sessionValue: string, timestampMs: number, initialOffset = 0): ArcGisPaginationSession {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const serviceKey = keyPart(serviceValue, this.policy.maxServiceKeyLength, 'service key');
    const sessionKey = keyPart(sessionValue, this.policy.maxSessionKeyLength, 'session key');
    const offset = integer(initialOffset, 'initialOffset', true);
    const id = this.id(serviceKey, sessionKey);
    const previous = this.sessions.get(id);
    if (previous?.state === 'active') throw new Error('pagination session already active');
    if (!previous) this.ensureCapacity(serviceKey);
    const next = frozen({ serviceKey, sessionKey, startedAtMs: now, updatedAtMs: now, state: 'active', pages: 0, features: 0, bytes: 0, nextOffset: offset, generation: (previous?.generation ?? 0) + 1, terminalAtMs: null });
    this.sessions.set(id, next);
    this.generation += 1;
    return next;
  }

  decide(serviceValue: string, sessionValue: string, timestampMs: number): ArcGisPaginationDecision {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const session = this.lookup(serviceValue, sessionValue);
    if (!session) return this.decision(false, 'missing', 0, 0, 0, 0);
    if (session.state !== 'active') return this.decision(false, 'terminal', session.nextOffset, 0, 0, 0);
    if (now - session.startedAtMs >= this.policy.maxDurationMs) return this.decision(false, 'duration-limit', session.nextOffset, 0, 0, 0);
    if (session.pages >= this.policy.maxPages) return this.decision(false, 'page-limit', session.nextOffset, 0, this.policy.maxFeatures - session.features, this.policy.maxBytes - session.bytes);
    if (session.features >= this.policy.maxFeatures) return this.decision(false, 'feature-limit', session.nextOffset, this.policy.maxPages - session.pages, 0, this.policy.maxBytes - session.bytes);
    if (session.bytes >= this.policy.maxBytes) return this.decision(false, 'byte-limit', session.nextOffset, this.policy.maxPages - session.pages, this.policy.maxFeatures - session.features, 0);
    return this.decision(true, 'ready', session.nextOffset, this.policy.maxPages - session.pages, this.policy.maxFeatures - session.features, this.policy.maxBytes - session.bytes);
  }

  recordPage(input: { readonly serviceKey: string; readonly sessionKey: string; readonly timestampMs: number; readonly featureCount: number; readonly byteCount: number; readonly nextOffset: number; readonly hasMore: boolean }): ArcGisPaginationSession {
    this.assertUsable();
    const now = this.clock(input.timestampMs);
    const current = this.lookup(input.serviceKey, input.sessionKey);
    if (!current) throw new Error('pagination session not found');
    if (current.state !== 'active') throw new Error('pagination session is terminal');
    if (now - current.startedAtMs >= this.policy.maxDurationMs) throw new Error('pagination duration exhausted');
    const featureCount = integer(input.featureCount, 'featureCount', true);
    const byteCount = integer(input.byteCount, 'byteCount', true);
    const nextOffset = integer(input.nextOffset, 'nextOffset', true);
    if (featureCount > this.policy.maxPageSize) throw new Error('page feature count exceeds policy');
    if (current.pages + 1 > this.policy.maxPages) throw new Error('pagination page budget exhausted');
    if (current.features + featureCount > this.policy.maxFeatures) throw new Error('pagination feature budget exhausted');
    if (current.bytes + byteCount > this.policy.maxBytes) throw new Error('pagination byte budget exhausted');
    if (input.hasMore && nextOffset <= current.nextOffset) throw new Error('pagination offset did not advance');
    const terminal = !input.hasMore;
    const next = frozen({ ...current, updatedAtMs: now, state: terminal ? 'complete' : 'active', pages: current.pages + 1, features: current.features + featureCount, bytes: current.bytes + byteCount, nextOffset, generation: current.generation + 1, terminalAtMs: terminal ? now : null });
    this.sessions.set(this.id(current.serviceKey, current.sessionKey), next);
    this.generation += 1;
    return next;
  }

  cancel(serviceValue: string, sessionValue: string, timestampMs: number): ArcGisPaginationSession { return this.finish(serviceValue, sessionValue, timestampMs, 'cancelled'); }
  fail(serviceValue: string, sessionValue: string, timestampMs: number): ArcGisPaginationSession { return this.finish(serviceValue, sessionValue, timestampMs, 'failed'); }

  prune(timestampMs: number): number {
    this.assertUsable();
    const now = this.clock(timestampMs);
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.terminalAtMs !== null && now - session.terminalAtMs > this.policy.terminalRetentionMs) { this.sessions.delete(id); removed += 1; }
    }
    if (removed) this.generation += 1;
    return removed;
  }

  snapshot(timestampMs: number): ArcGisPaginationSnapshot {
    this.assertUsable();
    this.clock(timestampMs);
    const sessions = [...this.sessions.values()].sort((a, b) => a.serviceKey.localeCompare(b.serviceKey) || a.sessionKey.localeCompare(b.sessionKey)).map(frozen);
    return Object.freeze({ generation: this.generation, sessions: Object.freeze(sessions) });
  }

  restore(snapshot: Pick<ArcGisPaginationSnapshot, 'sessions'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.clock(timestampMs);
    if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length > this.policy.maxSessions) throw new Error('invalid pagination snapshot capacity');
    const next = new Map<string, ArcGisPaginationSession>();
    const counts = new Map<string, number>();
    for (const raw of snapshot.sessions) {
      const serviceKey = keyPart(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key');
      const sessionKey = keyPart(raw.sessionKey, this.policy.maxSessionKeyLength, 'session key');
      this.assertState(raw.state);
      const startedAtMs = integer(raw.startedAtMs, 'startedAtMs', true);
      const updatedAtMs = integer(raw.updatedAtMs, 'updatedAtMs', true);
      const pages = integer(raw.pages, 'pages', true);
      const features = integer(raw.features, 'features', true);
      const bytes = integer(raw.bytes, 'bytes', true);
      const nextOffset = integer(raw.nextOffset, 'nextOffset', true);
      const generation = integer(raw.generation, 'generation');
      const terminalAtMs = raw.terminalAtMs === null ? null : integer(raw.terminalAtMs, 'terminalAtMs', true);
      if (startedAtMs > updatedAtMs || updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('invalid pagination chronology');
      if (pages > this.policy.maxPages || features > this.policy.maxFeatures || bytes > this.policy.maxBytes) throw new Error('pagination snapshot exceeds budgets');
      if (raw.state === 'active' && terminalAtMs !== null) throw new Error('active pagination session cannot be terminal');
      if (raw.state !== 'active' && terminalAtMs === null) throw new Error('terminal pagination session missing timestamp');
      if (terminalAtMs !== null && (terminalAtMs < updatedAtMs || terminalAtMs > now + this.policy.maxClockSkewMs)) throw new Error('invalid pagination terminal timestamp');
      const id = this.id(serviceKey, sessionKey);
      if (next.has(id)) throw new Error('duplicate pagination session');
      const count = (counts.get(serviceKey) ?? 0) + 1;
      if (count > this.policy.maxSessionsPerService) throw new Error('per-service pagination capacity exceeded');
      counts.set(serviceKey, count);
      next.set(id, frozen({ serviceKey, sessionKey, startedAtMs, updatedAtMs, state: raw.state, pages, features, bytes, nextOffset, generation, terminalAtMs }));
    }
    this.sessions.clear();
    for (const [id, session] of next) this.sessions.set(id, session);
    this.lastClockMs = now;
    this.generation += 1;
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.sessions.clear(); this.generation += 1; } }

  private finish(serviceValue: string, sessionValue: string, timestampMs: number, state: 'cancelled' | 'failed'): ArcGisPaginationSession {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const current = this.lookup(serviceValue, sessionValue);
    if (!current) throw new Error('pagination session not found');
    if (current.state !== 'active') throw new Error('pagination session is terminal');
    const next = frozen({ ...current, state, updatedAtMs: now, terminalAtMs: now, generation: current.generation + 1 });
    this.sessions.set(this.id(current.serviceKey, current.sessionKey), next);
    this.generation += 1;
    return next;
  }

  private lookup(serviceValue: string, sessionValue: string): ArcGisPaginationSession | undefined {
    const serviceKey = keyPart(serviceValue, this.policy.maxServiceKeyLength, 'service key');
    const sessionKey = keyPart(sessionValue, this.policy.maxSessionKeyLength, 'session key');
    return this.sessions.get(this.id(serviceKey, sessionKey));
  }

  private ensureCapacity(serviceKey: string): void {
    while ([...this.sessions.values()].filter((value) => value.serviceKey === serviceKey).length >= this.policy.maxSessionsPerService) this.evict((value) => value.serviceKey === serviceKey);
    while (this.sessions.size >= this.policy.maxSessions) this.evict(() => true);
  }

  private evict(predicate: (value: ArcGisPaginationSession) => boolean): void {
    const candidate = [...this.sessions.values()].filter(predicate).sort((a, b) => (a.state === 'active' ? 1 : 0) - (b.state === 'active' ? 1 : 0) || a.updatedAtMs - b.updatedAtMs || a.serviceKey.localeCompare(b.serviceKey) || a.sessionKey.localeCompare(b.sessionKey))[0];
    if (!candidate) throw new Error('pagination capacity invariant failed');
    if (candidate.state === 'active') throw new Error('pagination capacity exhausted by active sessions');
    this.sessions.delete(this.id(candidate.serviceKey, candidate.sessionKey));
    this.generation += 1;
  }

  private decision(admitted: boolean, reason: ArcGisPaginationDecision['reason'], nextOffset: number, remainingPages: number, remainingFeatures: number, remainingBytes: number): ArcGisPaginationDecision { return Object.freeze({ admitted, reason, nextOffset, remainingPages, remainingFeatures, remainingBytes }); }
  private id(serviceKey: string, sessionKey: string): string { return `${serviceKey}\u0001${sessionKey}`; }
  private assertState(value: string): asserts value is ArcGisPaginationState { if (value !== 'active' && value !== 'complete' && value !== 'cancelled' && value !== 'failed') throw new Error('invalid pagination state'); }
  private clock(value: number): number { const now = integer(value, 'timestampMs', true); if (now + this.policy.maxClockSkewMs < this.lastClockMs) throw new Error('stale pagination clock'); this.lastClockMs = Math.max(this.lastClockMs, now); return now; }
  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisServicePaginationCoordinator is disposed'); }
}
