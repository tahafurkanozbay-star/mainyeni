import { describe, expect, it } from 'vitest'
import { ArcGisLayerCapabilityRegistry, type ArcGisLayerCapabilityBudget, type ArcGisLayerCapabilityDescriptor } from './ArcGisLayerCapabilityRegistry'

const budget: ArcGisLayerCapabilityBudget = { maxLayers: 3, maxFieldsPerLayer: 8, maxOperationsPerLayer: 6, maxRecordCountCeiling: 10_000, maxMetadataBytesPerLayer: 8_000, maxAggregateMetadataBytes: 16_000 }
const layer = (overrides: Partial<ArcGisLayerCapabilityDescriptor> = {}): ArcGisLayerCapabilityDescriptor => ({
  serviceId: 'planning', layerId: 'parcels', revision: 1, kind: 'feature', geometry: 'polygon', wkid: 102100,
  maxRecordCount: 2_000, supportsZ: false, supportsM: false, objectIdField: 'OBJECTID', globalIdField: 'GlobalID',
  operations: ['query', 'identify', 'edit', 'statistics', 'pagination'], estimatedMetadataBytes: 2_000,
  fields: [
    { name: 'OBJECTID', type: 'oid', editable: false, nullable: false },
    { name: 'GlobalID', type: 'globalid', editable: false, nullable: false },
    { name: 'NAME', type: 'string', editable: true, nullable: false, maxLength: 80 },
    { name: 'SCORE', type: 'double', editable: true, nullable: true },
  ], ...overrides,
})

describe('ArcGisLayerCapabilityRegistry', () => {
  it('canonicalizes Web Mercator aliases and returns frozen detached views', () => { const r=new ArcGisLayerCapabilityRegistry(budget);const v=r.register(layer());expect(v.wkid).toBe(3857);expect(v.fieldCount).toBe(4);expect(Object.isFrozen(v)).toBe(true);expect(v).not.toHaveProperty('fields') })
  it.each([102100,102113,900913,3857])('canonicalizes wkid %s deterministically',wkid=>{expect(new ArcGisLayerCapabilityRegistry(budget).register(layer({wkid})).wkid).toBe(3857)})
  it('requires monotonic revisions',()=>{const r=new ArcGisLayerCapabilityRegistry(budget);r.register(layer());expect(()=>r.register(layer())).toThrow(/revision/);expect(r.register(layer({revision:2})).revision).toBe(2)})
  it('bounds layer cardinality',()=>{const r=new ArcGisLayerCapabilityRegistry({...budget,maxLayers:1});r.register(layer());expect(()=>r.register(layer({layerId:'buildings'}))).toThrow(/capacity/)})
  it('bounds fields and operations',()=>{const fields=[...layer().fields,...Array.from({length:5},(_,i)=>({name:`F_${i}`,type:'integer' as const,editable:true,nullable:true}))];expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({fields}))).toThrow(/field count/);expect(()=>new ArcGisLayerCapabilityRegistry({...budget,maxOperationsPerLayer:2}).register(layer())).toThrow(/operation count/)})
  it('rejects duplicate fields case-insensitively',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({fields:[...layer().fields,{name:'name',type:'string',editable:true,nullable:true}]}))).toThrow(/duplicate field/)})
  it('validates identity references',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({objectIdField:'MISSING'}))).toThrow(/oid field/);expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({globalIdField:'NAME'}))).toThrow(/globalid field/)})
  it('requires identity for edit',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({objectIdField:undefined,globalIdField:undefined}))).toThrow(/identity/)})
  it('rejects scene edit',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({kind:'scene'}))).toThrow(/scene layer edit/)})
  it('enforces operation dependencies',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({operations:['pagination']}))).toThrow(/requires query/);expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({operations:['statistics']}))).toThrow(/requires query/)})
  it('rejects duplicate operations',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({operations:['query','query']}))).toThrow(/duplicate operation/)})
  it('rejects non-spatial Z/M',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({geometry:'none',supportsZ:true}))).toThrow(/non-spatial/)})
  it('bounds record count and metadata',()=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({maxRecordCount:10001}))).toThrow(/ceiling/);expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({estimatedMetadataBytes:8001}))).toThrow(/per-layer/)})
  it('returns detached field metadata',()=>{const r=new ArcGisLayerCapabilityRegistry(budget);r.register(layer());expect(r.field('planning','parcels','name')).toEqual({name:'NAME',type:'string',editable:true,nullable:false,maxLength:80})})
  it('binds consumers to exact revision',()=>{const r=new ArcGisLayerCapabilityRegistry(budget);r.register(layer());expect(r.assertRevision('planning','parcels',1)).toBe(true);r.register(layer({revision:2}));expect(r.assertRevision('planning','parcels',1)).toBe(false)})
  it('releases metadata deterministically',()=>{const r=new ArcGisLayerCapabilityRegistry(budget);r.register(layer());expect(r.releaseLayer('planning','parcels')).toBe(true);expect(r.snapshot()).toEqual([])})
  it('fingerprints exclude transport payloads',()=>{const r=new ArcGisLayerCapabilityRegistry(budget);r.register(layer());expect(r.fingerprint()).not.toContain('http');expect(r.fingerprint()).not.toContain('token')})
  it.each(['','bad id','x'.repeat(161)])('rejects malformed service identifiers %s',serviceId=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({serviceId}))).toThrow(/invalid/)})
  it.each([NaN,Infinity,-Infinity,-1,1.5])('rejects invalid wkid %s',wkid=>{expect(()=>new ArcGisLayerCapabilityRegistry(budget).register(layer({wkid}))).toThrow()})
  it('dispose fails closed',()=>{const r=new ArcGisLayerCapabilityRegistry(budget);r.register(layer());r.dispose();expect(()=>r.snapshot()).toThrow(/disposed/)})
})
