export type RuntimePressurePriority = 'background' | 'normal' | 'critical'
export type RuntimePressureSignal = 'cpu' | 'memory' | 'network' | 'gpu'
export type RuntimePressureLevel = 'nominal' | 'elevated' | 'critical'

export interface RuntimePressurePolicy {
  readonly maxScopes: number
  readonly maxSamplesPerScope: number
  readonly retentionMs: number
  readonly elevatedThreshold: number
  readonly criticalThreshold: number
  readonly recoveryThreshold: number
  readonly recoverySamples: number
}

export interface RuntimePressureSample {
  readonly scope: string
  readonly signal: RuntimePressureSignal
  readonly value: number
  readonly now: number
}

export interface RuntimePressureDecision {
  readonly admitted: boolean
  readonly level: RuntimePressureLevel
  readonly reason: RuntimePressureSignal | 'none'
}

export interface RuntimePressureScopeSnapshot {
  readonly scope: string
  readonly generation: number
  readonly level: RuntimePressureLevel
  readonly dominantSignal: RuntimePressureSignal | null
  readonly sampleCount: number
  readonly recoveryStreak: number
  readonly touchedAt: number
}

export interface RuntimePressureSnapshot {
  readonly disposed: boolean
  readonly scopeCount: number
  readonly scopes: readonly RuntimePressureScopeSnapshot[]
}

type StoredSample = Readonly<{ signal: RuntimePressureSignal; value: number; at: number; sequence: number }>
type ScopeState = {
  readonly scope: string
  generation: number
  level: RuntimePressureLevel
  dominantSignal: RuntimePressureSignal | null
  recoveryStreak: number
  touchedAt: number
  samples: StoredSample[]
}

const DEFAULT_POLICY: RuntimePressurePolicy = Object.freeze({
  maxScopes: 64,
  maxSamplesPerScope: 32,
  retentionMs: 30_000,
  elevatedThreshold: 0.7,
  criticalThreshold: 0.9,
  recoveryThreshold: 0.55,
  recoverySamples: 3,
})

const boundedInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback
const validTime = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null
const validRatio = (value: number): number | null => Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
const scopeName = (value: string): string | null => {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null
}

/**
 * Payload-free pressure authority for expensive browser runtime work.
 * Samples are normalized scalar ratios supplied by existing runtime adapters.
 * No observers, timers, callbacks, SDK objects, URLs, errors, credentials,
 * request payloads or AbortControllers are retained by this authority.
 */
export class RuntimePressureController {
  private readonly policy: RuntimePressurePolicy
  private readonly scopes = new Map<string, ScopeState>()
  private sequence = 1
  private disposed = false

  constructor(policy: Partial<RuntimePressurePolicy> = {}) {
    const elevated = validRatio(policy.elevatedThreshold ?? DEFAULT_POLICY.elevatedThreshold) ?? DEFAULT_POLICY.elevatedThreshold
    const criticalCandidate = validRatio(policy.criticalThreshold ?? DEFAULT_POLICY.criticalThreshold) ?? DEFAULT_POLICY.criticalThreshold
    const critical = Math.max(elevated, criticalCandidate)
    const recoveryCandidate = validRatio(policy.recoveryThreshold ?? DEFAULT_POLICY.recoveryThreshold) ?? DEFAULT_POLICY.recoveryThreshold
    this.policy = Object.freeze({
      maxScopes: boundedInteger(policy.maxScopes ?? DEFAULT_POLICY.maxScopes, DEFAULT_POLICY.maxScopes),
      maxSamplesPerScope: boundedInteger(policy.maxSamplesPerScope ?? DEFAULT_POLICY.maxSamplesPerScope, DEFAULT_POLICY.maxSamplesPerScope),
      retentionMs: boundedInteger(policy.retentionMs ?? DEFAULT_POLICY.retentionMs, DEFAULT_POLICY.retentionMs),
      elevatedThreshold: elevated,
      criticalThreshold: critical,
      recoveryThreshold: Math.min(elevated, recoveryCandidate),
      recoverySamples: boundedInteger(policy.recoverySamples ?? DEFAULT_POLICY.recoverySamples, DEFAULT_POLICY.recoverySamples),
    })
  }

  record(sample: RuntimePressureSample): RuntimePressureScopeSnapshot | null {
    if (this.disposed) return null
    const scope = scopeName(sample.scope)
    const value = validRatio(sample.value)
    const now = validTime(sample.now)
    if (scope === null || value === null || now === null) return null
    this.sweep(now)
    let state = this.scopes.get(scope)
    if (!state) {
      this.ensureScopeCapacity()
      state = { scope, generation: 1, level: 'nominal', dominantSignal: null, recoveryStreak: 0, touchedAt: now, samples: [] }
      this.scopes.set(scope, state)
    }
    state.samples.push(Object.freeze({ signal: sample.signal, value, at: now, sequence: this.sequence++ }))
    while (state.samples.length > this.policy.maxSamplesPerScope) state.samples.shift()
    state.touchedAt = Math.max(state.touchedAt, now)
    this.recalculate(state)
    return this.scopeSnapshot(state)
  }

  decide(scope: string, priority: RuntimePressurePriority, now: number): RuntimePressureDecision {
    if (this.disposed) return Object.freeze({ admitted: false, level: 'critical', reason: 'none' })
    const normalized = scopeName(scope)
    const at = validTime(now)
    if (normalized === null || at === null) return Object.freeze({ admitted: false, level: 'critical', reason: 'none' })
    this.sweep(at)
    const state = this.scopes.get(normalized)
    if (!state) return Object.freeze({ admitted: true, level: 'nominal', reason: 'none' })
    if (state.level === 'critical') return Object.freeze({ admitted: priority === 'critical', level: state.level, reason: state.dominantSignal ?? 'none' })
    if (state.level === 'elevated') return Object.freeze({ admitted: priority !== 'background', level: state.level, reason: state.dominantSignal ?? 'none' })
    return Object.freeze({ admitted: true, level: state.level, reason: 'none' })
  }

  resetScope(scope: string, now: number): boolean {
    if (this.disposed) return false
    const normalized = scopeName(scope)
    const at = validTime(now)
    if (normalized === null || at === null) return false
    const state = this.scopes.get(normalized)
    if (!state) return false
    state.generation += 1
    state.level = 'nominal'
    state.dominantSignal = null
    state.recoveryStreak = 0
    state.samples = []
    state.touchedAt = at
    return true
  }

  removeScope(scope: string): boolean {
    if (this.disposed) return false
    const normalized = scopeName(scope)
    return normalized !== null && this.scopes.delete(normalized)
  }

  sweep(now: number): number {
    if (this.disposed) return 0
    const at = validTime(now)
    if (at === null) return 0
    let removed = 0
    const cutoff = at - this.policy.retentionMs
    for (const state of this.scopes.values()) {
      const before = state.samples.length
      state.samples = state.samples.filter((sample) => sample.at > cutoff)
      removed += before - state.samples.length
      this.recalculate(state)
    }
    return removed
  }

  snapshot(now?: number): RuntimePressureSnapshot {
    if (now !== undefined) this.sweep(now)
    if (this.disposed) return Object.freeze({ disposed: true, scopeCount: 0, scopes: Object.freeze([]) })
    const scopes = [...this.scopes.values()].sort((left, right) => left.scope.localeCompare(right.scope)).map((state) => this.scopeSnapshot(state))
    return Object.freeze({ disposed: false, scopeCount: scopes.length, scopes: Object.freeze(scopes) })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scopes.clear()
  }

  private recalculate(state: ScopeState): void {
    let dominant: StoredSample | null = null
    for (const sample of state.samples) {
      if (!dominant || sample.value > dominant.value || (sample.value === dominant.value && sample.sequence > dominant.sequence)) dominant = sample
    }
    const peak = dominant?.value ?? 0
    if (peak >= this.policy.criticalThreshold) {
      state.level = 'critical'
      state.dominantSignal = dominant?.signal ?? null
      state.recoveryStreak = 0
      return
    }
    if (peak >= this.policy.elevatedThreshold) {
      state.level = 'elevated'
      state.dominantSignal = dominant?.signal ?? null
      state.recoveryStreak = 0
      return
    }
    if (state.level !== 'nominal') {
      if (peak <= this.policy.recoveryThreshold) state.recoveryStreak += 1
      else state.recoveryStreak = 0
      if (state.recoveryStreak < this.policy.recoverySamples) return
    }
    state.level = 'nominal'
    state.dominantSignal = null
    state.recoveryStreak = 0
  }

  private ensureScopeCapacity(): void {
    if (this.scopes.size < this.policy.maxScopes) return
    const victim = [...this.scopes.values()].sort((left, right) => left.touchedAt - right.touchedAt || left.scope.localeCompare(right.scope))[0]
    if (victim) this.scopes.delete(victim.scope)
  }

  private scopeSnapshot(state: ScopeState): RuntimePressureScopeSnapshot {
    return Object.freeze({ scope: state.scope, generation: state.generation, level: state.level, dominantSignal: state.dominantSignal, sampleCount: state.samples.length, recoveryStreak: state.recoveryStreak, touchedAt: state.touchedAt })
  }
}
