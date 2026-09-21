export type QueryPriority = "interactive" | "foreground" | "background";

export interface QueryLifecyclePolicy {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly timeoutMs: number;
  readonly dedupeTtlMs: number;
}

export interface QueryRequest<T> {
  readonly key: string;
  readonly priority: QueryPriority;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
}

export interface QueryLifecycleSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly dedupedSubscribers: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly timedOut: number;
  readonly rejected: number;
}

export class QueryLifecycleError extends Error {
  public constructor(public readonly code: "invalid-key" | "queue-full" | "cancelled" | "timeout" | "disposed", message: string) {
    super(message);
    this.name = "QueryLifecycleError";
  }
}

interface Subscriber<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

interface WorkItem<T> {
  readonly key: string;
  readonly priority: QueryPriority;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber<T>>;
  readonly sequence: number;
  started: boolean;
}

const PRIORITY_WEIGHT: Readonly<Record<QueryPriority, number>> = Object.freeze({ interactive: 0, foreground: 1, background: 2 });
const DEFAULT_POLICY: QueryLifecyclePolicy = Object.freeze({ maxConcurrent: 6, maxQueued: 128, timeoutMs: 30_000, dedupeTtlMs: 250 });
const positiveInteger = (value: number, fallback: number): number => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const normalizePolicy = (input?: Partial<QueryLifecyclePolicy>): QueryLifecyclePolicy => {
  const merged = { ...DEFAULT_POLICY, ...input };
  return Object.freeze({
    maxConcurrent: positiveInteger(merged.maxConcurrent, DEFAULT_POLICY.maxConcurrent),
    maxQueued: positiveInteger(merged.maxQueued, DEFAULT_POLICY.maxQueued),
    timeoutMs: positiveInteger(merged.timeoutMs, DEFAULT_POLICY.timeoutMs),
    dedupeTtlMs: Number.isSafeInteger(merged.dedupeTtlMs) && merged.dedupeTtlMs >= 0 ? merged.dedupeTtlMs : DEFAULT_POLICY.dedupeTtlMs,
  });
};

export class QueryLifecycleCoordinator {
  readonly #policy: QueryLifecyclePolicy;
  readonly #inflight = new Map<string, WorkItem<unknown>>();
  readonly #recent = new Map<string, { readonly expiresAt: number; readonly value: unknown }>();
  readonly #queue: WorkItem<unknown>[] = [];
  #active = 0; #sequence = 0; #disposed = false; #completed = 0; #failed = 0; #cancelled = 0; #timedOut = 0; #rejected = 0; #dedupedSubscribers = 0;

  public constructor(policy?: Partial<QueryLifecyclePolicy>) { this.#policy = normalizePolicy(policy); }

  public execute<T>(request: QueryRequest<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new QueryLifecycleError("disposed", "Query lifecycle coordinator is disposed."));
    const key = request.key.trim();
    if (key.length === 0 || key.length > 512) { this.#rejected += 1; return Promise.reject(new QueryLifecycleError("invalid-key", "Query key must contain 1-512 characters.")); }
    if (request.signal?.aborted) { this.#cancelled += 1; return Promise.reject(new QueryLifecycleError("cancelled", "Query subscriber was already cancelled.")); }
    this.#pruneRecent();
    const cached = this.#recent.get(key); if (cached) return Promise.resolve(cached.value as T);
    const existing = this.#inflight.get(key) as WorkItem<T> | undefined;
    if (existing) { this.#dedupedSubscribers += 1; return this.#subscribe(existing, request.signal); }
    if (this.#queue.length >= this.#policy.maxQueued && this.#active >= this.#policy.maxConcurrent) { this.#rejected += 1; return Promise.reject(new QueryLifecycleError("queue-full", "Bounded GIS query queue is full.")); }
    const item: WorkItem<T> = { key, priority: request.priority, execute: request.execute, controller: new AbortController(), subscribers: new Set(), sequence: this.#sequence++, started: false };
    this.#inflight.set(key, item as WorkItem<unknown>);
    const promise = this.#subscribe(item, request.signal);
    this.#queue.push(item as WorkItem<unknown>);
    this.#queue.sort((left, right) => PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority] || left.sequence - right.sequence);
    this.#drain(); return promise;
  }

  public snapshot(): QueryLifecycleSnapshot { return Object.freeze({ active: this.#active, queued: this.#queue.length, dedupedSubscribers: this.#dedupedSubscribers, completed: this.#completed, failed: this.#failed, cancelled: this.#cancelled, timedOut: this.#timedOut, rejected: this.#rejected }); }
  public dispose(reason = "GIS query lifecycle disposed."): void {
    if (this.#disposed) return; this.#disposed = true; const error = new QueryLifecycleError("disposed", reason);
    for (const item of this.#inflight.values()) { item.controller.abort(error); this.#settleSubscribers(item, "reject", error); }
    this.#inflight.clear(); this.#queue.length = 0; this.#recent.clear();
  }

  #subscribe<T>(item: WorkItem<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const subscriber: Subscriber<T> = { resolve, reject, signal, settled: false };
      if (signal) {
        subscriber.abortListener = () => {
          if (subscriber.settled) return; subscriber.settled = true; item.subscribers.delete(subscriber); this.#cancelled += 1;
          reject(new QueryLifecycleError("cancelled", "GIS query subscriber cancelled."));
          if (item.subscribers.size === 0) { item.controller.abort(new QueryLifecycleError("cancelled", "All GIS query subscribers cancelled.")); if (!item.started) { const index = this.#queue.indexOf(item as WorkItem<unknown>); if (index >= 0) this.#queue.splice(index, 1); this.#inflight.delete(item.key); } }
        };
        signal.addEventListener("abort", subscriber.abortListener, { once: true });
      }
      item.subscribers.add(subscriber);
    });
  }

  #drain(): void { while (!this.#disposed && this.#active < this.#policy.maxConcurrent && this.#queue.length > 0) { const item = this.#queue.shift(); if (!item || item.subscribers.size === 0) continue; item.started = true; this.#active += 1; void this.#run(item); } }
  async #run(item: WorkItem<unknown>): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined; let timedOut = false;
    try {
      const timeout = new Promise<never>((_, reject) => { timeoutHandle = setTimeout(() => { timedOut = true; const error = new QueryLifecycleError("timeout", `GIS query exceeded ${this.#policy.timeoutMs}ms.`); item.controller.abort(error); reject(error); }, this.#policy.timeoutMs); });
      const value = await Promise.race([item.execute(item.controller.signal), timeout]);
      if (this.#policy.dedupeTtlMs > 0) this.#recent.set(item.key, { value, expiresAt: Date.now() + this.#policy.dedupeTtlMs });
      this.#completed += 1; this.#settleSubscribers(item, "resolve", value);
    } catch (error) {
      if (timedOut) this.#timedOut += 1; else if (item.controller.signal.aborted) this.#cancelled += 1; else this.#failed += 1;
      this.#settleSubscribers(item, "reject", error);
    } finally { if (timeoutHandle !== undefined) clearTimeout(timeoutHandle); this.#inflight.delete(item.key); this.#active -= 1; this.#drain(); }
  }
  #settleSubscribers(item: WorkItem<unknown>, mode: "resolve" | "reject", payload: unknown): void {
    for (const subscriber of item.subscribers) { if (subscriber.settled) continue; subscriber.settled = true; if (subscriber.signal && subscriber.abortListener) subscriber.signal.removeEventListener("abort", subscriber.abortListener); if (mode === "resolve") subscriber.resolve(payload); else subscriber.reject(payload); }
    item.subscribers.clear();
  }
  #pruneRecent(): void { const now = Date.now(); for (const [key, entry] of this.#recent) if (entry.expiresAt <= now) this.#recent.delete(key); }
}
