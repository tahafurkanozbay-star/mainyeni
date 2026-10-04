import { describe, expect, it } from 'vitest'
import { ArcGisQueryOrderByLifecyclePolicy, type QueryOrderBudget } from './ArcGisQueryOrderByLifecyclePolicy'

const budget: QueryOrderBudget = { maxLayers: 3, maxOrders: 4, maxOrdersPerLayer: 3, maxFieldsPerOrder: 3, maxResidentFieldRefs: 6, maxFieldNameBytes: 48, orderTtlMs: 100 }
const policy = (overrides: Partial<QueryOrderBudget> = {}) => new ArcGisQueryOrderByLifecyclePolicy({ ...budget, ...overrides })

describe('ArcGisQueryOrderByLifecyclePolicy', () => {
  it('invalidates stale ordering state on monotonic revision advance', () => {
    const subject=policy();expect(subject.setRevision('roads',1)).toBe(0)
    expect(subject.admit({orderId:'a',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME',direction:'ASC'}],createdAt:1})).not.toBeNull()
    expect(subject.setRevision('roads',2)).toBe(1);expect(subject.snapshot().orders).toBe(0);expect(subject.setRevision('roads',1)).toBe(-1)
  })

  it('preserves order semantics while deduplicating identical logical clauses', () => {
    const subject=policy();subject.setRevision('roads',1)
    expect(subject.admit({orderId:'a',layerId:'roads',revision:1,intent:'interactive',fields:[{fieldName:'DISTRICT',direction:'ASC'},{fieldName:'NAME',direction:'DESC'}],createdAt:1})).not.toBeNull()
    expect(subject.admit({orderId:'b',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'DISTRICT',direction:'ASC'},{fieldName:'NAME',direction:'DESC'}],createdAt:2})).toBeNull()
    expect(subject.admit({orderId:'c',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME',direction:'DESC'},{fieldName:'DISTRICT',direction:'ASC'}],createdAt:2})).not.toBeNull()
  })

  it('rejects unsafe fields, duplicate fields and malformed directions', () => {
    const subject=policy();subject.setRevision('roads',1)
    expect(()=>subject.admit({orderId:'a',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME DESC; DROP',direction:'ASC'}],createdAt:1})).toThrow('unsafe')
    expect(()=>subject.admit({orderId:'b',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME',direction:'ASC'},{fieldName:'name',direction:'DESC'}],createdAt:1})).toThrow('duplicate')
    expect(()=>subject.admit({orderId:'c',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME',direction:'SIDEWAYS' as 'ASC'}],createdAt:1})).toThrow('direction')
  })

  it('enforces field, utf8 byte and layer cardinality budgets', () => {
    const subject=policy({maxFieldsPerOrder:2,maxFieldNameBytes:6,maxOrdersPerLayer:1});subject.setRevision('roads',1)
    expect(subject.admit({orderId:'wide',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'A',direction:'ASC'},{fieldName:'B',direction:'ASC'},{fieldName:'C',direction:'ASC'}],createdAt:1})).toBeNull()
    expect(subject.admit({orderId:'bytes',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'İST',direction:'ASC'},{fieldName:'ABC',direction:'ASC'}],createdAt:1})).toBeNull()
    expect(subject.admit({orderId:'ok',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME',direction:'ASC'}],createdAt:1})).not.toBeNull()
    expect(subject.admit({orderId:'second',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'ID',direction:'ASC'}],createdAt:2})).toBeNull()
  })

  it('evicts lower intent older state under aggregate field pressure', () => {
    const subject=policy({maxResidentFieldRefs:3,maxOrders:3});subject.setRevision('roads',1);subject.setRevision('parks',1)
    subject.admit({orderId:'bg',layerId:'roads',revision:1,intent:'background',fields:[{fieldName:'A',direction:'ASC'},{fieldName:'B',direction:'ASC'}],createdAt:1})
    const admitted=subject.admit({orderId:'hot',layerId:'parks',revision:1,intent:'interactive',fields:[{fieldName:'C',direction:'ASC'},{fieldName:'D',direction:'DESC'}],createdAt:2})
    expect(admitted?.orderId).toBe('hot');expect(subject.snapshot()).toMatchObject({orders:1,fieldRefs:2})
  })

  it('does not let background pressure evict interactive state', () => {
    const subject=policy({maxOrders:1,maxOrdersPerLayer:1});subject.setRevision('roads',1);subject.setRevision('parks',1)
    subject.admit({orderId:'hot',layerId:'roads',revision:1,intent:'interactive',fields:[{fieldName:'A',direction:'ASC'}],createdAt:1})
    expect(subject.admit({orderId:'bg',layerId:'parks',revision:1,intent:'background',fields:[{fieldName:'B',direction:'ASC'}],createdAt:2})).toBeNull()
    expect(subject.fingerprint()).toContain('roads:1:interactive')
  })

  it('expires at the exact ttl boundary and touch extends residency', () => {
    const subject=policy();subject.setRevision('roads',1);subject.admit({orderId:'a',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'A',direction:'ASC'}],createdAt:10})
    expect(subject.expire(109)).toBe(0);expect(subject.touch('a',1,109)).toBe(true);expect(subject.expire(208)).toBe(0);expect(subject.expire(209)).toBe(1)
  })

  it('releases a layer atomically and permits clean revision re-admission', () => {
    const subject=policy();subject.setRevision('roads',1);subject.admit({orderId:'a',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'A',direction:'ASC'}],createdAt:1})
    expect(subject.releaseLayer('roads')).toBe(1);expect(subject.snapshot()).toEqual({layers:0,orders:0,fieldRefs:0,fieldNameBytes:0});expect(subject.setRevision('roads',2)).toBe(0)
  })

  it('returns frozen payload-free scalar views and deterministic fingerprints', () => {
    const subject=policy();subject.setRevision('roads',1);const view=subject.admit({orderId:'a',layerId:'roads',revision:1,intent:'visible',fields:[{fieldName:'NAME',direction:'ASC'}],createdAt:1})!
    expect(Object.isFrozen(view)).toBe(true);expect(Object.keys(view).sort()).toEqual(['createdAt','expiresAt','fieldCount','fieldNameBytes','intent','layerId','orderId','revision','sequence','touchedAt'].sort())
    expect(subject.fingerprint()).toContain('roads:1:visible:1:4')
  })

  it('fails closed after terminal disposal', () => {
    const subject=policy();subject.dispose();subject.dispose();expect(()=>subject.snapshot()).toThrow('disposed');expect(()=>subject.setRevision('roads',1)).toThrow('disposed')
  })
})
