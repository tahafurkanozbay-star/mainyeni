import { describe, expect, it } from "vitest";
import { ArcGisQueryExtentLifecyclePolicy } from "./ArcGisQueryExtentLifecyclePolicy";

const budget={maxLayers:2,maxQueued:3,maxRunning:2,maxRunningPerLayer:1,maxResident:2,queueTtlMs:20,leaseTtlMs:10,residentTtlMs:30};
const req=(requestId:string,layerId="parcels",revision=1,signature=requestId,intent:"interactive"|"visible"|"background"="visible",queuedAt=0)=>({requestId,layerId,revision,signature,intent,queuedAt});

describe("ArcGisQueryExtentLifecyclePolicy",()=>{
  it("dedupes logical work and rejects request-id collisions",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy(budget);p.setRevision("parcels",1);
    expect(p.enqueue(req("a","parcels",1,"same"))).toBe("queued");
    expect(p.enqueue(req("b","parcels",1,"same"))).toBe("deduped");
    expect(p.enqueue(req("a","parcels",1,"other"))).toBe("rejected");
  });
  it("schedules intent then FIFO while enforcing per-layer concurrency",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy(budget);p.setRevision("a",1);p.setRevision("b",1);
    p.enqueue(req("bg","a",1,"bg","background"));p.enqueue(req("hot","a",1,"hot","interactive"));p.enqueue(req("vis","b",1,"vis","visible"));
    expect(p.acquire(1)?.requestId).toBe("hot");expect(p.acquire(1)?.requestId).toBe("vis");expect(p.acquire(1)).toBeNull();
  });
  it("validates finite ordered bounds and stores only scalar extent metadata",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy(budget);p.setRevision("parcels",1);p.enqueue(req("a"));p.acquire(1);
    expect(()=>p.complete({requestId:"a",revision:1,xmin:5,ymin:0,xmax:4,ymax:2,spatialReferenceWkid:3857,completedAt:2})).toThrow("bounds");
    const view=p.complete({requestId:"a",revision:1,xmin:1,ymin:2,xmax:4,ymax:8,spatialReferenceWkid:3857,completedAt:2});
    expect(view).toMatchObject({xmin:1,ymin:2,xmax:4,ymax:8,spatialReferenceWkid:3857});
    expect(Object.isFrozen(view)).toBe(true);expect(p.snapshot()).toMatchObject({resident:1,running:0});
  });
  it("invalidates stale revision work and refuses late completion",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy(budget);p.setRevision("parcels",1);p.enqueue(req("a"));p.acquire(1);
    expect(p.setRevision("parcels",2)).toBe(1);
    expect(p.complete({requestId:"a",revision:1,xmin:0,ymin:0,xmax:1,ymax:1,spatialReferenceWkid:4326,completedAt:2})).toBeNull();
    expect(p.enqueue(req("old","parcels",1))).toBe("rejected");
  });
  it("expires queues, leases and residents deterministically",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy(budget);p.setRevision("parcels",1);p.enqueue(req("q"));expect(p.expire(20)).toBe(1);
    p.enqueue(req("r","parcels",1,"r", "visible",21));p.acquire(21);expect(p.renew("r",1,30)?.expiresAt).toBe(40);expect(p.expire(40)).toBe(1);
    p.enqueue(req("c","parcels",1,"c","visible",41));p.acquire(41);p.complete({requestId:"c",revision:1,xmin:0,ymin:0,xmax:1,ymax:1,spatialReferenceWkid:4326,completedAt:42});
    expect(p.lookup("parcels",1,"c",50)).not.toBeNull();expect(p.expire(80)).toBe(1);
  });
  it("evicts lower-priority queued work and bounds resident cardinality",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy({...budget,maxQueued:2,maxResident:1});p.setRevision("parcels",1);
    p.enqueue(req("b1","parcels",1,"b1","background"));p.enqueue(req("b2","parcels",1,"b2","background"));expect(p.enqueue(req("hot","parcels",1,"hot","interactive"))).toBe("queued");
    expect(p.acquire(1)?.requestId).toBe("hot");p.complete({requestId:"hot",revision:1,xmin:0,ymin:0,xmax:1,ymax:1,spatialReferenceWkid:4326,completedAt:2});
    p.cancel("b2");p.enqueue(req("next","parcels",1,"next","visible",3));p.acquire(3);p.complete({requestId:"next",revision:1,xmin:2,ymin:2,xmax:3,ymax:3,spatialReferenceWkid:4326,completedAt:4});
    expect(p.snapshot().resident).toBe(1);expect(p.lookup("parcels",1,"next",5)).not.toBeNull();
  });
  it("releases layer state and is terminal after idempotent disposal",()=>{
    const p=new ArcGisQueryExtentLifecyclePolicy(budget);p.setRevision("parcels",1);p.enqueue(req("a"));expect(p.releaseLayer("parcels")).toBe(1);
    p.dispose();p.dispose();expect(()=>p.snapshot()).toThrow("disposed");
  });
});
