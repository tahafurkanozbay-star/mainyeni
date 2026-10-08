import { describe, expect, it } from 'vitest'
import {
  ArcGisQueryPagePlanner,
  type ArcGisQueryCapabilities,
  type ArcGisQueryPageRequest,
} from './ArcGisQueryPagePlanner'

const capabilities: ArcGisQueryCapabilities = {
  maxRecordCount: 1000,
  supportsPagination: true,
  supportsOrderBy: true,
  objectIdField: 'OBJECTID',
}

const planner = new ArcGisQueryPagePlanner()
const base: ArcGisQueryPageRequest = {
  layerId: 'parcels',
  where: 'STATUS = 1',
  outFields: ['OBJECTID', 'NAME'],
}

function planKey(request: ArcGisQueryPageRequest, service = capabilities): string {
  const result = planner.plan(request, service)
  if (result.kind !== 'planned') throw new Error('Expected a valid ArcGIS query plan')
  return result.key
}

describe('ArcGIS page-plan identity and integrity', () => {
  it('separates plans with different effective page counts', () => {
    expect(planKey({ ...base, estimatedFeatures: 1 })).not.toBe(
      planKey({ ...base, estimatedFeatures: 2500 }),
    )
  })

  it('separates server ordering capabilities even for a single page', () => {
    expect(planKey({ ...base, estimatedFeatures: 1 })).not.toBe(
      planKey({ ...base, estimatedFeatures: 1 }, { ...capabilities, supportsOrderBy: false }),
    )
  })

  it('separates object-id fields that define the stable sort', () => {
    expect(planKey(base)).not.toBe(planKey(base, { ...capabilities, objectIdField: 'FID' }))
  })

  it('canonicalizes object-id permutations and duplicate input ids', () => {
    expect(planKey({ ...base, objectIds: [9, 2, 9, 5] })).toBe(
      planKey({ ...base, objectIds: [5, 9, 2] }),
    )
    expect(planKey({ ...base, objectIds: [9, 2] })).not.toBe(
      planKey({ ...base, objectIds: [9, 3] }),
    )
  })

  it('preserves SQL literal whitespace in query identity', () => {
    expect(planKey({ ...base, where: "NAME = 'A  B'" })).not.toBe(
      planKey({ ...base, where: "NAME = 'A B'" }),
    )
  })

  it('rejects multi-page offset plans without stable server ordering', () => {
    expect(planner.plan({ ...base, estimatedFeatures: 2000 }, {
      ...capabilities, supportsOrderBy: false,
    })).toEqual({ kind: 'rejected', reason: 'non-deterministic-pagination' })
  })

  it('rejects runtime-injected order syntax before planning transport', () => {
    expect(planner.plan({ ...base, order: 'desc; OBJECTID' as never }, capabilities)).toEqual({
      kind: 'rejected', reason: 'invalid-order',
    })
  })

  it('rejects empty object-id lists instead of producing an unexecutable plan', () => {
    expect(planner.plan({ ...base, objectIds: [] }, capabilities)).toEqual({
      kind: 'rejected', reason: 'object-id-budget',
    })
  })

  it('rejects trimmed-boundary control characters and malformed fields', () => {
    expect(planner.plan({ ...base, layerId: 'parcels\n' }, capabilities)).toEqual({
      kind: 'rejected', reason: 'invalid-layer',
    })
    expect(planner.plan({ ...base, outFields: ['OBJECTID\n'] }, capabilities)).toEqual({
      kind: 'rejected', reason: 'invalid-out-fields',
    })
    expect(planner.plan(base, { ...capabilities, objectIdField: 'OBJECTID\n' })).toEqual({
      kind: 'rejected', reason: 'invalid-object-id-field',
    })
  })
})
