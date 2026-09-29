import { describe,expect,it } from 'vitest';
import { ArcGisTimeWindowPolicy } from './ArcGisTimeWindowPolicy';
const budgets={minEpochMs:0,maxEpochMs:4_102_444_800_000,maxSpanMs:86_400_000,minStepMs:1_000,maxSteps:100};
const policy=()=>new ArcGisTimeWindowPolicy(budgets);
describe('ArcGisTimeWindowPolicy',()=>{
 it('plans immutable instant windows deterministically',()=>{const a=policy().plan({layerId:'traffic',startMs:1000,endMs:1000,revision:2,mode:'instant'});const b=policy().plan({layerId:'traffic',startMs:1000,endMs:1000,revision:2,mode:'instant'});expect(a).toEqual(b);expect(Object.isFrozen(a)).toBe(true);expect(a.stepCount).toBe(1)});
 it('plans bounded ranges',()=>{const plan=policy().plan({layerId:'events',startMs:0,endMs:9000,revision:1,mode:'range',stepMs:1000});expect(plan.stepCount).toBe(10);expect(plan.stepMs).toBe(1000)});
 it.each([
  [{layerId:' bad',startMs:0,endMs:0,revision:0,mode:'instant'} as const,'invalid layer id'],
  [{layerId:'a',startMs:2,endMs:1,revision:0,mode:'range',stepMs:1000} as const,'time window must be ordered'],
  [{layerId:'a',startMs:0,endMs:1,revision:0,mode:'instant'} as const,'instant window requires equal endpoints'],
  [{layerId:'a',startMs:0,endMs:0,revision:0,mode:'instant',stepMs:1000} as const,'instant window cannot define step'],
  [{layerId:'a',startMs:0,endMs:1,revision:0,mode:'range'} as const,'range window requires step'],
 ])('rejects malformed temporal requests %#',(input,message)=>expect(()=>policy().plan(input)).toThrow(message));
 it('rejects zero-span ranges',()=>expect(()=>policy().plan({layerId:'a',startMs:1,endMs:1,revision:0,mode:'range',stepMs:1000})).toThrow('range window requires positive span'));
 it('rejects epoch overflow',()=>expect(()=>policy().plan({layerId:'a',startMs:budgets.maxEpochMs+1,endMs:budgets.maxEpochMs+1,revision:0,mode:'instant'})).toThrow('time window exceeds epoch budget'));
 it('rejects span overflow',()=>expect(()=>policy().plan({layerId:'a',startMs:0,endMs:budgets.maxSpanMs+1,revision:0,mode:'range',stepMs:1000})).toThrow('time window exceeds span budget'));
 it('rejects too-small steps',()=>expect(()=>policy().plan({layerId:'a',startMs:0,endMs:1000,revision:0,mode:'range',stepMs:999})).toThrow('step below temporal budget'));
 it('rejects excessive step cardinality',()=>expect(()=>policy().plan({layerId:'a',startMs:0,endMs:100_000,revision:0,mode:'range',stepMs:1000})).toThrow('temporal step budget exceeded'));
 it('rejects stale revisions',()=>{const plan=policy().plan({layerId:'a',startMs:0,endMs:0,revision:3,mode:'instant'});expect(()=>policy().assertRevision(plan,4)).toThrow('stale temporal plan revision')});
 it('accepts matching revisions',()=>{const p=policy();const plan=p.plan({layerId:'a',startMs:0,endMs:0,revision:3,mode:'instant'});expect(()=>p.assertRevision(plan,3)).not.toThrow()});
 it('makes revision fingerprint-sensitive',()=>{const p=policy();const a=p.plan({layerId:'a',startMs:0,endMs:0,revision:1,mode:'instant'});const b=p.plan({layerId:'a',startMs:0,endMs:0,revision:2,mode:'instant'});expect(a.fingerprint).not.toBe(b.fingerprint)});
 it('validates constructor budgets',()=>{expect(()=>new ArcGisTimeWindowPolicy({...budgets,maxSteps:0})).toThrow('temporal budgets must be positive');expect(()=>new ArcGisTimeWindowPolicy({...budgets,maxEpochMs:-1})).toThrow('invalid epoch budget')});
});
