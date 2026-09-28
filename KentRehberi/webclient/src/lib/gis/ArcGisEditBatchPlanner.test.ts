import { describe, expect, it } from 'vitest'
import { ArcGisEditBatchPlanner, type ArcGisEditBatchBudget, type ArcGisEditCandidate, type ArcGisEditServiceFacts } from './ArcGisEditBatchPlanner'

const service: ArcGisEditServiceFacts = {
  supportsApplyEdits: true,
  supportsRollbackOnFailure: true,
  supportsGlobalIds: true,
  supportsAttachmentsByUploadId: true,
  maxRecordCount: 3,
}

const budget: ArcGisEditBatchBudget = {
  maxEditsPerBatch: 4,
  maxPayloadBytesPerBatch: 100,
  maxBatches: 4,
  maxTotalEdits: 10,
  maxAttachmentsPerEdit: 2,
  requireRollbackOnFailure: true,
  requireGlobalIds: false,
}

const edit = (clientId: string, operation: ArcGisEditCandidate['operation'] = 'add', bytes = 10): ArcGisEditCandidate => ({
  clientId,
  operation,
  objectId: operation === 'add' ? undefined : Number(clientId.replace(/\D/g, '')) || 1,
  estimatedAttributeBytes: bytes,
  estimatedGeometryBytes: 0,
})

describe('ArcGisEditBatchPlanner', () => {
  it('returns an immutable empty plan', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([])
    expect(plan).toEqual({ accepted: true, batches: [], totalEdits: 0, estimatedPayloadBytes: 0 })
    if (plan.accepted) expect(Object.isFrozen(plan.batches)).toBe(true)
  })

  it('caps batches by service maxRecordCount even when local budget is larger', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([edit('a'), edit('b'), edit('c'), edit('d')])
    expect(plan.accepted).toBe(true)
    if (!plan.accepted) return
    expect(plan.batches.map((batch) => batch.edits.length)).toEqual([3, 1])
  })

  it('splits by estimated payload bytes without reordering edits', () => {
    const plan = new ArcGisEditBatchPlanner(service, { ...budget, maxPayloadBytesPerBatch: 25 }).plan([
      edit('a', 'add', 20), edit('b', 'add', 10), edit('c', 'add', 15),
    ])
    expect(plan.accepted).toBe(true)
    if (!plan.accepted) return
    expect(plan.batches.map((batch) => batch.edits.map((candidate) => candidate.clientId))).toEqual([['a'], ['b', 'c']])
    expect(plan.estimatedPayloadBytes).toBe(45)
  })

  it('counts operation composition per batch', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([edit('a'), edit('u2', 'update'), edit('d3', 'delete')])
    expect(plan.accepted).toBe(true)
    if (!plan.accepted) return
    expect(plan.batches[0]).toMatchObject({ adds: 1, updates: 1, deletes: 1 })
  })

  it('fails closed when applyEdits is unavailable', () => {
    expect(new ArcGisEditBatchPlanner({ ...service, supportsApplyEdits: false }, budget).plan([edit('a')])).toEqual({
      accepted: false, reason: 'service-does-not-support-apply-edits',
    })
  })

  it('fails closed when rollback semantics are required but unavailable', () => {
    expect(new ArcGisEditBatchPlanner({ ...service, supportsRollbackOnFailure: false }, budget).plan([edit('a')])).toEqual({
      accepted: false, reason: 'rollback-on-failure-required-but-unsupported',
    })
  })

  it('allows unsupported rollback only when policy does not require it', () => {
    const plan = new ArcGisEditBatchPlanner({ ...service, supportsRollbackOnFailure: false }, { ...budget, requireRollbackOnFailure: false }).plan([edit('a')])
    expect(plan.accepted).toBe(true)
  })

  it('fails closed when global-id service capability is required but unavailable', () => {
    const plan = new ArcGisEditBatchPlanner({ ...service, supportsGlobalIds: false }, { ...budget, requireGlobalIds: true }).plan([edit('a')])
    expect(plan).toEqual({ accepted: false, reason: 'global-id-editing-required-but-unsupported' })
  })

  it('requires every edit to carry a global id under global-id policy', () => {
    const plan = new ArcGisEditBatchPlanner(service, { ...budget, requireGlobalIds: true }).plan([edit('a')])
    expect(plan).toEqual({ accepted: false, reason: 'global-id-required:a' })
  })

  it('accepts normalized global ids when required', () => {
    const plan = new ArcGisEditBatchPlanner(service, { ...budget, requireGlobalIds: true }).plan([
      { ...edit('a'), globalId: '  {A-B-C}  ' },
    ])
    expect(plan.accepted).toBe(true)
    if (!plan.accepted) return
    expect(plan.batches[0]?.edits[0]?.globalId).toBe('{A-B-C}')
  })

  it('rejects duplicate client ids after normalization', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([edit('same'), edit(' same ')])
    expect(plan).toEqual({ accepted: false, reason: 'duplicate-client-id:same' })
  })

  it('rejects duplicate object-id mutations across update and delete', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([
      { ...edit('u1', 'update'), objectId: 42 },
      { ...edit('d2', 'delete'), objectId: 42 },
    ])
    expect(plan).toEqual({ accepted: false, reason: 'duplicate-mutation-identity:o:42' })
  })

  it('rejects duplicate global-id mutations case-insensitively', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([
      { ...edit('u1', 'update'), objectId: undefined, globalId: '{ABC}' },
      { ...edit('d2', 'delete'), objectId: undefined, globalId: '{abc}' },
    ])
    expect(plan).toEqual({ accepted: false, reason: 'duplicate-mutation-identity:g:{abc}' })
  })

  it('requires mutation identity for updates', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('u', 'update'), objectId: undefined }])
    expect(plan).toEqual({ accepted: false, reason: 'update requires objectId or globalId identity' })
  })

  it('requires mutation identity for deletes', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('d', 'delete'), objectId: undefined }])
    expect(plan).toEqual({ accepted: false, reason: 'delete requires objectId or globalId identity' })
  })

  it('rejects a single edit larger than the payload budget', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([edit('huge', 'add', 101)])
    expect(plan).toEqual({ accepted: false, reason: 'single-edit-payload-budget-exceeded:huge' })
  })

  it('rejects total edit cardinality before allocating batches', () => {
    const plan = new ArcGisEditBatchPlanner(service, { ...budget, maxTotalEdits: 2 }).plan([edit('a'), edit('b'), edit('c')])
    expect(plan).toEqual({ accepted: false, reason: 'total-edit-budget-exceeded' })
  })

  it('rejects plans requiring more batches than allowed', () => {
    const plan = new ArcGisEditBatchPlanner(service, { ...budget, maxEditsPerBatch: 1, maxBatches: 2 }).plan([edit('a'), edit('b'), edit('c')])
    expect(plan).toEqual({ accepted: false, reason: 'batch-count-budget-exceeded' })
  })

  it('rejects attachments when upload-id semantics are unavailable', () => {
    const plan = new ArcGisEditBatchPlanner({ ...service, supportsAttachmentsByUploadId: false }, budget).plan([
      { ...edit('a'), attachmentCount: 1 },
    ])
    expect(plan).toEqual({ accepted: false, reason: 'attachment-upload-id-unsupported:a' })
  })

  it('rejects per-edit attachment cardinality overflow', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('a'), attachmentCount: 3 }])
    expect(plan).toEqual({ accepted: false, reason: 'attachmentCount must be an integer in [0, 2]' })
  })

  it.each([
    ['maxEditsPerBatch', { maxEditsPerBatch: 0 }],
    ['maxPayloadBytesPerBatch', { maxPayloadBytesPerBatch: 0 }],
    ['maxBatches', { maxBatches: 0 }],
    ['maxTotalEdits', { maxTotalEdits: 0 }],
    ['maxAttachmentsPerEdit', { maxAttachmentsPerEdit: -1 }],
  ] as const)('validates %s at construction', (_name, patch) => {
    expect(() => new ArcGisEditBatchPlanner(service, { ...budget, ...patch })).toThrow()
  })

  it('validates service record-count capability', () => {
    expect(() => new ArcGisEditBatchPlanner({ ...service, maxRecordCount: 0 }, budget)).toThrow()
  })

  it('rejects non-finite byte estimates', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('a'), estimatedGeometryBytes: Number.NaN }])
    expect(plan.accepted).toBe(false)
  })

  it('rejects negative byte estimates', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('a'), estimatedAttributeBytes: -1 }])
    expect(plan.accepted).toBe(false)
  })

  it('rejects blank client ids', () => {
    const plan = new ArcGisEditBatchPlanner(service, budget).plan([edit('   ')])
    expect(plan).toEqual({ accepted: false, reason: 'clientId must contain 1..256 characters' })
  })

  it('does not mutate the caller candidate array', () => {
    const candidates = [edit('a'), edit('b')]
    const snapshot = JSON.stringify(candidates)
    new ArcGisEditBatchPlanner(service, budget).plan(candidates)
    expect(JSON.stringify(candidates)).toBe(snapshot)
  })

  it('produces deterministic plans for identical input', () => {
    const planner = new ArcGisEditBatchPlanner(service, { ...budget, maxPayloadBytesPerBatch: 25 })
    const candidates = [edit('a', 'add', 15), edit('b', 'add', 15), edit('c', 'add', 10)]
    expect(planner.plan(candidates)).toEqual(planner.plan(candidates))
  })
})
