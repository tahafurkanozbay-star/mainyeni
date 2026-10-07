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
});
