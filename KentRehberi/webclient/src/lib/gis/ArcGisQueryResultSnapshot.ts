import type {
  ArcGisQueryExecutionFailureCode,
  ArcGisQueryExecutionResult,
} from './ArcGisQueryExecutionCoordinator'
import type { ArcGisQueryIntegrityIssueCode } from './ArcGisQueryResponseIntegrity'

/** Bounded, immutable trust boundary between an injectable executor and subscribers. */
export interface ArcGisQueryResultSnapshotLimits {
  readonly maxFeaturesPerEntry: number
  readonly maxBytesPerEntry: number
  readonly maxNodesPerEntry: number
}

export interface ArcGisQueryResultSnapshot {
  readonly result: ArcGisQueryExecutionResult
  readonly bytes: number
  readonly features: number
}

const FAILURE_CODES: ReadonlySet<string> = new Set<ArcGisQueryExecutionFailureCode>([
  'invalid-plan', 'aborted', 'timeout', 'transport-error', 'transport-capacity',
  'integrity-error', 'feature-budget', 'incomplete-transfer',
])
const ISSUE_CODES: ReadonlySet<string> = new Set<ArcGisQueryIntegrityIssueCode>([
  'invalid-response', 'invalid-features', 'feature-budget', 'invalid-feature',
  'invalid-attributes', 'attribute-budget', 'attribute-page-budget',
  'attribute-text-page-budget', 'attribute-text-budget', 'missing-object-id',
  'invalid-object-id', 'duplicate-object-id', 'unexpected-object-id',
  'invalid-geometry', 'geometry-depth-budget', 'geometry-coordinate-budget',
  'geometry-node-budget', 'geometry-page-node-budget', 'invalid-coordinate',
  'invalid-transfer-limit', 'invalid-spatial-reference', 'spatial-reference-mismatch',
])

interface Budget {
  nodes: number
  bytes: number
  readonly maxNodes: number
  readonly maxBytes: number
  seen: WeakSet<object>
}

function own(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function spend(budget: Budget, bytes: number): void {
  budget.nodes += 1
  budget.bytes += bytes
  if (budget.nodes > budget.maxNodes || !Number.isSafeInteger(budget.bytes) ||
      budget.bytes > budget.maxBytes) throw new Error('ArcGIS result retention budget exceeded')
}

/**
 * Snapshot JSON-like ArcGIS REST feature data. Descriptor-only traversal never
 * executes getters. Each nested object is deeply frozen; shared/cyclic graphs,
 * class instances, sparse arrays and oversized payloads fail closed.
 */
function cloneJson(value: unknown, depth: number, budget: Budget): unknown {
  if (depth > 12) throw new Error('ArcGIS result nesting budget exceeded')
  if (value === null || value === undefined || typeof value === 'boolean') {
    spend(budget, 4)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('ArcGIS result non-finite number')
    spend(budget, 8)
    return value
  }
  if (typeof value === 'string') {
    spend(budget, value.length * 2 + 8)
    return value
  }
  if (typeof value !== 'object' || budget.seen.has(value)) {
    throw new Error('ArcGIS result unsupported or aliased value')
  }
  budget.seen.add(value)
  if (Array.isArray(value)) {
    spend(budget, 16)
    if (value.length > budget.maxNodes - budget.nodes) throw new Error('ArcGIS result array budget exceeded')
    const copy: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error('ArcGIS result sparse or accessor array')
      }
      copy.push(cloneJson(descriptor.value, depth + 1, budget))
    }
    return Object.freeze(copy)
  }
  if (!plainRecord(value)) throw new Error('ArcGIS result non-JSON object')
  spend(budget, 24)
  const copy: Record<string, unknown> = {}
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (key.length > 256) throw new Error('ArcGIS result field length exceeded')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) throw new Error('ArcGIS result accessor')
    spend(budget, key.length * 2 + 8)
    Object.defineProperty(copy, key, {
      value: cloneJson(descriptor.value, depth + 1, budget),
      enumerable: true, writable: false, configurable: false,
    })
  }
  return Object.freeze(copy)
}

function captureFailure(raw: object): ArcGisQueryExecutionResult | null {
  const code = own(raw, 'code')
  if (typeof code !== 'string' || !FAILURE_CODES.has(code)) return null
  const page = own(raw, 'page')
  if (page !== undefined && (!Number.isSafeInteger(page) || (page as number) < 0)) return null
  const integrity = own(raw, 'integrity')
  if (integrity === undefined) {
    return Object.freeze({
      kind: 'failed' as const, code: code as ArcGisQueryExecutionFailureCode,
      ...(page === undefined ? {} : { page: page as number }),
    })
  }
  if (!plainRecord(integrity) || own(integrity, 'kind') !== 'rejected') return null
  const issue = own(integrity, 'issue')
  if (!plainRecord(issue)) return null
  const issueCode = own(issue, 'code')
  const featureIndex = own(issue, 'featureIndex')
  const field = own(issue, 'field')
  if (typeof issueCode !== 'string' || !ISSUE_CODES.has(issueCode) ||
      (featureIndex !== undefined && (!Number.isSafeInteger(featureIndex) || (featureIndex as number) < 0)) ||
      (field !== undefined && (typeof field !== 'string' || field.length === 0 || field.length > 256))) return null
  return Object.freeze({
    kind: 'failed' as const, code: code as ArcGisQueryExecutionFailureCode,
    ...(page === undefined ? {} : { page: page as number }),
    integrity: Object.freeze({
      kind: 'rejected' as const,
      issue: Object.freeze({
        code: issueCode as ArcGisQueryIntegrityIssueCode,
        ...(featureIndex === undefined ? {} : { featureIndex: featureIndex as number }),
        ...(field === undefined ? {} : { field: field as string }),
      }),
    }),
  })
}

/** Null means a malformed executor response: never forward the original. */
function snapshotUnchecked(
  raw: unknown,
  requestedKey: string,
  limits: ArcGisQueryResultSnapshotLimits,
): ArcGisQueryResultSnapshot | null {
  if (!plainRecord(raw)) return null
  const kind = own(raw, 'kind')
  if (kind === 'failed') {
    const result = captureFailure(raw)
    return result === null ? null : Object.freeze({ result, bytes: 0, features: 0 })
  }
  if (kind !== 'completed' || own(raw, 'key') !== requestedKey) return null
  const features = own(raw, 'features')
  const ids = own(raw, 'objectIds')
  const pagesCompleted = own(raw, 'pagesCompleted')
  if (!Array.isArray(features) || !Array.isArray(ids) ||
      features.length !== ids.length || features.length > limits.maxFeaturesPerEntry ||
      !Number.isSafeInteger(pagesCompleted) || (pagesCompleted as number) < 0) return null

  const budget: Budget = {
    nodes: 0, bytes: requestedKey.length * 2 + 64,
    maxNodes: limits.maxNodesPerEntry, maxBytes: limits.maxBytesPerEntry,
    seen: new WeakSet<object>(),
  }
  const copies: unknown[] = []
  const objectIds: number[] = []
  const seenIds = new Set<number>()
  for (let index = 0; index < ids.length; index += 1) {
    const idDescriptor = Object.getOwnPropertyDescriptor(ids, String(index))
    const featureDescriptor = Object.getOwnPropertyDescriptor(features, String(index))
    if (idDescriptor === undefined || !('value' in idDescriptor) ||
        featureDescriptor === undefined || !('value' in featureDescriptor)) return null
    const id: unknown = idDescriptor.value
    const feature: unknown = featureDescriptor.value
    if (!Number.isSafeInteger(id) || (id as number) <= 0 ||
        seenIds.has(id as number) || !plainRecord(feature) ||
        !plainRecord(own(feature, 'attributes'))) return null
    seenIds.add(id as number)
    objectIds.push(id as number)
    // Cross-feature shared source geometry is safe because copies are independent.
    budget.seen = new WeakSet<object>()
    copies.push(cloneJson(feature, 0, budget))
  }
  const result = Object.freeze({
    kind: 'completed' as const, key: requestedKey,
    pagesCompleted: pagesCompleted as number,
    objectIds: Object.freeze(objectIds), features: Object.freeze(copies),
  })
  return Object.freeze({ result, bytes: budget.bytes, features: copies.length })
}

/** Malformed executor payloads and throwing Proxy traps both fail closed. */
export function snapshotArcGisQueryResult(
  raw: unknown,
  requestedKey: string,
  limits: ArcGisQueryResultSnapshotLimits,
): ArcGisQueryResultSnapshot | null {
  try {
    return snapshotUnchecked(raw, requestedKey, limits)
  } catch {
    return null
  }
}
