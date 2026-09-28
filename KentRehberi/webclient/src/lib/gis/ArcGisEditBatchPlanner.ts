export type ArcGisEditOperation = 'add' | 'update' | 'delete'

export interface ArcGisEditCandidate {
  readonly operation: ArcGisEditOperation
  readonly clientId: string
  readonly objectId?: number
  readonly globalId?: string
  readonly estimatedAttributeBytes: number
  readonly estimatedGeometryBytes: number
  readonly attachmentCount?: number
}

export interface ArcGisEditServiceFacts {
  readonly supportsApplyEdits: boolean
  readonly supportsRollbackOnFailure: boolean
  readonly supportsGlobalIds: boolean
  readonly supportsAttachmentsByUploadId: boolean
  readonly maxRecordCount: number
}

export interface ArcGisEditBatchBudget {
  readonly maxEditsPerBatch: number
  readonly maxPayloadBytesPerBatch: number
  readonly maxBatches: number
  readonly maxTotalEdits: number
  readonly maxAttachmentsPerEdit: number
  readonly requireRollbackOnFailure: boolean
  readonly requireGlobalIds: boolean
}

export interface ArcGisEditBatch {
  readonly index: number
  readonly edits: readonly ArcGisEditCandidate[]
  readonly estimatedPayloadBytes: number
  readonly adds: number
  readonly updates: number
  readonly deletes: number
}

export type ArcGisEditPlan =
  | { readonly accepted: true; readonly batches: readonly ArcGisEditBatch[]; readonly totalEdits: number; readonly estimatedPayloadBytes: number }
  | { readonly accepted: false; readonly reason: string }

const MAX_SAFE_BYTES = 64 * 1024 * 1024
const MAX_SAFE_EDITS = 100_000

function finiteInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer in [${minimum}, ${maximum}]`)
  return value
}
function normalizeId(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new Error(`${name} must contain 1..256 characters`)
  return normalized
}
function normalizedCandidate(candidate: ArcGisEditCandidate, maxAttachmentsPerEdit: number): ArcGisEditCandidate {
  const clientId = normalizeId(candidate.clientId, 'clientId')
  const estimatedAttributeBytes = finiteInteger(candidate.estimatedAttributeBytes, 'estimatedAttributeBytes', 0, MAX_SAFE_BYTES)
  const estimatedGeometryBytes = finiteInteger(candidate.estimatedGeometryBytes, 'estimatedGeometryBytes', 0, MAX_SAFE_BYTES)
  const attachmentCount = finiteInteger(candidate.attachmentCount ?? 0, 'attachmentCount', 0, maxAttachmentsPerEdit)
  if (candidate.objectId !== undefined) finiteInteger(candidate.objectId, 'objectId', 0, Number.MAX_SAFE_INTEGER)
  const globalId = candidate.globalId === undefined ? undefined : normalizeId(candidate.globalId, 'globalId')
  if (candidate.operation !== 'add' && candidate.objectId === undefined && globalId === undefined) throw new Error(`${candidate.operation} requires objectId or globalId identity`)
  return Object.freeze({ ...candidate, clientId, globalId, estimatedAttributeBytes, estimatedGeometryBytes, attachmentCount })
}
function estimatedBytes(candidate: ArcGisEditCandidate): number { return candidate.estimatedAttributeBytes + candidate.estimatedGeometryBytes }

export class ArcGisEditBatchPlanner {
  private readonly service: ArcGisEditServiceFacts
  private readonly budget: ArcGisEditBatchBudget
  constructor(service: ArcGisEditServiceFacts, budget: ArcGisEditBatchBudget) {
    const maxRecordCount = finiteInteger(service.maxRecordCount, 'maxRecordCount', 1, MAX_SAFE_EDITS)
    const maxEditsPerBatch = finiteInteger(budget.maxEditsPerBatch, 'maxEditsPerBatch', 1, MAX_SAFE_EDITS)
    const maxPayloadBytesPerBatch = finiteInteger(budget.maxPayloadBytesPerBatch, 'maxPayloadBytesPerBatch', 1, MAX_SAFE_BYTES)
    const maxBatches = finiteInteger(budget.maxBatches, 'maxBatches', 1, 10_000)
    const maxTotalEdits = finiteInteger(budget.maxTotalEdits, 'maxTotalEdits', 1, MAX_SAFE_EDITS)
    const maxAttachmentsPerEdit = finiteInteger(budget.maxAttachmentsPerEdit, 'maxAttachmentsPerEdit', 0, 1_000)
    this.service = Object.freeze({ ...service, maxRecordCount })
    this.budget = Object.freeze({ ...budget, maxEditsPerBatch, maxPayloadBytesPerBatch, maxBatches, maxTotalEdits, maxAttachmentsPerEdit })
  }
  plan(candidates: readonly ArcGisEditCandidate[]): ArcGisEditPlan {
    if (!this.service.supportsApplyEdits) return Object.freeze({ accepted: false, reason: 'service-does-not-support-apply-edits' })
    if (this.budget.requireRollbackOnFailure && !this.service.supportsRollbackOnFailure) return Object.freeze({ accepted: false, reason: 'rollback-on-failure-required-but-unsupported' })
    if (this.budget.requireGlobalIds && !this.service.supportsGlobalIds) return Object.freeze({ accepted: false, reason: 'global-id-editing-required-but-unsupported' })
    if (candidates.length > this.budget.maxTotalEdits) return Object.freeze({ accepted: false, reason: 'total-edit-budget-exceeded' })
    if (candidates.length === 0) return Object.freeze({ accepted: true, batches: Object.freeze([]), totalEdits: 0, estimatedPayloadBytes: 0 })
    const seenClientIds = new Set<string>(); const seenMutationIdentities = new Set<string>(); const normalized: ArcGisEditCandidate[] = []
    for (const candidate of candidates) {
      let edit: ArcGisEditCandidate
      try { edit = normalizedCandidate(candidate, this.budget.maxAttachmentsPerEdit) } catch (error) { return Object.freeze({ accepted: false, reason: error instanceof Error ? error.message : 'invalid-edit' }) }
      if (seenClientIds.has(edit.clientId)) return Object.freeze({ accepted: false, reason: `duplicate-client-id:${edit.clientId}` })
      seenClientIds.add(edit.clientId)
      if (this.budget.requireGlobalIds && !edit.globalId) return Object.freeze({ accepted: false, reason: `global-id-required:${edit.clientId}` })
      if ((edit.attachmentCount ?? 0) > 0 && !this.service.supportsAttachmentsByUploadId) return Object.freeze({ accepted: false, reason: `attachment-upload-id-unsupported:${edit.clientId}` })
      if (edit.operation !== 'add') { const identity = edit.globalId ? `g:${edit.globalId.toLowerCase()}` : `o:${edit.objectId}`; if (seenMutationIdentities.has(identity)) return Object.freeze({ accepted: false, reason: `duplicate-mutation-identity:${identity}` }); seenMutationIdentities.add(identity) }
      const bytes = estimatedBytes(edit); if (bytes > this.budget.maxPayloadBytesPerBatch) return Object.freeze({ accepted: false, reason: `single-edit-payload-budget-exceeded:${edit.clientId}` }); normalized.push(edit)
    }
    const batchEditLimit = Math.min(this.budget.maxEditsPerBatch, this.service.maxRecordCount); const batches: ArcGisEditBatch[] = []; let current: ArcGisEditCandidate[] = []; let currentBytes = 0; let totalBytes = 0
    const flush = (): boolean => { if (current.length === 0) return true; if (batches.length >= this.budget.maxBatches) return false; let adds = 0; let updates = 0; let deletes = 0; for (const edit of current) { if (edit.operation === 'add') adds++; else if (edit.operation === 'update') updates++; else deletes++ } batches.push(Object.freeze({ index: batches.length, edits: Object.freeze([...current]), estimatedPayloadBytes: currentBytes, adds, updates, deletes })); totalBytes += currentBytes; current = []; currentBytes = 0; return true }
    for (const edit of normalized) { const bytes = estimatedBytes(edit); const exceedsCount = current.length >= batchEditLimit; const exceedsBytes = current.length > 0 && currentBytes + bytes > this.budget.maxPayloadBytesPerBatch; if ((exceedsCount || exceedsBytes) && !flush()) return Object.freeze({ accepted: false, reason: 'batch-count-budget-exceeded' }); current.push(edit); currentBytes += bytes }
    if (!flush()) return Object.freeze({ accepted: false, reason: 'batch-count-budget-exceeded' })
    return Object.freeze({ accepted: true, batches: Object.freeze(batches), totalEdits: normalized.length, estimatedPayloadBytes: totalBytes })
  }
}
