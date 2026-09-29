import { describe, expect, it } from 'vitest'
import { ArcGisQueryPageAssembler, type ArcGisQueryResultPage } from './ArcGisQueryPageAssembler'

type Feature = { readonly attributes: Readonly<Record<string, unknown>>; readonly geometry?: unknown }
const budget = { maxPages: 4, maxFeatures: 6, maxEstimatedBytes: 1_000, maxRevisionLength: 32 }
const feature = (OBJECTID: number): Feature => Object.freeze({ attributes: Object.freeze({ OBJECTID, name: `f${OBJECTID}` }) })
const page = (pageIndex: number, ids: readonly number[], extra: Partial<ArcGisQueryResultPage<Feature>> = {}): ArcGisQueryResultPage<Feature> => ({
  pageIndex,
  features: Object.freeze(ids.map(feature)),
  estimatedBytes: ids.length * 10,
  datasetRevision: 'rev-1',
  ...extra,
})
const assembler = () => new ArcGisQueryPageAssembler<Feature>({ objectIdField: 'OBJECTID', requireDatasetRevision: true }, budget)

describe('ArcGisQueryPageAssembler', () => {
  it('assembles out-of-order arrivals into deterministic page order', () => {
    const result = assembler().assemble([page(1, [3, 4]), page(0, [1, 2])])
    expect(result.accepted).toBe(true)
    if (result.accepted) expect(result.result.objectIds).toEqual([1, 2, 3, 4])
  })

  it('returns immutable result collections', () => {
    const result = assembler().assemble([page(0, [1])])
    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(Object.isFrozen(result.result)).toBe(true)
      expect(Object.isFrozen(result.result.features)).toBe(true)
      expect(Object.isFrozen(result.result.objectIds)).toBe(true)
    }
  })

  it('rejects duplicate page indexes', () => {
    expect(assembler().assemble([page(0, [1]), page(0, [2])])).toEqual({ accepted: false, reason: 'duplicate-page-index:0' })
  })

  it('rejects missing page gaps', () => {
    expect(assembler().assemble([page(0, [1]), page(2, [2])])).toEqual({ accepted: false, reason: 'non-contiguous-page-index:2' })
  })

  it('rejects duplicate object ids across pages', () => {
    expect(assembler().assemble([page(0, [1, 2]), page(1, [2, 3])])).toEqual({ accepted: false, reason: 'duplicate-object-id:2' })
  })

  it('rejects invalid object ids', () => {
    const invalid = { attributes: { OBJECTID: -1 } }
    expect(assembler().assemble([{ ...page(0, []), features: [invalid] }])).toEqual({ accepted: false, reason: 'invalid-object-id:OBJECTID' })
  })

  it('rejects nonnumeric object ids', () => {
    const invalid = { attributes: { OBJECTID: '1' } }
    expect(assembler().assemble([{ ...page(0, []), features: [invalid] }])).toEqual({ accepted: false, reason: 'invalid-object-id:OBJECTID' })
  })

  it('rejects revision drift between pages', () => {
    expect(assembler().assemble([page(0, [1]), page(1, [2], { datasetRevision: 'rev-2' })])).toEqual({ accepted: false, reason: 'dataset-revision-drift:1' })
  })

  it('requires revisions when configured', () => {
    expect(assembler().assemble([page(0, [1], { datasetRevision: undefined })])).toEqual({ accepted: false, reason: 'dataset-revision-required:0' })
  })

  it('pins pages to an expected dataset revision', () => {
    const pinned = new ArcGisQueryPageAssembler<Feature>({ objectIdField: 'OBJECTID', requireDatasetRevision: true, expectedDatasetRevision: 'rev-2' }, budget)
    expect(pinned.assemble([page(0, [1])])).toEqual({ accepted: false, reason: 'dataset-revision-drift:0' })
  })

  it('allows absent revisions when revision integrity is optional', () => {
    const optional = new ArcGisQueryPageAssembler<Feature>({ objectIdField: 'OBJECTID', requireDatasetRevision: false }, budget)
    const result = optional.assemble([page(0, [1], { datasetRevision: undefined })])
    expect(result.accepted).toBe(true)
  })

  it('rejects feature budget overflow before exposing a result', () => {
    expect(assembler().assemble([page(0, [1, 2, 3, 4]), page(1, [5, 6, 7])])).toEqual({ accepted: false, reason: 'assembled-feature-budget-exceeded' })
  })

  it('rejects aggregate response byte overflow', () => {
    const small = new ArcGisQueryPageAssembler<Feature>({ objectIdField: 'OBJECTID', requireDatasetRevision: true }, { ...budget, maxEstimatedBytes: 15 })
    expect(small.assemble([page(0, [1]), page(1, [2])])).toEqual({ accepted: false, reason: 'assembled-response-byte-budget-exceeded' })
  })

  it('rejects individual page byte overflow', () => {
    const result = assembler().assemble([page(0, [1], { estimatedBytes: 1001 })])
    expect(result.accepted).toBe(false)
  })

  it('rejects page cardinality overflow', () => {
    expect(assembler().assemble([page(0, [1]), page(1, [2]), page(2, [3]), page(3, [4]), page(4, [5])])).toEqual({ accepted: false, reason: 'page-budget-exceeded' })
  })

  it('rejects empty page collections to avoid ambiguous completion', () => {
    expect(assembler().assemble([])).toEqual({ accepted: false, reason: 'query-pages-empty' })
  })

  it('reports transfer-limit pages as incomplete', () => {
    const result = assembler().assemble([page(0, [1], { exceededTransferLimit: true })])
    expect(result.accepted).toBe(true)
    if (result.accepted) expect(result.result.complete).toBe(false)
  })

  it('reports fully admitted pages as complete', () => {
    const result = assembler().assemble([page(0, [1]), page(1, [2])])
    expect(result.accepted).toBe(true)
    if (result.accepted) expect(result.result.complete).toBe(true)
  })

  it('sums admitted estimated bytes', () => {
    const result = assembler().assemble([page(0, [1], { estimatedBytes: 21 }), page(1, [2], { estimatedBytes: 22 })])
    expect(result.accepted).toBe(true)
    if (result.accepted) expect(result.result.estimatedBytes).toBe(43)
  })

  it('preserves canonical dataset revision', () => {
    const result = assembler().assemble([page(0, [1]), page(1, [2])])
    expect(result.accepted).toBe(true)
    if (result.accepted) expect(result.result.datasetRevision).toBe('rev-1')
  })

  it('normalizes expected revisions', () => {
    const pinned = new ArcGisQueryPageAssembler<Feature>({ objectIdField: 'OBJECTID', requireDatasetRevision: true, expectedDatasetRevision: ' rev-1 ' }, budget)
    expect(pinned.assemble([page(0, [1])]).accepted).toBe(true)
  })

  it('rejects control characters in revisions', () => {
    expect(assembler().assemble([page(0, [1], { datasetRevision: 'bad\nrev' })])).toEqual({ accepted: false, reason: 'invalid-dataset-revision' })
  })

  it('rejects oversized revisions', () => {
    expect(assembler().assemble([page(0, [1], { datasetRevision: 'x'.repeat(33) })])).toEqual({ accepted: false, reason: 'invalid-dataset-revision' })
  })

  it('validates object-id field identifiers at construction', () => {
    expect(() => new ArcGisQueryPageAssembler({ objectIdField: 'OBJECT ID', requireDatasetRevision: false }, budget)).toThrow('invalid-object-id-field')
  })

  it('rejects unsafe page indexes', () => {
    expect(assembler().assemble([page(-1, [1])]).accepted).toBe(false)
  })

  it('does not mutate caller page ordering', () => {
    const pages = [page(1, [2]), page(0, [1])]
    assembler().assemble(pages)
    expect(pages.map(value => value.pageIndex)).toEqual([1, 0])
  })

  it('does not mutate caller feature arrays', () => {
    const features = [feature(1), feature(2)]
    const input = [{ ...page(0, []), features }]
    assembler().assemble(input)
    expect(features.map(value => value.attributes.OBJECTID)).toEqual([1, 2])
  })

  it('accepts sparse but unique object-id values', () => {
    const result = assembler().assemble([page(0, [1, 1000, 999999])])
    expect(result.accepted).toBe(true)
  })
})
