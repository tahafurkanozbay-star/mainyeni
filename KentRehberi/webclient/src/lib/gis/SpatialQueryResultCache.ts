export interface SpatialQueryResultCacheOptions {
  readonly maxEntries: number
  readonly maxBytes: number
  readonly maxBytesPerLayer: number
  readonly ttlMs: number
}

export interface SpatialQueryResultDescriptor {
  readonly layerId: string
  readonly queryKey: string
  readonly revision: string
}

export interface SpatialQueryResultValue<T> {
  readonly value: T
  readonly byteSize: number
  readonly featureCount: number
}

export interface SpatialQueryResultCacheSnapshot {
  readonly entries: number
  readonly bytes: number
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly expirations: number
  readonly rejectedWrites: number
  readonly layers: readonly SpatialQueryResultLayerSnapshot[]
}

export interface SpatialQueryResultLayerSnapshot {
  readonly layerId: string
  readonly entries: number
  readonly bytes: number
}

interface Entry<T> {
  readonly key: string
  readonly layerId: string
  readonly value: T
  readonly byteSize: number
  readonly featureCount: number
  readonly expiresAt: number
  lastAccess: number
}

const DEFAULT_OPTIONS: SpatialQueryResultCacheOptions = {
  maxEntries: 128,
  maxBytes: 64 * 1024 * 1024,
  maxBytesPerLayer: 16 * 1024 * 1024,
  ttlMs: 30_000,
}

const CONTROL = /[\u0000-\u001f\u007f]/u

function validText(value: string): boolean {
  const text = value.trim()
  return text.length > 0 && text.length <= 512 && !CONTROL.test(text)
}

function keyOf(descriptor: SpatialQueryResultDescriptor): string | null {
  if (!validText(descriptor.layerId) || !validText(descriptor.queryKey) || !validText(descriptor.revision)) return null
  return `${descriptor.layerId.trim()}\u001f${descriptor.revision.trim()}\u001f${descriptor.queryKey.trim()}`
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function normalizeOptions(input: Partial<SpatialQueryResultCacheOptions>): SpatialQueryResultCacheOptions {
  const options = { ...DEFAULT_OPTIONS, ...input }
  for (const [name, value] of Object.entries(options)) {
    if (!positiveInteger(value)) throw new Error(`Invalid spatial query result cache option: ${name}`)
  }
  if (options.maxBytesPerLayer > options.maxBytes) throw new Error('maxBytesPerLayer exceeds maxBytes')
  return Object.freeze(options)
}

export class SpatialQueryResultCache<T> {
  readonly #options: SpatialQueryResultCacheOptions
  readonly #entries = new Map<string, Entry<T>>()
  #bytes = 0
  #clock = 0
  #hits = 0
  #misses = 0
  #evictions = 0
  #expirations = 0
  #rejectedWrites = 0

  constructor(options: Partial<SpatialQueryResultCacheOptions> = {}) {
    this.#options = normalizeOptions(options)
  }

  get(descriptor: SpatialQueryResultDescriptor, now = Date.now()): SpatialQueryResultValue<T> | null {
    const key = keyOf(descriptor)
    if (key === null || !Number.isFinite(now)) {
      this.#misses += 1
      return null
    }
    const entry = this.#entries.get(key)
    if (entry === undefined) {
      this.#misses += 1
      return null
    }
    if (entry.expiresAt <= now) {
      this.#remove(entry)
      this.#expirations += 1
      this.#misses += 1
      return null
    }
    entry.lastAccess = ++this.#clock
    this.#hits += 1
    return Object.freeze({ value: entry.value, byteSize: entry.byteSize, featureCount: entry.featureCount })
  }

  set(descriptor: SpatialQueryResultDescriptor, result: SpatialQueryResultValue<T>, now = Date.now()): boolean {
    const key = keyOf(descriptor)
    if (key === null || !Number.isFinite(now) || !positiveInteger(result.byteSize) || !Number.isSafeInteger(result.featureCount) || result.featureCount < 0) {
      this.#rejectedWrites += 1
      return false
    }
    if (result.byteSize > this.#options.maxBytes || result.byteSize > this.#options.maxBytesPerLayer) {
      this.#rejectedWrites += 1
      return false
    }
    const layerId = descriptor.layerId.trim()
    const previous = this.#entries.get(key)
    if (previous !== undefined) this.#remove(previous)
    const entry: Entry<T> = {
      key,
      layerId,
      value: result.value,
      byteSize: result.byteSize,
      featureCount: result.featureCount,
      expiresAt: now + this.#options.ttlMs,
      lastAccess: ++this.#clock,
    }
    this.#entries.set(key, entry)
    this.#bytes += entry.byteSize
    this.#evictLayer(layerId, key)
    this.#evictGlobal(key)
    if (!this.#entries.has(key)) {
      if (previous !== undefined) this.#restore(previous)
      this.#rejectedWrites += 1
      return false
    }
    return true
  }

  delete(descriptor: SpatialQueryResultDescriptor): boolean {
    const key = keyOf(descriptor)
    if (key === null) return false
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    this.#remove(entry)
    return true
  }

  invalidateLayer(layerId: string): number {
    if (!validText(layerId)) return 0
    const normalized = layerId.trim()
    let removed = 0
    for (const entry of [...this.#entries.values()]) {
      if (entry.layerId !== normalized) continue
      this.#remove(entry)
      removed += 1
    }
    return removed
  }

  pruneExpired(now = Date.now()): number {
    if (!Number.isFinite(now)) return 0
    let removed = 0
    for (const entry of [...this.#entries.values()]) {
      if (entry.expiresAt > now) continue
      this.#remove(entry)
      this.#expirations += 1
      removed += 1
    }
    return removed
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }

  has(descriptor: SpatialQueryResultDescriptor, now = Date.now()): boolean {
    const key = keyOf(descriptor)
    if (key === null || !Number.isFinite(now)) return false
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    if (entry.expiresAt <= now) {
      this.#remove(entry)
      this.#expirations += 1
      return false
    }
    return true
  }

  snapshot(): SpatialQueryResultCacheSnapshot {
    const layerIds = [...new Set([...this.#entries.values()].map(entry => entry.layerId))].sort()
    const layers = layerIds.map(layerId => {
      const entries = [...this.#entries.values()].filter(entry => entry.layerId === layerId)
      return Object.freeze({
        layerId,
        entries: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
      })
    })
    return Object.freeze({
      entries: this.#entries.size,
      bytes: this.#bytes,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      expirations: this.#expirations,
      rejectedWrites: this.#rejectedWrites,
      layers: Object.freeze(layers),
    })
  }

  #layerBytes(layerId: string): number {
    let bytes = 0
    for (const entry of this.#entries.values()) if (entry.layerId === layerId) bytes += entry.byteSize
    return bytes
  }

  #evictLayer(layerId: string, protectedKey: string): void {
    while (this.#layerBytes(layerId) > this.#options.maxBytesPerLayer) {
      const victim = this.#leastRecentlyUsed(entry => entry.layerId === layerId && entry.key !== protectedKey)
      if (victim === null) {
        const protectedEntry = this.#entries.get(protectedKey)
        if (protectedEntry !== undefined) this.#remove(protectedEntry)
        return
      }
      this.#remove(victim)
      this.#evictions += 1
    }
  }

  #evictGlobal(protectedKey: string): void {
    while (this.#entries.size > this.#options.maxEntries || this.#bytes > this.#options.maxBytes) {
      const victim = this.#leastRecentlyUsed(entry => entry.key !== protectedKey)
      if (victim === null) {
        const protectedEntry = this.#entries.get(protectedKey)
        if (protectedEntry !== undefined) this.#remove(protectedEntry)
        return
      }
      this.#remove(victim)
      this.#evictions += 1
    }
  }

  #leastRecentlyUsed(predicate: (entry: Entry<T>) => boolean): Entry<T> | null {
    let victim: Entry<T> | null = null
    for (const entry of this.#entries.values()) {
      if (!predicate(entry)) continue
      if (victim === null || entry.lastAccess < victim.lastAccess || (entry.lastAccess === victim.lastAccess && entry.key < victim.key)) victim = entry
    }
    return victim
  }

  #remove(entry: Entry<T>): void {
    if (!this.#entries.delete(entry.key)) return
    this.#bytes -= entry.byteSize
  }

  #restore(entry: Entry<T>): void {
    this.#entries.set(entry.key, entry)
    this.#bytes += entry.byteSize
  }
}
