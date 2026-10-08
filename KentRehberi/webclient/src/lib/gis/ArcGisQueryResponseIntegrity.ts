export interface ArcGisQueryResponseIntegrityOptions {
  readonly maxFeaturesPerPage: number
  readonly maxAttributesPerFeature: number
  readonly maxAttributesPerPage: number
  readonly maxAttributeTextCharactersPerPage: number
  readonly maxAttributeTextLength: number
  readonly maxGeometryDepth: number
  readonly maxGeometryCoordinates: number
  readonly maxGeometryNodesPerFeature: number
  readonly maxGeometryNodesPerPage: number
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
  | 'attribute-page-budget'
  | 'attribute-text-page-budget'
  | 'attribute-text-budget'
  | 'missing-object-id'
  | 'invalid-object-id'
  | 'duplicate-object-id'
  | 'unexpected-object-id'
  | 'invalid-geometry'
  | 'geometry-depth-budget'
  | 'geometry-coordinate-budget'
  | 'geometry-node-budget'
  | 'geometry-page-node-budget'
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
  maxAttributesPerPage: 131_072,
  maxAttributeTextCharactersPerPage: 16_777_216,
  maxAttributeTextLength: 16_384,
  maxGeometryDepth: 12,
  maxGeometryCoordinates: 200_000,
  maxGeometryNodesPerFeature: 250_000,
  maxGeometryNodesPerPage: 500_000,
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
    if (name === 'requireObjectId') {
      if (typeof value !== 'boolean') throw new Error('Invalid ArcGIS response integrity option: requireObjectId')
      continue
    }
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
  maxNodesPerFeature: number,
  maxNodesPerPage: number,
  page: { nodes: number },
): ArcGisQueryIntegrityIssueCode | null {
  if (geometry === undefined || geometry === null) return null
  if (!isRecord(geometry)) return 'invalid-geometry'

  let coordinateCount = 0
  let featureNodes = 1
  page.nodes += 1
  if (page.nodes > maxNodesPerPage) return 'geometry-page-node-budget'
  const consumeNode = (): ArcGisQueryIntegrityIssueCode | null => {
    featureNodes += 1
    page.nodes += 1
    if (featureNodes > maxNodesPerFeature) return 'geometry-node-budget'
    if (page.nodes > maxNodesPerPage) return 'geometry-page-node-budget'
    return null
  }
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: geometry, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > maxDepth) return 'geometry-depth-budget'
    const value = current.value
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const exceeded = consumeNode()
        if (exceeded !== null) return exceeded
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
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key) || key === 'spatialReference') continue
      const exceeded = consumeNode()
      if (exceeded !== null) return exceeded
      const child = value[key]
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
  page: { attributes: number; textCharacters: number },
  maxPageAttributes: number,
  maxPageTextCharacters: number,
): { readonly record: Record<string, unknown> } | { readonly issue: ArcGisQueryIntegrityIssueCode; readonly field?: string } {
  if (!isRecord(attributes)) return { issue: 'invalid-attributes' }
  let featureAttributes = 0
  // A bounded own-property walk avoids allocating an unbounded Object.entries array
  // before the attribute cardinality limit has been checked.
  for (const field in attributes) {
    if (!Object.prototype.hasOwnProperty.call(attributes, field)) continue
    featureAttributes += 1
    if (featureAttributes > maxAttributes) return { issue: 'attribute-budget' }
    page.attributes += 1
    if (page.attributes > maxPageAttributes) return { issue: 'attribute-page-budget' }
    if (field.length === 0 || field.length > 256) return { issue: 'invalid-attributes', field }
    const value = attributes[field]
    if (typeof value === 'string') {
      if (value.length > maxTextLength) return { issue: 'attribute-text-budget', field }
      page.textCharacters += value.length
      if (page.textCharacters > maxPageTextCharacters) return { issue: 'attribute-text-page-budget', field }
    }
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
    const pageGeometryBudget = { nodes: 0 }
    const pageAttributeBudget = { attributes: 0, textCharacters: 0 }
    for (let index = 0; index < response.features.length; index += 1) {
      const raw = response.features[index]
      if (!isRecord(raw)) return { kind: 'rejected', issue: { code: 'invalid-feature', featureIndex: index } }
      // Classify malformed object IDs precisely before generic attribute validation.
      const candidateId = isRecord(raw.attributes) ? raw.attributes[context.objectIdField] : undefined
      if (candidateId !== undefined && candidateId !== null && !positiveInteger(candidateId as number)) {
        return { kind: 'rejected', issue: { code: 'invalid-object-id', featureIndex: index, field: context.objectIdField } }
      }
      const attributes = inspectAttributes(
        raw.attributes,
        this.#options.maxAttributesPerFeature,
        this.#options.maxAttributeTextLength,
        pageAttributeBudget,
        this.#options.maxAttributesPerPage,
        this.#options.maxAttributeTextCharactersPerPage,
      )
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
      // ArcGIS may attach a spatial reference to each geometry independently.
      // A mismatched feature SR must not be rendered as if it used the response SR.
      if (isRecord(raw.geometry) && 'spatialReference' in raw.geometry) {
        const geometryWkid = parseWkid(raw.geometry.spatialReference)
        if (geometryWkid === null) {
          return { kind: 'rejected', issue: { code: 'invalid-spatial-reference', featureIndex: index } }
        }
        if (geometryWkid !== undefined &&
            ((wkid !== undefined && geometryWkid !== wkid) ||
             (context.expectedSpatialReferenceWkid !== undefined &&
              geometryWkid !== context.expectedSpatialReferenceWkid))) {
          return { kind: 'rejected', issue: { code: 'spatial-reference-mismatch', featureIndex: index } }
        }
      }
      const geometryIssue = inspectGeometry(
        raw.geometry,
        this.#options.maxGeometryDepth,
        this.#options.maxGeometryCoordinates,
        this.#options.maxGeometryNodesPerFeature,
        this.#options.maxGeometryNodesPerPage,
        pageGeometryBudget,
      )
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
