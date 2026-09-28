export type ArcGisCacheScope = 'metadata' | 'query' | 'identify' | 'legend';

export interface ArcGisServiceResponseCachePolicy {
  readonly maxEntries: number;
  readonly maxEntriesPerService: number;
  readonly maxServiceKeyLength: number;
  readonly maxCacheKeyLength: number;
  readonly maxPayloadBytes: number;
  readonly maxTotalBytes: number;
  readonly maxTtlMs: number;
  readonly maxStaleMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisServiceResponseCacheEntry {
  readonly serviceKey: string;
  readonly cacheKey: string;
  readonly scope: ArcGisCacheScope;
  readonly payloadBytes: number;
  readonly etag: string | null;
  readonly storedAtMs: number;
  readonly expiresAtMs: number;
  readonly lastAccessedAtMs: number;
  readonly accessCount: number;
}

export interface ArcGisServiceResponseCacheSnapshot {
  readonly generation: number;
  readonly totalBytes: number;
  readonly entries: readonly ArcGisServiceResponseCacheEntry[];
}

export interface ArcGisCacheLookup {
  readonly state: 'miss' | 'fresh' | 'stale';
  readonly entry: ArcGisServiceResponseCacheEntry | null;
}

const integer = (value: number, name: string, allowZero = false): number => {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} outside safe integer bounds`);
  return value;
};
const boundedKey = (value: string, max: number, name: string): string => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
};
const validScope = (value: ArcGisCacheScope): boolean => value === 'metadata' || value === 'query' || value === 'identify' || value === 'legend';
const freezeEntry = (entry: ArcGisServiceResponseCacheEntry): ArcGisServiceResponseCacheEntry => Object.freeze({ ...entry });

/**
 * Primitive-only cache metadata authority for responses owned by verified ArcGIS REST adapters.
 * Payload bodies are deliberately not retained here. The adapter/cache implementation owns bytes;
 * this coordinator only decides bounded freshness, admission, eviction and invalidation.
 */
export class ArcGisServiceResponseCacheCoordinator {
  private readonly policy: Readonly<ArcGisServiceResponseCachePolicy>;
  private readonly entries = new Map<string, ArcGisServiceResponseCacheEntry>();
  private generation = 0;
  private totalBytes = 0;
  private lastObservedAtMs = 0;
  private disposed = false;

  constructor(policy: ArcGisServiceResponseCachePolicy) {
    this.policy = Object.freeze({
      maxEntries: integer(policy.maxEntries, 'maxEntries'),
      maxEntriesPerService: integer(policy.maxEntriesPerService, 'maxEntriesPerService'),
      maxServiceKeyLength: integer(policy.maxServiceKeyLength, 'maxServiceKeyLength'),
      maxCacheKeyLength: integer(policy.maxCacheKeyLength, 'maxCacheKeyLength'),
      maxPayloadBytes: integer(policy.maxPayloadBytes, 'maxPayloadBytes'),
      maxTotalBytes: integer(policy.maxTotalBytes, 'maxTotalBytes'),
      maxTtlMs: integer(policy.maxTtlMs, 'maxTtlMs'),
      maxStaleMs: integer(policy.maxStaleMs, 'maxStaleMs', true),
      maxClockSkewMs: integer(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
    if (this.policy.maxEntriesPerService > this.policy.maxEntries) throw new Error('per-service cache capacity exceeds global capacity');
    if (this.policy.maxPayloadBytes > this.policy.maxTotalBytes) throw new Error('single payload budget exceeds total cache budget');
  }

  put(input: {
    readonly serviceKey: string;
    readonly cacheKey: string;
    readonly scope: ArcGisCacheScope;
    readonly payloadBytes: number;
    readonly etag?: string | null;
    readonly ttlMs: number;
  }, timestampMs: number): ArcGisServiceResponseCacheEntry {
    this.assertUsable();
    const now = this.time(timestampMs);
    this.pruneExpired(now);
    const serviceKey = boundedKey(input.serviceKey, this.policy.maxServiceKeyLength, 'service key');
    const cacheKey = boundedKey(input.cacheKey, this.policy.maxCacheKeyLength, 'cache key');
    if (!validScope(input.scope)) throw new Error('invalid cache scope');
    const payloadBytes = integer(input.payloadBytes, 'payloadBytes', true);
    if (payloadBytes > this.policy.maxPayloadBytes) throw new Error('payload exceeds cache budget');
    const ttlMs = integer(input.ttlMs, 'ttlMs');
    if (ttlMs > this.policy.maxTtlMs || now > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error('ttl outside configured bounds');
    const etag = input.etag == null ? null : boundedKey(input.etag, 256, 'etag');
    const id = this.id(serviceKey, cacheKey);
    const previous = this.entries.get(id);
    if (previous) this.remove(id);
    this.evictForAdmission(serviceKey, payloadBytes);
    if (this.entries.size >= this.policy.maxEntries || this.countService(serviceKey) >= this.policy.maxEntriesPerService || this.totalBytes + payloadBytes > this.policy.maxTotalBytes) {
      if (previous) this.install(previous);
      throw new Error('cache admission capacity unavailable');
    }
    const entry = freezeEntry({ serviceKey, cacheKey, scope: input.scope, payloadBytes, etag, storedAtMs: now, expiresAtMs: now + ttlMs, lastAccessedAtMs: now, accessCount: 0 });
    this.install(entry); this.generation += 1;
    return entry;
  }

  lookup(serviceKeyValue: string, cacheKeyValue: string, timestampMs: number, allowStale = false): ArcGisCacheLookup {
    this.assertUsable(); const now = this.time(timestampMs);
    const serviceKey = boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    const cacheKey = boundedKey(cacheKeyValue, this.policy.maxCacheKeyLength, 'cache key');
    const id = this.id(serviceKey, cacheKey); const found = this.entries.get(id);
    if (!found) return Object.freeze({ state: 'miss', entry: null });
    const staleUntil = found.expiresAtMs > Number.MAX_SAFE_INTEGER - this.policy.maxStaleMs ? Number.MAX_SAFE_INTEGER : found.expiresAtMs + this.policy.maxStaleMs;
    if (now > staleUntil || (now > found.expiresAtMs && !allowStale)) {
      this.remove(id); this.generation += 1; return Object.freeze({ state: 'miss', entry: null });
    }
    const touched = freezeEntry({ ...found, lastAccessedAtMs: now, accessCount: Math.min(Number.MAX_SAFE_INTEGER, found.accessCount + 1) });
    this.entries.set(id, touched); this.generation += 1;
    return Object.freeze({ state: now <= found.expiresAtMs ? 'fresh' : 'stale', entry: touched });
  }

  invalidateService(serviceKeyValue: string): number {
    this.assertUsable(); const serviceKey = boundedKey(serviceKeyValue, this.policy.maxServiceKeyLength, 'service key');
    let removed = 0; for (const [id, entry] of [...this.entries]) if (entry.serviceKey === serviceKey) { this.remove(id); removed += 1; }
    if (removed) this.generation += 1; return removed;
  }

  invalidateScope(scope: ArcGisCacheScope): number {
    this.assertUsable(); if (!validScope(scope)) throw new Error('invalid cache scope');
    let removed = 0; for (const [id, entry] of [...this.entries]) if (entry.scope === scope) { this.remove(id); removed += 1; }
    if (removed) this.generation += 1; return removed;
  }

  snapshot(timestampMs: number): ArcGisServiceResponseCacheSnapshot {
    this.assertUsable(); const now = this.time(timestampMs); this.pruneExpired(now);
    const entries = [...this.entries.values()].sort((a,b) => a.serviceKey.localeCompare(b.serviceKey) || a.cacheKey.localeCompare(b.cacheKey)).map(freezeEntry);
    return Object.freeze({ generation: this.generation, totalBytes: this.totalBytes, entries: Object.freeze(entries) });
  }

  restore(snapshot: Pick<ArcGisServiceResponseCacheSnapshot, 'entries'>, timestampMs: number): void {
    this.assertUsable(); const now = this.time(timestampMs);
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > this.policy.maxEntries) throw new Error('invalid cache snapshot');
    const next = new Map<string, ArcGisServiceResponseCacheEntry>(); let bytes = 0; const perService = new Map<string, number>();
    for (const raw of snapshot.entries) {
      const entry = this.validateRestored(raw, now); if (!entry) continue;
      const id = this.id(entry.serviceKey, entry.cacheKey); if (next.has(id)) throw new Error('duplicate cache identity in snapshot');
      const count = (perService.get(entry.serviceKey) ?? 0) + 1; if (count > this.policy.maxEntriesPerService) throw new Error('snapshot exceeds per-service cache capacity');
      bytes += entry.payloadBytes; if (bytes > this.policy.maxTotalBytes) throw new Error('snapshot exceeds total cache bytes');
      perService.set(entry.serviceKey, count); next.set(id, entry);
    }
    this.entries.clear(); for (const [id, entry] of next) this.entries.set(id, entry); this.totalBytes = bytes; this.lastObservedAtMs = now; this.generation += 1;
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; this.entries.clear(); this.totalBytes = 0; this.generation += 1; }

  private validateRestored(raw: ArcGisServiceResponseCacheEntry, now: number): ArcGisServiceResponseCacheEntry | null {
    const serviceKey = boundedKey(raw.serviceKey, this.policy.maxServiceKeyLength, 'service key'); const cacheKey = boundedKey(raw.cacheKey, this.policy.maxCacheKeyLength, 'cache key');
    if (!validScope(raw.scope)) throw new Error('invalid cache scope'); const payloadBytes = integer(raw.payloadBytes, 'payloadBytes', true); if (payloadBytes > this.policy.maxPayloadBytes) throw new Error('snapshot payload exceeds budget');
    const storedAtMs = integer(raw.storedAtMs, 'storedAtMs', true); const expiresAtMs = integer(raw.expiresAtMs, 'expiresAtMs', true); const lastAccessedAtMs = integer(raw.lastAccessedAtMs, 'lastAccessedAtMs', true); const accessCount = integer(raw.accessCount, 'accessCount', true);
    if (storedAtMs > now + this.policy.maxClockSkewMs || lastAccessedAtMs > now + this.policy.maxClockSkewMs || expiresAtMs < storedAtMs || expiresAtMs - storedAtMs > this.policy.maxTtlMs) throw new Error('invalid cache timeline');
    if (now > expiresAtMs + this.policy.maxStaleMs) return null;
    const etag = raw.etag == null ? null : boundedKey(raw.etag, 256, 'etag'); return freezeEntry({ serviceKey, cacheKey, scope: raw.scope, payloadBytes, etag, storedAtMs, expiresAtMs, lastAccessedAtMs, accessCount });
  }
  private evictForAdmission(serviceKey: string, incomingBytes: number): void {
    while (this.entries.size >= this.policy.maxEntries || this.countService(serviceKey) >= this.policy.maxEntriesPerService || this.totalBytes + incomingBytes > this.policy.maxTotalBytes) {
      const candidates = [...this.entries.entries()].sort((a,b) => a[1].lastAccessedAtMs-b[1].lastAccessedAtMs || a[1].storedAtMs-b[1].storedAtMs || a[0].localeCompare(b[0]));
      const sameService = candidates.find(([,entry]) => entry.serviceKey === serviceKey); const victim = this.countService(serviceKey) >= this.policy.maxEntriesPerService ? sameService : candidates[0]; if (!victim) break; this.remove(victim[0]);
    }
  }
  private pruneExpired(now: number): void { let changed=false; for (const [id,e] of [...this.entries]) if (now > e.expiresAtMs + this.policy.maxStaleMs) { this.remove(id); changed=true; } if (changed) this.generation+=1; }
  private install(entry: ArcGisServiceResponseCacheEntry): void { this.entries.set(this.id(entry.serviceKey,entry.cacheKey),entry); this.totalBytes += entry.payloadBytes; }
  private remove(id: string): void { const entry=this.entries.get(id); if (!entry) return; this.entries.delete(id); this.totalBytes-=entry.payloadBytes; }
  private countService(serviceKey:string):number { let count=0; for(const entry of this.entries.values()) if(entry.serviceKey===serviceKey) count+=1; return count; }
  private id(serviceKey:string,cacheKey:string):string { return `${serviceKey.length}:${serviceKey}${cacheKey}`; }
  private time(value:number):number { const now=integer(value,'timestampMs',true); if(now+this.policy.maxClockSkewMs<this.lastObservedAtMs) throw new Error('stale cache clock'); this.lastObservedAtMs=Math.max(this.lastObservedAtMs,now); return now; }
  private assertUsable():void { if(this.disposed) throw new Error('ArcGisServiceResponseCacheCoordinator is disposed'); }
}
