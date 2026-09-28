import { describe, expect, it } from 'vitest'
import { ArcGisEditBatchPlanner, type ArcGisEditBatchBudget, type ArcGisEditCandidate, type ArcGisEditServiceFacts } from './ArcGisEditBatchPlanner'

const service: ArcGisEditServiceFacts = { supportsApplyEdits: true, supportsRollbackOnFailure: true, supportsGlobalIds: true, supportsAttachmentsByUploadId: true, maxRecordCount: 3 }
const budget: ArcGisEditBatchBudget = { maxEditsPerBatch: 4, maxPayloadBytesPerBatch: 100, maxBatches: 4, maxTotalEdits: 10, maxAttachmentsPerEdit: 2, requireRollbackOnFailure: true, requireGlobalIds: false }
const edit = (clientId: string, operation: ArcGisEditCandidate['operation'] = 'add', bytes = 10): ArcGisEditCandidate => ({ clientId, operation, objectId: operation === 'add' ? undefined : Number(clientId.replace(/\D/g, '')) || 1, estimatedAttributeBytes: bytes, estimatedGeometryBytes: 0 })

describe('ArcGisEditBatchPlanner', () => {
  it('returns an immutable empty plan', () => { const plan = new ArcGisEditBatchPlanner(service, budget).plan([]); expect(plan).toEqual({ accepted: true, batches: [], totalEdits: 0, estimatedPayloadBytes: 0 }); if (plan.accepted) expect(Object.isFrozen(plan.batches)).toBe(true) })
  it('caps batches by service maxRecordCount', () => { const plan = new ArcGisEditBatchPlanner(service, budget).plan([edit('a'), edit('b'), edit('c'), edit('d')]); expect(plan.accepted).toBe(true); if (plan.accepted) expect(plan.batches.map(x => x.edits.length)).toEqual([3, 1]) })
  it('splits by payload without reordering', () => { const plan = new ArcGisEditBatchPlanner(service, { ...budget, maxPayloadBytesPerBatch: 25 }).plan([edit('a','add',20), edit('b','add',10), edit('c','add',15)]); expect(plan.accepted).toBe(true); if (plan.accepted) expect(plan.batches.map(x => x.edits.map(e => e.clientId))).toEqual([['a'], ['b','c']]) })
  it('fails closed without applyEdits', () => expect(new ArcGisEditBatchPlanner({ ...service, supportsApplyEdits: false }, budget).plan([edit('a')])).toEqual({ accepted: false, reason: 'service-does-not-support-apply-edits' }))
  it('fails closed without required rollback', () => expect(new ArcGisEditBatchPlanner({ ...service, supportsRollbackOnFailure: false }, budget).plan([edit('a')])).toEqual({ accepted: false, reason: 'rollback-on-failure-required-but-unsupported' }))
  it('requires global-id capability under policy', () => expect(new ArcGisEditBatchPlanner({ ...service, supportsGlobalIds: false }, { ...budget, requireGlobalIds: true }).plan([edit('a')])).toEqual({ accepted: false, reason: 'global-id-editing-required-but-unsupported' }))
  it('requires a global id per edit under policy', () => expect(new ArcGisEditBatchPlanner(service, { ...budget, requireGlobalIds: true }).plan([edit('a')])).toEqual({ accepted: false, reason: 'global-id-required:a' }))
  it('rejects duplicate normalized client ids', () => expect(new ArcGisEditBatchPlanner(service, budget).plan([edit('same'), edit(' same ')])).toEqual({ accepted: false, reason: 'duplicate-client-id:same' }))
  it('rejects duplicate object-id mutations', () => expect(new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('u1','update'), objectId: 42 }, { ...edit('d2','delete'), objectId: 42 }])).toEqual({ accepted: false, reason: 'duplicate-mutation-identity:o:42' }))
  it('rejects duplicate global-id mutations case-insensitively', () => expect(new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('u1','update'), objectId: undefined, globalId: '{ABC}' }, { ...edit('d2','delete'), objectId: undefined, globalId: '{abc}' }])).toEqual({ accepted: false, reason: 'duplicate-mutation-identity:g:{abc}' }))
  it('requires update identity', () => expect(new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('u','update'), objectId: undefined }])).toEqual({ accepted: false, reason: 'update requires objectId or globalId identity' }))
  it('rejects oversized edits', () => expect(new ArcGisEditBatchPlanner(service, budget).plan([edit('huge','add',101)])).toEqual({ accepted: false, reason: 'single-edit-payload-budget-exceeded:huge' }))
  it('rejects total cardinality overflow', () => expect(new ArcGisEditBatchPlanner(service, { ...budget, maxTotalEdits: 2 }).plan([edit('a'),edit('b'),edit('c')])).toEqual({ accepted: false, reason: 'total-edit-budget-exceeded' }))
  it('rejects excessive batch count', () => expect(new ArcGisEditBatchPlanner(service, { ...budget, maxEditsPerBatch: 1, maxBatches: 2 }).plan([edit('a'),edit('b'),edit('c')])).toEqual({ accepted: false, reason: 'batch-count-budget-exceeded' }))
  it('rejects attachments without upload-id support', () => expect(new ArcGisEditBatchPlanner({ ...service, supportsAttachmentsByUploadId: false }, budget).plan([{ ...edit('a'), attachmentCount: 1 }])).toEqual({ accepted: false, reason: 'attachment-upload-id-unsupported:a' }))
  it('rejects invalid budgets', () => expect(() => new ArcGisEditBatchPlanner(service, { ...budget, maxEditsPerBatch: 0 })).toThrow())
  it('rejects non-finite estimates', () => expect(new ArcGisEditBatchPlanner(service, budget).plan([{ ...edit('a'), estimatedGeometryBytes: Number.NaN }]).accepted).toBe(false))
  it('does not mutate caller candidates', () => { const candidates=[edit('a'),edit('b')]; const before=JSON.stringify(candidates); new ArcGisEditBatchPlanner(service,budget).plan(candidates); expect(JSON.stringify(candidates)).toBe(before) })
  it('is deterministic', () => { const planner=new ArcGisEditBatchPlanner(service,budget); const candidates=[edit('a'),edit('b')]; expect(planner.plan(candidates)).toEqual(planner.plan(candidates)) })
})
