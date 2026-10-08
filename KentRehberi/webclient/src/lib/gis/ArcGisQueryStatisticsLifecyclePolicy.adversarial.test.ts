import { describe, expect, it } from "vitest";
import { ArcGisQueryStatisticsLifecyclePolicy } from "./ArcGisQueryStatisticsLifecyclePolicy";

const budget = { maxLayers: 2, maxQueued: 2, maxRunning: 2, maxRunningPerLayer: 1,
  maxResidentGroups: 10, maxResidentBytes: 100, maxResidentEntries: 2,
  queueTtlMs: 50, leaseTtlMs: 20, residentTtlMs: 100 };
const request = (id: string, signature = id, queuedAt = 0) => ({
  requestId: id, layerId: "parcels", revision: 1, signature,
  groupBySignature: "district", statisticSignature: "count(id)" as const,
  intent: "visible" as const, queuedAt,
});

describe("ArcGIS statistics lifecycle adversarial bounds", () => {
  it("refuses oversized completion without evicting existing residents", () => {
    const p = new ArcGisQueryStatisticsLifecyclePolicy(budget); p.setRevision("parcels", 1);
    p.enqueue(request("good")); p.acquire(1);
    expect(p.complete({ requestId: "good", revision: 1, groupCount: 4, actualBytes: 40, completedAt: 2 })).not.toBeNull();
    p.enqueue(request("huge", "huge", 3)); p.acquire(3);
    expect(p.complete({ requestId: "huge", revision: 1, groupCount: 11, actualBytes: 20, completedAt: 4 })).toBeNull();
    expect(p.snapshot()).toMatchObject({ resident: 1, residentGroups: 4, residentBytes: 40, running: 0 });
    expect(p.lookup("parcels", 1, "good", "district", "count(id)", 5)?.groupCount).toBe(4);
    p.enqueue(request("bytes", "bytes", 6)); p.acquire(6);
    expect(p.complete({ requestId: "bytes", revision: 1, groupCount: 1, actualBytes: 101, completedAt: 7 })).toBeNull();
    expect(p.snapshot()).toMatchObject({ resident: 1, residentBytes: 40 });
  });

  it("caps zero-byte and zero-group residents by cardinality", () => {
    const p = new ArcGisQueryStatisticsLifecyclePolicy(budget); p.setRevision("parcels", 1);
    for (const [id, now] of [["a",1],["b",3],["c",5]] as const) {
      p.enqueue(request(id, id, now)); p.acquire(now);
      expect(p.complete({ requestId: id, revision: 1, groupCount: 0, actualBytes: 0, completedAt: now+1 })).not.toBeNull();
    }
    expect(p.snapshot()).toMatchObject({ resident: 2, residentGroups: 0, residentBytes: 0 });
    expect(p.lookup("parcels", 1, "a", "district", "count(id)", 7)).toBeNull();
    expect(p.lookup("parcels", 1, "c", "district", "count(id)", 7)).not.toBeNull();
  });

  it("rejects future acquisition, lease rollback and completion before start", () => {
    const p = new ArcGisQueryStatisticsLifecyclePolicy(budget); p.setRevision("parcels", 1);
    p.enqueue(request("a", "a", 10));
    expect(p.acquire(9)).toBeNull();
    expect(p.acquire(10)?.requestId).toBe("a");
    expect(p.renew("a", 1, 9)).toBeNull();
    expect(p.complete({ requestId: "a", revision: 1, groupCount: 1, actualBytes: 1, completedAt: 9 })).toBeNull();
    expect(p.complete({ requestId: "a", revision: 1, groupCount: 1, actualBytes: 1, completedAt: 11 })).not.toBeNull();
    expect(p.lookup("parcels", 1, "a", "district", "count(id)", 10)).toBeNull();
  });

  it("does not evict equal-priority queued requests to admit a newer one", () => {
    const p = new ArcGisQueryStatisticsLifecyclePolicy({ ...budget, maxQueued: 1 }); p.setRevision("parcels", 1);
    expect(p.enqueue(request("old"))).toBe("queued");
    expect(p.enqueue(request("new"))).toBe("rejected");
    expect(p.acquire(1)?.requestId).toBe("old");
  });
});
