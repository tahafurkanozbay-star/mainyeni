import { describe, expect, it } from "vitest";
import {
  createSpatialResultCache,
  DEFAULT_SPATIAL_CACHE_POLICY,
  type SpatialCachePolicy,
} from "./spatialResultCacheRuntime";

function policy(overrides: Partial<SpatialCachePolicy> = {}): SpatialCachePolicy {
  return { ...DEFAULT_SPATIAL_CACHE_POLICY, ...overrides };
}

describe("spatialResultCacheRuntime", () => {
  it("returns deterministic misses before data is admitted", () => {
    const cache = createSpatialResultCache<string>();
    expect(cache.get("missing", 1)).toEqual({ status: "miss" });
    expect(cache.metrics().misses).toBe(1);
  });

  it("stores and returns fresh spatial results", () => {
    const cache = createSpatialResultCache<string>();
    expect(cache.set({ key: "layer:1", value: "a", byteSize: 64 }, 100)).toBe(true);
    const result = cache.get("layer:1", 101);
    expect(result.status).toBe("hit");
    expect(result.entry?.value).toBe("a");
    expect(result.entry?.accessCount).toBe(1);
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 64, disposed: false });
  });

  it("serves stale data only inside the bounded revalidation window", () => {
    const cache = createSpatialResultCache<string>(policy({ ttlMs: 10, staleWhileRevalidateMs: 5 }));
    cache.set({ key: "query", value: "result", byteSize: 10 }, 100);
    expect(cache.get("query", 111).status).toBe("stale");
    expect(cache.get("query", 116).status).toBe("miss");
    expect(cache.snapshot().entries).toBe(0);
    expect(cache.metrics()).toMatchObject({ staleHits: 1, expirations: 1, misses: 1 });
  });

  it("honors per-entry ttl without mutating the shared policy", () => {
    const cache = createSpatialResultCache<number>(policy({ ttlMs: 100, staleWhileRevalidateMs: 0 }));
    cache.set({ key: "short", value: 1, byteSize: 8, ttlMs: 2 }, 10);
    expect(cache.get("short", 12).status).toBe("hit");
    expect(cache.get("short", 13).status).toBe("miss");
  });

  it("rejects entries larger than the per-entry budget", () => {
    const cache = createSpatialResultCache<string>(policy({ maxBytes: 100, maxEntryBytes: 40 }));
    expect(cache.set({ key: "oversize", value: "x", byteSize: 41 }, 1)).toBe(false);
    expect(cache.metrics().rejections).toBe(1);
  });

  it("rejects malformed keys and non-positive byte estimates", () => {
    const cache = createSpatialResultCache<string>();
    expect(cache.set({ key: " ", value: "x", byteSize: 1 }, 1)).toBe(false);
    expect(cache.set({ key: "valid", value: "x", byteSize: 0 }, 1)).toBe(false);
    expect(cache.set({ key: "valid", value: "x", byteSize: -1 }, 1)).toBe(false);
    expect(cache.metrics().rejections).toBe(3);
  });

  it("normalizes outer key whitespace consistently", () => {
    const cache = createSpatialResultCache<string>();
    expect(cache.set({ key: "  layer:2  ", value: "ok", byteSize: 5 }, 1)).toBe(true);
    expect(cache.get("layer:2", 2).entry?.value).toBe("ok");
  });

  it("deduplicates and sorts invalidation tags", () => {
    const cache = createSpatialResultCache<string>();
    cache.set({ key: "tagged", value: "x", byteSize: 5, tags: ["roads", "district", "roads"] }, 1);
    expect(cache.get("tagged", 2).entry?.tags).toEqual(["district", "roads"]);
  });

  it("invalidates all entries sharing a data-integrity tag", () => {
    const cache = createSpatialResultCache<number>();
    cache.set({ key: "a", value: 1, byteSize: 10, tags: ["service:4"] }, 1);
    cache.set({ key: "b", value: 2, byteSize: 10, tags: ["service:4", "layer:2"] }, 1);
    cache.set({ key: "c", value: 3, byteSize: 10, tags: ["service:5"] }, 1);
    expect(cache.invalidateTag("service:4")).toBe(2);
    expect(cache.snapshot().keys).toEqual(["c"]);
    expect(cache.metrics().invalidations).toBe(2);
  });

  it("replaces the same key without leaking byte accounting", () => {
    const cache = createSpatialResultCache<string>();
    cache.set({ key: "same", value: "first", byteSize: 80 }, 1);
    cache.set({ key: "same", value: "second", byteSize: 20 }, 2);
    expect(cache.snapshot()).toMatchObject({ entries: 1, bytes: 20 });
    expect(cache.get("same", 3).entry?.value).toBe("second");
    expect(cache.metrics().replacements).toBe(1);
  });

  it("evicts lower-priority least-recently-used entries under byte pressure", () => {
    const cache = createSpatialResultCache<string>(policy({ maxEntries: 4, maxBytes: 100, maxEntryBytes: 100 }));
    cache.set({ key: "old", value: "old", byteSize: 40, priority: "background" }, 1);
    cache.set({ key: "new", value: "new", byteSize: 40, priority: "normal" }, 2);
    expect(cache.set({ key: "incoming", value: "incoming", byteSize: 40, priority: "important" }, 3)).toBe(true);
    expect(cache.snapshot().keys).toEqual(["incoming", "new"]);
    expect(cache.metrics().evictions).toBe(1);
  });

  it("does not evict higher-priority entries for background work", () => {
    const cache = createSpatialResultCache<string>(policy({ maxEntries: 1, maxBytes: 100, maxEntryBytes: 100 }));
    cache.set({ key: "critical", value: "keep", byteSize: 50, priority: "critical" }, 1);
    expect(cache.set({ key: "background", value: "drop", byteSize: 50, priority: "background" }, 2)).toBe(false);
    expect(cache.snapshot().keys).toEqual(["critical"]);
  });

  it("uses access recency as a deterministic eviction tie breaker", () => {
    const cache = createSpatialResultCache<string>(policy({ maxEntries: 2, maxBytes: 200, maxEntryBytes: 100 }));
    cache.set({ key: "a", value: "a", byteSize: 50 }, 1);
    cache.set({ key: "b", value: "b", byteSize: 50 }, 2);
    cache.get("a", 3);
    cache.set({ key: "c", value: "c", byteSize: 50 }, 4);
    expect(cache.snapshot().keys).toEqual(["a", "c"]);
  });

  it("enforces entry-count bounds independently from byte bounds", () => {
    const cache = createSpatialResultCache<number>(policy({ maxEntries: 2, maxBytes: 1_000, maxEntryBytes: 500 }));
    cache.set({ key: "a", value: 1, byteSize: 1 }, 1);
    cache.set({ key: "b", value: 2, byteSize: 1 }, 2);
    cache.set({ key: "c", value: 3, byteSize: 1 }, 3);
    expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 2 });
    expect(cache.snapshot().keys).toEqual(["b", "c"]);
  });

  it("sweeps only entries beyond stale-until", () => {
    const cache = createSpatialResultCache<number>(policy({ ttlMs: 5, staleWhileRevalidateMs: 5 }));
    cache.set({ key: "a", value: 1, byteSize: 1 }, 10);
    cache.set({ key: "b", value: 2, byteSize: 1, ttlMs: 20 }, 10);
    expect(cache.sweep(21)).toBe(1);
    expect(cache.snapshot().keys).toEqual(["b"]);
  });

  it("supports explicit deletion without counting it as eviction", () => {
    const cache = createSpatialResultCache<number>();
    cache.set({ key: "a", value: 1, byteSize: 10 }, 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.metrics().evictions).toBe(0);
  });

  it("clears entries and byte accounting deterministically", () => {
    const cache = createSpatialResultCache<number>();
    cache.set({ key: "a", value: 1, byteSize: 10 }, 1);
    cache.set({ key: "b", value: 2, byteSize: 20 }, 1);
    cache.clear();
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("fails closed after disposal", () => {
    const cache = createSpatialResultCache<number>();
    cache.set({ key: "a", value: 1, byteSize: 10 }, 1);
    cache.dispose();
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0, disposed: true });
    expect(cache.get("a", 2).status).toBe("miss");
    expect(cache.set({ key: "b", value: 2, byteSize: 10 }, 2)).toBe(false);
    expect(cache.invalidateTag("x")).toBe(0);
    expect(cache.sweep(3)).toBe(0);
  });

  it("rejects invalid policies at construction time", () => {
    expect(() => createSpatialResultCache(policy({ maxEntries: 0 }))).toThrow("Invalid spatial cache policy");
    expect(() => createSpatialResultCache(policy({ maxBytes: 10, maxEntryBytes: 11 }))).toThrow("Invalid spatial cache policy");
    expect(() => createSpatialResultCache(policy({ ttlMs: -1 }))).toThrow("Invalid spatial cache policy");
  });

  it("bounds tag cardinality to avoid untrusted metadata amplification", () => {
    const cache = createSpatialResultCache<string>();
    const tags = Array.from({ length: 33 }, (_, index) => `tag-${index}`);
    expect(cache.set({ key: "many-tags", value: "x", byteSize: 10, tags }, 1)).toBe(false);
  });

  it("tracks fresh, stale and miss metrics independently", () => {
    const cache = createSpatialResultCache<string>(policy({ ttlMs: 2, staleWhileRevalidateMs: 2 }));
    cache.set({ key: "a", value: "a", byteSize: 10 }, 10);
    expect(cache.get("a", 11).status).toBe("hit");
    expect(cache.get("a", 13).status).toBe("stale");
    expect(cache.get("missing", 13).status).toBe("miss");
    expect(cache.metrics()).toMatchObject({ hits: 1, staleHits: 1, misses: 1 });
  });
});
