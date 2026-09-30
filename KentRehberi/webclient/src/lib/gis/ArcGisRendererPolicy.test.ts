import { describe, expect, it } from 'vitest'
import { ArcGisRendererPolicy, type ArcGisRendererInput } from './ArcGisRendererPolicy'

const policy = (gpu = 4096) => new ArcGisRendererPolicy({ maxClasses: 4, maxVisualVariables: 3, maxStopsPerVariable: 4, maxFieldLength: 40, maxSymbolKeyLength: 64, maxEstimatedGpuBytes: gpu }, [
  { field: 'TYPE', allowedValues: ['park', 'school', 'hospital'] },
  { field: 'POPULATION' },
  { field: 'ANGLE' },
])
const unique = (patch: Partial<ArcGisRendererInput> = {}): ArcGisRendererInput => ({ id: 'poi-renderer', kind: 'unique-value', field: 'TYPE', classes: [{ key: 'school', symbolKey: 'poi-school' }, { key: 'park', symbolKey: 'poi-park' }], revision: 3, ...patch })

describe('ArcGisRendererPolicy', () => {
  it('builds immutable deterministic unique-value plans', () => {
    const plan = policy().plan(unique())
    expect(plan.classes.map(item => item.key)).toEqual(['park', 'school'])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.classes)).toBe(true)
    expect(Object.isFrozen(plan.classes[0])).toBe(true)
  })
  it('is stable across class input order', () => {
    const a = policy().plan(unique())
    const b = policy().plan(unique({ classes: [{ key: 'park', symbolKey: 'poi-park' }, { key: 'school', symbolKey: 'poi-school' }] }))
    expect(a.fingerprint).toBe(b.fingerprint)
  })
  it('pins revision into fingerprint', () => expect(policy().plan(unique()).fingerprint).not.toBe(policy().plan(unique({ revision: 4 }), 4).fingerprint))
  it('rejects stale revisions', () => expect(() => policy().plan(unique(), 4)).toThrow(/stale/))
  it('requires simple symbols', () => expect(() => policy().plan({ id: 'simple', kind: 'simple', revision: 1 })).toThrow(/symbol/))
  it('accepts bounded simple renderers', () => expect(policy().plan({ id: 'simple', kind: 'simple', symbolKey: 'poi-default', revision: 1 }).kind).toBe('simple'))
  it('rejects classes on simple renderers', () => expect(() => policy().plan({ id: 'simple', kind: 'simple', symbolKey: 'x', classes: [{ key: 'x', symbolKey: 'x' }], revision: 1 })).toThrow(/cannot retain classes/))
  it('rejects ungoverned fields', () => expect(() => policy().plan(unique({ field: 'SECRET' }))).toThrow(/not admitted/))
  it('rejects ungoverned unique values', () => expect(() => policy().plan(unique({ classes: [{ key: 'unknown', symbolKey: 'x' }] }))).toThrow(/not admitted/))
  it('rejects duplicate class keys', () => expect(() => policy().plan(unique({ classes: [{ key: 'park', symbolKey: 'a' }, { key: 'park', symbolKey: 'b' }] }))).toThrow(/duplicate/))
  it('bounds class cardinality', () => expect(() => policy().plan(unique({ classes: Array.from({ length: 5 }, (_, index) => ({ key: `v${index}`, symbolKey: 'x' })) }))).toThrow(/class budget/))
  it('requires class break bounds', () => expect(() => policy().plan({ id: 'breaks', kind: 'class-breaks', field: 'POPULATION', classes: [{ key: 'low', symbolKey: 'low' }], revision: 1 })).toThrow(/requires bounds/))
  it('rejects inverted class breaks', () => expect(() => policy().plan({ id: 'breaks', kind: 'class-breaks', field: 'POPULATION', classes: [{ key: 'low', min: 10, max: 1, symbolKey: 'low' }], revision: 1 })).toThrow(/positive span/))
  it('rejects overlapping class breaks', () => expect(() => policy().plan({ id: 'breaks', kind: 'class-breaks', field: 'POPULATION', classes: [{ key: 'a', min: 0, max: 10, symbolKey: 'a' }, { key: 'b', min: 9, max: 20, symbolKey: 'b' }], revision: 1 })).toThrow(/overlap/))
  it('accepts non-overlapping class breaks', () => expect(policy().plan({ id: 'breaks', kind: 'class-breaks', field: 'POPULATION', classes: [{ key: 'a', min: 0, max: 10, symbolKey: 'a' }, { key: 'b', min: 10, max: 20, symbolKey: 'b' }], revision: 1 }).classes).toHaveLength(2))
  it('accepts deterministic visual variables', () => {
    const plan = policy().plan(unique({ visualVariables: [{ kind: 'size', field: 'POPULATION', stops: [{ value: 0, output: 4 }, { value: 1000, output: 16 }] }, { kind: 'rotation', field: 'ANGLE', stops: [{ value: 0, output: 0 }, { value: 360, output: 360 }] }] }))
    expect(plan.visualVariables.map(item => item.kind)).toEqual(['rotation', 'size'])
    expect(Object.isFrozen(plan.visualVariables[0].stops)).toBe(true)
  })
  it('rejects duplicate visual variable kinds', () => expect(() => policy().plan(unique({ visualVariables: [{ kind: 'size', field: 'POPULATION', stops: [{ value: 0, output: 1 }, { value: 1, output: 2 }] }, { kind: 'size', field: 'ANGLE', stops: [{ value: 0, output: 1 }, { value: 1, output: 2 }] }] }))).toThrow(/duplicate/))
  it('requires at least two stops', () => expect(() => policy().plan(unique({ visualVariables: [{ kind: 'size', field: 'POPULATION', stops: [{ value: 0, output: 1 }] }] }))).toThrow(/stop budget/))
  it('rejects unsorted stops', () => expect(() => policy().plan(unique({ visualVariables: [{ kind: 'size', field: 'POPULATION', stops: [{ value: 10, output: 1 }, { value: 5, output: 2 }] }] }))).toThrow(/strictly increasing/))
  it('bounds opacity output', () => expect(() => policy().plan(unique({ visualVariables: [{ kind: 'opacity', field: 'POPULATION', stops: [{ value: 0, output: 0 }, { value: 1, output: 2 }] }] }))).toThrow(/opacity/))
  it('rejects negative size output', () => expect(() => policy().plan(unique({ visualVariables: [{ kind: 'size', field: 'POPULATION', stops: [{ value: 0, output: -1 }, { value: 1, output: 2 }] }] }))).toThrow(/non-negative/))
  it('enforces estimated GPU budget', () => expect(() => policy(300).plan(unique())).toThrow(/GPU budget/))
  it('rejects malformed identifiers', () => expect(() => policy().plan(unique({ id: ' bad id ' }))).toThrow(/invalid renderer id/))
  it('rejects malformed symbol keys', () => expect(() => policy().plan(unique({ classes: [{ key: 'park', symbolKey: ' bad ' }] }))).toThrow(/symbol key/))
  it('rejects negative revisions', () => expect(() => policy().plan(unique({ revision: -1 }), -1)).toThrow(/revision/))
})
