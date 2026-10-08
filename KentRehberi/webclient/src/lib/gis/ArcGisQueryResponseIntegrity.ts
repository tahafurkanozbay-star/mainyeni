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

// Untrusted REST data must be read through own data descriptors. Accessors
// must never execute during response validation or snapshot construction.
function ownData(record: Record<string, unknown>, key: string):
  { readonly valid: true; readonly value: unknown } | { readonly valid: false } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return { valid: true, value: undefined }
  if (!('value' in descriptor)) return { valid: false }
  return { valid: true, value: descriptor.value }
}

function parseWkid(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const latest = ownData(value, 'latestWkid')
  const legacy = ownData(value, 'wkid')
  if (!latest.valid || !legacy.valid) return null
  if (latest.value !== undefined && !positiveInteger(latest.value as number)) return null
  if (legacy.value !== undefined && !positiveInteger(legacy.value as number)) return null
  return (latest.value ?? legacy.value) as number | undefined
}

// A single bounded walk validates and snapshots geometry. Never retain a
// transport-owned nested coordinate array in an accepted response.
function inspectGeometry(
  geometry: unknown,
  maxDepth: number,
  maxCoordinates: number,
  maxNodesPerFeature: number,
  maxNodesPerPage: number,
  page: { nodes: number },
): { readonly issue: ArcGisQueryIntegrityIssueCode | null; readonly snapshot?: unknown } {
  if (geometry === undefined || geometry === null) return { issue: null, snapshot: geometry }
  if (!isRecord(geometry)) return { issue: 'invalid-geometry' }

  let coordinateCount = 0
  let featureNodes = 1
  page.nodes += 1
  if (page.nodes > maxNodesPerPage) return { issue: 'geometry-page-node-budget' }
  const consumeNode = (): ArcGisQueryIntegrityIssueCode | null => {
    featureNodes += 1
    page.nodes += 1
    if (featureNodes > maxNodesPerFeature) return 'geometry-node-budget'
    if (page.nodes > maxNodesPerPage) return 'geometry-page-node-budget'
    return null
  }

  type Copy = Record<string, unknown> | unknown[]
  const snapshot: Record<string, unknown> = {}
  const visited = new WeakSet<object>([geometry])
  const stack: Array<{ readonly source: Copy; readonly target: Copy; readonly depth: number }> = [
    { source: geometry, target: snapshot, depth: 0 },
  ]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > maxDepth) return { issue: 'geometry-depth-budget' }
    const { source, target, depth } = current
    if (Array.isArray(source)) {
      // Reject oversized and sparse arrays before allocating their slots.
      if (source.length > maxNodesPerFeature - featureNodes) return { issue: 'geometry-node-budget' }
      if (source.length > maxNodesPerPage - page.nodes) return { issue: 'geometry-page-node-budget' }
      const copy = target as unknown[]
      for (let index = 0; index < source.length; index += 1) {
        const exceeded = consumeNode()
        if (exceeded !== null) return { issue: exceeded }
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
        if (descriptor !== undefined && !('value' in descriptor)) return { issue: 'invalid-geometry' }
        // Sparse arrays and undefined elements are not representable in
        // ArcGIS REST JSON and must not become holes in rendered geometry.
        if (descriptor === undefined) return { issue: 'invalid-geometry' }
        const child = descriptor.value
        if (typeof child === 'number') {
          if (!Number.isFinite(child)) return { issue: 'invalid-coordinate' }
          coordinateCount += 1
          if (coordinateCount > maxCoordinates) return { issue: 'geometry-coordinate-budget' }
          copy[index] = child
        } else if (Array.isArray(child) || isRecord(child)) {
          if (visited.has(child)) return { issue: 'invalid-geometry' }
          visited.add(child)
          const nested: Copy = Array.isArray(child) ? [] : {}
          copy[index] = nested
          stack.push({ source: child, target: nested, depth: depth + 1 })
        } else if (child === null) {
          copy[index] = child
        } else {
          return { issue: 'invalid-geometry' }
        }
      }
      Object.freeze(copy)
      continue
    }

    if (!isRecord(source)) return { issue: 'invalid-geometry' }
    const copy = target as Record<string, unknown>
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue
      const exceeded = consumeNode()
      if (exceeded !== null) return { issue: exceeded }
      const descriptor = Object.getOwnPropertyDescriptor(source, key)
      if (descriptor === undefined || !('value' in descriptor)) return { issue: 'invalid-geometry' }
      const child = descriptor.value
      let cloned: unknown
      if (typeof child === 'number') {
        if (!Number.isFinite(child)) return { issue: 'invalid-coordinate' }
        if (key === 'x' || key === 'y' || key === 'z' || key === 'm') {
          coordinateCount += 1
          if (coordinateCount > maxCoordinates) return { issue: 'geometry-coordinate-budget' }
        }
        cloned = child
      } else if (Array.isArray(child) || isRecord(child)) {
        if (visited.has(child)) return { issue: 'invalid-geometry' }
        visited.add(child)
        const nested: Copy = Array.isArray(child) ? [] : {}
        cloned = nested
        stack.push({ source: child, target: nested, depth: depth + 1 })
      } else if (child === null || typeof child === 'string' || typeof child === 'boolean') {
        cloned = child
      } else {
        return { issue: 'invalid-geometry' }
      }
      // Define own keys safely (including JSON's __proto__) without
      // mutating the snapshot prototype or calling untrusted accessors.
      Object.defineProperty(copy, key, {
        value: cloned, enumerable: true, writable: true, configurable: true,
      })
    }
    Object.freeze(copy)
  }
  return { issue: null, snapshot }
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
  const snapshot: Record<string, unknown> = {}
  for (const field in attributes) {
    if (!Object.prototype.hasOwnProperty.call(attributes, field)) continue
    featureAttributes += 1
    if (featureAttributes > maxAttributes) return { issue: 'attribute-budget' }
    page.attributes += 1
    if (page.attributes > maxPageAttributes) return { issue: 'attribute-page-budget' }
    if (field.length === 0 || field.length > 256) return { issue: 'invalid-attributes', field }
    const descriptor = Object.getOwnPropertyDescriptor(attributes, field)
    if (descriptor === undefined || !('value' in descriptor)) return { issue: 'invalid-attributes', field }
    const value: unknown = descriptor.value
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
    // Define own keys without prototype setter side effects.
    Object.defineProperty(snapshot, field, {
      value, enumerable: true, writable: false, configurable: false,
    })
  }
  return { record: Object.freeze(snapshot) }
}

export class ArcGisQueryResponseIntegrity {
  readonly #options: ArcGisQueryResponseIntegrityOptions

  constructor(options: Partial<ArcGisQueryResponseIntegrityOptions> = {}) {
    this.#options = normalizeOptions(options)
  }

  inspect(response: unknown, context: ArcGisQueryResponseContext): ArcGisQueryIntegrityResult {
    if (!isRecord(response)) return { kind: 'rejected', issue: { code: 'invalid-response' } }
    if (context === null || typeof context !== 'object' ||
        typeof context.objectIdField !== 'string' || !FIELD.test(context.objectIdField)) {
      return { kind: 'rejected', issue: { code: 'invalid-object-id' } }
    }
    const featureData = ownData(response, 'features')
    if (!featureData.valid || !Array.isArray(featureData.value)) {
      return { kind: 'rejected', issue: { code: 'invalid-features' } }
    }
    const features = featureData.value
    if (features.length > this.#options.maxFeaturesPerPage) {
      return { kind: 'rejected', issue: { code: 'feature-budget' } }
    }
    const transferData = ownData(response, 'exceededTransferLimit')
    if (!transferData.valid || (transferData.value !== undefined && typeof transferData.value !== 'boolean')) {
      return { kind: 'rejected', issue: { code: 'invalid-transfer-limit' } }
    }
    const referenceData = ownData(response, 'spatialReference')
    if (!referenceData.valid) return { kind: 'rejected', issue: { code: 'invalid-spatial-reference' } }
    const wkid = parseWkid(referenceData.value)
    if (wkid === null) return { kind: 'rejected', issue: { code: 'invalid-spatial-reference' } }
    if (context.expectedSpatialReferenceWkid !== undefined) {
      if (!positiveInteger(context.expectedSpatialReferenceWkid)) {
        return { kind: 'rejected', issue: { code: 'invalid-spatial-reference' } }
      }
      if (wkid !== undefined && wkid !== context.expectedSpatialReferenceWkid) {
        return { kind: 'rejected', issue: { code: 'spatial-reference-mismatch' } }
      }
    }

    // The expected-ID list is also a caller-supplied input. Bound and
    // validate it before allocating a Set or comparing any feature IDs.
    const expectedIds = context.expectedObjectIds
    if (expectedIds !== undefined &&
        (!Array.isArray(expectedIds) || expectedIds.length > this.#options.maxFeaturesPerPage ||
         expectedIds.some(id => !positiveInteger(id)))) {
      return { kind: 'rejected', issue: { code: 'invalid-object-id' } }
    }
    const expected = expectedIds === undefined ? undefined : new Set(expectedIds)
    if (expectedIds !== undefined && expected?.size !== expectedIds.length) {
      return { kind: 'rejected', issue: { code: 'invalid-object-id' } }
    }
    const seen = new Set<number>()
    const accepted: ArcGisFeatureLike[] = []
    const pageGeometryBudget = { nodes: 0 }
    const pageAttributeBudget = { attributes: 0, textCharacters: 0 }
    for (let index = 0; index < features.length; index += 1) {
      const featureDescriptor = Object.getOwnPropertyDescriptor(features, String(index))
      if (featureDescriptor === undefined || !('value' in featureDescriptor)) {
        return { kind: 'rejected', issue: { code: 'invalid-feature', featureIndex: index } }
      }
      const raw: unknown = featureDescriptor.value
      if (!isRecord(raw)) return { kind: 'rejected', issue: { code: 'invalid-feature', featureIndex: index } }
      const attributeData = ownData(raw, 'attributes')
      const geometryData = ownData(raw, 'geometry')
      if (!attributeData.valid) return { kind: 'rejected', issue: { code: 'invalid-attributes', featureIndex: index } }
      if (!geometryData.valid) return { kind: 'rejected', issue: { code: 'invalid-geometry', featureIndex: index } }
      const rawAttributes = attributeData.value
      const rawGeometry = geometryData.value
      // Classify malformed object IDs precisely before generic attribute validation.
      const idData = isRecord(rawAttributes) ? ownData(rawAttributes, context.objectIdField) : { valid: true, value: undefined }
      if (!idData.valid) return { kind: 'rejected', issue: { code: 'invalid-attributes', featureIndex: index, field: context.objectIdField } }
      const candidateId = idData.value
      if (candidateId !== undefined && candidateId !== null && !positiveInteger(candidateId as number)) {
        return { kind: 'rejected', issue: { code: 'invalid-object-id', featureIndex: index, field: context.objectIdField } }
      }
      const attributes = inspectAttributes(
        rawAttributes,
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
      if (isRecord(rawGeometry) && Object.prototype.hasOwnProperty.call(rawGeometry, 'spatialReference')) {
        const geometryReference = ownData(rawGeometry, 'spatialReference')
        const geometryWkid = geometryReference.valid ? parseWkid(geometryReference.value) : null
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
      const geometryInspection = inspectGeometry(
        rawGeometry,
        this.#options.maxGeometryDepth,
        this.#options.maxGeometryCoordinates,
        this.#options.maxGeometryNodesPerFeature,
        this.#options.maxGeometryNodesPerPage,
        pageGeometryBudget,
      )
      if (geometryInspection.issue !== null) {
        return { kind: 'rejected', issue: { code: geometryInspection.issue, featureIndex: index } }
      }
      accepted.push(Object.freeze({
        attributes: attributes.record,
        ...(rawGeometry === undefined ? {} : { geometry: geometryInspection.snapshot }),
      }))
    }

    return Object.freeze({
      kind: 'accepted',
      features: Object.freeze(accepted),
      objectIds: Object.freeze([...seen]),
      exceededTransferLimit: transferData.value === true,
      ...(wkid === undefined ? {} : { spatialReferenceWkid: wkid }),
    })
  }
}
