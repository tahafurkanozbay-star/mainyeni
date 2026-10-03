export type RuntimeHealthLevel = 'healthy' | 'degraded' | 'unhealthy'
export type RuntimeHealthSignalKind = 'success' | 'failure' | 'timeout' | 'cancelled'

export interface RuntimeHealthLedgerPolicy {
  readonly maxScopes: number
  readonly maxSignalsPerScope: number
  readonly retentionMs: number
  readonly degradedFailureRatio: number
  readonly unhealthyFailureRatio: number
  readonly minimumSamples: number
}

export interface RuntimeHealthSignal {
  readonly scope: string
  readonly kind: RuntimeHealthSignalKind
  readonly at: number
  readonly latencyMs?: number
}

export interface RuntimeHealthScopeSnapshot {
  readonly scope: string
  readonly level: RuntimeHealthLevel
  readonly sampleCount: number
  readonly successCount: number
  readonly failureCount: number
  readonly timeoutCount: number
  readonly cancelledCount: number
  readonly failureRatio: number
  readonly averageLatencyMs: number | null
  readonly lastSignalAt: number | null
}

export interface RuntimeHealthLedgerSnapshot {
  readonly disposed: boolean
  readonly scopeCount: number
  readonly signalCount: number
  readonly scopes: readonly RuntimeHealthScopeSnapshot[]
}

type StoredSignal = Readonly<{
  kind: RuntimeHealthSignalKind
  at: number
  latencyMs: number | null
}>

type ScopeState = {
  readonly scope: string
  readonly signals: StoredSignal[]
  touchedAt: number
}

const DEFAULT_POLICY: RuntimeHealthLedgerPolicy = Object.freeze({
  maxScopes: 64,
  maxSignalsPerScope: 128,
  retentionMs: 60_000,
  degradedFailureRatio: 0.2,
  unhealthyFailureRatio: 0.5,
  minimumSamples: 5,
})

const normalizePositiveInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback

const normalizeRatio = (value: number, fallback: number): number =>
  Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback

const normalizeScope = (value: string): string | null => {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 128) return null
  return normalized
}

const normalizeTimestamp = (value: number): number | null =>
  Number.isFinite(value) && value >= 0 ? value : null

const normalizeLatency = (value: number | undefined): number | null => {
  if (value === undefined) return null
  return Number.isFinite(value) && value >= 0 ? value : null
}

const freezeScopeSnapshot = (snapshot: RuntimeHealthScopeSnapshot): RuntimeHealthScopeSnapshot =>
  Object.freeze(snapshot)

export class RuntimeHealthLedger {
  private readonly policy: RuntimeHealthLedgerPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private disposed = false

  constructor(policy: Partial<RuntimeHealthLedgerPolicy> = {}) {
    const degradedFailureRatio = normalizeRatio(
      policy.degradedFailureRatio ?? DEFAULT_POLICY.degradedFailureRatio,
      DEFAULT_POLICY.degradedFailureRatio,
    )
    const unhealthyCandidate = normalizeRatio(
      policy.unhealthyFailureRatio ?? DEFAULT_POLICY.unhealthyFailureRatio,
      DEFAULT_POLICY.unhealthyFailureRatio,
    )
    this.policy = Object.freeze({
      maxScopes: normalizePositiveInteger(policy.maxScopes ?? DEFAULT_POLICY.maxScopes, DEFAULT_POLICY.maxScopes),
      maxSignalsPerScope: normalizePositiveInteger(
        policy.maxSignalsPerScope ?? DEFAULT_POLICY.maxSignalsPerScope,
        DEFAULT_POLICY.maxSignalsPerScope,
      ),
      retentionMs: normalizePositiveInteger(policy.retentionMs ?? DEFAULT_POLICY.retentionMs, DEFAULT_POLICY.retentionMs),
      degradedFailureRatio,
      unhealthyFailureRatio: Math.max(degradedFailureRatio, unhealthyCandidate),
      minimumSamples: normalizePositiveInteger(
        policy.minimumSamples ?? DEFAULT_POLICY.minimumSamples,
        DEFAULT_POLICY.minimumSamples,
      ),
    })
  }

  record(signal: RuntimeHealthSignal): boolean {
    if (this.disposed) return false
    const scope = normalizeScope(signal.scope)
    const at = normalizeTimestamp(signal.at)
    if (scope === null || at === null) return false
    const latencyMs = normalizeLatency(signal.latencyMs)
    if (signal.latencyMs !== undefined && latencyMs === null) return false

    this.sweep(at)
    let state = this.scopes.get(scope)
    if (!state) {
      this.ensureScopeCapacity()
      state = { scope, signals: [], touchedAt: at }
      this.scopes.set(scope, state)
    }
    state.touchedAt = Math.max(state.touchedAt, at)
    state.signals.push(Object.freeze({ kind: signal.kind, at, latencyMs }))
    state.signals.sort((left, right) => left.at - right.at)
    if (state.signals.length > this.policy.maxSignalsPerScope) {
      state.signals.splice(0, state.signals.length - this.policy.maxSignalsPerScope)
    }
    return true
  }

  sweep(now: number): number {
    if (this.disposed) return 0
    const normalizedNow = normalizeTimestamp(now)
    if (normalizedNow === null) return 0
    const cutoff = Math.max(0, normalizedNow - this.policy.retentionMs)
    let removed = 0
    for (const [scope, state] of this.scopes) {
      const before = state.signals.length
      state.signals.splice(0, state.signals.findIndex((signal) => signal.at >= cutoff) === -1
        ? state.signals.length
        : state.signals.findIndex((signal) => signal.at >= cutoff))
      removed += before - state.signals.length
      if (state.signals.length === 0 && state.touchedAt < cutoff) this.scopes.delete(scope)
    }
    return removed
  }

  removeScope(scope: string): boolean {
    if (this.disposed) return false
    const normalized = normalizeScope(scope)
    return normalized === null ? false : this.scopes.delete(normalized)
  }

  getScope(scope: string, now?: number): RuntimeHealthScopeSnapshot | null {
    if (this.disposed) return null
    if (now !== undefined) this.sweep(now)
    const normalized = normalizeScope(scope)
    if (normalized === null) return null
    const state = this.scopes.get(normalized)
    return state ? this.buildScopeSnapshot(state) : null
  }

  snapshot(now?: number): RuntimeHealthLedgerSnapshot {
    if (now !== undefined) this.sweep(now)
    if (this.disposed) return Object.freeze({ disposed: true, scopeCount: 0, signalCount: 0, scopes: Object.freeze([]) })
    const scopes = [...this.scopes.values()]
      .sort((left, right) => left.scope.localeCompare(right.scope))
      .map((state) => this.buildScopeSnapshot(state))
    return Object.freeze({
      disposed: false,
      scopeCount: scopes.length,
      signalCount: scopes.reduce((total, scope) => total + scope.sampleCount, 0),
      scopes: Object.freeze(scopes),
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scopes.clear()
  }

  private ensureScopeCapacity(): void {
    if (this.scopes.size < this.policy.maxScopes) return
    let victim: ScopeState | null = null
    for (const candidate of this.scopes.values()) {
      if (
        victim === null ||
        candidate.touchedAt < victim.touchedAt ||
        (candidate.touchedAt === victim.touchedAt && candidate.scope.localeCompare(victim.scope) < 0)
      ) victim = candidate
    }
    if (victim) this.scopes.delete(victim.scope)
  }

  private buildScopeSnapshot(state: ScopeState): RuntimeHealthScopeSnapshot {
    let successCount = 0
    let failureCount = 0
    let timeoutCount = 0
    let cancelledCount = 0
    let latencyTotal = 0
    let latencyCount = 0
    for (const signal of state.signals) {
      if (signal.kind === 'success') successCount += 1
      else if (signal.kind === 'failure') failureCount += 1
      else if (signal.kind === 'timeout') timeoutCount += 1
      else cancelledCount += 1
      if (signal.latencyMs !== null) {
        latencyTotal += signal.latencyMs
        latencyCount += 1
      }
    }
    const sampleCount = state.signals.length
    const adverseCount = failureCount + timeoutCount
    const denominator = successCount + adverseCount
    const failureRatio = denominator === 0 ? 0 : adverseCount / denominator
    let level: RuntimeHealthLevel = 'healthy'
    if (denominator >= this.policy.minimumSamples) {
      if (failureRatio >= this.policy.unhealthyFailureRatio) level = 'unhealthy'
      else if (failureRatio >= this.policy.degradedFailureRatio) level = 'degraded'
    }
    return freezeScopeSnapshot({
      scope: state.scope,
      level,
      sampleCount,
      successCount,
      failureCount,
      timeoutCount,
      cancelledCount,
      failureRatio,
      averageLatencyMs: latencyCount === 0 ? null : latencyTotal / latencyCount,
      lastSignalAt: sampleCount === 0 ? null : state.signals[sampleCount - 1]?.at ?? null,
    })
  }
}
