export interface ArcGisCacheEntry<T> {
  readonly key: string
  readonly value: T
  readonly datasetRevision: string
  readonly fingerprint: string
  readonly byteSize: number
  readonly storedAtMs: number
  readonly expiresAtMs: number
  readonly lastAccessedAtMs: number
}

export interface ArcGisCacheBudget {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly maxEntryBytes: number
  readonly maxTtlMs: number
  readonly maxKeyLength: number
  readonly maxRevisionLength: number
  readonly maxFingerprintLength: number
}

export interface ArcGisCacheSnapshot {
  readonly entries: number
  readonly bytes: number
  readonly keys: readonly string[]
}

const MAX_ENTRIES = 100_000
const MAX_BYTES = 512 * 1024 * 1024
const MAX_TTL = 24 * 60 * 60 * 1000

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function boundedText(value: string, name: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

/** Revision-aware, TTL/LRU and byte-bounded cache authority for admitted ArcGIS results. */
export class ArcGisCachePolicy<T> {
  private readonly budget: Readonly<ArcGisCacheBudget>
  private readonly entries = new Map<string, ArcGisCacheEntry<T>>()
  private bytes = 0
  private disposed = false

  constructor(budget: ArcGisCacheBudget) {
    this.budget = Object.freeze({
      maxEntries: integer(budget.maxEntries, 'maxEntries', 1, MAX_ENTRIES),
      maxBytes: integer(budget.maxBytes, 'maxBytes', 1, MAX_BYTES),
      maxEntryBytes: integer(budget.maxEntryBytes, 'maxEntryBytes', 1, MAX_BYTES),
      maxTtlMs: integer(budget.maxTtlMs, 'maxTtlMs', 1, MAX_TTL),
      maxKeyLength: integer(budget.maxKeyLength, 'maxKeyLength', 1, 1024),
      maxRevisionLength: integer(budget.maxRevisionLength, 'maxRevisionLength', 1, 256),
      maxFingerprintLength: integer(budget.maxFingerprintLength, 'maxFingerprintLength', 1, 512),
    })
    if (this.budget.maxEntryBytes > this.budget.maxBytes) throw new Error('maxEntryBytes must be <= maxBytes')
  }

  put(input: { readonly key: string; readonly value: T; readonly datasetRevision: string; readonly fingerprint: string; readonly byteSize: number; readonly ttlMs: number; readonly nowMs: number }): void {
    this.assertLive()
    const key = boundedText(input.key, 'cache-key', this.budget.maxKeyLength)
    const datasetRevision = boundedText(input.datasetRevision, 'dataset-revision', this.budget.maxRevisionLength)
    const fingerprint = boundedText(input.fingerprint, 'fingerprint', this.budget.maxFingerprintLength)
    const byteSize = integer(input.byteSize, 'byteSize', 0, this.budget.maxEntryBytes)
    const ttlMs = integer(input.ttlMs, 'ttlMs', 1, this.budget.maxTtlMs)
    const nowMs = integer(input.nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    if (nowMs > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error('cache-expiry-overflow')
    const previous = this.entries.get(key)
    if (previous) this.removeEntry(previous)
    const entry = Object.freeze({ key, value: input.value, datasetRevision, fingerprint, byteSize, storedAtMs: nowMs, expiresAtMs: nowMs + ttlMs, lastAccessedAtMs: nowMs })
    this.entries.set(key, entry)
    this.bytes += byteSize
    this.evictToBudget()
  }

  get(keyInput: string, datasetRevisionInput: string, fingerprintInput: string, nowMsInput: number): T | undefined {
    this.assertLive()
    const key = boundedText(keyInput, 'cache-key', this.budget.maxKeyLength)
    const datasetRevision = boundedText(datasetRevisionInput, 'dataset-revision', this.budget.maxRevisionLength)
    const fingerprint = boundedText(fingerprintInput, 'fingerprint', this.budget.maxFingerprintLength)
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAtMs <= nowMs || entry.datasetRevision !== datasetRevision || entry.fingerprint !== fingerprint) {
      this.removeEntry(entry)
      return undefined
    }
    this.entries.set(key, Object.freeze({ ...entry, lastAccessedAtMs: nowMs }))
    return entry.value
  }

  invalidateRevision(datasetRevisionInput: string): number {
    this.assertLive()
    const revision = boundedText(datasetRevisionInput, 'dataset-revision', this.budget.maxRevisionLength)
    let removed = 0
    for (const entry of [...this.entries.values()]) if (entry.datasetRevision === revision) { this.removeEntry(entry); removed += 1 }
    return removed
  }

  prune(nowMsInput: number): number {
    this.assertLive()
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    let removed = 0
    for (const entry of [...this.entries.values()]) if (entry.expiresAtMs <= nowMs) { this.removeEntry(entry); removed += 1 }
    return removed
  }

  snapshot(): ArcGisCacheSnapshot {
    return Object.freeze({ entries: this.entries.size, bytes: this.bytes, keys: Object.freeze([...this.entries.keys()].sort()) })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.bytes = 0
  }

  private evictToBudget(): void {
    while (this.entries.size > this.budget.maxEntries || this.bytes > this.budget.maxBytes) {
      const victim = [...this.entries.values()].sort((a, b) => a.lastAccessedAtMs - b.lastAccessedAtMs || a.storedAtMs - b.storedAtMs || a.key.localeCompare(b.key))[0]
      if (!victim) throw new Error('cache-budget-accounting-invalid')
      this.removeEntry(victim)
    }
  }

  private removeEntry(entry: ArcGisCacheEntry<T>): void {
    if (!this.entries.delete(entry.key)) return
    this.bytes -= entry.byteSize
    if (this.bytes < 0) throw new Error('cache-byte-accounting-invalid')
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-cache-disposed')
  }
}
