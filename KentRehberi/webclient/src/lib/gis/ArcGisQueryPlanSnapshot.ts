import type { ArcGisQueryPage, ArcGisQueryPlan } from './ArcGisQueryPagePlanner'
import { hasAsciiControl } from './ArcGisScalarValidation'

/**
 * Immutable admission boundary for caller-supplied ArcGIS query plans.
 * A readonly TypeScript annotation cannot protect against getters, sparse
 * arrays, mutated SDK objects or oversized runtime input.
 */
export type CapturedArcGisQueryPlan = Extract<ArcGisQueryPlan, { kind: 'planned' }>

const MAX_PAGES = 4_096
const MAX_PAGE_SIZE = 100_000
const MAX_OBJECT_IDS = 100_000
const MAX_ORDER_FIELDS = 8
const ORDER_FIELD = /^[A-Za-z_][A-Za-z0-9_.]* (asc|desc)$/iu

function own(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** No array index is accessed through a getter or an inherited property. */
function ownArrayValues(value: unknown, maxLength: number): unknown[] | null {
  if (!Array.isArray(value)) return null
  const length = own(value, 'length')
  if (!nonNegativeInteger(length) || length > maxLength) return null
  const copied: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor)) return null
    copied.push(descriptor.value)
  }
  return copied
}

/**
 * Return null without allocating workers or executing user-controlled accessors.
 * The original plan is never retained, including page/order/ID arrays.
 */
function captureUnchecked(input: unknown): CapturedArcGisQueryPlan | null {
  if (!record(input) || own(input, 'kind') !== 'planned') return null
  const key = own(input, 'key')
  const pageSize = own(input, 'pageSize')
  if (typeof key !== 'string' || key.trim().length === 0 ||
      key.length > 8_192 || hasAsciiControl(key) ||
      !positiveInteger(pageSize) || pageSize > MAX_PAGE_SIZE) return null

  const rawPages = ownArrayValues(own(input, 'pages'), MAX_PAGES)
  if (rawPages === null || rawPages.length === 0) return null
  const pages: ArcGisQueryPage[] = []
  const seenPages = new Set<number>()
  const seenIds = new Set<number>()
  let totalIds = 0
  let firstKind: 'objectIds' | 'offset' | undefined
  let firstOrder: string | undefined

  for (const rawPage of rawPages) {
    if (!record(rawPage)) return null
    const kind = own(rawPage, 'kind')
    const page = own(rawPage, 'page')
    if ((kind !== 'objectIds' && kind !== 'offset') ||
        !nonNegativeInteger(page) || page >= rawPages.length ||
        seenPages.has(page) || (firstKind !== undefined && kind !== firstKind)) return null
    firstKind = kind
    seenPages.add(page)

    if (kind === 'objectIds') {
      const rawIds = ownArrayValues(own(rawPage, 'objectIds'), pageSize)
      if (rawIds === null || rawIds.length === 0 ||
          totalIds + rawIds.length > MAX_OBJECT_IDS) return null
      const ids: number[] = []
      for (const rawId of rawIds) {
        if (!positiveInteger(rawId) || seenIds.has(rawId)) return null
        seenIds.add(rawId)
        ids.push(rawId)
      }
      totalIds += ids.length
      pages.push(Object.freeze({
        kind: 'objectIds', page, objectIds: Object.freeze(ids),
      }))
      continue
    }

    const offset = own(rawPage, 'resultOffset')
    const count = own(rawPage, 'resultRecordCount')
    if (!nonNegativeInteger(offset) || !positiveInteger(count) ||
        count > pageSize || offset !== page * pageSize) return null
    const rawOrder = ownArrayValues(own(rawPage, 'orderByFields'), MAX_ORDER_FIELDS)
    if (rawOrder === null || (rawPages.length > 1 && rawOrder.length === 0)) return null
    const order: string[] = []
    for (const field of rawOrder) {
      if (typeof field !== 'string' || field.length > 256 || !ORDER_FIELD.test(field)) return null
      order.push(field)
    }
    const orderIdentity = JSON.stringify(order)
    if (firstOrder !== undefined && firstOrder !== orderIdentity) return null
    firstOrder = orderIdentity
    pages.push(Object.freeze({
      kind: 'offset', page, resultOffset: offset, resultRecordCount: count,
      orderByFields: Object.freeze(order),
    }))
  }

  return Object.freeze({
    kind: 'planned', key, pageSize, pages: Object.freeze(pages),
  })
}

/** Adversarial Proxy traps are treated as invalid plans, not thrown to callers. */
export function captureArcGisQueryPlan(input: unknown): CapturedArcGisQueryPlan | null {
  try {
    return captureUnchecked(input)
  } catch {
    return null
  }
}
