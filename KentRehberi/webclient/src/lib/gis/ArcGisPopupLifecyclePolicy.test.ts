import { describe, expect, it } from 'vitest'
import { ArcGisPopupLifecyclePolicy, type ArcGisPopupBudget, type ArcGisPopupRequest } from './ArcGisPopupLifecyclePolicy'

const budget = (overrides: Partial<ArcGisPopupBudget> = {}): ArcGisPopupBudget => ({ maxLayers: 3, maxPopups: 5, maxPopupsPerLayer: 3, maxPinnedPopups: 2, maxLoadingPopups: 2, maxEstimatedContentBytes: 1000, maxEstimatedContentBytesPerPopup: 500, maxFieldsPerPopup: 4, hoverTtlMs: 10, inspectTtlMs: 20, selectedTtlMs: 30, loadingLeaseMs: 15, ...overrides })
const request = (overrides: Partial<ArcGisPopupRequest> = {}): ArcGisPopupRequest => ({ layerId: 'parcels', featureKey: '42', revision: 1, intent: 'inspect', fieldNames: ['NAME', 'OBJECTID'], estimatedContentBytes: 100, requestedAt: 100, ...overrides })

describe('ArcGisPopupLifecyclePolicy', () => {
  it('canonicalizes fields and exposes immutable deterministic state', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    expect(policy.admit(request({ fieldNames: ['NAME', 'OBJECTID', 'NAME'] }))).toBe(true)
    expect(policy.entriesForLayer('parcels')[0].fieldNames).toEqual(['NAME', 'OBJECTID'])
    const first = policy.snapshot()
    expect(policy.snapshot().fingerprint).toBe(first.fingerprint)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.revisionWatermark)).toBe(true)
  })

  it('enforces aggregate, per-popup and per-layer budgets', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget({ maxPopups: 2, maxPopupsPerLayer: 1, maxEstimatedContentBytes: 300, maxEstimatedContentBytesPerPopup: 200 }))
    expect(policy.admit(request({ estimatedContentBytes: 201 }))).toBe(false)
    expect(policy.admit(request({ estimatedContentBytes: 180 }))).toBe(true)
    expect(policy.admit(request({ featureKey: '43', estimatedContentBytes: 10 }))).toBe(false)
    expect(policy.admit(request({ layerId: 'roads', featureKey: '9', estimatedContentBytes: 121 }))).toBe(false)
    expect(policy.admit(request({ layerId: 'roads', featureKey: '9', estimatedContentBytes: 120 }))).toBe(true)
  })

  it('bounds pinned and loading cardinality independently', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget({ maxPinnedPopups: 1, maxLoadingPopups: 1 }))
    expect(policy.admit(request({ featureKey: '1', intent: 'pinned' }))).toBe(true)
    expect(policy.admit(request({ featureKey: '2', intent: 'pinned' }))).toBe(false)
    expect(policy.admit(request({ featureKey: '2', intent: 'selected' }))).toBe(true)
    expect(policy.beginLoading('parcels', '1', 101)).toBe(true)
    expect(policy.beginLoading('parcels', '2', 101)).toBe(false)
  })

  it('rejects stale revisions and invalidates old entries on revision advance', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    expect(policy.admit(request({ featureKey: '1', revision: 2 }))).toBe(true)
    expect(policy.admit(request({ featureKey: '2', revision: 1 }))).toBe(false)
    expect(policy.admit(request({ featureKey: '2', revision: 3 }))).toBe(true)
    expect(policy.entriesForLayer('parcels').map(entry => entry.featureKey)).toEqual(['2'])
    expect(policy.snapshot().revisionWatermark.parcels).toBe(3)
  })

  it('requires matching loading revision to resolve or fail', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request())
    expect(policy.resolve('parcels', '42', 1, 101)).toBe(false)
    expect(policy.beginLoading('parcels', '42', 101)).toBe(true)
    expect(policy.resolve('parcels', '42', 2, 102)).toBe(false)
    expect(policy.resolve('parcels', '42', 1, 102)).toBe(true)
    expect(policy.entriesForLayer('parcels')[0].state).toBe('ready')
  })

  it('records bounded error state without retaining response payloads', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request())
    policy.beginLoading('parcels', '42', 101)
    expect(policy.fail('parcels', '42', 1, 'timeout', 102)).toBe(true)
    const entry = policy.entriesForLayer('parcels')[0]
    expect(entry.state).toBe('error')
    expect(entry.errorCode).toBe('timeout')
    expect(entry.loadingLeaseUntil).toBeNull()
  })

  it('expires loading leases and finite intent TTLs while preserving pins', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request({ featureKey: 'hover', intent: 'hover', requestedAt: 100 }))
    policy.admit(request({ featureKey: 'load', intent: 'selected', requestedAt: 100 }))
    policy.admit(request({ featureKey: 'pin', intent: 'pinned', requestedAt: 100 }))
    policy.beginLoading('parcels', 'load', 100)
    expect(policy.expire(111)).toBe(1)
    expect(policy.expire(116)).toBe(1)
    expect(policy.entriesForLayer('parcels').map(entry => entry.featureKey)).toEqual(['pin'])
  })

  it('promotes intent without allowing priority regression', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request({ intent: 'hover' }))
    expect(policy.promote('parcels', '42', 'selected', 105)).toBe(true)
    expect(policy.admit(request({ intent: 'inspect', requestedAt: 106 }))).toBe(false)
    expect(policy.entriesForLayer('parcels')[0].intent).toBe('selected')
  })

  it('orders entries by intent then stable admission sequence', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request({ featureKey: 'a', intent: 'inspect' }))
    policy.admit(request({ featureKey: 'b', intent: 'pinned' }))
    policy.admit(request({ featureKey: 'c', intent: 'inspect' }))
    expect(policy.entriesForLayer('parcels').map(entry => entry.featureKey)).toEqual(['b', 'a', 'c'])
  })

  it('enforces layer cardinality through revision watermarks', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget({ maxLayers: 1 }))
    expect(policy.admit(request({ layerId: 'a' }))).toBe(true)
    expect(policy.admit(request({ layerId: 'b', featureKey: '2' }))).toBe(false)
    expect(policy.invalidateLayer('b', 2)).toBe(0)
  })

  it('releases entries without dropping a layer revision watermark', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request({ revision: 4 }))
    expect(policy.release('parcels', '42')).toBe(true)
    expect(policy.snapshot().popups).toBe(0)
    expect(policy.snapshot().revisionWatermark.parcels).toBe(4)
    expect(policy.admit(request({ revision: 3 }))).toBe(false)
  })

  it('rejects unsafe identifiers, fields, revisions and byte estimates', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    expect(() => policy.admit(request({ layerId: ' ' }))).toThrow()
    expect(() => policy.admit(request({ revision: -1 }))).toThrow()
    expect(() => policy.admit(request({ estimatedContentBytes: Number.NaN }))).toThrow()
    expect(() => policy.admit(request({ fieldNames: ['a', 'b', 'c', 'd', 'e'] }))).toThrow()
  })

  it('validates internally consistent budgets', () => {
    expect(() => new ArcGisPopupLifecyclePolicy(budget({ maxPopups: 1, maxPopupsPerLayer: 2 }))).toThrow()
    expect(() => new ArcGisPopupLifecyclePolicy(budget({ maxPopups: 1, maxPinnedPopups: 2 }))).toThrow()
    expect(() => new ArcGisPopupLifecyclePolicy(budget({ maxPopups: 1, maxLoadingPopups: 2 }))).toThrow()
    expect(() => new ArcGisPopupLifecyclePolicy(budget({ maxEstimatedContentBytes: 10, maxEstimatedContentBytesPerPopup: 11 }))).toThrow()
  })

  it('fails closed after disposal', () => {
    const policy = new ArcGisPopupLifecyclePolicy(budget())
    policy.admit(request())
    policy.dispose()
    expect(() => policy.snapshot()).toThrow('disposed')
    expect(() => policy.admit(request())).toThrow('disposed')
  })
})
