export interface ArcGisResultIntegrityBudget {
  readonly maxFeatures: number
  readonly maxAttributesPerFeature: number
  readonly maxAttributeNameLength: number
  readonly maxStringValueLength: number
  readonly maxTotalStringCharacters: number
  readonly maxGeometryJsonBytes: number
}

export interface ArcGisResultField {
  readonly name: string
  readonly type: string
  readonly nullable?: boolean
}

export interface ArcGisResultFeature {
  readonly attributes: Readonly<Record<string, unknown>>
  readonly geometry?: unknown
}

export interface ArcGisResultPage {
  readonly fields: readonly ArcGisResultField[]
  readonly features: readonly ArcGisResultFeature[]
  readonly exceededTransferLimit?: boolean
  readonly objectIdFieldName?: string
  readonly globalIdFieldName?: string
}

export type ArcGisResultIntegrityDecision =
  | { readonly accepted: true; readonly page: ArcGisResultPage; readonly fingerprint: string }
  | { readonly accepted: false; readonly reason: string }

const FIELD_TYPES = new Set([
  'esriFieldTypeOID', 'esriFieldTypeGlobalID', 'esriFieldTypeGUID', 'esriFieldTypeString',
  'esriFieldTypeSmallInteger', 'esriFieldTypeInteger', 'esriFieldTypeSingle', 'esriFieldTypeDouble',
  'esriFieldTypeDate', 'esriFieldTypeDateOnly', 'esriFieldTypeTimeOnly', 'esriFieldTypeTimestampOffset',
])

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function cleanName(value: string, max: number, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`invalid ${label}`)
  return normalized
}

function stableHash(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function scalar(value: unknown, field: ArcGisResultField, maxString: number): unknown {
  if (value === null) return null
  if (field.type === 'esriFieldTypeString' || field.type === 'esriFieldTypeGUID' || field.type === 'esriFieldTypeGlobalID') {
    if (typeof value !== 'string' || value.length > maxString || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`invalid value:${field.name}`)
    return value
  }
  if (field.type === 'esriFieldTypeOID' || field.type === 'esriFieldTypeSmallInteger' || field.type === 'esriFieldTypeInteger') {
    if (!Number.isSafeInteger(value)) throw new Error(`invalid integer:${field.name}`)
    return value
  }
  if (field.type === 'esriFieldTypeSingle' || field.type === 'esriFieldTypeDouble') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid number:${field.name}`)
    return value
  }
  if (field.type.startsWith('esriFieldTypeDate') || field.type === 'esriFieldTypeTimeOnly' || field.type === 'esriFieldTypeTimestampOffset') {
    if ((typeof value !== 'number' || !Number.isFinite(value)) && typeof value !== 'string') throw new Error(`invalid temporal value:${field.name}`)
    return value
  }
  throw new Error(`unsupported field type:${field.type}`)
}

export class ArcGisResultIntegrityPolicy {
  private readonly budget: ArcGisResultIntegrityBudget

  constructor(budget: ArcGisResultIntegrityBudget) {
    this.budget = Object.freeze({
      maxFeatures: integer(budget.maxFeatures, 'maxFeatures', 1, 100_000),
      maxAttributesPerFeature: integer(budget.maxAttributesPerFeature, 'maxAttributesPerFeature', 1, 2_000),
      maxAttributeNameLength: integer(budget.maxAttributeNameLength, 'maxAttributeNameLength', 1, 256),
      maxStringValueLength: integer(budget.maxStringValueLength, 'maxStringValueLength', 1, 1_000_000),
      maxTotalStringCharacters: integer(budget.maxTotalStringCharacters, 'maxTotalStringCharacters', 1, 20_000_000),
      maxGeometryJsonBytes: integer(budget.maxGeometryJsonBytes, 'maxGeometryJsonBytes', 1, 64 * 1024 * 1024),
    })
  }

  admit(input: ArcGisResultPage): ArcGisResultIntegrityDecision {
    try {
      if (input.features.length > this.budget.maxFeatures) return Object.freeze({ accepted: false, reason: 'feature-budget-exceeded' })
      const fields: ArcGisResultField[] = []
      const schema = new Map<string, ArcGisResultField>()
      for (const raw of input.fields) {
        const name = cleanName(raw.name, this.budget.maxAttributeNameLength, 'field name')
        if (!FIELD_TYPES.has(raw.type)) return Object.freeze({ accepted: false, reason: `unsupported-field-type:${raw.type}` })
        const key = name.toLocaleLowerCase('en-US')
        if (schema.has(key)) return Object.freeze({ accepted: false, reason: `duplicate-field:${name}` })
        const field = Object.freeze({ ...raw, name })
        schema.set(key, field)
        fields.push(field)
      }
      const objectId = input.objectIdFieldName ? cleanName(input.objectIdFieldName, this.budget.maxAttributeNameLength, 'object id field') : undefined
      const globalId = input.globalIdFieldName ? cleanName(input.globalIdFieldName, this.budget.maxAttributeNameLength, 'global id field') : undefined
      if (objectId && !schema.has(objectId.toLocaleLowerCase('en-US'))) return Object.freeze({ accepted: false, reason: 'object-id-field-not-in-schema' })
      if (globalId && !schema.has(globalId.toLocaleLowerCase('en-US'))) return Object.freeze({ accepted: false, reason: 'global-id-field-not-in-schema' })
      let totalStrings = 0
      const features: ArcGisResultFeature[] = []
      const identities = new Set<string>()
      for (const source of input.features) {
        const entries = Object.entries(source.attributes)
        if (entries.length > this.budget.maxAttributesPerFeature) return Object.freeze({ accepted: false, reason: 'attribute-budget-exceeded' })
        const attributes: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const [rawName, value] of entries) {
          const name = cleanName(rawName, this.budget.maxAttributeNameLength, 'attribute name')
          const field = schema.get(name.toLocaleLowerCase('en-US'))
          if (!field) return Object.freeze({ accepted: false, reason: `attribute-not-in-schema:${name}` })
          if (value === null && field.nullable === false) return Object.freeze({ accepted: false, reason: `null-for-non-nullable:${field.name}` })
          const normalized = scalar(value, field, this.budget.maxStringValueLength)
          if (typeof normalized === 'string') {
            totalStrings += normalized.length
            if (totalStrings > this.budget.maxTotalStringCharacters) return Object.freeze({ accepted: false, reason: 'string-character-budget-exceeded' })
          }
          attributes[field.name] = normalized
        }
        if (objectId && attributes[objectId] !== undefined) {
          const identity = `o:${String(attributes[objectId])}`
          if (identities.has(identity)) return Object.freeze({ accepted: false, reason: `duplicate-object-identity:${identity}` })
          identities.add(identity)
        } else if (globalId && attributes[globalId] !== undefined) {
          const identity = `g:${String(attributes[globalId]).toLocaleLowerCase('en-US')}`
          if (identities.has(identity)) return Object.freeze({ accepted: false, reason: `duplicate-global-identity:${identity}` })
          identities.add(identity)
        }
        let geometry = source.geometry
        if (geometry !== undefined) {
          const encoded = JSON.stringify(geometry)
          if (encoded === undefined || encoded.length > this.budget.maxGeometryJsonBytes) return Object.freeze({ accepted: false, reason: 'geometry-json-budget-exceeded' })
          geometry = JSON.parse(encoded) as unknown
        }
        features.push(Object.freeze({ attributes: Object.freeze(attributes), geometry }))
      }
      const page = Object.freeze({
        fields: Object.freeze(fields),
        features: Object.freeze(features),
        exceededTransferLimit: input.exceededTransferLimit === true,
        objectIdFieldName: objectId,
        globalIdFieldName: globalId,
      })
      const fingerprintSource = JSON.stringify({ fields: fields.map(({ name, type, nullable }) => [name, type, nullable]), features: features.map(feature => feature.attributes), exceededTransferLimit: page.exceededTransferLimit })
      return Object.freeze({ accepted: true, page, fingerprint: stableHash(fingerprintSource) })
    } catch (error) {
      return Object.freeze({ accepted: false, reason: error instanceof Error ? error.message : 'invalid-result-page' })
    }
  }
}
