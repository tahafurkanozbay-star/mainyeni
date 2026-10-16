/**
 * Indexed minimum heap for ArcGIS success-cache TTLs.
 *
 * Unlike scanning every cache entry per query or accumulating lazy tombstones,
 * indexed removal is O(log n) and retains exactly one deadline per live key.
 * The LRU map remains the separate cache admission and eviction authority.
 */
interface ExpiryNode {
  readonly key: string
  readonly expiresAt: number
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export class ArcGisCacheExpiryIndex {
  readonly #heap: ExpiryNode[] = []
  readonly #positions = new Map<string, number>()
  readonly #capacity: number

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_001) {
      throw new Error('ArcGIS expiry index capacity is invalid')
    }
    this.#capacity = capacity
  }

  get size(): number { return this.#heap.length }
  get nextExpiry(): number | undefined { return this.#heap[0]?.expiresAt }
  has(key: string): boolean { return this.#positions.has(key) }

  /** Replace an existing deadline in place; never retain stale heap entries. */
  set(key: string, expiresAt: number): void {
    if (typeof key !== 'string' || key.length === 0 || !validTime(expiresAt)) {
      throw new Error('ArcGIS expiry index key or deadline is invalid')
    }
    const index = this.#positions.get(key)
    if (index !== undefined) {
      this.#heap[index] = { key, expiresAt }
      this.#restore(index)
      return
    }
    if (this.#heap.length >= this.#capacity) {
      throw new Error('ArcGIS expiry index capacity exceeded')
    }
    const position = this.#heap.length
    this.#heap.push({ key, expiresAt })
    this.#positions.set(key, position)
    this.#rise(position)
  }

  delete(key: string): boolean {
    const index = this.#positions.get(key)
    if (index === undefined) return false
    this.#removeAt(index)
    return true
  }

  /** Pop one expired key without visiting unexpired cache entries. */
  popExpired(now: number): string | undefined {
    if (!validTime(now)) throw new Error('ArcGIS expiry index clock is invalid')
    const first = this.#heap[0]
    if (first === undefined || first.expiresAt > now) return undefined
    this.#removeAt(0)
    return first.key
  }

  clear(): void {
    this.#heap.length = 0
    this.#positions.clear()
  }

  #less(a: ExpiryNode, b: ExpiryNode): boolean {
    return a.expiresAt < b.expiresAt ||
      (a.expiresAt === b.expiresAt && a.key < b.key)
  }

  #swap(a: number, b: number): void {
    if (a === b) return
    const first = this.#heap[a]
    const second = this.#heap[b]
    if (first === undefined || second === undefined) {
      throw new Error('ArcGIS expiry index invariant violated')
    }
    this.#heap[a] = second
    this.#heap[b] = first
    this.#positions.set(first.key, b)
    this.#positions.set(second.key, a)
  }

  #rise(start: number): number {
    let position = start
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2)
      const current = this.#heap[position]
      const ancestor = this.#heap[parent]
      if (current === undefined || ancestor === undefined ||
          !this.#less(current, ancestor)) break
      this.#swap(position, parent)
      position = parent
    }
    return position
  }

  #sink(start: number): void {
    let position = start
    while (true) {
      const left = position * 2 + 1
      const right = left + 1
      let smallest = position
      const first = this.#heap[smallest]
      if (first === undefined) break
      const leftNode = this.#heap[left]
      if (leftNode !== undefined && this.#less(leftNode, first)) smallest = left
      const rightNode = this.#heap[right]
      const selected = this.#heap[smallest]
      if (rightNode !== undefined && selected !== undefined &&
          this.#less(rightNode, selected)) smallest = right
      if (smallest === position) break
      this.#swap(position, smallest)
      position = smallest
    }
  }

  #restore(position: number): void {
    const afterRise = this.#rise(position)
    this.#sink(afterRise)
  }

  #removeAt(index: number): void {
    const last = this.#heap.length - 1
    const removed = this.#heap[index]
    if (removed === undefined) throw new Error('ArcGIS expiry index removal invariant violated')
    if (index !== last) this.#swap(index, last)
    this.#heap.pop()
    this.#positions.delete(removed.key)
    if (index < this.#heap.length) this.#restore(index)
  }
}
