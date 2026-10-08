import { describe, expect, it } from 'vitest'
import { ArcGisQueryDedupeLifecyclePolicy, type QueryDedupeBudget, type QueryDedupeRequest } from './ArcGisQueryDedupeLifecyclePolicy'

const budget: QueryDedupeBudget = {
  maxLayers: 3, maxEntries: 6, maxEntriesPerLayer: 4,
  maxInflight: 2, maxInflightPerLayer: 1, maxCached: 3, maxCachedPerLayer: 2,
  maxFeaturesPerEntry: 100, maxBytesPerEntry: 2000,
  maxCachedFeatures: 200, maxCachedBytes: 4000,
  pendingTtlMs: 100, requestLeaseMs: 50, cacheTtlMs: 200,
}
const req=(requestId:string,layerId='parcels',revision=1,intent:QueryDedupeRequest['intent']='visible',requestedAt=0):QueryDedupeRequest=>({requestId,signature:`sig-${requestId}`,layerId,revision,intent,estimatedFeatures:10,estimatedBytes:200,requestedAt})
const policy=(custom:Partial<QueryDedupeBudget>={})=>new ArcGisQueryDedupeLifecyclePolicy({...budget,...custom})

describe('ArcGisQueryDedupeLifecyclePolicy',()=>{
  it('validates bounded budgets',()=>{
    expect(()=>policy({maxLayers:0})).toThrow(); expect(()=>policy({maxEntriesPerLayer:7})).toThrow()
    expect(()=>policy({maxInflightPerLayer:3})).toThrow(); expect(()=>policy({maxCachedPerLayer:4})).toThrow()
    expect(()=>policy({maxCachedBytes:1000})).toThrow(); expect(()=>policy({cacheTtlMs:Number.NaN})).toThrow()
  })
  it('requires current revision',()=>{const p=policy(); expect(p.admit(req('a'))).toBe('rejected'); expect(p.setRevision('parcels',1)).toBe(0); expect(p.admit(req('a'))).toBe('admitted')})
  it('rejects malformed identifiers and scalars',()=>{const p=policy();p.setRevision('parcels',1);expect(()=>p.admit({...req('a'),requestId:''})).toThrow();expect(()=>p.admit({...req('a'),signature:'x\n'})).toThrow();expect(()=>p.admit({...req('a'),estimatedFeatures:0})).toThrow();expect(()=>p.admit({...req('a'),requestedAt:-1})).toThrow();expect(()=>p.admit({...req('a'),intent:'other' as never})).toThrow()})
  it('rejects oversized estimates',()=>{const p=policy();p.setRevision('parcels',1);expect(p.admit({...req('a'),estimatedFeatures:101})).toBe('rejected');expect(p.admit({...req('b'),estimatedBytes:2001})).toBe('rejected')})
  it('coalesces identical signatures independently of request id',()=>{const p=policy();p.setRevision('parcels',1);expect(p.admit(req('a'))).toBe('admitted');expect(p.admit({...req('b'),signature:'sig-a'})).toBe('duplicate');expect(p.snapshot().entries).toBe(1)})
  it('does not alias signatures across revisions',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));expect(p.setRevision('parcels',2)).toBe(1);expect(p.admit({...req('b'),signature:'sig-a',revision:2})).toBe('admitted')})
  it('enforces global and per-layer cardinality',()=>{const p=policy({maxEntries:3,maxEntriesPerLayer:2});p.setRevision('a',1);p.setRevision('b',1);expect(p.admit(req('a1','a'))).toBe('admitted');expect(p.admit(req('a2','a'))).toBe('admitted');expect(p.admit(req('a3','a'))).toBe('rejected');expect(p.admit(req('b1','b'))).toBe('admitted');expect(p.admit(req('b2','b'))).toBe('rejected')})
  it('schedules by intent then request time',()=>{const p=policy({maxInflight:3,maxInflightPerLayer:3});p.setRevision('parcels',1);p.admit(req('b','parcels',1,'background',0));p.admit(req('v','parcels',1,'visible',0));p.admit(req('i','parcels',1,'interactive',1));expect(p.startNext(2)?.requestId).toBe('i');expect(p.startNext(3)?.requestId).toBe('v');expect(p.startNext(4)?.requestId).toBe('b')})
  it('enforces per-layer inflight concurrency',()=>{const p=policy({maxInflight:2,maxInflightPerLayer:1});p.setRevision('a',1);p.setRevision('b',1);p.admit(req('a1','a'));p.admit(req('a2','a'));p.admit(req('b1','b'));expect(p.startNext(1)?.requestId).toBe('a1');expect(p.startNext(2)?.requestId).toBe('b1');expect(p.startNext(3)).toBeNull()})
  it('renews only live inflight work',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));p.startNext(1);expect(p.renew('a',1,10)).toBe(true);expect(p.renew('a',2,20)).toBe(false)})
  it('rejects stale completion after revision change',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));p.startNext(1);expect(p.setRevision('parcels',2)).toBe(1);expect(p.complete('a',1,1,1,2)).toBeNull()})
  it('rejects oversized actual response accounting',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));p.startNext(1);expect(p.complete('a',1,101,1,2)).toBeNull();expect(p.snapshot().entries).toBe(0)})
  it('reconciles estimates to actual cache accounting',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));p.startNext(1);expect(p.complete('a',1,30,900,2)?.features).toBe(30);expect(p.snapshot()).toMatchObject({cached:1,cachedFeatures:30,cachedBytes:900})})
  it('serves and refreshes cached signatures',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));p.startNext(1);p.complete('a',1,2,20,2);expect(p.lookup('sig-a','parcels',1,10)?.requestId).toBe('a');expect(p.lookup('sig-a','parcels',2,11)).toBeNull();expect(p.expire(209)).toBe(0);expect(p.expire(210)).toBe(1)})
  it('evicts deterministic low-priority cached victims under pressure',()=>{const p=policy({maxCached:2,maxCachedPerLayer:2,maxFeaturesPerEntry:30,maxBytesPerEntry:1000,maxCachedFeatures:30,maxCachedBytes:1000});p.setRevision('parcels',1);for(const [id,intent] of [['bg','background'],['vis','visible'],['int','interactive']] as const){p.admit({...req(id,'parcels',1,intent),estimatedFeatures:10,estimatedBytes:200});p.startNext(1);p.complete(id,1,10,200,2)}expect(p.lookup('sig-bg','parcels',1,3)).toBeNull();expect(p.lookup('sig-vis','parcels',1,3)).not.toBeNull();expect(p.lookup('sig-int','parcels',1,3)).not.toBeNull()})
  it('expires pending and inflight leases',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('pending'));expect(p.expire(100)).toBe(1);p.admit(req('running','parcels',1,'visible',101));p.startNext(101);expect(p.expire(151)).toBe(1)})
  it('cancels without leaving signature aliases',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));expect(p.cancel('a')).toBe(true);expect(p.admit({...req('b'),signature:'sig-a'})).toBe('admitted')})
  it('releases layer state atomically',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));expect(p.releaseLayer('parcels')).toBe(1);expect(p.snapshot()).toMatchObject({layers:0,entries:0})})
  it('produces deterministic scalar fingerprints',()=>{const p=policy();p.setRevision('b',1);p.setRevision('a',1);p.admit(req('b1','b'));p.admit(req('a1','a'));expect(p.fingerprint()).toBe('a:sig-a1:1:visible:pending:10:200|b:sig-b1:1:visible:pending:10:200')})
  it('disposes idempotently and rejects reuse',()=>{const p=policy();p.setRevision('parcels',1);p.admit(req('a'));p.dispose();p.dispose();expect(()=>p.snapshot()).toThrow();expect(()=>p.setRevision('x',1)).toThrow()})
})
