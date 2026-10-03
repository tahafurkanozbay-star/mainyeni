import { describe, expect, it } from 'vitest'
import { RuntimeBudgetLedger } from './runtimeBudgetLedger'

describe('RuntimeBudgetLedger', () => {
  it('reserves and releases bounded units', () => {
    const ledger = new RuntimeBudgetLedger({ maxUnitsGlobal: 10, criticalReserveUnits: 0 })
    const lease = ledger.reserve({ scope: 'map', budget: 'cpu', priority: 'interactive', units: 4, now: 0 })!
    expect(ledger.snapshot(0).units).toBe(4)
    expect(ledger.release(lease, 1)).toBe(true)
    expect(ledger.snapshot(1).units).toBe(0)
  })

  it('reserves global capacity for critical work', () => {
    const ledger = new RuntimeBudgetLedger({ maxUnitsGlobal: 10, criticalReserveUnits: 2, maxUnitsPerScope: 10 })
    expect(ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'interactive', units: 8, now: 0 })).not.toBeNull()
    expect(ledger.reserve({ scope: 'b', budget: 'cpu', priority: 'interactive', units: 1, now: 0 })).toBeNull()
    expect(ledger.reserve({ scope: 'b', budget: 'cpu', priority: 'critical', units: 2, now: 0 })).not.toBeNull()
  })

  it('bounds units per scope', () => {
    const ledger = new RuntimeBudgetLedger({ maxUnitsPerScope: 5, criticalReserveUnits: 0 })
    expect(ledger.reserve({ scope: 'map', budget: 'gpu', priority: 'critical', units: 5, now: 0 })).not.toBeNull()
    expect(ledger.reserve({ scope: 'map', budget: 'gpu', priority: 'critical', units: 1, now: 0 })).toBeNull()
  })

  it('bounds reservation cardinality', () => {
    const ledger = new RuntimeBudgetLedger({ maxReservations: 1, criticalReserveUnits: 0 })
    expect(ledger.reserve({ scope: 'a', budget: 'network', priority: 'interactive', units: 1, now: 0 })).not.toBeNull()
    expect(ledger.reserve({ scope: 'b', budget: 'network', priority: 'interactive', units: 1, now: 0 })).toBeNull()
  })

  it('expires reservations deterministically', () => {
    const ledger = new RuntimeBudgetLedger({ reservationTtlMs: 10, criticalReserveUnits: 0 })
    ledger.reserve({ scope: 'a', budget: 'memory', priority: 'interactive', units: 3, now: 0 })
    expect(ledger.snapshot(9).units).toBe(3)
    expect(ledger.snapshot(10).units).toBe(0)
  })

  it('renews live reservations', () => {
    const ledger = new RuntimeBudgetLedger({ reservationTtlMs: 10 })
    const lease = ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'interactive', units: 1, now: 0 })!
    const renewed = ledger.renew(lease, 5)!
    expect(renewed.expiresAt).toBe(15)
    expect(ledger.snapshot(12).reservations).toBe(1)
  })

  it('rejects forged reservations', () => {
    const ledger = new RuntimeBudgetLedger()
    const lease = ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    expect(ledger.release({ ...lease, units: 2 }, 1)).toBe(false)
    expect(ledger.snapshot(1).units).toBe(1)
  })

  it('rejects stale pre-renewal reservations', () => {
    const ledger = new RuntimeBudgetLedger({ reservationTtlMs: 10 })
    const lease = ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    const renewed = ledger.renew(lease, 5)!
    expect(ledger.release(lease, 6)).toBe(false)
    expect(ledger.release(renewed, 6)).toBe(true)
  })

  it('rejects duplicate release', () => {
    const ledger = new RuntimeBudgetLedger()
    const lease = ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    expect(ledger.release(lease, 1)).toBe(true)
    expect(ledger.release(lease, 2)).toBe(false)
  })

  it('resets a scope and invalidates reservations', () => {
    const ledger = new RuntimeBudgetLedger()
    const lease = ledger.reserve({ scope: 'map', budget: 'gpu', priority: 'critical', units: 2, now: 0 })!
    expect(ledger.resetScope('map', 1)).toBe(true)
    expect(ledger.release(lease, 2)).toBe(false)
    expect(ledger.snapshot(2).units).toBe(0)
  })

  it('does not remove active scopes', () => {
    const ledger = new RuntimeBudgetLedger()
    ledger.reserve({ scope: 'map', budget: 'gpu', priority: 'critical', units: 2, now: 0 })
    expect(ledger.removeScope('map')).toBe(false)
  })

  it('removes inactive scopes explicitly', () => {
    const ledger = new RuntimeBudgetLedger()
    const lease = ledger.reserve({ scope: 'map', budget: 'gpu', priority: 'critical', units: 2, now: 0 })!
    ledger.release(lease, 1)
    expect(ledger.removeScope('map')).toBe(true)
  })

  it('evicts the oldest inactive scope at cardinality', () => {
    const ledger = new RuntimeBudgetLedger({ maxScopes: 2 })
    const a = ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    ledger.release(a, 0)
    const b = ledger.reserve({ scope: 'b', budget: 'cpu', priority: 'critical', units: 1, now: 1 })!
    ledger.release(b, 1)
    expect(ledger.reserve({ scope: 'c', budget: 'cpu', priority: 'critical', units: 1, now: 2 })).not.toBeNull()
    expect(ledger.removeScope('a')).toBe(false)
    expect(ledger.removeScope('b')).toBe(true)
  })

  it('uses lexical tie breaking for scope eviction', () => {
    const ledger = new RuntimeBudgetLedger({ maxScopes: 2 })
    const b = ledger.reserve({ scope: 'b', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    ledger.release(b, 0)
    const a = ledger.reserve({ scope: 'a', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    ledger.release(a, 0)
    ledger.reserve({ scope: 'c', budget: 'cpu', priority: 'critical', units: 1, now: 1 })
    expect(ledger.removeScope('a')).toBe(false)
    expect(ledger.removeScope('b')).toBe(true)
  })

  it('does not evict active scopes', () => {
    const ledger = new RuntimeBudgetLedger({ maxScopes: 1 })
    ledger.reserve({ scope: 'active', budget: 'cpu', priority: 'critical', units: 1, now: 0 })
    expect(() => ledger.reserve({ scope: 'other', budget: 'cpu', priority: 'critical', units: 1, now: 1 })).toThrow('scope capacity exhausted')
  })

  it('removes idle scopes after retention', () => {
    const ledger = new RuntimeBudgetLedger({ idleScopeTtlMs: 10 })
    const lease = ledger.reserve({ scope: 'idle', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    ledger.release(lease, 0)
    expect(ledger.snapshot(9).scopes).toBe(1)
    expect(ledger.snapshot(10).scopes).toBe(0)
  })

  it('normalizes scope whitespace', () => {
    const ledger = new RuntimeBudgetLedger()
    const lease = ledger.reserve({ scope: ' map ', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    expect(lease.scope).toBe('map')
  })

  it('rejects invalid scopes', () => {
    const ledger = new RuntimeBudgetLedger()
    expect(() => ledger.reserve({ scope: ' ', budget: 'cpu', priority: 'critical', units: 1, now: 0 })).toThrow()
    expect(() => ledger.reserve({ scope: 'x'.repeat(129), budget: 'cpu', priority: 'critical', units: 1, now: 0 })).toThrow()
  })

  it('rejects invalid timestamps', () => {
    const ledger = new RuntimeBudgetLedger()
    expect(() => ledger.reserve({ scope: 'map', budget: 'cpu', priority: 'critical', units: 1, now: Number.NaN })).toThrow()
    expect(() => ledger.snapshot(-1)).toThrow()
  })

  it('rejects invalid units', () => {
    const ledger = new RuntimeBudgetLedger()
    expect(() => ledger.reserve({ scope: 'map', budget: 'cpu', priority: 'critical', units: 0, now: 0 })).toThrow()
    expect(() => ledger.reserve({ scope: 'map', budget: 'cpu', priority: 'critical', units: 1.5, now: 0 })).toThrow()
  })

  it('reports aggregate class totals without identifiers', () => {
    const ledger = new RuntimeBudgetLedger({ criticalReserveUnits: 0 })
    ledger.reserve({ scope: 'private-a', budget: 'cpu', priority: 'interactive', units: 2, now: 0 })
    ledger.reserve({ scope: 'private-b', budget: 'memory', priority: 'interactive', units: 3, now: 0 })
    ledger.reserve({ scope: 'private-c', budget: 'network', priority: 'interactive', units: 4, now: 0 })
    ledger.reserve({ scope: 'private-d', budget: 'gpu', priority: 'interactive', units: 5, now: 0 })
    const snapshot = ledger.snapshot(0)
    expect(snapshot).toMatchObject({ cpuUnits: 2, memoryUnits: 3, networkUnits: 4, gpuUnits: 5, units: 14 })
    expect(JSON.stringify(snapshot)).not.toContain('private')
  })

  it('returns frozen public values', () => {
    const ledger = new RuntimeBudgetLedger()
    const lease = ledger.reserve({ scope: 'map', budget: 'cpu', priority: 'critical', units: 1, now: 0 })!
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(ledger.snapshot(0))).toBe(true)
  })

  it('clamps critical reserve to global capacity', () => {
    const ledger = new RuntimeBudgetLedger({ maxUnitsGlobal: 5, criticalReserveUnits: 99 })
    expect(ledger.policy.criticalReserveUnits).toBe(5)
    expect(ledger.canReserve({ scope: 'a', budget: 'cpu', priority: 'interactive', units: 1, now: 0 })).toBe(false)
    expect(ledger.canReserve({ scope: 'a', budget: 'cpu', priority: 'critical', units: 1, now: 0 })).toBe(true)
  })

  it('falls back from invalid policy numbers', () => {
    const ledger = new RuntimeBudgetLedger({ maxScopes: 0, maxUnitsGlobal: -1, criticalReserveUnits: -1 })
    expect(ledger.policy.maxScopes).toBe(128)
    expect(ledger.policy.maxUnitsGlobal).toBe(256)
    expect(ledger.policy.criticalReserveUnits).toBe(16)
  })

  it('becomes terminal after disposal', () => {
    const ledger = new RuntimeBudgetLedger()
    ledger.dispose()
    ledger.dispose()
    expect(() => ledger.snapshot(0)).toThrow('disposed')
    expect(() => ledger.reserve({ scope: 'map', budget: 'cpu', priority: 'critical', units: 1, now: 0 })).toThrow('disposed')
  })
})
