export type ArcGisPopupDimension = '2d' | '3d'

export interface ArcGisPopupField {
  readonly name: string
  readonly label: string
  readonly value: string | number | boolean | null
  readonly priority: number
}

export interface ArcGisPopupRequest {
  readonly dimension: ArcGisPopupDimension
  readonly layerId: number
  readonly objectId: number
  readonly revision: string
  readonly title: string
  readonly fields: readonly ArcGisPopupField[]
  readonly x: number
  readonly y: number
  readonly spatialReferenceWkid: number
}

export interface ArcGisPopupBudget {
  readonly maxFields: number
  readonly maxTitleLength: number
  readonly maxFieldNameLength: number
  readonly maxFieldLabelLength: number
  readonly maxFieldValueLength: number
  readonly maxRevisionLength: number
  readonly maxEstimatedBytes: number
  readonly maxPriority: number
}

export interface ArcGisPopupFieldPlan {
  readonly name: string
  readonly label: string
  readonly value: string | number | boolean | null
  readonly priority: number
  readonly estimatedBytes: number
}

export interface ArcGisPopupPlan {
  readonly dimension: ArcGisPopupDimension
  readonly layerId: number
  readonly objectId: number
  readonly revision: string
  readonly title: string
  readonly point: Readonly<{ x: number; y: number; spatialReferenceWkid: number }>
  readonly fields: readonly ArcGisPopupFieldPlan[]
  readonly estimatedBytes: number
  readonly fingerprint: string
}

const MAX_FIELDS = 10_000
const MAX_BYTES = 16 * 1024 * 1024
const WEB_MERCATOR_WKIDS = new Set([102100, 102113, 3857])

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return value
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name}-must-be-finite`)
  return Object.is(value, -0) ? 0 : value
}

function text(value: string, name: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function canonicalWkid(value: number): number {
  const wkid = integer(value, 'spatialReferenceWkid', 1, 999_999)
  return WEB_MERCATOR_WKIDS.has(wkid) ? 3857 : wkid
}

function canonicalValue(value: ArcGisPopupField['value'], maxLength: number): ArcGisPopupField['value'] {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('popup-field-number-must-be-finite')
    return Object.is(value, -0) ? 0 : value
  }
  return text(value, 'popup-field-value', maxLength)
}

function bytes(value: ArcGisPopupField['value']): number {
  if (value === null) return 4
  return String(value).length * 2
}

function fingerprint(plan: Omit<ArcGisPopupPlan, 'fingerprint'>): string {
  return ['popup-v1', plan.dimension, plan.layerId, plan.objectId, plan.revision, plan.point.x, plan.point.y,
    plan.point.spatialReferenceWkid, ...plan.fields.map((field) => `${field.name}:${String(field.value)}`)].join('|')
}

/** Transport-independent popup admission authority. It never emits HTML or performs network I/O. */
export class ArcGisPopupPolicy {
  private readonly budget: Readonly<ArcGisPopupBudget>

  constructor(budget: ArcGisPopupBudget) {
    this.budget = Object.freeze({
      maxFields: integer(budget.maxFields, 'maxFields', 1, MAX_FIELDS),
      maxTitleLength: integer(budget.maxTitleLength, 'maxTitleLength', 1, 1024),
      maxFieldNameLength: integer(budget.maxFieldNameLength, 'maxFieldNameLength', 1, 256),
      maxFieldLabelLength: integer(budget.maxFieldLabelLength, 'maxFieldLabelLength', 1, 512),
      maxFieldValueLength: integer(budget.maxFieldValueLength, 'maxFieldValueLength', 1, 32_768),
      maxRevisionLength: integer(budget.maxRevisionLength, 'maxRevisionLength', 1, 256),
      maxEstimatedBytes: integer(budget.maxEstimatedBytes, 'maxEstimatedBytes', 1, MAX_BYTES),
      maxPriority: integer(budget.maxPriority, 'maxPriority', 0, 1_000_000),
    })
  }

  plan(request: ArcGisPopupRequest): ArcGisPopupPlan {
    if (request.dimension !== '2d' && request.dimension !== '3d') throw new Error('invalid-popup-dimension')
    if (!Array.isArray(request.fields)) throw new Error('popup-fields-must-be-array')
    if (request.fields.length > this.budget.maxFields) throw new Error('popup-field-budget-exceeded')
    const layerId = integer(request.layerId, 'layerId', 0, 1_000_000)
    const objectId = integer(request.objectId, 'objectId', 0, Number.MAX_SAFE_INTEGER)
    const revision = text(request.revision, 'revision', this.budget.maxRevisionLength)
    const title = text(request.title, 'popup-title', this.budget.maxTitleLength)
    const seen = new Set<string>()
    const fields: ArcGisPopupFieldPlan[] = []
    let estimatedBytes = title.length * 2
    for (const field of request.fields) {
      const name = text(field.name, 'popup-field-name', this.budget.maxFieldNameLength)
      if (seen.has(name)) throw new Error(`duplicate-popup-field:${name}`)
      seen.add(name)
      const label = text(field.label, 'popup-field-label', this.budget.maxFieldLabelLength)
      const value = canonicalValue(field.value, this.budget.maxFieldValueLength)
      const priority = integer(field.priority, 'priority', 0, this.budget.maxPriority)
      const estimatedFieldBytes = name.length * 2 + label.length * 2 + bytes(value)
      if (estimatedFieldBytes > this.budget.maxEstimatedBytes - estimatedBytes) throw new Error('popup-byte-budget-exceeded')
      estimatedBytes += estimatedFieldBytes
      fields.push(Object.freeze({ name, label, value, priority, estimatedBytes: estimatedFieldBytes }))
    }
    fields.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'en'))
    const frozenFields = Object.freeze(fields)
    const partial = Object.freeze({
      dimension: request.dimension, layerId, objectId, revision, title,
      point: Object.freeze({ x: finite(request.x, 'x'), y: finite(request.y, 'y'), spatialReferenceWkid: canonicalWkid(request.spatialReferenceWkid) }),
      fields: frozenFields, estimatedBytes,
    })
    return Object.freeze({ ...partial, fingerprint: fingerprint(partial) })
  }
}
