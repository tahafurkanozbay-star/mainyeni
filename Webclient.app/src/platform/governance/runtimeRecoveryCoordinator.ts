import { RuntimeCircuitBreaker, type RuntimeCircuitPolicy, type RuntimeCircuitPriority } from './runtimeCircuitBreaker'
import { RuntimeHealthWindow, type RuntimeHealthPolicy, type RuntimeHealthSignal } from './runtimeHealthWindow'
import { RuntimeRetryGovernor, type RuntimeRetryPolicy, type RuntimeRetryTicket } from './runtimeRetryGovernor'

export interface RuntimeRecoveryPolicy {
  readonly circuit?: Partial<RuntimeCircuitPolicy>
  readonly retry?: Partial<RuntimeRetryPolicy>
  readonly health?: Partial<RuntimeHealthPolicy>
}
export interface RuntimeRecoveryAttempt {
  readonly scope: string
  readonly generation: number
  readonly circuitId: string
  readonly retry: RuntimeRetryTicket
  readonly issuedAt: number
}
export interface RuntimeRecoverySnapshot {
  readonly circuitScopes: number
  readonly openCircuits: number
  readonly halfOpenCircuits: number
  readonly retryScopes: number
  readonly activeRetries: number
  readonly healthScopes: number
  readonly unhealthyScopes: number
  readonly degradedScopes: number
}
interface AttemptState { readonly attempt: RuntimeRecoveryAttempt; readonly circuitPermit: NonNullable<ReturnType<RuntimeCircuitBreaker['acquire']>> }
function normalizeScope(value: string): string { const scope = value.trim(); if (scope.length === 0 || scope.length > 128) throw new TypeError('scope must contain 1..128 characters'); return scope }
function validNow(value: number): number { if (!Number.isFinite(value) || value < 0) throw new TypeError('now must be finite and non-negative'); return value }

export class RuntimeRecoveryCoordinator {
  readonly circuit: RuntimeCircuitBreaker
  readonly retry: RuntimeRetryGovernor
  readonly health: RuntimeHealthWindow
  private readonly attempts = new Map<string, AttemptState>()
  private readonly generations = new Map<string, number>()
  private disposed = false

  constructor(policy: RuntimeRecoveryPolicy = {}) {
    this.circuit = new RuntimeCircuitBreaker(policy.circuit)
    this.retry = new RuntimeRetryGovernor(policy.retry)
    this.health = new RuntimeHealthWindow(policy.health)
  }

  acquire(scopeInput: string, priority: RuntimeCircuitPriority, nowInput: number): RuntimeRecoveryAttempt | null {
    this.assertLive()
    const scope = normalizeScope(scopeInput)
    const now = validNow(nowInput)
    const circuitPermit = this.circuit.acquire(scope, priority, now)
    if (!circuitPermit) return null
    const retry = this.retry.acquire(scope, priority, now)
    if (!retry) { this.circuit.cancel(circuitPermit, now); return null }
    const generation = this.generations.get(scope) ?? 1
    const attempt = Object.freeze({ scope, generation, circuitId: circuitPermit.id, retry, issuedAt: now })
    this.attempts.set(retry.id, { attempt, circuitPermit })
    return attempt
  }

  canRun(attempt: RuntimeRecoveryAttempt, nowInput: number): boolean {
    this.assertLive()
    const now = validNow(nowInput)
    const state = this.validate(attempt)
    return state !== null && this.retry.canRun(state.attempt.retry, now)
  }

  succeed(attempt: RuntimeRecoveryAttempt, nowInput: number): boolean {
    return this.complete(attempt, 'success', nowInput)
  }

  fail(attempt: RuntimeRecoveryAttempt, nowInput: number, signal: Exclude<RuntimeHealthSignal, 'success'> = 'failure'): boolean {
    return this.complete(attempt, signal, nowInput)
  }

  cancel(attempt: RuntimeRecoveryAttempt, nowInput: number): boolean {
    this.assertLive()
    const now = validNow(nowInput)
    const state = this.validate(attempt)
    if (!state) return false
    this.attempts.delete(attempt.retry.id)
    this.retry.complete(state.attempt.retry, 'cancelled', now)
    this.circuit.cancel(state.circuitPermit, now)
    return true
  }

  resetScope(scopeInput: string, nowInput: number): boolean {
    this.assertLive()
    const scope = normalizeScope(scopeInput)
    const now = validNow(nowInput)
    let changed = false
    for (const [id, state] of this.attempts) if (state.attempt.scope === scope) { this.attempts.delete(id); changed = true }
    changed = this.circuit.resetScope(scope, now) || changed
    changed = this.retry.resetScope(scope, now) || changed
    changed = this.health.resetScope(scope, now) || changed
    if (changed) this.generations.set(scope, (this.generations.get(scope) ?? 1) + 1)
    return changed
  }

  removeScope(scopeInput: string): boolean {
    this.assertLive()
    const scope = normalizeScope(scopeInput)
    for (const state of this.attempts.values()) if (state.attempt.scope === scope) return false
    const a = this.circuit.removeScope(scope)
    const b = this.retry.removeScope(scope)
    const c = this.health.removeScope(scope)
    this.generations.delete(scope)
    return a || b || c
  }

  snapshot(nowInput: number): RuntimeRecoverySnapshot {
    this.assertLive()
    const now = validNow(nowInput)
    const circuit = this.circuit.snapshot(now)
    const retry = this.retry.snapshot(now)
    const health = this.health.snapshot(now)
    return Object.freeze({ circuitScopes: circuit.scopes, openCircuits: circuit.open, halfOpenCircuits: circuit.halfOpen, retryScopes: retry.scopes, activeRetries: retry.activeTickets, healthScopes: health.scopes, unhealthyScopes: health.unhealthyScopes, degradedScopes: health.degradedScopes })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.attempts.clear(); this.generations.clear(); this.circuit.dispose(); this.retry.dispose(); this.health.dispose()
  }

  private complete(attempt: RuntimeRecoveryAttempt, signal: RuntimeHealthSignal, nowInput: number): boolean {
    this.assertLive()
    const now = validNow(nowInput)
    const state = this.validate(attempt)
    if (!state) return false
    this.attempts.delete(attempt.retry.id)
    if (signal === 'success') { this.retry.complete(state.attempt.retry, 'success', now); this.circuit.succeed(state.circuitPermit, now) }
    else { this.retry.complete(state.attempt.retry, 'failure', now); this.circuit.fail(state.circuitPermit, now) }
    this.health.record(attempt.scope, signal, now)
    return true
  }

  private validate(attempt: RuntimeRecoveryAttempt): AttemptState | null {
    if (!attempt || typeof attempt.scope !== 'string' || !attempt.retry) return null
    const state = this.attempts.get(attempt.retry.id)
    if (!state) return null
    if (state.attempt.scope !== attempt.scope || state.attempt.generation !== attempt.generation || state.attempt.circuitId !== attempt.circuitId || state.attempt.issuedAt !== attempt.issuedAt || state.attempt.retry.id !== attempt.retry.id) return null
    if ((this.generations.get(attempt.scope) ?? 1) !== attempt.generation) return null
    return state
  }

  private assertLive(): void { if (this.disposed) throw new Error('RuntimeRecoveryCoordinator is disposed') }
}
