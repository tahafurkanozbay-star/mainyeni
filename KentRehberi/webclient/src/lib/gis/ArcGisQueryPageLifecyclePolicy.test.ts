import { describe, expect, it } from "vitest";
import { ArcGisQueryPageLifecyclePolicy } from "./ArcGisQueryPageLifecyclePolicy";

const options={maxConcurrent:2,maxConcurrentPerLayer:1,maxQueued:3,maxResidentPages:2,maxResidentBytes:100,queueTtlMs:50,leaseTtlMs:20,residentTtlMs:100};
const req=(requestId:string,layerId:string,intent:"interactive"|"visible"|"background",now=0)=>({requestId,layerId,revision:1,signature:"where=1=1",offset:0,pageSize:50,intent,now});

describe("ArcGisQueryPageLifecyclePolicy",()=>{
 it("dedupes logical pages and schedules by intent with per-layer fairness",()=>{
  const p=new ArcGisQueryPageLifecyclePolicy(options);
  p.setRevision("a",1); p.setRevision("b",1);
  expect(p.enqueue(req("bg","a","background"))).toBe("queued");
  expect(p.enqueue(req("dup","a","interactive"))).toBe("deduped");
  p.enqueue(req("visible","b","visible"));
  expect(p.acquire(1)?.requestId).toBe("visible");
  expect(p.acquire(1)?.requestId).toBe("bg");
  expect(p.acquire(1)).toBeUndefined();
 });
 it("invalidates stale work on revision changes",()=>{
  const p=new ArcGisQueryPageLifecyclePolicy(options);
  p.setRevision("a",1); p.enqueue(req("one","a","interactive")); p.acquire(1);
  p.setRevision("a",2);
  expect(p.snapshot(2)).toEqual({queued:0,running:0,resident:0,residentBytes:0});
  expect(()=>p.enqueue(req("stale","a","interactive",2))).toThrow("stale layer revision");
 });
 it("stores only scalar page metadata and evicts by byte pressure",()=>{
  const p=new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("a",1); p.setRevision("b",1);
  p.enqueue(req("a","a","interactive")); p.acquire(0); p.complete({requestId:"a",featureCount:50,exceededTransferLimit:true,actualBytes:70,now:1});
  p.enqueue(req("b","b","interactive",2)); p.acquire(2); p.complete({requestId:"b",featureCount:3,exceededTransferLimit:false,actualBytes:60,now:3});
  expect(p.snapshot(3)).toEqual({queued:0,running:0,resident:1,residentBytes:60});
  expect(p.lookup("b",1,"where=1=1",0,50,4)).toEqual({featureCount:3,exceededTransferLimit:false});
 });
 it("expires queue, leases and residents deterministically",()=>{
  const p=new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("a",1);
  p.enqueue(req("q","a","background")); expect(p.snapshot(50).queued).toBe(0);
  p.enqueue(req("r","a","interactive",60)); p.acquire(60); expect(p.snapshot(80).running).toBe(0);
  p.enqueue(req("z","a","interactive",81)); p.acquire(81); p.complete({requestId:"z",featureCount:1,exceededTransferLimit:false,actualBytes:1,now:82});
  expect(p.snapshot(182).resident).toBe(0);
 });
 it("renews leases, cancels work and rejects use after disposal",()=>{
  const p=new ArcGisQueryPageLifecyclePolicy(options); p.setRevision("a",1);
  p.enqueue(req("x","a","interactive")); p.acquire(1);
  expect(p.renew("x",10).expiresAt).toBe(30); expect(p.cancel("x")).toBe(true);
  p.dispose(); expect(()=>p.snapshot(11)).toThrow("disposed");
 });
});
