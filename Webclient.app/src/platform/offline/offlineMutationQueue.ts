export type OfflineMutationPriority = 'critical' | 'interactive' | 'background';
export type OfflineMutationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface OfflineMutationDescriptor<TPayload = unknown> { readonly id: string; readonly owner: string; readonly operation: string; readonly payload: TPayload; readonly priority?: OfflineMutationPriority; readonly createdAt?: number; readonly expiresAt?: number; readonly dedupeKey?: string; readonly maxAttempts?: number; readonly metadata?: Readonly<Record<string, string>>; }
export interface OfflineMutationExecutorContext { readonly signal: AbortSignal; readonly attempt: number; readonly id: string; readonly owner: string; readonly operation: string; }
export type OfflineMutationExecutor<TPayload = unknown, TResult = unknown> = (payload: TPayload, context: OfflineMutationExecutorContext) => Promise<TResult>;
export interface OfflineMutationQueueOptions { readonly maxEntries?: number; readonly maxEntriesPerOwner?: number; readonly maxPayloadBytes?: number; readonly maxMetadataEntries?: number; readonly maxMetadataValueLength?: number; readonly maxConcurrent?: number; readonly maxAttempts?: number; readonly maxAgeMs?: number; readonly historyLimit?: number; readonly clock?: () => number; readonly estimateBytes?: (value: unknown) => number; }
export interface OfflineMutationSnapshot { readonly queued: number; readonly running: number; readonly disposed: boolean; readonly totalAccepted: number; readonly totalRejected: number; readonly totalSucceeded: number; readonly totalFailed: number; readonly totalCancelled: number; readonly totalExpired: number; }
export interface OfflineMutationEvent { readonly sequence: number; readonly at: number; readonly id: string; readonly owner: string; readonly operation: string; readonly state: OfflineMutationState | 'accepted' | 'rejected' | 'deduplicated' | 'disposed'; readonly attempt: number; readonly reason?: string; }
export interface OfflineMutationResult<TResult = unknown> { readonly id: string; readonly state: Extract<OfflineMutationState, 'succeeded' | 'failed' | 'cancelled' | 'expired'>; readonly attempts: number; readonly value?: TResult; readonly error?: unknown; }
export type OfflineMutationRejectionReason = 'disposed' | 'queue-capacity' | 'owner-capacity' | 'payload-budget' | 'invalid-descriptor' | 'expired';
export class OfflineMutationRejectedError extends Error { constructor(readonly reason: OfflineMutationRejectionReason) { super(`Offline mutation rejected: ${reason}`); this.name = 'OfflineMutationRejectedError'; } }
interface QueueEntry { readonly descriptor: Required<Pick<OfflineMutationDescriptor, 'id' | 'owner' | 'operation' | 'payload'>> & OfflineMutationDescriptor; readonly priority: OfflineMutationPriority; readonly createdAt: number; readonly expiresAt: number; readonly maxAttempts: number; readonly controller: AbortController; readonly promise: Promise<OfflineMutationResult>; readonly resolve: (value: OfflineMutationResult) => void; state: 'queued' | 'running'; attempts: number; }
const priorityWeight: Readonly<Record<OfflineMutationPriority, number>> = Object.freeze({ critical: 0, interactive: 1, background: 2 });
const priorityOrder: readonly OfflineMutationPriority[] = Object.freeze(['critical', 'interactive', 'background']);
const boundedInteger = (name: string, value: number, min: number, max: number): number => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer between ${min} and ${max}`); return value; };
const containsControlCharacter = (value: string): boolean => { for (const character of value) { const codePoint = character.codePointAt(0); if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true; } return false; };
const boundedText = (name: string, value: string, maxLength = 128): string => { const normalized = value.trim(); if (!normalized || normalized.length > maxLength || containsControlCharacter(normalized)) throw new TypeError(`${name} must be non-empty bounded text`); return normalized; };
const encoder = new TextEncoder();
const defaultEstimateBytes = (value: unknown): number => {
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number): number => {
    if (depth > 24) throw new RangeError('payload nesting exceeds 24 levels');
    if (current === null || current === undefined) return 4;
    if (typeof current === 'string') return encoder.encode(current).byteLength;
    if (typeof current === 'number' || typeof current === 'boolean') return 8;
    if (typeof current === 'bigint' || typeof current === 'symbol' || typeof current === 'function') {
      throw new TypeError('payload contains unsupported value');
    }
    if (current instanceof ArrayBuffer) return current.byteLength;
    if (ArrayBuffer.isView(current)) return current.byteLength;
    if (current instanceof Date) return 24;
    if (typeof current !== 'object') return 0;
    if (seen.has(current)) throw new TypeError('payload must not contain cycles');

    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return current.reduce((bytes, item) => bytes + visit(item, depth + 1), 0);
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('payload must contain plain data');
      }
      return Object.entries(current as Record<string, unknown>).reduce(
        (bytes, [key, item]) => bytes + encoder.encode(key).byteLength + visit(item, depth + 1),
        0,
      );
    } finally {
      seen.delete(current);
    }
  };
  return visit(value, 0);
};

export class OfflineMutationQueue {
  readonly maxEntries: number; readonly maxEntriesPerOwner: number; readonly maxPayloadBytes: number; readonly maxMetadataEntries: number; readonly maxMetadataValueLength: number; readonly maxConcurrent: number; readonly maxAttempts: number; readonly maxAgeMs: number; readonly historyLimit: number;
  readonly #clock: () => number; readonly #estimateBytes: (value: unknown) => number; readonly #entries = new Map<string, QueueEntry>(); readonly #ownerCounts = new Map<string, number>(); readonly #dedupeEntries = new Map<string, QueueEntry>(); readonly #ready: Record<OfflineMutationPriority, QueueEntry[]> = { critical: [], interactive: [], background: [] }; readonly #history: OfflineMutationEvent[] = []; #executor: OfflineMutationExecutor | undefined; #online = false; #disposed = false; #running = 0; #sequence = 0; #totalAccepted = 0; #totalRejected = 0; #totalSucceeded = 0; #totalFailed = 0; #totalCancelled = 0; #totalExpired = 0;
  constructor(options: OfflineMutationQueueOptions = {}) { this.maxEntries = boundedInteger('maxEntries', options.maxEntries ?? 256, 1, 10_000); this.maxEntriesPerOwner = boundedInteger('maxEntriesPerOwner', options.maxEntriesPerOwner ?? 64, 1, this.maxEntries); this.maxPayloadBytes = boundedInteger('maxPayloadBytes', options.maxPayloadBytes ?? 256 * 1024, 1, 8 * 1024 * 1024); this.maxMetadataEntries = boundedInteger('maxMetadataEntries', options.maxMetadataEntries ?? 16, 0, 64); this.maxMetadataValueLength = boundedInteger('maxMetadataValueLength', options.maxMetadataValueLength ?? 256, 1, 2048); this.maxConcurrent = boundedInteger('maxConcurrent', options.maxConcurrent ?? 2, 1, 16); this.maxAttempts = boundedInteger('maxAttempts', options.maxAttempts ?? 3, 1, 10); this.maxAgeMs = boundedInteger('maxAgeMs', options.maxAgeMs ?? 24 * 60 * 60 * 1000, 1_000, 7 * 24 * 60 * 60 * 1000); this.historyLimit = boundedInteger('historyLimit', options.historyLimit ?? 128, 0, 2_000); this.#clock = options.clock ?? Date.now; this.#estimateBytes = options.estimateBytes ?? defaultEstimateBytes; }
  setExecutor(executor: OfflineMutationExecutor | undefined): void { if (!this.#disposed) { this.#executor = executor; this.#drain(); } }
  setOnline(online: boolean): void { if (!this.#disposed) { this.#online = online; if (online) this.#drain(); } }
  enqueue<TPayload>(descriptor: OfflineMutationDescriptor<TPayload>): Promise<OfflineMutationResult> { if (this.#disposed) return Promise.reject(this.#reject(descriptor, 'disposed')); let normalized: QueueEntry['descriptor']; let createdAt: number; let expiresAt: number; let maxAttempts: number; let dedupeKey: string | undefined; try { const id = boundedText('id', descriptor.id, 160); const owner = boundedText('owner', descriptor.owner, 128); const operation = boundedText('operation', descriptor.operation, 128); const sameId = this.#entries.get(id); if (sameId) return sameId.promise; if (descriptor.dedupeKey) { dedupeKey = boundedText('dedupeKey', descriptor.dedupeKey, 192); const duplicate = this.#dedupeEntries.get(dedupeKey); if (duplicate) { this.#record(duplicate, 'deduplicated', 0); return duplicate.promise; } } createdAt = descriptor.createdAt ?? this.#clock(); if (!Number.isFinite(createdAt) || createdAt < 0) throw new TypeError('createdAt must be finite and non-negative'); expiresAt = descriptor.expiresAt ?? createdAt + this.maxAgeMs; if (!Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > this.maxAgeMs) throw new TypeError('expiresAt must be after createdAt and within maxAgeMs'); maxAttempts = boundedInteger('descriptor.maxAttempts', descriptor.maxAttempts ?? this.maxAttempts, 1, this.maxAttempts); this.#validateMetadata(descriptor.metadata); const bytes = this.#estimateBytes(descriptor.payload); if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxPayloadBytes) return Promise.reject(this.#reject(descriptor, 'payload-budget')); normalized = { ...descriptor, ...(dedupeKey ? { dedupeKey } : {}), id, owner, operation, payload: descriptor.payload }; } catch (error) { if (error instanceof OfflineMutationRejectedError) return Promise.reject(error); return Promise.reject(this.#reject(descriptor, 'invalid-descriptor')); } if (expiresAt <= this.#clock()) return Promise.reject(this.#reject(normalized, 'expired')); if (this.#entries.size >= this.maxEntries) return Promise.reject(this.#reject(normalized, 'queue-capacity')); if ((this.#ownerCounts.get(normalized.owner) ?? 0) >= this.maxEntriesPerOwner) return Promise.reject(this.#reject(normalized, 'owner-capacity')); let resolve!: (value: OfflineMutationResult) => void; const promise = new Promise<OfflineMutationResult>(res => { resolve = res; }); const entry: QueueEntry = { descriptor: normalized, priority: descriptor.priority ?? 'interactive', createdAt, expiresAt, maxAttempts, controller: new AbortController(), promise, resolve, state: 'queued', attempts: 0 }; this.#entries.set(normalized.id, entry); this.#ownerCounts.set(normalized.owner, (this.#ownerCounts.get(normalized.owner) ?? 0) + 1); if (dedupeKey) this.#dedupeEntries.set(dedupeKey, entry); this.#queueReady(entry); this.#totalAccepted += 1; this.#record(entry, 'accepted', 0); this.#drain(); return promise; }
  cancel(id: string, reason = 'cancelled'): boolean { const entry = this.#entries.get(id); if (!entry) return false; entry.controller.abort(reason); if (entry.state === 'queued') this.#finish(entry, 'cancelled', undefined, reason); return true; }
  cancelOwner(owner: string, reason = 'owner-cancelled'): number {
    const normalized = boundedText('owner', owner, 128);
    return Array.from(this.#entries.values()).reduce(
      (cancelled, entry) =>
        entry.descriptor.owner === normalized && this.cancel(entry.descriptor.id, reason)
          ? cancelled + 1
          : cancelled,
      0,
    );
  }
  pruneExpired(): number {
    const now = this.#clock();
    return Array.from(this.#entries.values()).reduce((expired, entry) => {
      if (entry.state !== 'queued' || entry.expiresAt > now) return expired;
      this.#finish(entry, 'expired', undefined, 'expired-before-replay');
      return expired + 1;
    }, 0);
  }
  snapshot(): OfflineMutationSnapshot {
    const queued = Array.from(this.#entries.values()).reduce(
      (count, entry) => count + (entry.state === 'queued' ? 1 : 0),
      0,
    );
    return Object.freeze({ queued, running: this.#running, disposed: this.#disposed, totalAccepted: this.#totalAccepted, totalRejected: this.#totalRejected, totalSucceeded: this.#totalSucceeded, totalFailed: this.#totalFailed, totalCancelled: this.#totalCancelled, totalExpired: this.#totalExpired });
  }
  history(): readonly OfflineMutationEvent[] { return Object.freeze(this.#history.map(event => Object.freeze({ ...event }))); }
  pending(): readonly Readonly<OfflineMutationDescriptor>[] { return Object.freeze(Array.from(this.#entries.values()).sort((a, b) => this.#compareEntries(a, b)).map(entry => { const descriptor = entry.descriptor; return Object.freeze({ ...descriptor, ...(descriptor.metadata ? { metadata: Object.freeze({ ...descriptor.metadata }) } : {}) }); })); }
  dispose(reason = 'queue-disposed'): void {
    if (this.#disposed) return;
    this.#disposed = true;
    Array.from(this.#entries.values()).reduce((count, entry) => {
      entry.controller.abort(reason);
      if (entry.state === 'queued') this.#finish(entry, 'cancelled', undefined, reason);
      return count + 1;
    }, 0);
    this.#recordRaw('queue', 'queue', 'queue', 'disposed', 0, reason);
  }
  #validateMetadata(metadata: Readonly<Record<string, string>> | undefined): void {
    if (!metadata) return;
    const entries = Object.entries(metadata);
    if (entries.length > this.maxMetadataEntries) throw new RangeError('metadata entry budget exceeded');
    entries.reduce((count, [key, value]) => {
      boundedText('metadata key', key, 64);
      if (typeof value !== 'string' || value.length > this.maxMetadataValueLength || containsControlCharacter(value)) {
        throw new TypeError('metadata value is invalid');
      }
      return count + 1;
    }, 0);
  }
  #compareEntries(a: QueueEntry, b: QueueEntry): number { return priorityWeight[a.priority] - priorityWeight[b.priority] || a.createdAt - b.createdAt || a.descriptor.id.localeCompare(b.descriptor.id); }
  #compareWithinPriority(a: QueueEntry, b: QueueEntry): number { return a.createdAt - b.createdAt || a.descriptor.id.localeCompare(b.descriptor.id); }
  #queueReady(entry: QueueEntry): void { const bucket = this.#ready[entry.priority]; let low = 0; let high = bucket.length; while (low < high) { const middle = (low + high) >>> 1; const candidate = bucket[middle]; if (candidate && this.#compareWithinPriority(candidate, entry) <= 0) low = middle + 1; else high = middle; } bucket.splice(low, 0, entry); }
  #takeReady(): QueueEntry | undefined { for (const priority of priorityOrder) { const bucket = this.#ready[priority]; while (bucket.length > 0) { const candidate = bucket.shift(); if (candidate && candidate.state === 'queued' && this.#entries.get(candidate.descriptor.id) === candidate) return candidate; } } return undefined; }
  #releaseIndexes(entry: QueueEntry): void { const owner = entry.descriptor.owner; const ownerCount = this.#ownerCounts.get(owner) ?? 0; if (ownerCount <= 1) this.#ownerCounts.delete(owner); else this.#ownerCounts.set(owner, ownerCount - 1); const dedupeKey = entry.descriptor.dedupeKey; if (dedupeKey && this.#dedupeEntries.get(dedupeKey) === entry) this.#dedupeEntries.delete(dedupeKey); }
  #reject(descriptor: Pick<OfflineMutationDescriptor, 'id' | 'owner' | 'operation'>, reason: OfflineMutationRejectionReason): OfflineMutationRejectedError { this.#totalRejected += 1; this.#recordRaw(descriptor.id || 'unknown', descriptor.owner || 'unknown', descriptor.operation || 'unknown', 'rejected', 0, reason); return new OfflineMutationRejectedError(reason); }
  #drain(): void { if (!this.#online || !this.#executor || this.#disposed) return; this.pruneExpired(); const availableSlots = Math.max(0, this.maxConcurrent - this.#running); for (let slot = 0; slot < availableSlots; slot += 1) { const next = this.#takeReady(); if (!next) break; this.#start(next); } }
  #start(entry: QueueEntry): void { const executor = this.#executor; if (!executor || entry.state !== 'queued') return; entry.state = 'running'; entry.attempts += 1; this.#running += 1; this.#record(entry, 'running', entry.attempts); void executor(entry.descriptor.payload, { signal: entry.controller.signal, attempt: entry.attempts, id: entry.descriptor.id, owner: entry.descriptor.owner, operation: entry.descriptor.operation }).then(value => this.#finish(entry, 'succeeded', value), error => { if (entry.controller.signal.aborted) { this.#finish(entry, 'cancelled', undefined, String(entry.controller.signal.reason ?? 'aborted')); return; } if (entry.attempts < entry.maxAttempts && entry.expiresAt > this.#clock()) { entry.state = 'queued'; this.#running -= 1; this.#queueReady(entry); this.#record(entry, 'queued', entry.attempts, 'retry'); this.#drain(); return; } this.#finish(entry, entry.expiresAt <= this.#clock() ? 'expired' : 'failed', undefined, error instanceof Error ? error.name : 'executor-failed', error); }); }
  #finish(entry: QueueEntry, state: OfflineMutationResult['state'], value?: unknown, reason?: string, error?: unknown): void { const wasRunning = entry.state === 'running'; const removed = this.#entries.delete(entry.descriptor.id); if (removed) this.#releaseIndexes(entry); if (wasRunning) this.#running = Math.max(0, this.#running - 1); if (state === 'succeeded') this.#totalSucceeded += 1; else if (state === 'failed') this.#totalFailed += 1; else if (state === 'cancelled') this.#totalCancelled += 1; else this.#totalExpired += 1; this.#record(entry, state, entry.attempts, reason); const result: OfflineMutationResult = { id: entry.descriptor.id, state, attempts: entry.attempts, ...(state === 'succeeded' ? { value } : {}), ...(error !== undefined ? { error } : {}) }; entry.resolve(Object.freeze(result)); this.#drain(); }
  #record(entry: QueueEntry, state: OfflineMutationEvent['state'], attempt: number, reason?: string): void { this.#recordRaw(entry.descriptor.id, entry.descriptor.owner, entry.descriptor.operation, state, attempt, reason); }
  #recordRaw(id: string, owner: string, operation: string, state: OfflineMutationEvent['state'], attempt: number, reason?: string): void { if (this.historyLimit === 0) return; const event: OfflineMutationEvent = Object.freeze({ sequence: ++this.#sequence, at: this.#clock(), id, owner, operation, state, attempt, ...(reason ? { reason: reason.slice(0, 160) } : {}) }); this.#history.push(event); if (this.#history.length > this.historyLimit) this.#history.splice(0, this.#history.length - this.historyLimit); }
}
