export interface ArcGisQueryResponseIntegrityOptions {
  readonly maxFeaturesPerPage: number
  readonly maxAttributesPerFeature: number
  readonly maxAttributeTextLength: number
  readonly maxGeometryDepth: number
  readonly maxGeometryCoordinates: number
  readonly requireObjectId: boolean
}

export interface ArcGisQueryResponseContext {
  readonly objectIdField: string
  readonly expectedObjectIds?: readonly number[]
  readonly expectedSpatialReferenceWkid?: number
}

export interface ArcGisFeatureLike {
  readonly attributes?: unknown
  readonly geometry?: unknown
}

export interface ArcGisQueryResponseLike {
  readonly features?: unknown
  readonly exceededTransferLimit?: unknown
  readonly spatialReference?: unknown
}

export type ArcGisQueryIntegrityIssueCode =
  | 'invalid-response'
  | 'invalid-features'
  | 'feature-budget'
  | 'invalid-feature'
  | 'invalid-attributes'
  | 'attribute-budget'
  | 'attribute-text-budget'
  | 'missing-object-id'
  | 'invalid-object-id'
  | 'duplicate-object-id'
  | 'unexpected-object-id'
  | 'invalid-geometry'
  | 'geometry-depth-budget'
  | 'geometry-coordinate-budget'
  | 'invalid-coordinate'
  | 'invalid-transfer-limit'
  | 'invalid-spatial-reference'
  | 'spatial-reference-mismatch'

export interface ArcGisQueryIntegrityIssue {
  readonly code: ArcGisQueryIntegrityIssueCode
  readonly featureIndex?: number
  readonly field?: string
}

export type ArcGisQueryIntegrityResult =
  | {
      readonly kind: 'accepted'
      readonly features: readonly ArcGisFeatureLike[]
      readonly objectIds: readonly number[]
      readonly exceededTransferLimit: boolean
      readonly spatialReferenceWkid?: number
    }
  | { readonly kind: 'rejected'; readonly issue: ArcGisQueryIntegrityIssue }

const DEFAULTS: ArcGisQueryResponseIntegrityOptions = {
  maxFeaturesPerPage: 2_000,
  maxAttributesPerFeature: 256,
  maxAttributeTextLength: 16_384,
  maxGeometryDepth: 12,
  maxGeometryCoordinates: 200_000,
  requireObjectId: true,
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/u

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeOptions(input: Partial<ArcGisQueryResponseIntegrityOptions>): ArcGisQueryResponseIntegrityOptions {
  const options = { ...DEFAULTS, ...input }
  for (const [name, value] of Object.entries(options)) {
    if (name === 'requireObjectId') continue
    if (!positiveInteger(value as number)) throw new Error(`Invalid ArcGIS response integrity option: ${name}`)
  }
  return Object.freeze(options)
}

function parseWkid(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const wkid = value.latestWkid ?? value.wkid
  if (wkid === undefined) return undefined
  if (!positiveInteger(wkid as number)) return null
  return wkid as number
}

function inspectGeometry(
  geometry: unknown,
  maxDepth: number,
  maxCoordinates: number,
): ArcGisQueryIntegrityIssueCode | null {
  if (geometry === undefined || geometry === null) return null
  if (!isRecord(geometry)) return 'invalid-geometry'

  let coordinateCount = 0
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: geometry, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > maxDepth) return 'geometry-depth-budget'
    const value = current.value
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const child = value[index]
        if (typeof child === 'number') {
          if (!Number.isFinite(child)) return 'invalid-coordinate'
          coordinateCount += 1
          if (coordinateCount > maxCoordinates) return 'geometry-coordinate-budget'
        } else if (Array.isArray(child) || isRecord(child)) {
          stack.push({ value: child, depth: current.depth + 1 })
        } else if (child !== null && child !== undefined) {
          return 'invalid-geometry'
        }
      }
      continue
    }
    if (!isRecord(value)) return 'invalid-geometry'
    for (const [key, child] of Object.entries(value)) {
      if (key === 'spatialReference') continue
      if (typeof child === 'number') {
        if (!Number.isFinite(child)) return 'invalid-coordinate'
        if (key === 'x' || key === 'y' || key === 'z' || key === 'm') {
          coordinateCount += 1
          if (coordinateCount > maxCoordinates) return 'geometry-coordinate-budget'
        }
      } else if (Array.isArray(child) || isRecord(child)) {
        stack.push({ value: child, depth: current.depth + 1 })
      } else if (child !== null && child !== undefined && typeof child !== 'string' && typeof child !== 'boolean') {
        return 'invalid-geometry'
      }
    }
  }
  return null
}

function inspectAttributes(
  attributes: unknown,
  maxAttributes: number,
  maxTextLength: number,
): { readonly record: Record<string, unknown> } | { readonly issue: ArcGisQueryIntegrityIssueCode; readonly field?: string } {
  if (!isRecord(attributes)) return { issue: 'invalid-attributes' }
  const entries = Object.entries(attributes)
  if (entries.length > maxAttributes) return { issue: 'attribute-budget' }
  for (const [field, value] of entries) {
    if (field.length === 0 || field.length > 256) return { issue: 'invalid-attributes', field }
    if (typeof value === 'string' && value.length > maxTextLength) return { issue: 'attribute-text-budget', field }
    if (typeof value === 'number' && !Number.isFinite(value)) return { issue: 'invalid-attributes', field }
    if (typeof value === 'object' && value !== null) return { issue: 'invalid-attributes', field }
    if (!['string', 'number', 'boolean', 'object', 'undefined'].includes(typeof value)) {
      return { issue: 'invalid-attributes', field }
    }
  }
  return { record: attributes }
}

export class ArcGisQueryResponseIntegrity {
  readonly #options: ArcGisQueryResponseIntegrityOptions

  constructor(options: Partial<ArcGisQueryResponseIntegrityOptions> = {}) {
    this.#options = normalizeOptions(options)
  }

  inspect(response: unknown, context: ArcGisQueryResponseContext): ArcGisQueryIntegrityResult {
    if (!isRecord(response)) return { kind: 'rejected', issue: { code: 'invalid-response' } }
    if (!FIELD.test(context.objectIdField.trim())) {
      return { kind: 'rejected', issue: { code: 'invalid-object-id', field: context.objectIdField } }
    }
    if (!Array.isArray(response.features)) return { kind: 'rejected', issue: { code: 'invalid-features' } }
    if (response.features.length > this.#options.maxFeaturesPerPage) {
      return { kind: 'rejected', issue: { code: 'feature-budget' } }
    }
    if (response.exceededTransferLimit !== undefined && typeof response.exceededTransferLimit !== 'boolean') {
      return { kind: 'rejected', issue: { code: 'invalid-transfer-limit' } }
    }

    const wkid = parseWkid(response.spatialReference)
    if (wkid === null) return { kind: 'rejected', issue: { code: 'invalid-spatial-reference' } }
    if (context.expectedSpatialReferenceWkid !== undefined) {
      if (!positiveInteger(context.expectedSpatialReferenceWkid)) {
        return { kind: 'rejected', issue: { code: 'invalid-spatial-reference' } }
      }
      if (wkid !== undefined && wkid !== context.expectedSpatialReferenceWkid) {
        return { kind: 'rejected', issue: { code: 'spatial-reference-mismatch' } }
      }
    }

    const expected = context.expectedObjectIds === undefined ? undefined : new Set(context.expectedObjectIds)
    const seen = new Set<number>()
    const accepted: ArcGisFeatureLike[] = []
    for (let index = 0; index < response.features.length; index += 1) {
      const raw = response.features[index]
      if (!isRecord(raw)) return { kind: 'rejected', issue: { code: 'invalid-feature', featureIndex: index } }
      const attributes = inspectAttributes(raw.attributes, this.#options.maxAttributesPerFeature, this.#options.maxAttributeTextLength)
      if ('issue' in attributes) {
        return { kind: 'rejected', issue: { code: attributes.issue, featureIndex: index, ...(attributes.field === undefined ? {} : { field: attributes.field }) } }
      }
      const objectId = attributes.record[context.objectIdField]
      if (objectId === undefined || objectId === null) {
        if (this.#options.requireObjectId) return { kind: 'rejected', issue: { code: 'missing-object-id', featureIndex: index, field: context.objectIdField } }
      } else {
        if (!positiveInteger(objectId as number)) {
          return { kind: 'rejected', issue: { code: 'invalid-object-id', featureIndex: index, field: context.objectIdField } }
        }
        const id = objectId as number
        if (seen.has(id)) return { kind: 'rejected', issue: { code: 'duplicate-object-id', featureIndex: index, field: context.objectIdField } }
        if (expected !== undefined && !expected.has(id)) {
          return { kind: 'rejected', issue: { code: 'unexpected-object-id', featureIndex: index, field: context.objectIdField } }
        }
        seen.add(id)
      }
      const geometryIssue = inspectGeometry(raw.geometry, this.#options.maxGeometryDepth, this.#options.maxGeometryCoordinates)
      if (geometryIssue !== null) return { kind: 'rejected', issue: { code: geometryIssue, featureIndex: index } }
      accepted.push(Object.freeze({ attributes: Object.freeze({ ...attributes.record }), ...(raw.geometry === undefined ? {} : { geometry: raw.geometry }) }))
    }

    return Object.freeze({
      kind: 'accepted',
      features: Object.freeze(accepted),
      objectIds: Object.freeze([...seen]),
      exceededTransferLimit: response.exceededTransferLimit === true,
      ...(wkid === undefined ? {} : { spatialReferenceWkid: wkid }),
    })
  }
}
