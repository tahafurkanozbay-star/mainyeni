import { describe, expect, it } from 'vitest'
import { ArcGisQueryTimeWindowLifecyclePolicy, type QueryTimeWindowBudget } from './ArcGisQueryTimeWindowLifecyclePolicy'

const budget = (overrides: Partial<QueryTimeWindowBudget> = {}): QueryTimeWindowBudget => ({
  maxLayers: 3,
  maxWindows: 4,
  maxWindowsPerLayer: 3,
  maxOpenEndedWindows: 2,
  maxSpanMs: 10_000,
  maxResidentSpanMs: 20_000,
  windowTtlMs: 100,
  ...overrides,
})

const policy = (overrides: Partial<QueryTimeWindowBudget> = {}) => new ArcGisQueryTimeWindowLifecyclePolicy(budget(overrides))

describe('ArcGisQueryTimeWindowLifecyclePolicy', () => {
  it('admits bounded scalar time windows after revision registration', () => {
    const subject = policy()
    expect(subject.setRevision('parcels', 2)).toBe(0)
    const view = subject.admit({ windowId:'w1',layerId:'parcels',revision:2,intent:'visible',startTime:100,endTime:500,createdAt:10 })
    expect(view).toMatchObject({ windowId:'w1',layerId:'parcels',revision:2,spanMs:400,openEnded:false })
    expect(Object.isFrozen(view)).toBe(true)
    expect(subject.snapshot()).toEqual({layers:1,windows:1,openEndedWindows:0,residentSpanMs:400})
  })

  it('rejects stale revisions and monotonically invalidates resident windows', () => {
    const subject = policy()
    subject.setRevision('roads', 4)
    expect(subject.admit({windowId:'stale',layerId:'roads',revision:3,intent:'interactive',startTime:1,endTime:2,createdAt:0})).toBeNull()
    expect(subject.admit({windowId:'live',layerId:'roads',revision:4,intent:'interactive',startTime:1,endTime:2,createdAt:0})).not.toBeNull()
    expect(subject.setRevision('roads', 3)).toBe(-1)
    expect(subject.setRevision('roads', 5)).toBe(1)
    expect(subject.snapshot().windows).toBe(0)
  })

  it('deduplicates logical windows independent of caller ids', () => {
    const subject=policy();subject.setRevision('events',1)
    expect(subject.admit({windowId:'a',layerId:'events',revision:1,intent:'visible',startTime:10,endTime:20,createdAt:1})).not.toBeNull()
    expect(subject.admit({windowId:'b',layerId:'events',revision:1,intent:'interactive',startTime:10,endTime:20,createdAt:2})).toBeNull()
    expect(subject.snapshot().windows).toBe(1)
  })

  it('bounds per-layer cardinality without evicting unrelated plans', () => {
    const subject=policy({maxWindowsPerLayer:2});subject.setRevision('a',1);subject.setRevision('b',1)
    expect(subject.admit({windowId:'a1',layerId:'a',revision:1,intent:'background',startTime:0,endTime:10,createdAt:0})).not.toBeNull()
    expect(subject.admit({windowId:'a2',layerId:'a',revision:1,intent:'background',startTime:20,endTime:30,createdAt:1})).not.toBeNull()
    expect(subject.admit({windowId:'a3',layerId:'a',revision:1,intent:'interactive',startTime:40,endTime:50,createdAt:2})).toBeNull()
    expect(subject.admit({windowId:'b1',layerId:'b',revision:1,intent:'visible',startTime:40,endTime:50,createdAt:2})).not.toBeNull()
  })

  it('evicts lower intent oldest work under global cardinality pressure', () => {
    const subject=policy({maxWindows:2,maxWindowsPerLayer:2});subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({windowId:'background',layerId:'a',revision:1,intent:'background',startTime:0,endTime:10,createdAt:0})
    subject.admit({windowId:'visible',layerId:'b',revision:1,intent:'visible',startTime:20,endTime:30,createdAt:1})
    expect(subject.admit({windowId:'interactive',layerId:'a',revision:1,intent:'interactive',startTime:40,endTime:50,createdAt:2})).not.toBeNull()
    expect(subject.release('background')).toBe(false)
    expect(subject.release('visible')).toBe(true)
  })

  it('does not let background pressure evict higher intent residents', () => {
    const subject=policy({maxWindows:1,maxWindowsPerLayer:1});subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({windowId:'interactive',layerId:'a',revision:1,intent:'interactive',startTime:0,endTime:10,createdAt:0})
    expect(subject.admit({windowId:'background',layerId:'b',revision:1,intent:'background',startTime:20,endTime:30,createdAt:1})).toBeNull()
    expect(subject.release('interactive')).toBe(true)
  })

  it('enforces aggregate resident span pressure', () => {
    const subject=policy({maxResidentSpanMs:100,maxSpanMs:100});subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({windowId:'old',layerId:'a',revision:1,intent:'background',startTime:0,endTime:70,createdAt:0})
    expect(subject.admit({windowId:'new',layerId:'b',revision:1,intent:'interactive',startTime:100,endTime:160,createdAt:1})).not.toBeNull()
    expect(subject.snapshot().residentSpanMs).toBe(60)
    expect(subject.release('old')).toBe(false)
  })

  it('bounds open-ended windows separately from finite span', () => {
    const subject=policy({maxOpenEndedWindows:1});subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({windowId:'open-low',layerId:'a',revision:1,intent:'background',startTime:null,endTime:100,createdAt:0})
    expect(subject.admit({windowId:'open-high',layerId:'b',revision:1,intent:'interactive',startTime:200,endTime:null,createdAt:1})).not.toBeNull()
    expect(subject.snapshot()).toMatchObject({openEndedWindows:1,residentSpanMs:0})
    expect(subject.release('open-low')).toBe(false)
  })

  it('rejects impossible and fully unbounded windows fail closed', () => {
    const subject=policy();subject.setRevision('a',1)
    expect(()=>subject.admit({windowId:'none',layerId:'a',revision:1,intent:'visible',startTime:null,endTime:null,createdAt:0})).toThrow('at least one bound')
    expect(()=>subject.admit({windowId:'reverse',layerId:'a',revision:1,intent:'visible',startTime:20,endTime:10,createdAt:0})).toThrow('precedes')
    expect(subject.admit({windowId:'huge',layerId:'a',revision:1,intent:'visible',startTime:0,endTime:20_000,createdAt:0})).toBeNull()
  })

  it('rejects non-scalar epoch values and invalid identifiers', () => {
    const subject=policy();subject.setRevision('a',1)
    expect(()=>subject.admit({windowId:'bad',layerId:'a',revision:1,intent:'visible',startTime:Number.NaN,endTime:1,createdAt:0})).toThrow('startTime')
    expect(()=>subject.admit({windowId:'bad',layerId:'a',revision:1,intent:'visible',startTime:-1,endTime:1,createdAt:0})).toThrow('startTime')
    expect(()=>subject.setRevision('bad\nlayer',1)).toThrow('layerId')
  })

  it('expires at the exact TTL boundary and frees pressure', () => {
    const subject=policy({windowTtlMs:10});subject.setRevision('a',1)
    subject.admit({windowId:'w',layerId:'a',revision:1,intent:'visible',startTime:0,endTime:1,createdAt:5})
    expect(subject.expire(14)).toBe(0)
    expect(subject.expire(15)).toBe(1)
    expect(subject.snapshot().windows).toBe(0)
  })

  it('touch extends TTL only for the current revision', () => {
    const subject=policy({windowTtlMs:10});subject.setRevision('a',1)
    subject.admit({windowId:'w',layerId:'a',revision:1,intent:'visible',startTime:0,endTime:1,createdAt:0})
    expect(subject.touch('w',2,5)).toBe(false)
    expect(subject.touch('w',1,5)).toBe(true)
    expect(subject.expire(10)).toBe(0)
    expect(subject.expire(15)).toBe(1)
  })

  it('consume atomically returns a detached frozen scalar view', () => {
    const subject=policy();subject.setRevision('a',1)
    subject.admit({windowId:'w',layerId:'a',revision:1,intent:'interactive',startTime:100,endTime:200,createdAt:0})
    const consumed=subject.consume('w',1,1)
    expect(consumed).toMatchObject({windowId:'w',startTime:100,endTime:200})
    expect(Object.isFrozen(consumed)).toBe(true)
    expect(subject.consume('w',1,2)).toBeNull()
    expect(subject.snapshot().windows).toBe(0)
  })

  it('releaseLayer clears revision and only the selected layer residents', () => {
    const subject=policy();subject.setRevision('a',1);subject.setRevision('b',1)
    subject.admit({windowId:'a1',layerId:'a',revision:1,intent:'visible',startTime:0,endTime:1,createdAt:0})
    subject.admit({windowId:'b1',layerId:'b',revision:1,intent:'visible',startTime:2,endTime:3,createdAt:0})
    expect(subject.releaseLayer('a')).toBe(1)
    expect(subject.snapshot()).toMatchObject({layers:1,windows:1})
    expect(subject.admit({windowId:'a2',layerId:'a',revision:1,intent:'visible',startTime:4,endTime:5,createdAt:1})).toBeNull()
  })

  it('fingerprint is deterministic and excludes caller payload objects', () => {
    const first=policy();const second=policy()
    for(const subject of [first,second]){subject.setRevision('a',1);subject.setRevision('b',2)}
    first.admit({windowId:'one',layerId:'b',revision:2,intent:'visible',startTime:null,endTime:50,createdAt:0})
    first.admit({windowId:'two',layerId:'a',revision:1,intent:'interactive',startTime:10,endTime:20,createdAt:0})
    second.admit({windowId:'x',layerId:'a',revision:1,intent:'interactive',startTime:10,endTime:20,createdAt:9})
    second.admit({windowId:'y',layerId:'b',revision:2,intent:'visible',startTime:null,endTime:50,createdAt:9})
    expect(first.fingerprint()).toBe(second.fingerprint())
    expect(first.fingerprint()).not.toContain('one')
    expect(first.fingerprint()).not.toContain('two')
  })

  it('bounds layer revision cardinality', () => {
    const subject=policy({maxLayers:1})
    expect(subject.setRevision('a',1)).toBe(0)
    expect(subject.setRevision('b',1)).toBe(-1)
    expect(subject.snapshot().layers).toBe(1)
  })

  it('validates internally inconsistent budgets', () => {
    expect(()=>policy({maxWindows:2,maxWindowsPerLayer:3})).toThrow('maxWindowsPerLayer')
    expect(()=>policy({maxWindows:2,maxOpenEndedWindows:3})).toThrow('maxOpenEndedWindows')
    expect(()=>policy({maxSpanMs:101,maxResidentSpanMs:100})).toThrow('maxSpanMs')
  })

  it('dispose is idempotent and terminal', () => {
    const subject=policy();subject.setRevision('a',1)
    subject.admit({windowId:'w',layerId:'a',revision:1,intent:'visible',startTime:0,endTime:1,createdAt:0})
    subject.dispose();subject.dispose()
    expect(()=>subject.snapshot()).toThrow('disposed')
    expect(()=>subject.setRevision('a',2)).toThrow('disposed')
  })
})
