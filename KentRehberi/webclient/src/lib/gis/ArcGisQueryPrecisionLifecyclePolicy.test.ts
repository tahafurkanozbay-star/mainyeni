import { describe, expect, it } from 'vitest'
import { ArcGisQueryPrecisionLifecyclePolicy, type QueryPrecisionRequest } from './ArcGisQueryPrecisionLifecyclePolicy'

const budget = { maxLayers: 3, maxPlans: 4, maxPlansPerLayer: 3, maxTotalTolerance: 20, maxTolerance: 10, maxDecimals: 8, planTtlMs: 100 }
const request = (overrides: Partial<QueryPrecisionRequest> = {}): QueryPrecisionRequest => ({
  planId: 'p1', layerId: 'roads', revision: 1, intent: 'visible', spatialReferenceWkid: 3857,
  tolerance: 2, geometryPrecision: 3, maxAllowableOffset: 1, returnGeometry: true, createdAt: 10, ...overrides,
})

describe('ArcGisQueryPrecisionLifecyclePolicy', () => {
  it('requires an active exact layer revision', () => {
    const p = new ArcGisQueryPrecisionLifecyclePolicy(budget)
    expect(p.admit(request())).toBeNull()
    expect(p.setRevision('roads', 1)).toBe(0)
    expect(p.admit(request())?.planId).toBe('p1')
    expect(p.admit(request({ planId:'stale', revision:0 }))).toBeNull()
  })

  it('invalidates resident plans on revision advance and rejects rollback', () => {
    const p = new ArcGisQueryPrecisionLifecyclePolicy(budget); p.setRevision('roads',1); p.admit(request())
    expect(p.setRevision('roads',2)).toBe(1)
    expect(p.snapshot().plans).toBe(0)
    expect(p.setRevision('roads',1)).toBe(-1)
  })

  it('dedupes equivalent scalar plans independent of plan id', () => {
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);expect(p.admit(request())).not.toBeNull()
    expect(p.admit(request({planId:'p2'}))).toBeNull()
  })

  it('bounds per-layer cardinality',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy({...budget,maxPlansPerLayer:1});p.setRevision('roads',1)
    expect(p.admit(request())).not.toBeNull();expect(p.admit(request({planId:'p2',tolerance:3}))).toBeNull()
  })

  it('bounds layer revision cardinality',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy({...budget,maxLayers:1});expect(p.setRevision('a',1)).toBe(0);expect(p.setRevision('b',1)).toBe(-1)
  })

  it('rejects precision and tolerance beyond budgets',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1)
    expect(p.admit(request({geometryPrecision:9}))).toBeNull()
    expect(p.admit(request({tolerance:11}))).toBeNull()
    expect(p.admit(request({maxAllowableOffset:11}))).toBeNull()
  })

  it('rejects geometry shaping when geometry is not returned',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1)
    expect(()=>p.admit(request({returnGeometry:false}))).toThrow(/requires returnGeometry/)
    expect(p.admit(request({returnGeometry:false,geometryPrecision:0,maxAllowableOffset:0}))).not.toBeNull()
  })

  it('rejects non-finite and malformed scalar input',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1)
    expect(()=>p.admit(request({tolerance:Number.NaN}))).toThrow(/tolerance/)
    expect(()=>p.admit(request({createdAt:-1}))).toThrow(/createdAt/)
    expect(()=>p.admit(request({spatialReferenceWkid:0}))).toThrow(/spatialReferenceWkid/)
  })

  it('evicts lower-intent plans under aggregate pressure',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy({...budget,maxTotalTolerance:7});p.setRevision('roads',1)
    p.admit(request({planId:'bg',intent:'background',tolerance:3,maxAllowableOffset:1,createdAt:1}))
    expect(p.admit(request({planId:'hot',intent:'interactive',tolerance:4,maxAllowableOffset:2,createdAt:2}))).not.toBeNull()
    expect(p.snapshot()).toEqual({layers:1,plans:1,totalTolerance:6})
  })

  it('does not evict higher-intent work for background pressure',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy({...budget,maxTotalTolerance:7});p.setRevision('roads',1)
    p.admit(request({planId:'hot',intent:'interactive',tolerance:3,maxAllowableOffset:1,createdAt:1}))
    expect(p.admit(request({planId:'bg',intent:'background',tolerance:4,maxAllowableOffset:2,createdAt:2}))).toBeNull()
    expect(p.snapshot().plans).toBe(1)
  })

  it('uses touch to extend TTL and consume atomically removes',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);p.admit(request({createdAt:0}))
    expect(p.touch('p1',1,50)).toBe(true);expect(p.expire(100)).toBe(0);expect(p.consume('p1',1,120)?.planId).toBe('p1');expect(p.snapshot().plans).toBe(0)
  })

  it('expires at the deterministic boundary',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);p.admit(request({createdAt:5}))
    expect(p.expire(104)).toBe(0);expect(p.expire(105)).toBe(1)
  })

  it('releases a layer and its revision authority',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);p.admit(request())
    expect(p.releaseLayer('roads')).toBe(1);expect(p.admit(request({planId:'new'}))).toBeNull()
  })

  it('returns frozen detached views and snapshots',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);const view=p.admit(request())!
    expect(Object.isFrozen(view)).toBe(true);expect(Object.isFrozen(p.snapshot())).toBe(true)
  })

  it('fingerprints scalar semantics without plan identifiers',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);p.admit(request({planId:'secret-ish-id'}))
    const fingerprint=p.fingerprint();expect(fingerprint).toContain('roads:1:visible:3857:2:3:1:1');expect(fingerprint).not.toContain('secret-ish-id')
  })

  it('validates constructor invariants',()=>{
    expect(()=>new ArcGisQueryPrecisionLifecyclePolicy({...budget,maxPlansPerLayer:5})).toThrow(/maxPlansPerLayer/)
    expect(()=>new ArcGisQueryPrecisionLifecyclePolicy({...budget,maxTolerance:21})).toThrow(/maxTolerance/)
  })

  it('disposal is idempotent and terminal',()=>{
    const p=new ArcGisQueryPrecisionLifecyclePolicy(budget);p.setRevision('roads',1);p.admit(request());p.dispose();p.dispose()
    expect(()=>p.snapshot()).toThrow(/disposed/);expect(()=>p.admit(request())).toThrow(/disposed/)
  })
})
