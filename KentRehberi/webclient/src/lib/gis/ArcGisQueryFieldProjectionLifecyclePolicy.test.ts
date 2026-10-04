import { describe, expect, it } from 'vitest'
import { ArcGisQueryFieldProjectionLifecyclePolicy, type QueryFieldProjectionBudget } from './ArcGisQueryFieldProjectionLifecyclePolicy'

const budget = (overrides: Partial<QueryFieldProjectionBudget> = {}): QueryFieldProjectionBudget => ({
  maxLayers: 3,
  maxProjections: 4,
  maxProjectionsPerLayer: 3,
  maxFieldsPerProjection: 4,
  maxFieldNameBytes: 64,
  maxResidentFieldRefs: 8,
  projectionTtlMs: 100,
  ...overrides,
})

const policy = (overrides: Partial<QueryFieldProjectionBudget> = {}) => new ArcGisQueryFieldProjectionLifecyclePolicy(budget(overrides))

describe('ArcGisQueryFieldProjectionLifecyclePolicy', () => {
  it('requires a current monotonic layer revision before admission', () => {
    const subject = policy()
    expect(subject.setRevision('parcels', 4)).toBe(0)
    expect(subject.setRevision('parcels', 3)).toBe(-1)
    expect(subject.admit({ projectionId:'p1',layerId:'parcels',revision:3,intent:'visible',fieldNames:['OBJECTID'],createdAt:0 })).toBeNull()
    expect(subject.admit({ projectionId:'p1',layerId:'parcels',revision:4,intent:'visible',fieldNames:['OBJECTID'],createdAt:0 })?.fieldCount).toBe(1)
  })

  it('invalidates projections when a layer revision advances', () => {
    const subject=policy();subject.setRevision('roads',1)
    subject.admit({projectionId:'a',layerId:'roads',revision:1,intent:'visible',fieldNames:['id'],createdAt:0})
    subject.admit({projectionId:'b',layerId:'roads',revision:1,intent:'background',fieldNames:['name'],createdAt:1})
    expect(subject.setRevision('roads',2)).toBe(2)
    expect(subject.snapshot().projections).toBe(0)
  })

  it('deduplicates logical projections independent of field order and duplicates', () => {
    const subject=policy();subject.setRevision('poi',1)
    expect(subject.admit({projectionId:'a',layerId:'poi',revision:1,intent:'interactive',fieldNames:['name','OBJECTID','name'],createdAt:0})?.fieldCount).toBe(2)
    expect(subject.admit({projectionId:'b',layerId:'poi',revision:1,intent:'visible',fieldNames:['OBJECTID','name'],createdAt:1})).toBeNull()
  })

  it('rejects unsafe wildcard and expression-shaped field identifiers', () => {
    const subject=policy();subject.setRevision('poi',1)
    for(const field of ['*','name,OBJECTID','UPPER(name)','x=y','x;y']) {
      expect(()=>subject.admit({projectionId:`p-${field}`,layerId:'poi',revision:1,intent:'visible',fieldNames:[field],createdAt:0})).toThrow()
    }
  })

  it('bounds fields, UTF-8 field-name bytes and resident field references', () => {
    const subject=policy({maxFieldsPerProjection:2,maxFieldNameBytes:8,maxResidentFieldRefs:3,maxProjections:3,maxProjectionsPerLayer:3})
    subject.setRevision('a',1);subject.setRevision('b',1)
    expect(subject.admit({projectionId:'too-many',layerId:'a',revision:1,intent:'visible',fieldNames:['a','b','c'],createdAt:0})).toBeNull()
    expect(subject.admit({projectionId:'too-wide',layerId:'a',revision:1,intent:'visible',fieldNames:['ççççç'],createdAt:0})).toBeNull()
    expect(subject.admit({projectionId:'one',layerId:'a',revision:1,intent:'background',fieldNames:['a','b'],createdAt:0})).not.toBeNull()
    expect(subject.admit({projectionId:'two',layerId:'b',revision:1,intent:'visible',fieldNames:['c','d'],createdAt:1})).not.toBeNull()
    expect(subject.snapshot().fieldRefs).toBe(2)
  })

  it('evicts lower-intent older residency deterministically under pressure', () => {
    const subject=policy({maxProjections:2,maxProjectionsPerLayer:2,maxResidentFieldRefs:3})
    subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({projectionId:'background',layerId:'a',revision:1,intent:'background',fieldNames:['a','b'],createdAt:0})
    subject.admit({projectionId:'visible',layerId:'a',revision:1,intent:'visible',fieldNames:['c'],createdAt:1})
    expect(subject.admit({projectionId:'interactive',layerId:'b',revision:1,intent:'interactive',fieldNames:['d','e'],createdAt:2})).not.toBeNull()
    expect(subject.release('background')).toBe(false)
    expect(subject.snapshot()).toMatchObject({projections:2,fieldRefs:3})
  })

  it('does not evict higher intent work for lower intent admission', () => {
    const subject=policy({maxProjections:1,maxProjectionsPerLayer:1,maxResidentFieldRefs:2})
    subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({projectionId:'interactive',layerId:'a',revision:1,intent:'interactive',fieldNames:['a'],createdAt:0})
    expect(subject.admit({projectionId:'background',layerId:'b',revision:1,intent:'background',fieldNames:['b'],createdAt:1})).toBeNull()
    expect(subject.release('interactive')).toBe(true)
  })

  it('expires exactly at the TTL boundary and touch extends residency', () => {
    const subject=policy();subject.setRevision('a',1)
    subject.admit({projectionId:'p',layerId:'a',revision:1,intent:'visible',fieldNames:['a'],createdAt:10})
    expect(subject.expire(109)).toBe(0)
    expect(subject.touch('p',1,109)).toBe(true)
    expect(subject.expire(208)).toBe(0)
    expect(subject.expire(209)).toBe(1)
  })

  it('bounds tracked layers and per-layer projection cardinality', () => {
    const subject=policy({maxLayers:1,maxProjectionsPerLayer:1})
    expect(subject.setRevision('a',1)).toBe(0)
    expect(subject.setRevision('b',1)).toBe(-1)
    expect(subject.admit({projectionId:'a1',layerId:'a',revision:1,intent:'visible',fieldNames:['x'],createdAt:0})).not.toBeNull()
    expect(subject.admit({projectionId:'a2',layerId:'a',revision:1,intent:'visible',fieldNames:['y'],createdAt:1})).toBeNull()
  })

  it('releases a layer atomically with its revision authority', () => {
    const subject=policy();subject.setRevision('a',1)
    subject.admit({projectionId:'a1',layerId:'a',revision:1,intent:'visible',fieldNames:['x'],createdAt:0})
    subject.admit({projectionId:'a2',layerId:'a',revision:1,intent:'background',fieldNames:['y'],createdAt:1})
    expect(subject.releaseLayer('a')).toBe(2)
    expect(subject.snapshot()).toEqual({layers:0,projections:0,fieldRefs:0,fieldNameBytes:0})
  })

  it('publishes detached frozen views and scalar aggregate snapshots', () => {
    const subject=policy();subject.setRevision('a',1)
    const view=subject.admit({projectionId:'p',layerId:'a',revision:1,intent:'visible',fieldNames:['OBJECTID','name'],createdAt:0})!
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.keys(view).sort()).toEqual(['createdAt','expiresAt','fieldCount','fieldNameBytes','intent','layerId','projectionId','revision','sequence','touchedAt'].sort())
    expect(subject.snapshot()).toEqual({layers:1,projections:1,fieldRefs:2,fieldNameBytes:12})
  })

  it('produces deterministic payload-free fingerprints', () => {
    const a=policy(),b=policy();for(const subject of [a,b]){subject.setRevision('layer',2);subject.admit({projectionId:'different-id',layerId:'layer',revision:2,intent:'visible',fieldNames:['name','OBJECTID'],createdAt:7})}
    expect(a.fingerprint()).toBe(b.fingerprint())
    expect(a.fingerprint()).not.toContain('different-id')
  })

  it('fails closed for malformed scalar inputs and invalid budgets', () => {
    expect(()=>policy({maxProjectionsPerLayer:5,maxProjections:4})).toThrow()
    expect(()=>policy({maxFieldsPerProjection:9,maxResidentFieldRefs:8})).toThrow()
    const subject=policy();expect(()=>subject.setRevision('',1)).toThrow();expect(()=>subject.setRevision('a',-1)).toThrow()
    subject.setRevision('a',1)
    expect(()=>subject.admit({projectionId:'p',layerId:'a',revision:1,intent:'visible',fieldNames:[],createdAt:0})).toThrow()
    expect(()=>subject.admit({projectionId:'p',layerId:'a',revision:1,intent:'visible',fieldNames:['ok'],createdAt:Number.NaN})).toThrow()
  })

  it('is terminal after disposal and disposal is idempotent', () => {
    const subject=policy();subject.setRevision('a',1);subject.dispose();subject.dispose()
    expect(()=>subject.snapshot()).toThrow('disposed')
    expect(()=>subject.setRevision('a',2)).toThrow('disposed')
  })
})
