import { describe, expect, it } from 'vitest'
import { RuntimePressureController } from './runtimePressureController'

describe('RuntimePressureController', () => {
  it('starts unknown scopes nominal and admits all priorities', () => {
    const controller = new RuntimePressureController()
    expect(controller.decide('map', 'background', 0)).toEqual({ admitted: true, level: 'nominal', reason: 'none' })
    expect(controller.snapshot()).toEqual({ disposed: false, scopeCount: 0, scopes: [] })
  })

  it('rejects malformed samples without creating scope state', () => {
    const controller = new RuntimePressureController()
    expect(controller.record({ scope: '', signal: 'cpu', value: 0.5, now: 0 })).toBeNull()
    expect(controller.record({ scope: 'map', signal: 'cpu', value: -1, now: 0 })).toBeNull()
    expect(controller.record({ scope: 'map', signal: 'cpu', value: 2, now: 0 })).toBeNull()
    expect(controller.record({ scope: 'map', signal: 'cpu', value: Number.NaN, now: 0 })).toBeNull()
    expect(controller.record({ scope: 'map', signal: 'cpu', value: 0.5, now: -1 })).toBeNull()
    expect(controller.snapshot().scopeCount).toBe(0)
  })

  it('normalizes scope names and tracks scalar samples only', () => {
    const controller = new RuntimePressureController()
    const snapshot = controller.record({ scope: '  map  ', signal: 'cpu', value: 0.2, now: 10 })
    expect(snapshot).toMatchObject({ scope: 'map', level: 'nominal', dominantSignal: null, sampleCount: 1 })
  })

  it('enters elevated pressure and blocks background work', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.6, criticalThreshold: 0.9 })
    controller.record({ scope: 'map', signal: 'cpu', value: 0.61, now: 1 })
    expect(controller.decide('map', 'background', 1)).toEqual({ admitted: false, level: 'elevated', reason: 'cpu' })
    expect(controller.decide('map', 'normal', 1).admitted).toBe(true)
    expect(controller.decide('map', 'critical', 1).admitted).toBe(true)
  })

  it('enters critical pressure and reserves admission for critical work', () => {
    const controller = new RuntimePressureController({ criticalThreshold: 0.8 })
    controller.record({ scope: 'scene', signal: 'gpu', value: 0.95, now: 5 })
    expect(controller.decide('scene', 'background', 5).admitted).toBe(false)
    expect(controller.decide('scene', 'normal', 5).admitted).toBe(false)
    expect(controller.decide('scene', 'critical', 5)).toEqual({ admitted: true, level: 'critical', reason: 'gpu' })
  })

  it('reports the strongest signal as the dominant pressure reason', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.5 })
    controller.record({ scope: 'search', signal: 'network', value: 0.7, now: 1 })
    controller.record({ scope: 'search', signal: 'memory', value: 0.8, now: 2 })
    expect(controller.decide('search', 'background', 2).reason).toBe('memory')
  })

  it('uses latest sample as deterministic tie breaker for equal peaks', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.5 })
    controller.record({ scope: 'search', signal: 'network', value: 0.8, now: 1 })
    controller.record({ scope: 'search', signal: 'cpu', value: 0.8, now: 2 })
    expect(controller.decide('search', 'background', 2).reason).toBe('cpu')
  })

  it('bounds retained samples per scope', () => {
    const controller = new RuntimePressureController({ maxSamplesPerScope: 3 })
    for (let index = 0; index < 10; index += 1) controller.record({ scope: 'map', signal: 'cpu', value: index / 20, now: index })
    expect(controller.snapshot().scopes[0]?.sampleCount).toBe(3)
  })

  it('expires samples by explicit retention sweep', () => {
    const controller = new RuntimePressureController({ retentionMs: 10, recoverySamples: 1 })
    controller.record({ scope: 'map', signal: 'cpu', value: 0.8, now: 0 })
    expect(controller.sweep(11)).toBe(1)
    expect(controller.snapshot().scopes[0]).toMatchObject({ sampleCount: 0, level: 'nominal' })
  })

  it('does not expire a sample exactly before its retention boundary', () => {
    const controller = new RuntimePressureController({ retentionMs: 10 })
    controller.record({ scope: 'map', signal: 'cpu', value: 0.4, now: 5 })
    expect(controller.sweep(14)).toBe(0)
    expect(controller.snapshot().scopes[0]?.sampleCount).toBe(1)
  })

  it('requires a recovery streak before clearing elevated state', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.7, recoveryThreshold: 0.4, recoverySamples: 2, retentionMs: 5 })
    controller.record({ scope: 'map', signal: 'cpu', value: 0.8, now: 0 })
    expect(controller.decide('map', 'background', 0).level).toBe('elevated')
    controller.sweep(6)
    expect(controller.snapshot().scopes[0]?.level).toBe('elevated')
    controller.record({ scope: 'map', signal: 'cpu', value: 0.2, now: 7 })
    expect(controller.snapshot().scopes[0]?.level).toBe('nominal')
  })

  it('resets recovery streak when pressure rises above recovery threshold', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.7, recoveryThreshold: 0.4, recoverySamples: 3, retentionMs: 2 })
    controller.record({ scope: 'map', signal: 'cpu', value: 0.8, now: 0 })
    controller.sweep(3)
    expect(controller.snapshot().scopes[0]?.recoveryStreak).toBe(1)
    controller.record({ scope: 'map', signal: 'cpu', value: 0.5, now: 3 })
    expect(controller.snapshot().scopes[0]?.recoveryStreak).toBe(0)
  })

  it('bounds scope cardinality with deterministic least-recently-touched eviction', () => {
    const controller = new RuntimePressureController({ maxScopes: 2 })
    controller.record({ scope: 'b', signal: 'cpu', value: 0.1, now: 0 })
    controller.record({ scope: 'a', signal: 'cpu', value: 0.1, now: 0 })
    controller.record({ scope: 'c', signal: 'cpu', value: 0.1, now: 1 })
    expect(controller.snapshot().scopes.map((scope) => scope.scope)).toEqual(['b', 'c'])
  })

  it('prefers older touched scope over lexical tie breaking', () => {
    const controller = new RuntimePressureController({ maxScopes: 2 })
    controller.record({ scope: 'z', signal: 'cpu', value: 0.1, now: 0 })
    controller.record({ scope: 'a', signal: 'cpu', value: 0.1, now: 1 })
    controller.record({ scope: 'n', signal: 'cpu', value: 0.1, now: 2 })
    expect(controller.snapshot().scopes.map((scope) => scope.scope)).toEqual(['a', 'n'])
  })

  it('resetScope clears pressure and increments generation', () => {
    const controller = new RuntimePressureController({ criticalThreshold: 0.8 })
    controller.record({ scope: 'scene', signal: 'gpu', value: 0.9, now: 0 })
    expect(controller.resetScope('scene', 5)).toBe(true)
    expect(controller.snapshot().scopes[0]).toMatchObject({ generation: 2, level: 'nominal', sampleCount: 0, touchedAt: 5 })
  })

  it('resetScope rejects missing and malformed scopes', () => {
    const controller = new RuntimePressureController()
    expect(controller.resetScope('', 0)).toBe(false)
    expect(controller.resetScope('missing', 0)).toBe(false)
    expect(controller.resetScope('missing', -1)).toBe(false)
  })

  it('removeScope performs deterministic scope teardown', () => {
    const controller = new RuntimePressureController()
    controller.record({ scope: 'map', signal: 'memory', value: 0.5, now: 0 })
    expect(controller.removeScope('map')).toBe(true)
    expect(controller.removeScope('map')).toBe(false)
    expect(controller.snapshot().scopeCount).toBe(0)
  })

  it('sorts scope diagnostics lexically', () => {
    const controller = new RuntimePressureController()
    controller.record({ scope: 'zeta', signal: 'cpu', value: 0.1, now: 0 })
    controller.record({ scope: 'alpha', signal: 'cpu', value: 0.1, now: 0 })
    expect(controller.snapshot().scopes.map((scope) => scope.scope)).toEqual(['alpha', 'zeta'])
  })

  it('returns frozen payload-free diagnostics', () => {
    const controller = new RuntimePressureController()
    controller.record({ scope: 'map', signal: 'cpu', value: 0.2, now: 0 })
    const snapshot = controller.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.scopes)).toBe(true)
    expect(Object.isFrozen(snapshot.scopes[0])).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('callback')
    expect(JSON.stringify(snapshot)).not.toContain('payload')
  })

  it('uses safe defaults for invalid policy values', () => {
    const controller = new RuntimePressureController({ maxScopes: 0, maxSamplesPerScope: -1, retentionMs: Number.NaN, elevatedThreshold: 2, criticalThreshold: -1, recoveryThreshold: 2, recoverySamples: 0 })
    expect(controller.record({ scope: 'map', signal: 'cpu', value: 0.8, now: 0 })?.level).toBe('elevated')
  })

  it('clamps critical threshold so it cannot be below elevated threshold', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.8, criticalThreshold: 0.4 })
    expect(controller.record({ scope: 'map', signal: 'cpu', value: 0.7, now: 0 })?.level).toBe('nominal')
    expect(controller.record({ scope: 'map', signal: 'cpu', value: 0.85, now: 1 })?.level).toBe('critical')
  })

  it('clamps recovery threshold at elevated threshold', () => {
    const controller = new RuntimePressureController({ elevatedThreshold: 0.5, recoveryThreshold: 0.9, recoverySamples: 1, retentionMs: 1 })
    controller.record({ scope: 'map', signal: 'cpu', value: 0.8, now: 0 })
    controller.sweep(2)
    expect(controller.snapshot().scopes[0]?.level).toBe('nominal')
  })

  it('ignores invalid sweep timestamps', () => {
    const controller = new RuntimePressureController()
    controller.record({ scope: 'map', signal: 'cpu', value: 0.2, now: 0 })
    expect(controller.sweep(-1)).toBe(0)
    expect(controller.sweep(Number.NaN)).toBe(0)
    expect(controller.snapshot().scopes[0]?.sampleCount).toBe(1)
  })

  it('fails closed for malformed decision inputs', () => {
    const controller = new RuntimePressureController()
    expect(controller.decide('', 'normal', 0)).toEqual({ admitted: false, level: 'critical', reason: 'none' })
    expect(controller.decide('map', 'normal', -1)).toEqual({ admitted: false, level: 'critical', reason: 'none' })
  })

  it('dispose is terminal and idempotent', () => {
    const controller = new RuntimePressureController()
    controller.record({ scope: 'map', signal: 'cpu', value: 0.2, now: 0 })
    controller.dispose()
    controller.dispose()
    expect(controller.snapshot()).toEqual({ disposed: true, scopeCount: 0, scopes: [] })
    expect(controller.record({ scope: 'map', signal: 'cpu', value: 0.2, now: 1 })).toBeNull()
    expect(controller.resetScope('map', 1)).toBe(false)
    expect(controller.removeScope('map')).toBe(false)
    expect(controller.decide('map', 'critical', 1)).toEqual({ admitted: false, level: 'critical', reason: 'none' })
  })
})
