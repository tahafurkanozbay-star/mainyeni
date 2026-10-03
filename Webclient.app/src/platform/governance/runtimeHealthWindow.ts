export type RuntimeHealthSignal = 'success' | 'failure' | 'timeout' | 'rejected'
export type RuntimeHealthLevel = 'healthy' | 'degraded' | 'unhealthy'

export interface RuntimeHealthPolicy {
  readonly maxScopes: number
  readonly maxSamplesPerScope: number
  readonly windowMs: number
  readonly idleScopeTtlMs: number
  readonly degradedPermille: number
  readonly unhealthyPermille: number
  readonly minimumSamples: number
}
export interface RuntimeHealthSnapshot {
  readonly scopes: number
  readonly samples: number
  readonly successes: number
  readonly failures: number
  readonly timeouts: number
  readonly rejected: number
  readonly healthyScopes: number
  readonly degradedScopes: number
  readonly unhealthyScopes: number
}
export interface RuntimeScopeHealth {
  readonly level: RuntimeHealthLevel
  readonly samples: number
  readonly adverse: number
  readonly adversePermille: number
}
interface Sample { readonly at: number; readonly signal: RuntimeHealthSignal }
interface ScopeState { readonly scope: string; samples: Sample[]; lastTouchedAt: number }
const DEFAULT_POLICY: RuntimeHealthPolicy = Object.freeze({ maxScopes: 128, maxSamplesPerScope: 128, windowMs: 60_000, idleScopeTtlMs: 120_000, degradedPermille: 250, unhealthyPermille: 500, minimumSamples: 4 })
function positive(value: number | undefined, fallback: number): number { return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback }
function permille(value: number | undefined, fallback: number): number { return Number.isSafeInteger(value) && (value ?? -1) >= 0 && (value ?? 1001) <= 1000 ? value! : fallback }
function time(value: number): number { if (!Number.isFinite(value) || value < 0) throw new TypeError('now must be finite and non-negative'); return value }
function scopeId(value: string): string { const scope = value.trim(); if (scope.length === 0 || scope.length > 128) throw new TypeError('scope must contain 1..128 characters'); return scope }
function signalValue(value: RuntimeHealthSignal): RuntimeHealthSignal { if (value !== 'success' && value !== 'failure' && value !== 'timeout' && value !== 'rejected') throw new TypeError('invalid health signal'); return value }

export class RuntimeHealthWindow {
  readonly policy: RuntimeHealthPolicy
  private readonly scopes = new Map<string, ScopeState>()
  private disposed = false

  constructor(policy: Partial<RuntimeHealthPolicy> = {}) {
    const degradedPermille = permille(policy.degradedPermille, DEFAULT_POLICY.degradedPermille)
    const unhealthyPermille = Math.max(degradedPermille, permille(policy.unhealthyPermille, DEFAULT_POLICY.unhealthyPermille))
    this.policy = Object.freeze({ maxScopes: positive(policy.maxScopes, DEFAULT_POLICY.maxScopes), maxSamplesPerScope: positive(policy.maxSamplesPerScope, DEFAULT_POLICY.maxSamplesPerScope), windowMs: positive(policy.windowMs, DEFAULT_POLICY.windowMs), idleScopeTtlMs: positive(policy.idleScopeTtlMs, DEFAULT_POLICY.idleScopeTtlMs), degradedPermille, unhealthyPermille, minimumSamples: positive(policy.minimumSamples, DEFAULT_POLICY.minimumSamples) })
  }

  record(scopeInput: string, signalInput: RuntimeHealthSignal, nowInput: number): RuntimeScopeHealth {
    this.assertLive()
    const now = time(nowInput)
    const scope = scopeId(scopeInput)
    const signal = signalValue(signalInput)
    this.sweep(now)
    const state = this.ensureScope(scope, now)
    this.trim(state, now)
    state.samples.push({ at: now, signal })
    if (state.samples.length > this.policy.maxSamplesPerScope) state.samples.splice(0, state.samples.length - this.policy.maxSamplesPerScope)
    state.lastTouchedAt = now
    return this.healthFor(state)
  }

  health(scopeInput: string, nowInput: number): RuntimeScopeHealth | null {
    this.assertLive()
    const now = time(nowInput)
    const scope = scopeId(scopeInput)
    this.sweep(now)
    const state = this.scopes.get(scope)
    if (!state) return null
    this.trim(state, now)
    return this.healthFor(state)
  }

  resetScope(scopeInput: string, nowInput: number): boolean {
    this.assertLive()
    const now = time(nowInput)
    const state = this.scopes.get(scopeId(scopeInput))
    if (!state) return false
    state.samples = []
    state.lastTouchedAt = now
    return true
  }

  removeScope(scopeInput: string): boolean {
    this.assertLive()
    return this.scopes.delete(scopeId(scopeInput))
  }

  snapshot(nowInput: number): RuntimeHealthSnapshot {
    this.assertLive()
    const now = time(nowInput)
    this.sweep(now)
    let samples = 0, successes = 0, failures = 0, timeouts = 0, rejected = 0, healthyScopes = 0, degradedScopes = 0, unhealthyScopes = 0
    for (const state of this.scopes.values()) {
      this.trim(state, now)
      for (const sample of state.samples) {
        samples += 1
        if (sample.signal === 'success') successes += 1
        else if (sample.signal === 'failure') failures += 1
        else if (sample.signal === 'timeout') timeouts += 1
        else rejected += 1
      }
      const health = this.healthFor(state)
      if (health.level === 'healthy') healthyScopes += 1
      else if (health.level === 'degraded') degradedScopes += 1
      else unhealthyScopes += 1
    }
    return Object.freeze({ scopes: this.scopes.size, samples, successes, failures, timeouts, rejected, healthyScopes, degradedScopes, unhealthyScopes })
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.scopes.clear() }

  private healthFor(state: ScopeState): RuntimeScopeHealth {
    const samples = state.samples.length
    let adverse = 0
    for (const sample of state.samples) if (sample.signal !== 'success') adverse += 1
    const adversePermille = samples === 0 ? 0 : Math.trunc((adverse * 1000) / samples)
    let level: RuntimeHealthLevel = 'healthy'
    if (samples >= this.policy.minimumSamples) {
      if (adversePermille >= this.policy.unhealthyPermille) level = 'unhealthy'
      else if (adversePermille >= this.policy.degradedPermille) level = 'degraded'
    }
    return Object.freeze({ level, samples, adverse, adversePermille })
  }

  private ensureScope(scope: string, now: number): ScopeState {
    const existing = this.scopes.get(scope)
    if (existing) return existing
    if (this.scopes.size >= this.policy.maxScopes) this.evictOldest()
    if (this.scopes.size >= this.policy.maxScopes) throw new Error('scope capacity exhausted')
    const state: ScopeState = { scope, samples: [], lastTouchedAt: now }
    this.scopes.set(scope, state)
    return state
  }

  private trim(state: ScopeState, now: number): void {
    const cutoff = now - this.policy.windowMs
    let remove = 0
    while (remove < state.samples.length && state.samples[remove]!.at <= cutoff) remove += 1
    if (remove > 0) state.samples.splice(0, remove)
  }

  private sweep(now: number): void {
    for (const state of this.scopes.values()) {
      this.trim(state, now)
      if (state.samples.length === 0 && now - state.lastTouchedAt >= this.policy.idleScopeTtlMs) this.scopes.delete(state.scope)
    }
  }

  private evictOldest(): void {
    let candidate: ScopeState | null = null
    for (const state of this.scopes.values()) if (!candidate || state.lastTouchedAt < candidate.lastTouchedAt || (state.lastTouchedAt === candidate.lastTouchedAt && state.scope < candidate.scope)) candidate = state
    if (candidate) this.scopes.delete(candidate.scope)
  }

  private assertLive(): void { if (this.disposed) throw new Error('RuntimeHealthWindow is disposed') }
}
