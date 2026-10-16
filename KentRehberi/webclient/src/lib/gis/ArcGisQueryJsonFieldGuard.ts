/**
 * Shared descriptor-only admission for ArcGIS REST JSON object and array trees.
 *
 * for...in/Object.keys silently omit non-enumerable own data and accessors,
 * which can produce a truncated feature or omit its identity. Reflect.ownKeys
 * lets the caller reject that malformed payload before retaining any page.
 * No property value is read through an accessor or inherited prototype.
 */
export interface ArcGisJsonField {
  readonly key: string
  readonly value: unknown
}

function budget(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ArcGIS JSON ${label} budget exceeded`)
  }
}

export function captureArcGisJsonFields(
  value: object,
  maxFields: number,
  maxKeyLength = 256,
): readonly ArcGisJsonField[] {
  budget(maxFields, 'field')
  budget(maxKeyLength, 'key')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error('ArcGIS JSON non-plain object is invalid')
  }
  if (Array.isArray(value)) throw new Error('ArcGIS JSON object expected')
  const keys = Reflect.ownKeys(value)
  if (keys.length > maxFields) throw new Error('ArcGIS JSON field budget exceeded')
  const fields: ArcGisJsonField[] = []
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > maxKeyLength) {
      throw new Error('ArcGIS JSON field key is invalid')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('ArcGIS JSON accessor or hidden field is invalid')
    }
    fields.push({ key, value: descriptor.value })
  }
  return fields
}

export function captureArcGisJsonArray(
  value: readonly unknown[],
  maxItems: number,
): readonly unknown[] {
  budget(maxItems, 'array')
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 || lengthDescriptor.value > maxItems) {
    throw new Error('ArcGIS JSON array node budget exceeded')
  }
  const length = lengthDescriptor.value as number
  // A dense JSON array owns exactly its indices and the built-in length.
  // Reject symbol/extra/accessor fields instead of silently dropping them.
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1) {
    throw new Error('ArcGIS JSON sparse or extra array fields are invalid')
  }
  const values: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error('ArcGIS JSON sparse or accessor array is invalid')
    }
    values.push(descriptor.value)
  }
  return values
}
