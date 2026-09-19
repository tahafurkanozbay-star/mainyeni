import { BoundedBulkhead, BulkheadRejectedError, type BulkheadOptions } from './bulkhead';
import { BoundedCircuitBreaker, CircuitOpenError, type CircuitBreakerOptions } from './circuitBreaker';
import { BoundedFailureBudget, type FailureBudgetOptions, type FailureBudgetState } from './failureBudget';
import { BoundedRetryPolicy, RetryAbortedError, type RetryPolicyOptions } from './retryPolicy';

export type ResiliencePriority = 'critical' | 'interactive' | 'background';
export type ResilienceOutcome = 'success' | 'failure' | 'rejected' | 'cancelled';
export interface ResilienceClock { now(): number; }
export interface ResilienceRequest<T> {
  readonly owner: string;
  readonly key: string;
  readonly priority?: ResiliencePriority;
  readonly signal?: AbortSignal;
  readonly operation: (signal: AbortSignal, attempt: number) => Promise<T>;
}
export interface ResilienceCoordinatorOptions {
  readonly bulkhead?: BulkheadOptions;
  readonly circuitBreaker?: CircuitBreakerOptions;
  readonly failureBudget?: FailureBudgetOptions;
  readonly retry?: RetryPolicyOptions;
  readonly historyLimit?: number;
  readonly maxOwners?: number;
  readonly maxKeys?: number;
  readonly clock?: ResilienceClock;
}
export interface ResilienceEvent {
  readonly sequence: number; readonly at: number; readonly owner: string; readonly key: string;
  readonly priority: ResiliencePriority; readonly outcome: ResilienceOutcome; readonly attempts: number;
  readonly durationMs: number; readonly budgetState: FailureBudgetState; readonly errorName?: string;
}
export interface ResilienceSnapshot {
  readonly disposed: boolean; readonly active: number; readonly owners: number; readonly keys: number;
  readonly budgetState: FailureBudgetState; readonly accepted: number; readonly rejected: number;
  readonly succeeded: number; readonly failed: number; readonly cancelled: number;
  readonly history: readonly ResilienceEvent[];
}
export class ResilienceCoordinatorError extends Error {
  constructor(readonly code: 'INVALID_REQUEST'|'COORDINATOR_DISPOSED'|'OWNER_LIMIT_EXCEEDED'|'KEY_LIMIT_EXCEEDED'|'FAILURE_BUDGET_EXHAUSTED'|'CANCELLED', message: string) {
    super(message); this.name = 'ResilienceCoordinatorError';
  }
}
const SYSTEM_CLOCK: ResilienceClock = Object.freeze({ now: () => Date.now() });
const PRIORITIES = new Set<ResiliencePriority>(['critical', 'interactive', 'background']);
const boundedInteger = (name: string, value: number, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
};
const normalizeIdentity = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new ResilienceCoordinatorError('INVALID_REQUEST', `${name} must contain 1-160 characters`);
  return normalized;
};
const errorName = (error: unknown): string => error instanceof Error && error.name.trim() ? error.name.slice(0, 80) : 'UnknownError';
interface MutableStats { accepted: number; rejected: number; succeeded: number; failed: number; cancelled: number; }

/** Bounded composition boundary for retry, circuit, bulkhead and rolling failure-budget policy. */
export class BoundedResilienceCoordinator {
  readonly #bulkhead: BoundedBulkhead; readonly #breaker: BoundedCircuitBreaker;
  readonly #budget: BoundedFailureBudget; readonly #retry: BoundedRetryPolicy; readonly #clock: ResilienceClock;
  readonly #historyLimit: number; readonly #maxOwners: number; readonly #maxKeys: number;
  readonly #history: ResilienceEvent[] = []; readonly #owners = new Map<string, number>(); readonly #keys = new Map<string, number>();
  readonly #activeControllers = new Set<AbortController>();
  readonly #stats: MutableStats = { accepted: 0, rejected: 0, succeeded: 0, failed: 0, cancelled: 0 };
  #sequence = 0; #disposed = false; #lastObservedAt: number | undefined;

  constructor(options: ResilienceCoordinatorOptions = {}) {
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 128, 0, 2_000);
    this.#maxOwners = boundedInteger('maxOwners', options.maxOwners ?? 128, 1, 10_000);
    this.#maxKeys = boundedInteger('maxKeys', options.maxKeys ?? 512, 1, 50_000);
    this.#bulkhead = new BoundedBulkhead(options.bulkhead);
    this.#breaker = new BoundedCircuitBreaker(options.circuitBreaker);
    this.#budget = new BoundedFailureBudget({ ...options.failureBudget, clock: () => this.#now() });
    this.#retry = new BoundedRetryPolicy(options.retry);
  }

  async execute<T>(request: ResilienceRequest<T>): Promise<T> {
    this.#assertUsable();
    const owner = normalizeIdentity(request.owner, 'owner'); const key = normalizeIdentity(request.key, 'key');
    const priority = request.priority ?? 'interactive';
    if (!PRIORITIES.has(priority)) throw new ResilienceCoordinatorError('INVALID_REQUEST', 'priority is invalid');
    if (request.signal?.aborted) { this.#stats.cancelled += 1; throw new ResilienceCoordinatorError('CANCELLED', 'operation was cancelled before admission'); }
    this.#assertIdentityCapacity(owner, key);
    if (priority !== 'critical' && !this.#budget.allowsOptionalWork()) { this.#stats.rejected += 1; throw new ResilienceCoordinatorError('FAILURE_BUDGET_EXHAUSTED', 'optional work rejected by failure budget'); }
    const controller = new AbortController(); const unlink = this.#linkSignal(request.signal, controller);
    this.#activeControllers.add(controller); this.#increment(this.#owners, owner); this.#increment(this.#keys, key); this.#stats.accepted += 1;
    const startedAt = this.#now(); let attempts = 0;
    try {
      const value = await this.#bulkhead.run(async () => this.#breaker.execute(async () => {
        const result = await this.#retry.execute(async (context) => { attempts = context.attempt; return request.operation(controller.signal, context.attempt); }, controller.signal);
        attempts = result.attempts;
        if (!result.ok) throw result.error;
        return result.value;
      }), { owner, signal: controller.signal });
      this.#budget.record('success', { owner }); this.#stats.succeeded += 1; this.#record(owner, key, priority, 'success', attempts, startedAt); return value;
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof RetryAbortedError || error instanceof BulkheadRejectedError && error.reason === 'aborted';
      if (cancelled) { this.#stats.cancelled += 1; this.#budget.record('ignored', { owner }); this.#record(owner, key, priority, 'cancelled', attempts, startedAt, error); }
      else if (error instanceof BulkheadRejectedError || error instanceof CircuitOpenError) { this.#stats.rejected += 1; this.#budget.record('ignored', { owner }); this.#record(owner, key, priority, 'rejected', attempts, startedAt, error); }
      else { this.#stats.failed += 1; this.#budget.record('failure', { owner }); this.#record(owner, key, priority, 'failure', attempts, startedAt, error); }
      throw error;
    } finally { unlink(); this.#activeControllers.delete(controller); this.#decrement(this.#owners, owner); this.#decrement(this.#keys, key); }
  }

  snapshot(): ResilienceSnapshot {
    return Object.freeze({ disposed: this.#disposed, active: this.#activeControllers.size, owners: this.#owners.size, keys: this.#keys.size,
      budgetState: this.#budget.snapshot().state, ...this.#stats, history: Object.freeze(this.#history.map((event) => Object.freeze({ ...event }))) });
  }
  resetHealth(): void {
    this.#assertUsable();
    if (this.#activeControllers.size) throw new ResilienceCoordinatorError('INVALID_REQUEST', 'health cannot be reset while operations are active');
    this.#budget.reset(); this.#breaker.reset();
  }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; for (const controller of this.#activeControllers) controller.abort('resilience-coordinator-disposed'); this.#bulkhead.dispose(); }
  #assertIdentityCapacity(owner: string, key: string): void {
    if (!this.#owners.has(owner) && this.#owners.size >= this.#maxOwners) throw new ResilienceCoordinatorError('OWNER_LIMIT_EXCEEDED', 'active owner limit exceeded');
    if (!this.#keys.has(key) && this.#keys.size >= this.#maxKeys) throw new ResilienceCoordinatorError('KEY_LIMIT_EXCEEDED', 'active key limit exceeded');
  }
  #linkSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) return () => undefined; const abort = () => controller.abort(signal.reason); signal.addEventListener('abort', abort, { once: true }); return () => signal.removeEventListener('abort', abort);
  }
  #record(owner: string, key: string, priority: ResiliencePriority, outcome: ResilienceOutcome, attempts: number, startedAt: number, error?: unknown): void {
    if (!this.#historyLimit) return; const at = this.#now();
    this.#history.push(Object.freeze({ sequence: ++this.#sequence, at, owner, key, priority, outcome, attempts, durationMs: Math.max(0, at - startedAt), budgetState: this.#budget.snapshot().state, ...(error === undefined ? {} : { errorName: errorName(error) }) }));
    const overflow = this.#history.length - this.#historyLimit; if (overflow > 0) this.#history.splice(0, overflow);
  }
  #increment(map: Map<string, number>, key: string): void { map.set(key, (map.get(key) ?? 0) + 1); }
  #decrement(map: Map<string, number>, key: string): void { const next = (map.get(key) ?? 1) - 1; if (next <= 0) map.delete(key); else map.set(key, next); }
  #now(): number {
    const now = this.#clock.now(); if (!Number.isFinite(now) || now < 0) throw new ResilienceCoordinatorError('INVALID_REQUEST', 'clock returned an invalid timestamp');
    if (this.#lastObservedAt !== undefined && now < this.#lastObservedAt) throw new ResilienceCoordinatorError('INVALID_REQUEST', 'clock must be monotonic'); this.#lastObservedAt = now; return now;
  }
  #assertUsable(): void { if (this.#disposed) throw new ResilienceCoordinatorError('COORDINATOR_DISPOSED', 'resilience coordinator is disposed'); }
}
