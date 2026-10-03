import { describe, expect, it } from 'vitest'
import { ArcGisQueryAdmissionPolicy, type ArcGisQueryAdmissionBudget, type ArcGisQueryIntent } from './ArcGisQueryAdmissionPolicy'

const budget: ArcGisQueryAdmissionBudget = {
  maxServices: 2, maxLayersPerService: 2, maxActiveQueries: 2, maxQueuedQueries: 4,
  maxActivePerLayer: 1, maxQueuedPerLayer: 2, maxResultRecords: 2_000, maxOffset: 10_000,
  maxOutFields: 8, maxWhereLength: 2_048, maxGeometryVertices: 5_000,
  maxEstimatedResponseBytes: 2_000_000, maxAggregateEstimatedResponseBytes: 3_000_000,
  maxQueueAgeMs: 5_000, maxExecutionAgeMs: 10_000,
}
const query = (overrides: Partial<ArcGisQueryIntent> = {}): ArcGisQueryIntent => ({
  id: 'q-1', serviceId: 'planning', layerId: 'parcels', revision: 1, priority: 'foreground',
  geometryKind: 'extent', geometryVertices: 4, resultRecordCount: 500, resultOffset: 0,
  outFields: ['OBJECTID', 'NAME'], whereLength: 20, estimatedResponseBytes: 500_000, createdAt: 1_000,
  ...overrides,
})

describe('ArcGisQueryAdmissionPolicy', () => {
  it('admits a bounded query and exposes payload-free lease metadata', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(), 1_000)
    const lease = policy.admitNext(1_100)
    expect(lease).toEqual({ id:'q-1', serviceId:'planning', layerId:'parcels', revision:1, admittedAt:1_100, expiresAt:11_100, estimatedResponseBytes:500_000 })
    expect(lease).not.toHaveProperty('outFields')
    expect(lease).not.toHaveProperty('where')
    expect(lease).not.toHaveProperty('geometry')
  })

  it('orders interactive work before foreground and background work', () => {
    const policy = new ArcGisQueryAdmissionPolicy({...budget,maxActivePerLayer:2})
    policy.enqueue(query({id:'background',priority:'background',layerId:'a'}),1_000)
    policy.enqueue(query({id:'foreground',priority:'foreground',layerId:'b'}),1_000)
    policy.enqueue(query({id:'interactive',priority:'interactive',layerId:'a'}),1_000)
    expect(policy.admitNext(1_100)?.id).toBe('interactive')
    expect(policy.admitNext(1_100)?.id).toBe('foreground')
  })

  it('uses creation time then insertion order as deterministic tie breakers', () => {
    const policy = new ArcGisQueryAdmissionPolicy({...budget,maxActivePerLayer:2})
    policy.enqueue(query({id:'newer',createdAt:1_100,layerId:'a'}),1_100)
    policy.enqueue(query({id:'older',createdAt:900,layerId:'b'}),1_100)
    expect(policy.admitNext(1_200)?.id).toBe('older')
    const second = new ArcGisQueryAdmissionPolicy({...budget,maxActivePerLayer:2})
    second.enqueue(query({id:'first',layerId:'a'}),1_000)
    second.enqueue(query({id:'second',layerId:'b'}),1_000)
    expect(second.admitNext(1_100)?.id).toBe('first')
  })

  it('does not let one layer exceed its active concurrency budget', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query({id:'a'}),1_000)
    policy.enqueue(query({id:'b'}),1_000)
    expect(policy.admitNext(1_100)?.id).toBe('a')
    expect(policy.admitNext(1_100)).toBeUndefined()
    expect(policy.complete('a',1)).toBe(true)
    expect(policy.admitNext(1_200)?.id).toBe('b')
  })

  it('skips work that would exceed aggregate response byte residency', () => {
    const policy = new ArcGisQueryAdmissionPolicy({...budget,maxActivePerLayer:2})
    policy.enqueue(query({id:'large-a',layerId:'a',estimatedResponseBytes:1_800_000,priority:'interactive'}),1_000)
    policy.enqueue(query({id:'large-b',layerId:'b',estimatedResponseBytes:1_800_000,priority:'interactive'}),1_000)
    expect(policy.admitNext(1_100)?.id).toBe('large-a')
    expect(policy.admitNext(1_100)).toBeUndefined()
    expect(policy.snapshot().activeEstimatedResponseBytes).toBe(1_800_000)
  })

  it('rejects duplicate ids across queued and active states', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(),1_000)
    expect(()=>policy.enqueue(query(),1_000)).toThrow(/already registered/)
    policy.admitNext(1_100)
    expect(()=>policy.enqueue(query(),1_200)).toThrow(/already registered/)
  })

  it('requires exact revision when completing a lease', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(),1_000); policy.admitNext(1_100)
    expect(policy.complete('q-1',2)).toBe(false)
    expect(policy.snapshot().active).toBe(1)
    expect(policy.complete('q-1',1)).toBe(true)
    expect(policy.snapshot().active).toBe(0)
  })

  it('expires stale queue entries before admission', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(),1_000)
    expect(policy.admitNext(6_001)).toBeUndefined()
    expect(policy.snapshot()).toMatchObject({queued:0,active:0,expired:1})
  })

  it('expires active leases at the execution deadline', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(),1_000); policy.admitNext(1_100)
    expect(policy.sweep(11_099)).toBe(0)
    expect(policy.sweep(11_100)).toBe(1)
    expect(policy.snapshot()).toMatchObject({active:0,expired:1})
  })

  it('rejects intents already older than the queue age budget', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    expect(()=>policy.enqueue(query({createdAt:1_000}),6_001)).toThrow(/already expired/)
  })

  it('rejects future-created intents to avoid clock inversion', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    expect(()=>policy.enqueue(query({createdAt:1_001}),1_000)).toThrow(/future/)
  })

  it('bounds result record count and offset', () => {
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({resultRecordCount:2_001}),1_000)).toThrow(/record count/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({resultOffset:10_001}),1_000)).toThrow(/offset/)
  })

  it('bounds where metadata length without retaining the where clause', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    expect(()=>policy.enqueue(query({whereLength:2_049}),1_000)).toThrow(/where length/)
    const accepted=policy.enqueue(query({whereLength:2_048}),1_000)
    expect(accepted).toHaveProperty('whereLength',2_048)
    expect(accepted).not.toHaveProperty('where')
  })

  it('bounds geometry complexity and requires coherent geometry metadata', () => {
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({geometryVertices:5_001}),1_000)).toThrow(/vertex/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({geometryKind:'none',geometryVertices:1}),1_000)).toThrow(/non-spatial/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({geometryKind:'point',geometryVertices:0}),1_000)).toThrow(/requires geometry/)
    expect(new ArcGisQueryAdmissionPolicy(budget).enqueue(query({geometryKind:'none',geometryVertices:0}),1_000).geometryVertices).toBe(0)
  })

  it('bounds per-query estimated response bytes', () => {
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({estimatedResponseBytes:2_000_001}),1_000)).toThrow(/response bytes/)
  })

  it('validates and de-duplicates requested fields case-insensitively', () => {
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({outFields:[]}),1_000)).toThrow(/outFields count/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({outFields:['NAME','name']}),1_000)).toThrow(/duplicate outField/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({outFields:['bad field']}),1_000)).toThrow(/outField is invalid/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({outFields:['*','NAME']}),1_000)).toThrow(/wildcard/)
    expect(new ArcGisQueryAdmissionPolicy(budget).enqueue(query({outFields:['*']}),1_000).outFields).toEqual(['*'])
  })

  it('bounds global and per-layer queue cardinality', () => {
    const perLayer = new ArcGisQueryAdmissionPolicy({...budget,maxQueuedPerLayer:1})
    perLayer.enqueue(query({id:'a'}),1_000)
    expect(()=>perLayer.enqueue(query({id:'b'}),1_000)).toThrow(/layer queue/)
    const global = new ArcGisQueryAdmissionPolicy({...budget,maxQueuedQueries:2,maxQueuedPerLayer:2})
    global.enqueue(query({id:'a',layerId:'a'}),1_000); global.enqueue(query({id:'b',layerId:'b'}),1_000)
    expect(()=>global.enqueue(query({id:'c',serviceId:'other',layerId:'c'}),1_000)).toThrow(/queue capacity/)
  })

  it('bounds service and layer cardinality', () => {
    const services = new ArcGisQueryAdmissionPolicy({...budget,maxServices:1})
    services.enqueue(query({id:'a'}),1_000)
    expect(()=>services.enqueue(query({id:'b',serviceId:'other'}),1_000)).toThrow(/service cardinality/)
    const layers = new ArcGisQueryAdmissionPolicy({...budget,maxLayersPerService:1})
    layers.enqueue(query({id:'a'}),1_000)
    expect(()=>layers.enqueue(query({id:'b',layerId:'buildings'}),1_000)).toThrow(/layer cardinality/)
  })

  it('cancels one query or an entire layer deterministically', () => {
    const policy = new ArcGisQueryAdmissionPolicy({...budget,maxActivePerLayer:2})
    policy.enqueue(query({id:'a'}),1_000); policy.enqueue(query({id:'b'}),1_000); policy.enqueue(query({id:'c',layerId:'other'}),1_000)
    policy.admitNext(1_100)
    expect(policy.cancel('b')).toBe(true)
    expect(policy.cancel('missing')).toBe(false)
    expect(policy.cancelLayer('planning','parcels')).toBe(1)
    expect(policy.snapshot()).toMatchObject({active:0,queued:1,cancelled:2})
  })

  it('returns frozen detached queue and active views', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    const source=query(); policy.enqueue(source,1_000)
    const queued=policy.queued(); expect(Object.isFrozen(queued)).toBe(true); expect(Object.isFrozen(queued[0])).toBe(true); expect(queued[0].outFields).not.toBe(source.outFields)
    policy.admitNext(1_100); const active=policy.active(); expect(Object.isFrozen(active)).toBe(true); expect(Object.isFrozen(active[0])).toBe(true)
  })

  it('tracks bounded scalar diagnostics without identifiers or payloads', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(),1_000); policy.admitNext(1_100)
    const snapshot=policy.snapshot(); expect(snapshot).toEqual({active:1,queued:0,activeEstimatedResponseBytes:500_000,services:1,layers:1,admitted:1,rejected:0,expired:0,cancelled:0})
    expect(snapshot).not.toHaveProperty('serviceId'); expect(snapshot).not.toHaveProperty('layerId'); expect(snapshot).not.toHaveProperty('where')
  })

  it('fails closed after disposal and disposal is idempotent', () => {
    const policy = new ArcGisQueryAdmissionPolicy(budget)
    policy.enqueue(query(),1_000); policy.dispose(); policy.dispose()
    expect(()=>policy.snapshot()).toThrow(/disposed/)
    expect(()=>policy.enqueue(query({id:'after'}),2_000)).toThrow(/disposed/)
  })

  it('rejects malformed identifiers and invalid numeric metadata', () => {
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({id:'bad id'}),1_000)).toThrow(/invalid/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({serviceId:''}),1_000)).toThrow(/invalid/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({revision:-1}),1_000)).toThrow(/revision/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({resultOffset:1.5}),1_000)).toThrow(/offset/)
    expect(()=>new ArcGisQueryAdmissionPolicy(budget).enqueue(query({createdAt:Infinity}),1_000)).toThrow(/createdAt/)
  })

  it('rejects inconsistent constructor budgets', () => {
    expect(()=>new ArcGisQueryAdmissionPolicy({...budget,maxActivePerLayer:3,maxActiveQueries:2})).toThrow(/active per-layer/)
    expect(()=>new ArcGisQueryAdmissionPolicy({...budget,maxQueuedPerLayer:5,maxQueuedQueries:4})).toThrow(/queued per-layer/)
    expect(()=>new ArcGisQueryAdmissionPolicy({...budget,maxEstimatedResponseBytes:4_000_000,maxAggregateEstimatedResponseBytes:3_000_000})).toThrow(/inconsistent/)
  })
})
