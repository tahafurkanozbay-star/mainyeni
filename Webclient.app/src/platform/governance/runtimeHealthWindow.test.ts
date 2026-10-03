import { describe, expect, it } from 'vitest'
import { RuntimeHealthWindow } from './runtimeHealthWindow'

describe('RuntimeHealthWindow', () => {
  it('starts healthy below the minimum sample threshold', () => {
    const window = new RuntimeHealthWindow({ minimumSamples: 4 })
    expect(window.record('map', 'failure', 0)).toMatchObject({ level: 'healthy', samples: 1, adverse: 1, adversePermille: 1000 })
  })

  it('classifies healthy scopes at the minimum sample threshold', () => {
    const window = new RuntimeHealthWindow({ minimumSamples: 4, degradedPermille: 500 })
    window.record('map', 'success', 0); window.record('map', 'success', 1); window.record('map', 'success', 2)
    expect(window.record('map', 'failure', 3).level).toBe('healthy')
  })

  it('classifies degraded scopes deterministically', () => {
    const window = new RuntimeHealthWindow({ minimumSamples: 4, degradedPermille: 250, unhealthyPermille: 750 })
    window.record('map', 'success', 0); window.record('map', 'success', 1); window.record('map', 'success', 2)
    expect(window.record('map', 'timeout', 3).level).toBe('degraded')
  })

  it('classifies unhealthy scopes deterministically', () => {
    const window = new RuntimeHealthWindow({ minimumSamples: 4, degradedPermille: 250, unhealthyPermille: 500 })
    window.record('map', 'success', 0); window.record('map', 'success', 1); window.record('map', 'failure', 2)
    expect(window.record('map', 'timeout', 3).level).toBe('unhealthy')
  })

  it('counts timeout and rejection as adverse signals', () => {
    const window = new RuntimeHealthWindow({ minimumSamples: 2, unhealthyPermille: 500 })
    window.record('map', 'timeout', 0)
    expect(window.record('map', 'rejected', 1)).toMatchObject({ adverse: 2, adversePermille: 1000, level: 'unhealthy' })
  })

  it('drops samples outside the rolling window', () => {
    const window = new RuntimeHealthWindow({ windowMs: 10, minimumSamples: 1 })
    window.record('map', 'failure', 0)
    expect(window.health('map', 9)?.samples).toBe(1)
    expect(window.health('map', 10)?.samples).toBe(0)
  })

  it('bounds samples per scope', () => {
    const window = new RuntimeHealthWindow({ maxSamplesPerScope: 2, minimumSamples: 1 })
    window.record('map', 'failure', 0); window.record('map', 'success', 1)
    expect(window.record('map', 'success', 2)).toMatchObject({ samples: 2, adverse: 0 })
  })

  it('tracks independent scopes', () => {
    const window = new RuntimeHealthWindow({ minimumSamples: 1, unhealthyPermille: 500 })
    expect(window.record('a', 'failure', 0).level).toBe('unhealthy')
    expect(window.record('b', 'success', 0).level).toBe('healthy')
  })

  it('returns null for unknown scope', () => {
    expect(new RuntimeHealthWindow().health('missing', 0)).toBeNull()
  })

  it('resets one scope without affecting another', () => {
    const window = new RuntimeHealthWindow()
    window.record('a', 'failure', 0); window.record('b', 'success', 0)
    expect(window.resetScope('a', 1)).toBe(true)
    expect(window.health('a', 1)?.samples).toBe(0)
    expect(window.health('b', 1)?.samples).toBe(1)
  })

  it('returns false when resetting an unknown scope', () => {
    expect(new RuntimeHealthWindow().resetScope('missing', 0)).toBe(false)
  })

  it('removes scopes explicitly', () => {
    const window = new RuntimeHealthWindow()
    window.record('map', 'success', 0)
    expect(window.removeScope('map')).toBe(true)
    expect(window.removeScope('map')).toBe(false)
  })

  it('evicts the oldest scope at cardinality', () => {
    const window = new RuntimeHealthWindow({ maxScopes: 2 })
    window.record('old', 'success', 0); window.record('new', 'success', 1); window.record('third', 'success', 2)
    expect(window.health('old', 2)).toBeNull()
    expect(window.health('new', 2)).not.toBeNull()
  })

  it('uses lexical tie breaking for scope eviction', () => {
    const window = new RuntimeHealthWindow({ maxScopes: 2 })
    window.record('b', 'success', 0); window.record('a', 'success', 0); window.record('c', 'success', 1)
    expect(window.health('a', 1)).toBeNull()
    expect(window.health('b', 1)).not.toBeNull()
  })

  it('removes empty idle scopes after retention', () => {
    const window = new RuntimeHealthWindow({ windowMs: 5, idleScopeTtlMs: 10 })
    window.record('idle', 'success', 0)
    expect(window.snapshot(9).scopes).toBe(1)
    expect(window.snapshot(10).scopes).toBe(0)
  })

  it('keeps aggregate signal counts', () => {
    const window = new RuntimeHealthWindow()
    window.record('a', 'success', 0); window.record('b', 'failure', 0); window.record('c', 'timeout', 0); window.record('d', 'rejected', 0)
    expect(window.snapshot(0)).toMatchObject({ scopes: 4, samples: 4, successes: 1, failures: 1, timeouts: 1, rejected: 1 })
  })

  it('keeps aggregate diagnostics free of identifiers', () => {
    const window = new RuntimeHealthWindow()
    window.record('private-map-scope', 'failure', 0)
    const snapshot = window.snapshot(0)
    expect(JSON.stringify(snapshot)).not.toContain('private-map-scope')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('freezes per-scope health values', () => {
    const window = new RuntimeHealthWindow()
    expect(Object.isFrozen(window.record('map', 'success', 0))).toBe(true)
  })

  it('normalizes scope whitespace', () => {
    const window = new RuntimeHealthWindow()
    window.record(' map ', 'success', 0)
    expect(window.health('map', 0)?.samples).toBe(1)
  })

  it('rejects blank and oversized scopes', () => {
    const window = new RuntimeHealthWindow()
    expect(() => window.record(' ', 'success', 0)).toThrow()
    expect(() => window.record('x'.repeat(129), 'success', 0)).toThrow()
  })

  it('rejects invalid timestamps and signals', () => {
    const window = new RuntimeHealthWindow()
    expect(() => window.record('map', 'success', Number.NaN)).toThrow()
    expect(() => window.record('map', 'invalid' as never, 0)).toThrow()
  })

  it('falls back from invalid positive policy values', () => {
    const window = new RuntimeHealthWindow({ maxScopes: 0, windowMs: -1, minimumSamples: 0 })
    expect(window.policy.maxScopes).toBe(128)
    expect(window.policy.windowMs).toBe(60_000)
    expect(window.policy.minimumSamples).toBe(4)
  })

  it('falls back from invalid permille values', () => {
    const window = new RuntimeHealthWindow({ degradedPermille: -1, unhealthyPermille: 1001 })
    expect(window.policy.degradedPermille).toBe(250)
    expect(window.policy.unhealthyPermille).toBe(500)
  })

  it('never configures unhealthy below degraded', () => {
    const window = new RuntimeHealthWindow({ degradedPermille: 800, unhealthyPermille: 200 })
    expect(window.policy.unhealthyPermille).toBe(800)
  })

  it('becomes terminal after disposal', () => {
    const window = new RuntimeHealthWindow()
    window.dispose(); window.dispose()
    expect(() => window.snapshot(0)).toThrow('disposed')
    expect(() => window.record('map', 'success', 0)).toThrow('disposed')
  })
})
