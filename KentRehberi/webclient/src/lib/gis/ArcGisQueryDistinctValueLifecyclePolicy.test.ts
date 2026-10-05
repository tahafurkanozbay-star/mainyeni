import { describe,expect,it } from 'vitest'
import { ArcGisQueryDistinctValueLifecyclePolicy,type DistinctValueBudget,type DistinctValueRequest } from './ArcGisQueryDistinctValueLifecyclePolicy'
const budget:DistinctValueBudget={maxLayers:3,maxQueries:4,maxQueriesPerLayer:3,maxFieldsPerQuery:3,maxValuesPerQuery:20,maxBytesPerQuery:2000,maxResidentValues:40,maxResidentBytes:4000,ttlMs:100}
const request=(queryId:string,layerId='parcels',revision=1,intent:DistinctValueRequest['intent']='visible',fields:readonly string[]=['TYPE'],requestedAt=0):DistinctValueRequest=>({queryId,layerId,revision,intent,fields,requestedAt})
const policy=(custom:Partial<DistinctValueBudget>={})=>new ArcGisQueryDistinctValueLifecyclePolicy({...budget,...custom})
describe('ArcGisQueryDistinctValueLifecyclePolicy',()=>{
 it('validates budgets',()=>{expect(()=>policy({maxLayers:0})).toThrow();expect(()=>policy({maxQueriesPerLayer:5})).toThrow();expect(()=>policy({maxResidentValues:10})).toThrow()})
 it('requires current revision',()=>{const s=policy();expect(s.admit(request('a'),2,20)).toBeNull();s.setRevision('parcels',1);expect(s.admit(request('a'),2,20)?.queryId).toBe('a')})
 it('rejects unsafe input',()=>{const s=policy();s.setRevision('parcels',1);expect(()=>s.admit(request(''),1,1)).toThrow();expect(()=>s.admit(request('a','parcels',1,'visible',[]),1,1)).toThrow();expect(()=>s.admit(request('a','parcels',1,'visible',['A','A']),1,1)).toThrow()})
 it('rejects oversized results',()=>{const s=policy();s.setRevision('parcels',1);expect(s.admit(request('a'),21,1)).toBeNull();expect(s.admit(request('b'),1,2001)).toBeNull()})
 it('canonicalizes field identity',()=>{const s=policy();s.setRevision('parcels',1);expect(s.admit(request('a','parcels',1,'visible',['B','A']),1,1)?.fields).toEqual(['A','B']);expect(s.admit(request('b','parcels',1,'visible',['A','B']),1,1)).toBeNull()})
 it('rejects query id collisions',()=>{const s=policy();s.setRevision('parcels',1);s.admit(request('a'),1,1);expect(()=>s.admit(request('a','parcels',1,'visible',['OTHER']),1,1)).toThrow(/collision/)})
 it('invalidates stale revisions',()=>{const s=policy();s.setRevision('parcels',1);s.admit(request('a'),1,1);expect(s.setRevision('parcels',2)).toBe(1);expect(s.consume('a',1)).toBeNull();expect(s.setRevision('parcels',1)).toBe(-1)})
 it('enforces layer cardinality',()=>{const s=policy({maxQueriesPerLayer:1});s.setRevision('parcels',1);expect(s.admit(request('a'),1,1)).not.toBeNull();expect(s.admit(request('b','parcels',1,'visible',['OTHER']),1,1)).toBeNull()})
 it('evicts lower intent under pressure',()=>{const s=policy({maxQueries:2,maxQueriesPerLayer:2,maxResidentValues:20});s.setRevision('parcels',1);s.admit(request('bg','parcels',1,'background',['A']),10,100);s.admit(request('i','parcels',1,'interactive',['B']),15,100);expect(s.consume('bg',1)).toBeNull();expect(s.consume('i',1)?.values).toBe(15)})
 it('touches and expires TTL',()=>{const s=policy();s.setRevision('parcels',1);s.admit(request('a'),1,1);expect(s.touch('a',1,50)).toBe(true);expect(s.expire(100)).toBe(0);expect(s.expire(150)).toBe(1)})
 it('releases a layer',()=>{const s=policy();s.setRevision('parcels',1);s.admit(request('a'),1,1);expect(s.releaseLayer('parcels')).toBe(1);expect(s.snapshot().layers).toBe(0)})
 it('keeps views immutable and payload free',()=>{const s=policy();s.setRevision('parcels',1);const view=s.admit(request('a'),3,30)!;expect(Object.isFrozen(view)).toBe(true);expect(Object.isFrozen(view.fields)).toBe(true);expect(s.snapshot()).toEqual({layers:1,queries:1,residentValues:3,residentBytes:30});expect(s.fingerprint()).toContain('parcels:a:1:TYPE:3:30')})
 it('invalidates explicitly',()=>{const s=policy();s.setRevision('parcels',1);s.admit(request('a'),1,1);expect(s.invalidate('a')).toBe(true);expect(s.invalidate('a')).toBe(false)})
 it('disposes terminally',()=>{const s=policy();s.dispose();s.dispose();expect(()=>s.snapshot()).toThrow(/disposed/)})
})