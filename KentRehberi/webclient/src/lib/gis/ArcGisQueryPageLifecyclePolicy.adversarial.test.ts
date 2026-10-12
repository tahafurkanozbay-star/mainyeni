import { describe, expect, it } from "vitest";
import { ArcGisQueryPageLifecyclePolicy } from "./ArcGisQueryPageLifecyclePolicy";

const options = { maxConcurrent: 2, maxConcurrentPerLayer: 1, maxQueued: 2,
  maxResidentPages: 2, maxResidentBytes: 100, queueTtlMs: 50,
  leaseTtlMs: 20, residentTtlMs: 100 };
const request = (requestId: string, intent: "interactive"|"visible"|"background" = "visible", now = 0) => ({
  requestId, layerId: "parcels", revision: 1, signature: "where=1", offset: 0, pageSize: 10, intent, now,
});

describe("ArcGIS query page lifecycle collision and privacy boundaries", () => {
  it("rejects request ID collisions in queued, running and resident phases", () => {
    const p = new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("parcels", 1);
    expect(p.enqueue(request("token"))).toBe("queued");
    expect(p.enqueue({ ...request("token"), offset: 10 })).toBe("rejected");
    expect(p.enqueue(request("token"))).toBe("deduped");
    expect(p.acquire(1)?.offset).toBe(0);
    expect(p.enqueue({ ...request("token"), offset: 20 })).toBe("rejected");
    p.complete({ requestId: "token", featureCount: 2, exceededTransferLimit: false, actualBytes: 20, now: 2 });
    expect(p.enqueue({ ...request("token"), offset: 30, now: 3 })).toBe("rejected");
    expect(p.lookup("parcels", 1, "where=1", 0, 10, 3)?.featureCount).toBe(2);
  });

  it("does not displace interactive work with background or equal-priority arrivals", () => {
    const p = new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("parcels", 1);
    p.enqueue(request("hot", "interactive"));
    p.enqueue({ ...request("visible"), offset: 10 });
    expect(p.enqueue({ ...request("background", "background"), offset: 20 })).toBe("rejected");
    expect(p.enqueue({ ...request("new-hot", "interactive"), offset: 30 })).toBe("queued");
    expect(p.acquire(1)?.requestId).toBe("hot");
    expect(p.cancel("hot")).toBe(true);
    expect(p.acquire(1)?.requestId).toBe("new-hot");
  });

  it("normalizes to whitelisted scalar fields and rejects unknown intent", () => {
    const p = new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("parcels", 1);
    expect(() => p.enqueue({ ...request("bad"), intent: "other" as "visible" })).toThrow("intent");
    const callerData = { features: [{ geometry: { x: 42, y: 11 } }] };
    p.enqueue({ ...request("ok"), ...callerData });
    const lease = p.acquire(1);
    expect(Object.keys(lease ?? {})).toEqual([
      "requestId","layerId","revision","signature","offset","pageSize","expiresAt",
    ]);
    expect(JSON.stringify(lease)).not.toContain("geometry");
  });

  it("fails closed on invalid page count and resident byte budgets", () => {
    const p = new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("parcels", 1);
    p.enqueue(request("bad-count")); p.acquire(1);
    expect(() => p.complete({ requestId: "bad-count", featureCount: 11,
      exceededTransferLimit: false, actualBytes: 10, now: 2 })).toThrow("invalid or oversized");
    expect(p.snapshot(2).resident).toBe(0);
    p.enqueue({ ...request("bad-bytes", "visible", 3), offset: 10 }); p.acquire(3);
    expect(() => p.complete({ requestId: "bad-bytes", featureCount: 1,
      exceededTransferLimit: true, actualBytes: 101, now: 4 })).toThrow("invalid or oversized");
    expect(p.snapshot(4)).toMatchObject({ running: 0, resident: 0 });
  });

  it("does not start future-queued work or accept rollback clocks", () => {
    const p = new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("parcels", 1);
    p.enqueue(request("future", "visible", 10));
    expect(p.acquire(9)).toBeUndefined();
    expect(p.acquire(10)?.requestId).toBe("future");
    expect(() => p.renew("future", 9)).toThrow("clock");
    expect(() => p.complete({ requestId: "future", featureCount: 1,
      exceededTransferLimit: false, actualBytes: 1, now: 9 })).toThrow("invalid or oversized");
  });

  it("validates lookup keys and rejects resident clock rollback", () => {
    const p = new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("parcels", 1);
    p.enqueue(request("a")); p.acquire(1);
    p.complete({ requestId: "a", featureCount: 1, exceededTransferLimit: false, actualBytes: 1, now: 2 });
    expect(() => p.lookup("parcels", 1, "where=1", -1, 10, 3)).toThrow("offset");
    expect(p.lookup("parcels", 1, "where=1", 0, 10, 1)).toBeUndefined();
    expect(p.lookup("parcels", 1, "where=1", 0, 10, 3)?.featureCount).toBe(1);
  });
});
