import { describe, expect, it } from 'vitest';
import { ArcGisTopologyValidationCoordinator } from './ArcGisTopologyValidationCoordinator';
const policy={maxGeometries:2,maxPointsPerGeometry:8,maxIssues:8,maxIdLength:32,coordinateTolerance:0};
const p=(x:number,y:number)=>({x,y,z:null,wkid:3857});
describe('ArcGisTopologyValidationCoordinator',()=>{
 it('accepts bounded valid geometry',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);c.upsert({id:'line',kind:'polyline',points:[p(0,0),p(1,1)]});expect(c.validate().issues).toHaveLength(0);});
 it('detects duplicate and zero length segments',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);c.upsert({id:'line',kind:'polyline',points:[p(0,0),p(0,0),p(1,1)]});expect(c.validate().issues.map(x=>x.kind)).toEqual(['duplicate-vertex','zero-length-segment']);});
 it('detects unclosed polygon rings',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);c.upsert({id:'poly',kind:'polygon',points:[p(0,0),p(1,0),p(1,1),p(0,1)]});expect(c.validate().issues.some(x=>x.kind==='unclosed-ring')).toBe(true);});
 it('detects self intersections',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);c.upsert({id:'poly',kind:'polygon',points:[p(0,0),p(2,2),p(0,2),p(2,0),p(0,0)]});expect(c.validate().issues.some(x=>x.kind==='self-intersection')).toBe(true);});
 it('bounds geometry capacity deterministically',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);for(const id of ['a','b','c'])c.upsert({id,kind:'polyline',points:[p(0,0),p(1,1)]});expect(c.validate().geometries.map(x=>x.id)).toEqual(['b','c']);});
 it('rejects unsafe geometry data',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);expect(()=>c.upsert({id:'bad\0id',kind:'polyline',points:[p(0,0),p(1,1)]})).toThrow(/bounds/);expect(()=>c.upsert({id:'x',kind:'polyline',points:[p(Infinity,0),p(1,1)]})).toThrow(/finite/);expect(()=>c.upsert({id:'x',kind:'polyline',points:[{...p(0,0),wkid:0},p(1,1)]})).toThrow(/wkid/);});
 it('restores atomically and rejects duplicates',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);c.upsert({id:'live',kind:'polyline',points:[p(0,0),p(1,1)]});const g={id:'a',kind:'polyline' as const,points:[p(0,0),p(1,1)]};expect(()=>c.restore({geometries:[g,g]})).toThrow(/duplicate/);expect(c.validate().geometries[0]?.id).toBe('live');});
 it('fails closed after disposal',()=>{const c=new ArcGisTopologyValidationCoordinator(policy);c.dispose();expect(()=>c.validate()).toThrow(/disposed/);});
});
