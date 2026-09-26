export type ArcGisSortDirection = 'asc' | 'desc'

export interface ArcGisResultWindowOptions {
  readonly maxFeatures: number
  readonly maxSortFields: number
  readonly maxStringLength: number
}

export interface ArcGisResultSortField {
  readonly field: string
  readonly direction: ArcGisSortDirection
}

export interface ArcGisResultFeature {
  readonly attributes: Readonly<Record<string, unknown>>
  readonly geometry?: unknown
}

export interface ArcGisResultWindowInput {
  readonly features: readonly ArcGisResultFeature[]
  readonly objectIdField: string
  readonly sort: readonly ArcGisResultSortField[]
  readonly offset: number
  readonly limit: number
}

export interface ArcGisResultWindowOutput {
  readonly features: readonly ArcGisResultFeature[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly hasPrevious: boolean
  readonly hasNext: boolean
  readonly firstObjectId?: string | number
  readonly lastObjectId?: string | number
}

const DEFAULTS: ArcGisResultWindowOptions = Object.freeze({ maxFeatures: 25_000, maxSortFields: 4, maxStringLength: 2048 })

type Scalar = string | number | boolean | null

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ArcGIS result window ${name} must be a positive integer`)
}

function fieldName(value: string, label: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 256) throw new Error(`ArcGIS result window ${label} is invalid`)
  return normalized
}

function normalizeScalar(value: unknown, maxStringLength: number): Scalar {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ArcGIS result window numeric sort values must be finite')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > maxStringLength) throw new Error('ArcGIS result window string sort value exceeds budget')
    return value
  }
  if (typeof value === 'boolean') return value
  throw new Error('ArcGIS result window sort values must be scalar')
}

function idValue(attributes: Readonly<Record<string, unknown>>, field: string, maxStringLength: number): string | number {
  const value = attributes[field]
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized.length > 0 && normalized.length <= maxStringLength) return normalized
  }
  throw new Error('ArcGIS result window requires a stable object id')
}

function idKey(value: string | number): string { return typeof value === 'number' ? `n:${value}` : `s:${value}` }

function compareScalar(left: Scalar, right: Scalar): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  if (typeof left === typeof right) {
    if (typeof left === 'number') return left < (right as number) ? -1 : 1
    if (typeof left === 'boolean') return left === false ? -1 : 1
    return (left as string).localeCompare(right as string, 'tr', { sensitivity: 'base', numeric: true })
  }
  const rank = (value: Scalar): number => typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2
  return rank(left) - rank(right)
}

export class ArcGisQueryResultWindow {
  private readonly options: ArcGisResultWindowOptions

  constructor(options: Partial<ArcGisResultWindowOptions> = {}) {
    this.options = Object.freeze({ ...DEFAULTS, ...options })
    positiveInteger(this.options.maxFeatures, 'maxFeatures')
    positiveInteger(this.options.maxSortFields, 'maxSortFields')
    positiveInteger(this.options.maxStringLength, 'maxStringLength')
  }

  select(input: ArcGisResultWindowInput): ArcGisResultWindowOutput {
    const objectIdField = fieldName(input.objectIdField, 'objectIdField')
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('ArcGIS result window offset must be a non-negative safe integer')
    positiveInteger(input.limit, 'limit')
    if (input.features.length > this.options.maxFeatures) throw new Error('ArcGIS result window feature budget exceeded')
    if (input.sort.length > this.options.maxSortFields) throw new Error('ArcGIS result window sort field budget exceeded')

    const sort = input.sort.map(item => ({ field: fieldName(item.field, 'sort field'), direction: item.direction }))
    for (const item of sort) if (item.direction !== 'asc' && item.direction !== 'desc') throw new Error('ArcGIS result window sort direction is invalid')
    const seenSort = new Set<string>()
    for (const item of sort) {
      const key = item.field.toLocaleLowerCase('tr-TR')
      if (seenSort.has(key)) throw new Error('ArcGIS result window duplicate sort field')
      seenSort.add(key)
    }

    const decorated = input.features.map((feature, originalIndex) => {
      if (!feature || typeof feature !== 'object' || !feature.attributes || typeof feature.attributes !== 'object') throw new Error('ArcGIS result window feature attributes are required')
      const id = idValue(feature.attributes, objectIdField, this.options.maxStringLength)
      const values = sort.map(item => normalizeScalar(feature.attributes[item.field], this.options.maxStringLength))
      return { feature, id, idKey: idKey(id), values, originalIndex }
    })

    const identities = new Set<string>()
    for (const item of decorated) {
      if (identities.has(item.idKey)) throw new Error(`ArcGIS result window duplicate object id ${String(item.id)}`)
      identities.add(item.idKey)
    }

    decorated.sort((left, right) => {
      for (let index = 0; index < sort.length; index += 1) {
        const descriptor = sort[index]
        if (!descriptor) continue
        const compared = compareScalar(left.values[index] ?? null, right.values[index] ?? null)
        if (compared !== 0) return descriptor.direction === 'asc' ? compared : -compared
      }
      const idCompared = compareScalar(left.id, right.id)
      if (idCompared !== 0) return idCompared
      return left.originalIndex - right.originalIndex
    })

    const selected = decorated.slice(input.offset, input.offset + input.limit)
    const features = Object.freeze(selected.map(item => item.feature))
    const first = selected[0]?.id
    const last = selected[selected.length - 1]?.id
    const result: ArcGisResultWindowOutput = {
      features, total: decorated.length, offset: input.offset, limit: input.limit,
      hasPrevious: input.offset > 0 && decorated.length > 0,
      hasNext: input.offset + selected.length < decorated.length,
      ...(first === undefined ? {} : { firstObjectId: first }),
      ...(last === undefined ? {} : { lastObjectId: last }),
    }
    return Object.freeze(result)
  }
}
