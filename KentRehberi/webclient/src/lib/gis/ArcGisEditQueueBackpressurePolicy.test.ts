import { describe, expect, it } from 'vitest'
import { ArcGisEditQueueBackpressurePolicy } from './ArcGisEditQueueBackpressurePolicy'

const budget = { maxLayers:3,maxJobs:5,maxJobsPerLayer:3,maxRunning:2,maxRunningPerLayer:1,maxOperations:20,maxBytes:1000,queueTtlMs:50,leaseMs:100 }
const make=()=>new ArcGisEditQueueBackpressurePolicy(budget)
const req=(jobId:string,layerId='roads',revision=1,intent:'interactive'|'visible'|'background'='visible',queuedAt=1,operations=2,bytes=100)=>({jobId,layerId,revision,intent,queuedAt,operations,bytes})

describe('ArcGisEditQueueBackpressurePolicy',()=>{
  it('requires revision authority',()=>{const p=make();expect(p.enqueue(req('a'))).toBe(false);p.setRevision('roads',1);expect(p.enqueue(req('a'))).toBe(true)})
  it('invalidates stale work on revision advance',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));expect(p.setRevision('roads',2)).toBe(1);expect(p.snapshot().jobs).toBe(0)})
  it('never regresses revision',()=>{const p=make();p.setRevision('roads',2);expect(p.setRevision('roads',1)).toBe(-1);expect(p.enqueue(req('a','roads',1))).toBe(false)})
  it('bounds layer authority',()=>{const p=new ArcGisEditQueueBackpressurePolicy({...budget,maxLayers:1});expect(p.setRevision('a',1)).toBe(0);expect(p.setRevision('b',1)).toBe(-1)})
  it('bounds jobs globally',()=>{const p=new ArcGisEditQueueBackpressurePolicy({...budget,maxJobs:1,maxJobsPerLayer:1,maxRunning:1,maxRunningPerLayer:1});p.setRevision('roads',1);expect(p.enqueue(req('a'))).toBe(true);expect(p.enqueue(req('b'))).toBe(false)})
  it('bounds jobs per layer',()=>{const p=new ArcGisEditQueueBackpressurePolicy({...budget,maxJobsPerLayer:1});p.setRevision('roads',1);expect(p.enqueue(req('a'))).toBe(true);expect(p.enqueue(req('b'))).toBe(false)})
  it('bounds aggregate operations',()=>{const p=new ArcGisEditQueueBackpressurePolicy({...budget,maxOperations:2});p.setRevision('roads',1);expect(p.enqueue(req('a'))).toBe(true);expect(p.enqueue(req('b','roads',1,'visible',2,1,1))).toBe(false)})
  it('bounds aggregate bytes',()=>{const p=new ArcGisEditQueueBackpressurePolicy({...budget,maxBytes:100});p.setRevision('roads',1);expect(p.enqueue(req('a'))).toBe(true);expect(p.enqueue(req('b','roads',1,'visible',2,1,1))).toBe(false)})
  it('prioritizes interactive over visible and background',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('b','roads',1,'background'));p.enqueue(req('v','roads',1,'visible'));p.enqueue(req('i','roads',1,'interactive'));expect(p.startNext(2)?.jobId).toBe('i')})
  it('uses FIFO within equal intent',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('late','roads',1,'visible',2));p.enqueue(req('early','roads',1,'visible',1));expect(p.startNext(3)?.jobId).toBe('early')})
  it('uses sequence as final deterministic tie breaker',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('first'));p.enqueue(req('second'));expect(p.startNext(2)?.jobId).toBe('first')})
  it('enforces global running concurrency',()=>{const p=new ArcGisEditQueueBackpressurePolicy({...budget,maxRunning:1,maxRunningPerLayer:1});p.setRevision('a',1);p.setRevision('b',1);p.enqueue(req('a','a'));p.enqueue(req('b','b'));expect(p.startNext(2)).not.toBeNull();expect(p.startNext(2)).toBeNull()})
  it('enforces per-layer running concurrency while allowing another layer',()=>{const p=make();p.setRevision('a',1);p.setRevision('b',1);p.enqueue(req('a1','a'));p.enqueue(req('a2','a'));p.enqueue(req('b1','b'));expect(p.startNext(2)?.jobId).toBe('a1');expect(p.startNext(2)?.jobId).toBe('b1')})
  it('renews only current running work',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));expect(p.renew('a',1,2)).toBe(false);p.startNext(2);expect(p.renew('a',1,3)).toBe(true);expect(p.renew('a',2,4)).toBe(false)})
  it('completes only current running work',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));expect(p.complete('a',1)).toBeNull();p.startNext(2);expect(p.complete('a',1)?.jobId).toBe('a');expect(p.snapshot().jobs).toBe(0)})
  it('expires queued work',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a','roads',1,'visible',10));expect(p.expire(59)).toBe(0);expect(p.expire(60)).toBe(1)})
  it('switches to lease expiry when running',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));p.startNext(10);expect(p.expire(109)).toBe(0);expect(p.expire(110)).toBe(1)})
  it('cancel frees accounting immediately',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));expect(p.cancel('a')).toBe(true);expect(p.snapshot().operations).toBe(0);expect(p.snapshot().bytes).toBe(0)})
  it('releaseLayer clears work and revision',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));p.enqueue(req('b'));expect(p.releaseLayer('roads')).toBe(2);expect(p.enqueue(req('c'))).toBe(false)})
  it('fingerprint is scalar and deterministic',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));expect(p.fingerprint()).toBe('roads:a:1:visible:queued:2:100');expect(p.fingerprint()).not.toContain('geometry')})
  it('normalizes identifiers and ignores excess payload properties',()=>{const p=make();p.setRevision(' roads ',1);expect(p.enqueue({...req(' a ',' roads '),...({geometry:{x:1},attributes:{secret:'x'}} as object)})).toBe(true);expect(p.fingerprint()).toContain('roads:a:');expect(p.fingerprint()).not.toContain('secret')})
  it('rejects unsafe identifiers and invalid numbers',()=>{const p=make();expect(()=>p.setRevision('',1)).toThrow();p.setRevision('roads',1);expect(()=>p.enqueue(req('a','roads',1,'visible',-1))).toThrow();expect(()=>p.enqueue(req('a','roads',1,'visible',1,0))).toThrow()})
  it('validates parent budgets',()=>{expect(()=>new ArcGisEditQueueBackpressurePolicy({...budget,maxJobs:1,maxJobsPerLayer:2})).toThrow();expect(()=>new ArcGisEditQueueBackpressurePolicy({...budget,maxRunning:6})).toThrow()})
  it('dispose is idempotent and terminal',()=>{const p=make();p.setRevision('roads',1);p.enqueue(req('a'));p.dispose();p.dispose();expect(()=>p.snapshot()).toThrow('disposed');expect(()=>p.enqueue(req('b'))).toThrow('disposed')})
})
