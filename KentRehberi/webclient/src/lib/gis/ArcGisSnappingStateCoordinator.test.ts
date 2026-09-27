import { describe, expect, it } from 'vitest';
import { ArcGisSnappingStateCoordinator } from './ArcGisSnappingStateCoordinator';

const policy = { maxCandidates: 2, maxIdLength: 32, maxLayerKeyLength: 32, maxDistancePx: 24, retentionMs: 1_000, maxClockSkewMs: 50 };
const candidate = (id:string, distancePx=5) => ({ id, layerKey:'roads', objectId:id, kind:'vertex' as const, point:{x:30,y:40,z:null,wkid:3857}, distancePx });

describe('ArcGisSnappingStateCoordinator', () => {
  it('selects the nearest candidate deterministically', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe(candidate('far',8),100); c.observe(candidate('near',2),101); expect(c.selectBest('2d',102)?.id).toBe('near'); expect(c.snapshot(102).activeId).toBe('near'); });
  it('evicts oldest candidates under bounded pressure', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe(candidate('a'),100); c.observe(candidate('b'),101); c.observe(candidate('c'),102); expect(c.snapshot(102).candidates.map(x=>x.id)).toEqual(['b','c']); });
  it('keeps numeric and string object ids typed', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe({...candidate('a'),objectId:7},100); c.observe({...candidate('b'),objectId:'7'},101); expect(c.snapshot(101).candidates.map(x=>typeof x.objectId)).toEqual(['number','string']); });
  it('rejects unsafe identity and malformed coordinates', () => { const c=new ArcGisSnappingStateCoordinator(policy); expect(()=>c.observe({...candidate('a'),objectId:Number.MAX_SAFE_INTEGER+1},100)).toThrow(/safe integer/); expect(()=>c.observe({...candidate('a'),point:{x:Infinity,y:0,z:null,wkid:3857}},100)).toThrow(/finite/); expect(()=>c.observe({...candidate('a'),layerKey:'bad\0key'},100)).toThrow(/bounds/); });
  it('rejects candidates outside pixel budget', () => { const c=new ArcGisSnappingStateCoordinator(policy); expect(()=>c.observe(candidate('a',25),100)).toThrow(/distance budget/); });
  it('prunes only after the retention boundary', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe(candidate('a'),100); expect(c.snapshot(1100).candidates).toHaveLength(1); expect(c.snapshot(1101).candidates).toHaveLength(0); });
  it('rejects stale replacement observations', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe(candidate('a'),200); expect(()=>c.observe(candidate('a'),149)).toThrow(/stale/); });
  it('restores an immutable bounded snapshot atomically', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.restore({mode:'3d',activeId:'a',candidates:[{...candidate('a'),observedAtMs:100}]},150); const s=c.snapshot(150); expect(s.mode).toBe('3d'); expect(s.activeId).toBe('a'); expect(Object.isFrozen(s.candidates)).toBe(true); expect(Object.isFrozen(s.candidates[0]?.point)).toBe(true); });
  it('rejects duplicate, future and missing-active restore state', () => { const c=new ArcGisSnappingStateCoordinator(policy); const a={...candidate('a'),observedAtMs:100}; expect(()=>c.restore({mode:'2d',activeId:null,candidates:[a,a]},100)).toThrow(/duplicate/); expect(()=>c.restore({mode:'2d',activeId:null,candidates:[{...a,observedAtMs:151}]},100)).toThrow(/future/); expect(()=>c.restore({mode:'2d',activeId:'missing',candidates:[a]},100)).toThrow(/active/); });
  it('does not mutate live state when restore validation fails', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe(candidate('live'),100); expect(()=>c.restore({mode:'2d',activeId:'missing',candidates:[]},100)).toThrow(); expect(c.snapshot(100).candidates[0]?.id).toBe('live'); });
  it('clears active selection when its candidate is removed', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.observe(candidate('a'),100); c.selectBest('2d',100); c.remove('a'); expect(c.snapshot(100).activeId).toBeNull(); });
  it('fails closed after disposal', () => { const c=new ArcGisSnappingStateCoordinator(policy); c.dispose(); expect(()=>c.snapshot(100)).toThrow(/disposed/); });
});
