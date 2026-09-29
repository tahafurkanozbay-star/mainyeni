export interface ArcGisPagedFeature<TAttributes extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly attributes: TAttributes
  readonly geometry?: unknown
}

export interface ArcGisQueryResultPage<TFeature extends ArcGisPagedFeature = ArcGisPagedFeature> {
  readonly pageIndex: number
  readonly features: readonly TFeature[]
  readonly exceededTransferLimit?: boolean
  readonly datasetRevision?: string
  readonly estimatedBytes: number
}

export interface ArcGisQueryPageAssemblerBudget {
  readonly maxPages: number
  readonly maxFeatures: number
  readonly maxEstimatedBytes: number
  readonly maxRevisionLength: number
}

export interface ArcGisQueryPageAssemblerFacts {
  readonly objectIdField: string
  readonly requireDatasetRevision: boolean
  readonly expectedDatasetRevision?: string
}

export interface ArcGisAssembledQueryResult<TFeature extends ArcGisPagedFeature = ArcGisPagedFeature> {
  readonly features: readonly TFeature[]
  readonly pageCount: number
  readonly estimatedBytes: number
  readonly datasetRevision?: string
  readonly objectIds: readonly number[]
  readonly complete: boolean
}

export type ArcGisQueryPageAssembly<TFeature extends ArcGisPagedFeature = ArcGisPagedFeature> =
  | { readonly accepted: true; readonly result: ArcGisAssembledQueryResult<TFeature> }
  | { readonly accepted: false; readonly reason: string }

const MAX_PAGES = 10_000
const MAX_FEATURES = 100_000
const MAX_BYTES = 512 * 1024 * 1024
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function revision(value: string | undefined, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`invalid-${name}`)
  }
  return normalized
}

function objectIdOf(feature: ArcGisPagedFeature, field: string): number {
  const value = feature.attributes[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid-object-id:${field}`)
  }
  return value
}

/**
 * Deterministically assembles independently fetched ArcGIS query pages.
 *
 * This authority is intentionally transport- and SDK-object-independent. It is
 * responsible for the integrity boundary between concurrent page execution and
 * consumption by render/state layers: page identity must be contiguous,
 * OBJECTIDs must be unique, dataset revisions cannot drift mid-query, and total
 * retained feature/byte cardinality is bounded before an immutable result is
 * exposed.
 */
export class ArcGisQueryPageAssembler<TFeature extends ArcGisPagedFeature = ArcGisPagedFeature> {
  private readonly budget: Readonly<ArcGisQueryPageAssemblerBudget>
  private readonly facts: Readonly<ArcGisQueryPageAssemblerFacts>

  constructor(facts: ArcGisQueryPageAssemblerFacts, budget: ArcGisQueryPageAssemblerBudget) {
    const objectIdField = facts.objectIdField.trim()
    if (!FIELD.test(objectIdField)) throw new Error('invalid-object-id-field')
    const maxRevisionLength = integer(budget.maxRevisionLength, 'maxRevisionLength', 1, 1024)
    const expectedDatasetRevision = revision(facts.expectedDatasetRevision, 'expected-dataset-revision', maxRevisionLength)
    if (facts.requireDatasetRevision && expectedDatasetRevision === undefined && facts.expectedDatasetRevision !== undefined) {
      throw new Error('invalid-expected-dataset-revision')
    }
    this.facts = Object.freeze({ ...facts, objectIdField, expectedDatasetRevision })
    this.budget = Object.freeze({
      maxPages: integer(budget.maxPages, 'maxPages', 1, MAX_PAGES),
      maxFeatures: integer(budget.maxFeatures, 'maxFeatures', 1, MAX_FEATURES),
      maxEstimatedBytes: integer(budget.maxEstimatedBytes, 'maxEstimatedBytes', 1, MAX_BYTES),
      maxRevisionLength,
    })
  }

  assemble(pages: readonly ArcGisQueryResultPage<TFeature>[]): ArcGisQueryPageAssembly<TFeature> {
    try {
      return Object.freeze({ accepted: true, result: this.assembleStrict(pages) })
    } catch (error) {
      return Object.freeze({ accepted: false, reason: error instanceof Error ? error.message : 'invalid-query-pages' })
    }
  }

  private assembleStrict(pages: readonly ArcGisQueryResultPage<TFeature>[]): ArcGisAssembledQueryResult<TFeature> {
    if (pages.length === 0) throw new Error('query-pages-empty')
    if (pages.length > this.budget.maxPages) throw new Error('page-budget-exceeded')

    const ordered = [...pages].sort((a, b) => a.pageIndex - b.pageIndex)
    const seenPages = new Set<number>()
    const seenObjectIds = new Set<number>()
    const features: TFeature[] = []
    const objectIds: number[] = []
    let totalBytes = 0
    let canonicalRevision = this.facts.expectedDatasetRevision
    let complete = true

    for (let position = 0; position < ordered.length; position++) {
      const page = ordered[position]
      const pageIndex = integer(page.pageIndex, 'pageIndex', 0, this.budget.maxPages - 1)
      if (seenPages.has(pageIndex)) throw new Error(`duplicate-page-index:${pageIndex}`)
      seenPages.add(pageIndex)
      if (pageIndex !== position) throw new Error(`non-contiguous-page-index:${pageIndex}`)

      const pageBytes = integer(page.estimatedBytes, 'estimatedBytes', 0, this.budget.maxEstimatedBytes)
      totalBytes += pageBytes
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.budget.maxEstimatedBytes) {
        throw new Error('assembled-response-byte-budget-exceeded')
      }
      if (features.length + page.features.length > this.budget.maxFeatures) {
        throw new Error('assembled-feature-budget-exceeded')
      }

      const pageRevision = revision(page.datasetRevision, 'dataset-revision', this.budget.maxRevisionLength)
      if (this.facts.requireDatasetRevision && pageRevision === undefined) {
        throw new Error(`dataset-revision-required:${pageIndex}`)
      }
      if (canonicalRevision === undefined) canonicalRevision = pageRevision
      if (canonicalRevision !== undefined && pageRevision !== canonicalRevision) {
        throw new Error(`dataset-revision-drift:${pageIndex}`)
      }

      for (const feature of page.features) {
        if (feature === null || typeof feature !== 'object' || feature.attributes === null || typeof feature.attributes !== 'object') {
          throw new Error(`invalid-feature:${pageIndex}`)
        }
        const objectId = objectIdOf(feature, this.facts.objectIdField)
        if (seenObjectIds.has(objectId)) throw new Error(`duplicate-object-id:${objectId}`)
        seenObjectIds.add(objectId)
        objectIds.push(objectId)
        features.push(feature)
      }

      if (page.exceededTransferLimit === true) complete = false
    }

    const frozenFeatures = Object.freeze([...features])
    const frozenObjectIds = Object.freeze([...objectIds])
    return Object.freeze({
      features: frozenFeatures,
      pageCount: ordered.length,
      estimatedBytes: totalBytes,
      datasetRevision: canonicalRevision,
      objectIds: frozenObjectIds,
      complete,
    })
  }
}
