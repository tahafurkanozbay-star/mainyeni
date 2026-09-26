export type ArcGisQueryOrder = 'asc' | 'desc'

export interface ArcGisQueryPagePlannerOptions {
  readonly defaultPageSize: number
  readonly maxPageSize: number
  readonly maxPages: number
  readonly maxObjectIds: number
  readonly maxEstimatedFeatures: number
}

export interface ArcGisQueryCapabilities {
  readonly maxRecordCount?: number
  readonly supportsPagination?: boolean
  readonly supportsOrderBy?: boolean
  readonly objectIdField: string
}

export interface ArcGisQueryPageRequest {
  readonly layerId: string
  readonly where: string
  readonly outFields: readonly string[]
  readonly estimatedFeatures?: number
  readonly pageSize?: number
  readonly order?: ArcGisQueryOrder
  readonly objectIds?: readonly number[]
}

export interface ArcGisOffsetPage {
  readonly kind: 'offset'
  readonly page: number
  readonly resultOffset: number
  readonly resultRecordCount: number
  readonly orderByFields: readonly string[]
}

export interface ArcGisObjectIdPage {
  readonly kind: 'objectIds'
  readonly page: number
  readonly objectIds: readonly number[]
}

export type ArcGisQueryPage = ArcGisOffsetPage | ArcGisObjectIdPage

export type ArcGisQueryPlan =
  | { readonly kind: 'planned'; readonly key: string; readonly pageSize: number; readonly pages: readonly ArcGisQueryPage[] }
  | { readonly kind: 'rejected'; readonly reason: ArcGisQueryPlanRejection }

export type ArcGisQueryPlanRejection =
  | 'invalid-layer'
  | 'invalid-where'
  | 'invalid-object-id-field'
  | 'invalid-out-fields'
  | 'invalid-page-size'
  | 'feature-budget'
  | 'page-budget'
  | 'object-id-budget'
  | 'pagination-unsupported-without-object-ids'

const DEFAULTS: ArcGisQueryPagePlannerOptions = {
  defaultPageSize: 1000,
  maxPageSize: 2000,
  maxPages: 64,
  maxObjectIds: 100_000,
  maxEstimatedFeatures: 100_000,
}

const CONTROL = /[\u0000-\u001f\u007f]/u
const FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/u

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function boundedText(value: string, max: number): boolean {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= max && !CONTROL.test(normalized)
}

function normalizeOptions(input: Partial<ArcGisQueryPagePlannerOptions>): ArcGisQueryPagePlannerOptions {
  const value = { ...DEFAULTS, ...input }
  for (const [name, amount] of Object.entries(value)) {
    if (!positiveInteger(amount)) throw new Error(`Invalid ArcGIS query planner option: ${name}`)
  }
  if (value.defaultPageSize > value.maxPageSize) throw new Error('defaultPageSize exceeds maxPageSize')
  return Object.freeze(value)
}

function normalizeFields(fields: readonly string[]): readonly string[] | null {
  if (fields.length === 0 || fields.length > 256) return null
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of fields) {
    const field = raw.trim()
    if (!FIELD.test(field) && field !== '*') return null
    const key = field.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(field)
  }
  return Object.freeze(normalized)
}

function normalizeObjectIds(values: readonly number[]): readonly number[] | null {
  const unique = new Set<number>()
  for (const value of values) {
    if (!positiveInteger(value)) return null
    unique.add(value)
  }
  return Object.freeze([...unique].sort((left, right) => left - right))
}

function stableKey(request: ArcGisQueryPageRequest, fields: readonly string[], pageSize: number): string {
  const ids = request.objectIds === undefined ? '' : request.objectIds.join(',')
  return [request.layerId.trim(), request.where.trim(), fields.join(','), String(pageSize), request.order ?? 'asc', ids].join('\u001e')
}

export class ArcGisQueryPagePlanner {
  readonly #options: ArcGisQueryPagePlannerOptions

  constructor(options: Partial<ArcGisQueryPagePlannerOptions> = {}) {
    this.#options = normalizeOptions(options)
  }

  plan(request: ArcGisQueryPageRequest, capabilities: ArcGisQueryCapabilities): ArcGisQueryPlan {
    if (!boundedText(request.layerId, 256)) return { kind: 'rejected', reason: 'invalid-layer' }
    if (!boundedText(request.where, 8192)) return { kind: 'rejected', reason: 'invalid-where' }
    if (!FIELD.test(capabilities.objectIdField.trim())) return { kind: 'rejected', reason: 'invalid-object-id-field' }
    const fields = normalizeFields(request.outFields)
    if (fields === null) return { kind: 'rejected', reason: 'invalid-out-fields' }

    const serviceLimit = capabilities.maxRecordCount === undefined
      ? this.#options.maxPageSize
      : Math.min(capabilities.maxRecordCount, this.#options.maxPageSize)
    if (!positiveInteger(serviceLimit)) return { kind: 'rejected', reason: 'invalid-page-size' }
    const requestedPageSize = request.pageSize ?? this.#options.defaultPageSize
    if (!positiveInteger(requestedPageSize)) return { kind: 'rejected', reason: 'invalid-page-size' }
    const pageSize = Math.min(requestedPageSize, serviceLimit)

    if (request.estimatedFeatures !== undefined) {
      if (!Number.isSafeInteger(request.estimatedFeatures) || request.estimatedFeatures < 0) {
        return { kind: 'rejected', reason: 'feature-budget' }
      }
      if (request.estimatedFeatures > this.#options.maxEstimatedFeatures) {
        return { kind: 'rejected', reason: 'feature-budget' }
      }
    }

    if (request.objectIds !== undefined) {
      if (request.objectIds.length > this.#options.maxObjectIds) return { kind: 'rejected', reason: 'object-id-budget' }
      const objectIds = normalizeObjectIds(request.objectIds)
      if (objectIds === null) return { kind: 'rejected', reason: 'object-id-budget' }
      const pageCount = Math.ceil(objectIds.length / pageSize)
      if (pageCount > this.#options.maxPages) return { kind: 'rejected', reason: 'page-budget' }
      const pages: ArcGisObjectIdPage[] = []
      for (let index = 0; index < objectIds.length; index += pageSize) {
        pages.push(Object.freeze({
          kind: 'objectIds',
          page: pages.length,
          objectIds: Object.freeze(objectIds.slice(index, index + pageSize)),
        }))
      }
      return Object.freeze({ kind: 'planned', key: stableKey(request, fields, pageSize), pageSize, pages: Object.freeze(pages) })
    }

    if (capabilities.supportsPagination !== true) {
      return { kind: 'rejected', reason: 'pagination-unsupported-without-object-ids' }
    }
    const estimated = request.estimatedFeatures ?? pageSize
    const pageCount = Math.max(1, Math.ceil(estimated / pageSize))
    if (pageCount > this.#options.maxPages) return { kind: 'rejected', reason: 'page-budget' }
    const orderByFields = capabilities.supportsOrderBy === true
      ? Object.freeze([`${capabilities.objectIdField.trim()} ${request.order ?? 'asc'}`])
      : Object.freeze([])
    const pages: ArcGisOffsetPage[] = []
    for (let page = 0; page < pageCount; page += 1) {
      pages.push(Object.freeze({
        kind: 'offset',
        page,
        resultOffset: page * pageSize,
        resultRecordCount: pageSize,
        orderByFields,
      }))
    }
    return Object.freeze({ kind: 'planned', key: stableKey(request, fields, pageSize), pageSize, pages: Object.freeze(pages) })
  }
}