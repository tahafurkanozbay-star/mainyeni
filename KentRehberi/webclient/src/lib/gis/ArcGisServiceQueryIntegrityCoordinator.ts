export type ArcGisQueryIntegrityState = 'active' | 'complete' | 'failed' | 'cancelled';
export type ArcGisQueryIdentity = string | number;

export interface ArcGisServiceQueryIntegrityPolicy {
  readonly maxSessions: number;
  readonly maxSessionsPerService: number;
  readonly maxServiceKeyLength: number;
  readonly maxSessionKeyLength: number;
  readonly maxIdentityLength: number;
  readonly maxIdentitiesPerSession: number;
  readonly maxPagesPerSession: number;
  readonly maxDiagnosticsPerSession: number;
  readonly maxClockSkewMs: number;
  readonly terminalRetentionMs: number;
}

export interface ArcGisQueryIntegrityDiagnostic {
  readonly code: 'duplicate-identity' | 'non-monotonic-page' | 'identity-budget' | 'page-budget';
  readonly page: number;
  readonly observedAtMs: number;
}

export interface ArcGisQueryIntegritySession {
  readonly serviceKey: string;
  readonly sessionKey: string;
  readonly state: ArcGisQueryIntegrityState;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly terminalAtMs: number | null;
  readonly pages: number;
  readonly identities: readonly ArcGisQueryIdentity[];
  readonly diagnostics: readonly ArcGisQueryIntegrityDiagnostic[];
  readonly generation: number;
}

export interface ArcGisQueryIntegritySnapshot {
  readonly generation: number;
  readonly sessions: readonly ArcGisQueryIntegritySession[];
}

const boundedInteger = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside configured bounds`);
  return value;
};

const boundedKey = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0') || normalized.includes('\u0001')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};

const normalizeIdentity = (value: ArcGisQueryIdentity, maxLength: number): ArcGisQueryIdentity => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('query identity must be a safe integer');
    return value;
  }
  if (typeof value !== 'string') throw new Error('query identity has unsupported type');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error('query identity outside configured bounds');
  return normalized;
};

const identityToken = (value: ArcGisQueryIdentity): string => typeof value === 'number' ? `n:${value}` : `s:${value}`;
const freezeDiagnostic = (value: ArcGisQueryIntegrityDiagnostic): ArcGisQueryIntegrityDiagnostic => Object.freeze({ ...value });
const freezeSession = (value: ArcGisQueryIntegritySession): ArcGisQueryIntegritySession => Object.freeze({
  ...value,
  identities: Object.freeze([...value.identities]),
  diagnostics: Object.freeze(value.diagnostics.map(freezeDiagnostic)),
});

/**
 * Primitive-only integrity authority for verified ArcGIS REST query adapters.
 * It tracks stable object/global identities across paged responses so adapters can
 * reject duplicate or replayed feature pages without retaining feature payloads,
 * Geometry, Graphic, request handles, URLs or credentials.
 */
export class ArcGisServiceQueryIntegrityCoordinator {
  private readonly policy: Readonly<ArcGisServiceQueryIntegrityPolicy>;
  private readonly sessions = new Map<string, ArcGisQueryIntegritySession>();
  private generation = 0;
  private lastClockMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceQueryIntegrityPolicy) {
    this.policy = Object.freeze({
      maxSessions: boundedInteger(policy.maxSessions, 'maxSessions'),
      maxSessionsPerService: boundedInteger(policy.maxSessionsPerService, 'maxSessionsPerService'),
      maxServiceKeyLength: boundedInteger(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxSessionKeyLength: boundedInteger(policy.maxSessionKeyLength, 'maxSessionKeyLength'),
      maxIdentityLength: boundedInteger(policy.maxIdentityLength, 'maxIdentityLength'),
      maxIdentitiesPerSession: boundedInteger(policy.maxIdentitiesPerSession, 'maxIdentitiesPerSession'),
      maxPagesPerSession: boundedInteger(policy.maxPagesPerSession, 'maxPagesPerSession'),
      maxDiagnosticsPerSession: boundedInteger(policy.maxDiagnosticsPerSession, 'maxDiagnosticsPerSession'),
      maxClockSkewMs: boundedInteger(policy.maxClockSkewMs, 'maxClockSkewMs', true),
      terminalRetentionMs: boundedInteger(policy.terminalRetentionMs, 'terminalRetentionMs', true),
    });
    if (this.policy.maxSessionsPerService > this.policy.maxSessions) throw new Error('per-service query integrity capacity exceeds global capacity');
  }

  begin(serviceValue: string, sessionValue: string, timestampMs: number): ArcGisQueryIntegritySession {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const serviceKey = boundedKey(serviceValue, this.policy.maxServiceKeyLength, 'service key');
    const sessionKey = boundedKey(sessionValue, this.policy.maxSessionKeyLength, 'session key');
    const id = this.id(serviceKey, sessionKey);
    const previous = this.sessions.get(id);
    if (previous?.state === 'active') throw new Error('query integrity session already active');
    if (!previous) this.ensureCapacity(serviceKey);
    const next = freezeSession({ serviceKey, sessionKey, state: 'active', startedAtMs: now, updatedAtMs: now, terminalAtMs: null, pages: 0, identities: [], diagnostics: [], generation: (previous?.generation ?? 0) + 1 });
    this.sessions.set(id, next);
    this.generation += 1;
    return next;
  }

  recordPage(input: { readonly serviceKey: string; readonly sessionKey: string; readonly timestampMs: number; readonly page: number; readonly identities: readonly ArcGisQueryIdentity[]; readonly hasMore: boolean }): ArcGisQueryIntegritySession {
    this.assertUsable();
    const now = this.clock(input.timestampMs);
    const current = this.lookup(input.serviceKey, input.sessionKey);
    if (!current) throw new Error('query integrity session not found');
    if (current.state !== 'active') throw new Error('query integrity session is terminal');
    const page = boundedInteger(input.page, 'page');
    if (page !== current.pages + 1) return this.failWith(current, now, 'non-monotonic-page', page);
    if (page > this.policy.maxPagesPerSession) return this.failWith(current, now, 'page-budget', page);
    if (!Array.isArray(input.identities)) throw new Error('query identities must be an array');
    if (current.identities.length + input.identities.length > this.policy.maxIdentitiesPerSession) return this.failWith(current, now, 'identity-budget', page);
    const existing = new Set(current.identities.map(identityToken));
    const normalized: ArcGisQueryIdentity[] = [];
    for (const raw of input.identities) {
      const identity = normalizeIdentity(raw, this.policy.maxIdentityLength);
      const token = identityToken(identity);
      if (existing.has(token)) return this.failWith(current, now, 'duplicate-identity', page);
      existing.add(token);
      normalized.push(identity);
    }
    const terminal = !input.hasMore;
    const next = freezeSession({ ...current, state: terminal ? 'complete' : 'active', updatedAtMs: now, terminalAtMs: terminal ? now : null, pages: page, identities: [...current.identities, ...normalized], generation: current.generation + 1 });
    this.sessions.set(this.id(current.serviceKey, current.sessionKey), next);
    this.generation += 1;
    return next;
  }

  cancel(serviceValue: string, sessionValue: string, timestampMs: number): ArcGisQueryIntegritySession {
    return this.finish(serviceValue, sessionValue, timestampMs, 'cancelled');
  }

  fail(serviceValue: string, sessionValue: string, timestampMs: number): ArcGisQueryIntegritySession {
    return this.finish(serviceValue, sessionValue, timestampMs, 'failed');
  }

  get(serviceValue: string, sessionValue: string): ArcGisQueryIntegritySession | null {
    this.assertUsable();
    return this.lookup(serviceValue, sessionValue) ?? null;
  }

  prune(timestampMs: number): number {
    this.assertUsable();
    const now = this.clock(timestampMs);
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.terminalAtMs !== null && now - session.terminalAtMs > this.policy.terminalRetentionMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    if (removed) this.generation += 1;
    return removed;
  }

  snapshot(timestampMs: number): ArcGisQueryIntegritySnapshot {
    this.assertUsable();
    this.clock(timestampMs);
    const sessions = [...this.sessions.values()]
      .sort((a, b) => a.serviceKey.localeCompare(b.serviceKey) || a.sessionKey.localeCompare(b.sessionKey))
      .map(freezeSession);
    return Object.freeze({ generation: this.generation, sessions: Object.freeze(sessions) });
  }

  restore(snapshot: Pick<ArcGisQueryIntegritySnapshot, 'sessions'>, timestampMs: number): void {
    this.assertUsable();
    const now = this.clock(timestampMs);
    if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length > this.policy.maxSessions) throw new Error('invalid query integrity snapshot capacity');
    const next = new Map<string, ArcGisQueryIntegritySession>();
    const serviceCounts = new Map<string, number>();
    for (const raw of snapshot.sessions) {
      const serviceKey = boundedKey(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key');
      const sessionKey = boundedKey(raw.sessionKey, this.policy.maxSessionKeyLength, 'session key');
      this.assertState(raw.state);
      const startedAtMs = boundedInteger(raw.startedAtMs, 'startedAtMs', true);
      const updatedAtMs = boundedInteger(raw.updatedAtMs, 'updatedAtMs', true);
      const terminalAtMs = raw.terminalAtMs === null ? null : boundedInteger(raw.terminalAtMs, 'terminalAtMs', true);
      const pages = boundedInteger(raw.pages, 'pages', true);
      const generation = boundedInteger(raw.generation, 'generation');
      if (startedAtMs > updatedAtMs || updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('invalid query integrity chronology');
      if (pages > this.policy.maxPagesPerSession) throw new Error('query integrity page budget exceeded');
      if (!Array.isArray(raw.identities) || raw.identities.length > this.policy.maxIdentitiesPerSession) throw new Error('query integrity identity budget exceeded');
      const identities = raw.identities.map((value) => normalizeIdentity(value, this.policy.maxIdentityLength));
      const tokens = new Set(identities.map(identityToken));
      if (tokens.size !== identities.length) throw new Error('duplicate query identity in snapshot');
      if (!Array.isArray(raw.diagnostics) || raw.diagnostics.length > this.policy.maxDiagnosticsPerSession) throw new Error('query integrity diagnostic budget exceeded');
      const diagnostics = raw.diagnostics.map((diagnostic) => this.restoreDiagnostic(diagnostic, now));
      if (raw.state === 'active' && terminalAtMs !== null) throw new Error('active query integrity session cannot be terminal');
      if (raw.state !== 'active' && terminalAtMs === null) throw new Error('terminal query integrity session missing timestamp');
      if (terminalAtMs !== null && (terminalAtMs < updatedAtMs || terminalAtMs > now + this.policy.maxClockSkewMs)) throw new Error('invalid query integrity terminal timestamp');
      const id = this.id(serviceKey, sessionKey);
      if (next.has(id)) throw new Error('duplicate query integrity session');
      const count = (serviceCounts.get(serviceKey) ?? 0) + 1;
      if (count > this.policy.maxSessionsPerService) throw new Error('per-service query integrity capacity exceeded');
      serviceCounts.set(serviceKey, count);
      next.set(id, freezeSession({ serviceKey, sessionKey, state: raw.state, startedAtMs, updatedAtMs, terminalAtMs, pages, identities, diagnostics, generation }));
    }
    this.sessions.clear();
    for (const [id, session] of next) this.sessions.set(id, session);
    this.lastClockMs = now;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sessions.clear();
    this.generation += 1;
  }

  private failWith(current: ArcGisQueryIntegritySession, now: number, code: ArcGisQueryIntegrityDiagnostic['code'], page: number): ArcGisQueryIntegritySession {
    const diagnostic = freezeDiagnostic({ code, page, observedAtMs: now });
    const diagnostics = [...current.diagnostics, diagnostic].slice(-this.policy.maxDiagnosticsPerSession);
    const next = freezeSession({ ...current, state: 'failed', updatedAtMs: now, terminalAtMs: now, diagnostics, generation: current.generation + 1 });
    this.sessions.set(this.id(current.serviceKey, current.sessionKey), next);
    this.generation += 1;
    return next;
  }

  private finish(serviceValue: string, sessionValue: string, timestampMs: number, state: 'failed' | 'cancelled'): ArcGisQueryIntegritySession {
    this.assertUsable();
    const now = this.clock(timestampMs);
    const current = this.lookup(serviceValue, sessionValue);
    if (!current) throw new Error('query integrity session not found');
    if (current.state !== 'active') throw new Error('query integrity session is terminal');
    const next = freezeSession({ ...current, state, updatedAtMs: now, terminalAtMs: now, generation: current.generation + 1 });
    this.sessions.set(this.id(current.serviceKey, current.sessionKey), next);
    this.generation += 1;
    return next;
  }

  private restoreDiagnostic(raw: ArcGisQueryIntegrityDiagnostic, now: number): ArcGisQueryIntegrityDiagnostic {
    if (raw.code !== 'duplicate-identity' && raw.code !== 'non-monotonic-page' && raw.code !== 'identity-budget' && raw.code !== 'page-budget') throw new Error('invalid query integrity diagnostic code');
    const page = boundedInteger(raw.page, 'diagnostic page');
    const observedAtMs = boundedInteger(raw.observedAtMs, 'diagnostic observedAtMs', true);
    if (observedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future query integrity diagnostic');
    return freezeDiagnostic({ code: raw.code, page, observedAtMs });
  }

  private lookup(serviceValue: string, sessionValue: string): ArcGisQueryIntegritySession | undefined {
    const serviceKey = boundedKey(serviceValue, this.policy.maxServiceKeyLength, 'service key');
    const sessionKey = boundedKey(sessionValue, this.policy.maxSessionKeyLength, 'session key');
    return this.sessions.get(this.id(serviceKey, sessionKey));
  }

  private ensureCapacity(serviceKey: string): void {
    while ([...this.sessions.values()].filter((session) => session.serviceKey === serviceKey).length >= this.policy.maxSessionsPerService) this.evict((session) => session.serviceKey === serviceKey);
    while (this.sessions.size >= this.policy.maxSessions) this.evict(() => true);
  }

  private evict(predicate: (session: ArcGisQueryIntegritySession) => boolean): void {
    const candidate = [...this.sessions.values()].filter(predicate).sort((a, b) => (a.state === 'active' ? 1 : 0) - (b.state === 'active' ? 1 : 0) || a.updatedAtMs - b.updatedAtMs || a.serviceKey.localeCompare(b.serviceKey) || a.sessionKey.localeCompare(b.sessionKey))[0];
    if (!candidate) throw new Error('query integrity capacity invariant failed');
    if (candidate.state === 'active') throw new Error('query integrity capacity exhausted by active sessions');
    this.sessions.delete(this.id(candidate.serviceKey, candidate.sessionKey));
    this.generation += 1;
  }

  private id(serviceKey: string, sessionKey: string): string { return `${serviceKey}\u0001${sessionKey}`; }
  private assertState(value: string): asserts value is ArcGisQueryIntegrityState { if (value !== 'active' && value !== 'complete' && value !== 'failed' && value !== 'cancelled') throw new Error('invalid query integrity state'); }
  private clock(value: number): number { const now = boundedInteger(value, 'timestampMs', true); if (now + this.policy.maxClockSkewMs < this.lastClockMs) throw new Error('stale query integrity clock'); this.lastClockMs = Math.max(this.lastClockMs, now); return now; }
  private assertUsable(): void { if (this.disposed) throw new Error('ArcGisServiceQueryIntegrityCoordinator is disposed'); }
}
