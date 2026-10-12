import { describe, expect, it } from "vitest";
import { ArcGisQueryStatisticsLifecyclePolicy } from "./ArcGisQueryStatisticsLifecyclePolicy";

const budget={maxLayers:4,maxQueued:3,maxRunning:2,maxRunningPerLayer:1,maxResidentGroups:10,maxResidentBytes:100,queueTtlMs:50,leaseTtlMs:20,residentTtlMs:100};
const req=(requestId:string,layerId:string,intent:"interactive"|"visible"|"background",queuedAt=0)=>({
 requestId,layerId,revision:1,signature:"where=1=1",groupBySignature:"district",
 statisticSignature:"sum(population)",intent,queuedAt
});
describe("ArcGisQueryStatisticsLifecyclePolicy",()=>{
 it("dedupes equivalent aggregate work and protects request-id collisions",()=>{
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);
  expect(p.enqueue(req("one","a","background"))).toBe("queued");
  expect(p.enqueue(req("two","a","interactive"))).toBe("deduped");
  expect(p.enqueue({...req("one","a","interactive"),statisticSignature:"avg(population)"})).toBe("rejected");
 });
 it("prioritizes interaction while enforcing per-layer concurrency",()=>{
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);p.setRevision("b",1);
  p.enqueue(req("bg","a","background"));p.enqueue({...req("hot","a","interactive"),statisticSignature:"avg(population)"});
  p.enqueue(req("visible","b","visible"));
  expect(p.acquire(1)?.requestId).toBe("hot");
  expect(p.acquire(1)?.requestId).toBe("visible");
  expect(p.acquire(1)).toBeNull();
 });
 it("invalidates stale aggregate work on revision changes",()=>{
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);p.enqueue(req("one","a","interactive"));p.acquire(1);
  expect(p.setRevision("a",2)).toBe(1);
  expect(p.snapshot()).toEqual({layers:1,queued:0,running:0,resident:0,residentGroups:0,residentBytes:0});
  expect(p.enqueue(req("stale","a","interactive",2))).toBe("rejected");
 });
 it("reconciles actual bytes and evicts deterministic resident pressure",()=>{
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);p.setRevision("b",1);
  p.enqueue(req("a","a","interactive"));p.acquire(0);
  expect(p.complete({requestId:"a",revision:1,groupCount:6,actualBytes:60,completedAt:1})?.groupCount).toBe(6);
  p.enqueue(req("b","b","interactive",2));p.acquire(2);
  p.complete({requestId:"b",revision:1,groupCount:6,actualBytes:60,completedAt:3});
  expect(p.snapshot()).toEqual({layers:2,queued:0,running:0,resident:1,residentGroups:6,residentBytes:60});
  expect(p.lookup("b",1,"where=1=1","district","sum(population)",4)?.groupCount).toBe(6);
 });
 it("expires queue, lease and resident state without payload retention",()=>{
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);
  p.enqueue(req("q","a","background"));expect(p.expire(50)).toBe(1);
  p.enqueue(req("r","a","interactive",60));p.acquire(60);expect(p.renew("r",1,70)?.expiresAt).toBe(90);
  expect(p.expire(90)).toBe(1);
  p.enqueue(req("c","a","interactive",91));p.acquire(91);p.complete({requestId:"c",revision:1,groupCount:1,actualBytes:1,completedAt:92});
  expect(p.expire(192)).toBe(1);
 });
 it("supports cancellation, release and terminal disposal",()=>{
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);p.enqueue(req("x","a","interactive"));
  expect(p.cancel("x")).toBe(true);p.enqueue(req("y","a","interactive"));expect(p.releaseLayer("a")).toBe(1);
  p.dispose();p.dispose();expect(()=>p.snapshot()).toThrow("disposed");
 });
 it("rejects unsafe budgets and malformed identities",()=>{
  expect(()=>new ArcGisQueryStatisticsLifecyclePolicy({...budget,maxRunningPerLayer:3})).toThrow();
  const p=new ArcGisQueryStatisticsLifecyclePolicy(budget);p.setRevision("a",1);
  expect(()=>p.enqueue({...req("x","a","interactive"),signature:"\u0000"})).toThrow("signature is invalid");
 });
});
