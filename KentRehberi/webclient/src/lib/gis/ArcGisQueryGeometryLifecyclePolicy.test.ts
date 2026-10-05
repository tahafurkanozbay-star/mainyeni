import { describe, expect, it } from 'vitest'
import { ArcGisQueryGeometryLifecyclePolicy, type QueryGeometryBudget, type QueryGeometryRequest } from './ArcGisQueryGeometryLifecyclePolicy'

const budget: QueryGeometryBudget = { maxLayers:2,maxGeometries:3,maxGeometriesPerLayer:2,maxVerticesPerGeometry:10,maxResidentVertices:12,maxCoordinateMagnitude:1_000_000,geometryTtlMs:100 }
const request=(overrides:Partial<QueryGeometryRequest>={}):QueryGeometryRequest=>({geometryId:'g1',layerId:'parcels',revision:1,intent:'visible',kind:'polygon',spatialReferenceWkid:3857,vertexCount:4,minX:0,minY:0,maxX:10,maxY:10,createdAt:10,...overrides})

describe('ArcGisQueryGeometryLifecyclePolicy',()=>{
  it('requires an admitted current revision',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);expect(p.admit(request())).toBeNull();expect(p.setRevision('parcels',1)).toBe(0);expect(p.admit(request())?.vertexCount).toBe(4)})
  it('invalidates stale geometry on revision advance',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());expect(p.setRevision('parcels',2)).toBe(1);expect(p.consume('g1',1,20)).toBeNull()})
  it('rejects revision rollback',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',2);expect(p.setRevision('parcels',1)).toBe(-1)})
  it('deduplicates scalar-equivalent geometry',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);expect(p.admit(request())).not.toBeNull();expect(p.admit(request({geometryId:'g2'}))).toBeNull()})
  it('rejects inverted bounds',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);expect(()=>p.admit(request({minX:20,maxX:10}))).toThrow(/inverted/)})
  it('rejects non-finite bounds',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);expect(()=>p.admit(request({maxY:Number.NaN}))).toThrow(/finite/)})
  it('rejects excessive coordinate magnitude',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);expect(()=>p.admit(request({maxX:2_000_000}))).toThrow(/magnitude/)})
  it('requires point vertex cardinality',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);expect(()=>p.admit(request({kind:'point',vertexCount:2}))).toThrow(/exactly one/)})
  it('rejects per-geometry vertex pressure',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);expect(p.admit(request({vertexCount:11}))).toBeNull()})
  it('enforces per-layer cardinality',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());p.admit(request({geometryId:'g2',minX:20,maxX:30}));expect(p.admit(request({geometryId:'g3',minX:40,maxX:50}))).toBeNull()})
  it('evicts lower intent under vertex pressure',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.setRevision('roads',1);p.admit(request({intent:'background',vertexCount:8}));expect(p.admit(request({geometryId:'g2',layerId:'roads',intent:'interactive',vertexCount:6,minX:20,maxX:30,createdAt:20}))).not.toBeNull();expect(p.snapshot()).toEqual({layers:2,geometries:1,residentVertices:6})})
  it('does not evict higher intent for background work',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.setRevision('roads',1);p.admit(request({intent:'interactive',vertexCount:8}));expect(p.admit(request({geometryId:'g2',layerId:'roads',intent:'background',vertexCount:6,minX:20,maxX:30,createdAt:20}))).toBeNull()})
  it('touch extends ttl and expiry remains bounded',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());expect(p.touch('g1',1,50)).toBe(true);expect(p.expire(109)).toBe(0);expect(p.expire(150)).toBe(1)})
  it('consume removes residency',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());expect(p.consume('g1',1,20)?.geometryId).toBe('g1');expect(p.snapshot().residentVertices).toBe(0)})
  it('release layer removes revision authority',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());expect(p.releaseLayer('parcels')).toBe(1);expect(p.admit(request({geometryId:'g2'}))).toBeNull()})
  it('fingerprint is payload-free and deterministic',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());expect(p.fingerprint()).toBe('parcels:1:visible:polygon:3857:4:0,0,10,10')})
  it('snapshot is frozen scalar state',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.setRevision('parcels',1);p.admit(request());const s=p.snapshot();expect(Object.isFrozen(s)).toBe(true);expect(s).toEqual({layers:1,geometries:1,residentVertices:4})})
  it('dispose is terminal and idempotent',()=>{const p=new ArcGisQueryGeometryLifecyclePolicy(budget);p.dispose();p.dispose();expect(()=>p.snapshot()).toThrow(/disposed/)})
})
