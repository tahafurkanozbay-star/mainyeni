export interface ArcGisRawQueryCapabilities {
  readonly maxRecordCount?: unknown
  readonly objectIdField?: unknown
  readonly globalIdField?: unknown
  readonly supportsPagination?: unknown
  readonly supportsOrderBy?: unknown
  readonly supportsStatistics?: unknown
  readonly supportsDistinct?: unknown
  readonly supportsReturningQueryExtent?: unknown
  readonly supportsSqlExpression?: unknown
  readonly supportedQueryFormats?: unknown
}

export interface ArcGisQueryCapabilitySnapshot {
  readonly maxRecordCount: number
  readonly identityField: string
  readonly identityKind: 'object-id' | 'global-id'
  readonly supportsPagination: boolean
  readonly supportsOrderBy: boolean
  readonly supportsStatistics: boolean
  readonly supportsDistinct: boolean
  readonly supportsReturningQueryExtent: boolean
  readonly supportsSqlExpression: boolean
  readonly supportedQueryFormats: readonly string[]
  readonly fingerprint: string
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) {
    throw new Error(`ArcGIS capability ${name} must be a bounded positive integer`)
  }
  return value
}

function optionalField(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`ArcGIS capability ${name} must be a string`)
  const normalized = value.trim()
  if (normalized.length === 0) return undefined
  if (normalized.length > 256 || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(normalized)) throw new Error(`ArcGIS capability ${name} is invalid`)
  return normalized
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`ArcGIS capability ${name} must be boolean`)
  return value
}

function formats(value: unknown): readonly string[] {
  if (typeof value !== 'string') throw new Error('ArcGIS capability supportedQueryFormats must be a string')
  const normalized = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  if (normalized.length === 0 || normalized.length > 16) throw new Error('ArcGIS capability supportedQueryFormats is invalid')
  const unique = [...new Set(normalized)]
  for (const format of unique) if (!/^[a-z0-9-]{1,32}$/.test(format)) throw new Error('ArcGIS capability query format is invalid')
  return Object.freeze(unique.sort())
}

function fingerprint(parts: readonly (string | number | boolean)[]): string {
  return parts.map(value => typeof value === 'boolean' ? (value ? '1' : '0') : String(value).replaceAll('|', '%7C')).join('|')
}

export function normalizeArcGisQueryCapabilities(raw: ArcGisRawQueryCapabilities): ArcGisQueryCapabilitySnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('ArcGIS capability payload is required')
  const maxRecordCount = positiveInteger(raw.maxRecordCount, 'maxRecordCount')
  const objectIdField = optionalField(raw.objectIdField, 'objectIdField')
  const globalIdField = optionalField(raw.globalIdField, 'globalIdField')
  const identityField = objectIdField ?? globalIdField
  if (!identityField) throw new Error('ArcGIS capability requires a verified identity field')
  const identityKind = objectIdField ? 'object-id' as const : 'global-id' as const
  const supportsPagination = boolean(raw.supportsPagination, 'supportsPagination')
  const supportsOrderBy = boolean(raw.supportsOrderBy, 'supportsOrderBy')
  const supportsStatistics = boolean(raw.supportsStatistics, 'supportsStatistics')
  const supportsDistinct = boolean(raw.supportsDistinct, 'supportsDistinct')
  const supportsReturningQueryExtent = boolean(raw.supportsReturningQueryExtent, 'supportsReturningQueryExtent')
  const supportsSqlExpression = boolean(raw.supportsSqlExpression, 'supportsSqlExpression')
  const supportedQueryFormats = formats(raw.supportedQueryFormats)
  if (supportsPagination && !supportsOrderBy) throw new Error('ArcGIS capability pagination requires deterministic order-by support')
  const fp = fingerprint([maxRecordCount, identityField, identityKind, supportsPagination, supportsOrderBy, supportsStatistics, supportsDistinct, supportsReturningQueryExtent, supportsSqlExpression, ...supportedQueryFormats])
  return Object.freeze({ maxRecordCount, identityField, identityKind, supportsPagination, supportsOrderBy, supportsStatistics, supportsDistinct, supportsReturningQueryExtent, supportsSqlExpression, supportedQueryFormats, fingerprint: fp })
}

export function sameArcGisQueryCapabilities(left: ArcGisQueryCapabilitySnapshot, right: ArcGisQueryCapabilitySnapshot): boolean {
  return left.fingerprint === right.fingerprint
}

export function assertArcGisQueryCapability(snapshot: ArcGisQueryCapabilitySnapshot, capability: 'pagination' | 'order-by' | 'statistics' | 'distinct' | 'extent' | 'sql-expression'): void {
  const supported = capability === 'pagination' ? snapshot.supportsPagination
    : capability === 'order-by' ? snapshot.supportsOrderBy
      : capability === 'statistics' ? snapshot.supportsStatistics
        : capability === 'distinct' ? snapshot.supportsDistinct
          : capability === 'extent' ? snapshot.supportsReturningQueryExtent
            : snapshot.supportsSqlExpression
  if (!supported) throw new Error(`ArcGIS query capability ${capability} is not verified for this service`)
}
