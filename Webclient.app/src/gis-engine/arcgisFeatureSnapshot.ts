/**
 * Bounded immutable snapshots for ArcGIS REST feature pages.
 *
 * Transport responses are untrusted JSON-shaped values. A readonly TypeScript
 * annotation does not prevent a transport adapter from retaining mutable aliases,
 * returning accessors, or producing pathological object graphs in tests and
 * plugin adapters. This boundary copies only plain data properties, rejects
 * cycles/aliases and commits page accounting atomically.
 */

export interface ArcGisFeatureSnapshotBudget {
  readonly maxFeatures?: number;
  readonly maxPages?: number;
  readonly maxNodesPerFeature?: number;
  readonly maxNodesPerQuery?: number;
  readonly maxBytesPerFeature?: number;
  readonly maxBytesPerQuery?: number;
  readonly maxStringLength?: number;
  readonly maxKeyLength?: number;
  readonly maxDepth?: number;
}

export interface ArcGisFeatureSnapshotPage<TFeature extends object = Record<string, unknown>> {
  readonly features: readonly TFeature[];
  readonly featureCount: number;
  readonly estimatedBytes: number;
  readonly nodes: number;
  readonly truncated: boolean;
}

export interface ArcGisFeatureSnapshotDiagnostics {
  readonly pages: number;
  readonly features: number;
  readonly nodes: number;
  readonly estimatedBytes: number;
}

export interface NormalizedArcGisFeatureSnapshotBudget {
  readonly maxFeatures: number;
  readonly maxPages: number;
  readonly maxNodesPerFeature: number;
  readonly maxNodesPerQuery: number;
  readonly maxBytesPerFeature: number;
  readonly maxBytesPerQuery: number;
  readonly maxStringLength: number;
  readonly maxKeyLength: number;
  readonly maxDepth: number;
}

interface TraversalState {
  readonly budget: NormalizedArcGisFeatureSnapshotBudget;
  readonly committedObjects: WeakSet<object>;
  readonly pendingObjects: WeakSet<object>;
  readonly pendingObjectList: object[];
  featureNodes: number;
  featureBytes: number;
  pageNodes: number;
  pageBytes: number;
  readonly baseNodes: number;
  readonly baseBytes: number;
}

export class ArcGisFeatureSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArcGisFeatureSnapshotError';
    this.code = code;
  }
}

const DEFAULT_BUDGET: NormalizedArcGisFeatureSnapshotBudget = Object.freeze({
  maxFeatures: 100_000,
  maxPages: 10_000,
  maxNodesPerFeature: 200_000,
  maxNodesPerQuery: 2_000_000,
  maxBytesPerFeature: 2 * 1024 * 1024,
  maxBytesPerQuery: 128 * 1024 * 1024,
  maxStringLength: 65_536,
  maxKeyLength: 256,
  maxDepth: 32,
});

function positiveInteger(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError('ArcGIS feature snapshot ' + name + ' is outside its safe range');
  }
  return value;
}

export function normalizeArcGisFeatureSnapshotBudget(
  input: Partial<ArcGisFeatureSnapshotBudget> = {},
): NormalizedArcGisFeatureSnapshotBudget {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const allowed = new Set(Object.keys(DEFAULT_BUDGET));
  try {
    if (!plainRecord(input)) throw new Error('invalid-shape');
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !allowed.has(key)) throw new Error('invalid-key');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('invalid-property');
      }
      values[key] = descriptor.value;
    }
  } catch {
    throw new TypeError('ArcGIS feature snapshot budget must contain only known plain data properties.');
  }
  const budget = Object.freeze({
    maxFeatures: positiveInteger(values.maxFeatures, DEFAULT_BUDGET.maxFeatures, 5_000_000, 'maxFeatures'),
    maxPages: positiveInteger(values.maxPages, DEFAULT_BUDGET.maxPages, 100_000, 'maxPages'),
    maxNodesPerFeature: positiveInteger(values.maxNodesPerFeature, DEFAULT_BUDGET.maxNodesPerFeature, 2_000_000, 'maxNodesPerFeature'),
    maxNodesPerQuery: positiveInteger(values.maxNodesPerQuery, DEFAULT_BUDGET.maxNodesPerQuery, 20_000_000, 'maxNodesPerQuery'),
    maxBytesPerFeature: positiveInteger(values.maxBytesPerFeature, DEFAULT_BUDGET.maxBytesPerFeature, 128 * 1024 * 1024, 'maxBytesPerFeature'),
    maxBytesPerQuery: positiveInteger(values.maxBytesPerQuery, DEFAULT_BUDGET.maxBytesPerQuery, 1024 * 1024 * 1024, 'maxBytesPerQuery'),
    maxStringLength: positiveInteger(values.maxStringLength, DEFAULT_BUDGET.maxStringLength, 4_000_000, 'maxStringLength'),
    maxKeyLength: positiveInteger(values.maxKeyLength, DEFAULT_BUDGET.maxKeyLength, 4096, 'maxKeyLength'),
    maxDepth: positiveInteger(values.maxDepth, DEFAULT_BUDGET.maxDepth, 64, 'maxDepth'),
  });
  if (budget.maxNodesPerFeature > budget.maxNodesPerQuery) {
    throw new RangeError('ArcGIS per-feature node budget exceeds query node budget');
  }
  if (budget.maxBytesPerFeature > budget.maxBytesPerQuery) {
    throw new RangeError('ArcGIS per-feature byte budget exceeds query byte budget');
  }
  return budget;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasAsciiControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reads an own data property without evaluating getters or inherited values.
 * Proxy traps are caught by callers at the response boundary.
 */
export function readArcGisOwnDataProperty(
  input: unknown,
  key: string,
): { readonly found: boolean; readonly value: unknown } {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new ArcGisFeatureSnapshotError('INVALID_FIELD', 'ArcGIS response field name is invalid.');
  }
  try {
    if (!plainRecord(input)) {
      throw new ArcGisFeatureSnapshotError('INVALID_OBJECT', 'ArcGIS response must be a plain data object.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) return Object.freeze({ found: false, value: undefined });
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new ArcGisFeatureSnapshotError('ACCESSOR_PROPERTY', 'ArcGIS response contains a non-data property.');
    }
    return Object.freeze({ found: true, value: descriptor.value });
  } catch (error) {
    if (error instanceof ArcGisFeatureSnapshotError) throw error;
    throw new ArcGisFeatureSnapshotError('UNSAFE_OBJECT', 'ArcGIS response contains unsafe object behavior.');
  }
}

function consume(state: TraversalState, bytes: number): void {
  state.featureNodes += 1;
  state.pageNodes += 1;
  state.featureBytes += bytes;
  state.pageBytes += bytes;
  const budget = state.budget;
  if (state.featureNodes > budget.maxNodesPerFeature) {
    throw new ArcGisFeatureSnapshotError('FEATURE_NODE_BUDGET', 'ArcGIS feature exceeds the node budget.');
  }
  if (state.pageNodes > budget.maxNodesPerQuery - state.baseNodes) {
    throw new ArcGisFeatureSnapshotError('QUERY_NODE_BUDGET', 'ArcGIS query exceeds the node budget.');
  }
  if (state.featureBytes > budget.maxBytesPerFeature) {
    throw new ArcGisFeatureSnapshotError('FEATURE_BYTE_BUDGET', 'ArcGIS feature exceeds the byte budget.');
  }
  if (state.pageBytes > budget.maxBytesPerQuery - state.baseBytes) {
    throw new ArcGisFeatureSnapshotError('QUERY_BYTE_BUDGET', 'ArcGIS query exceeds the byte budget.');
  }
}

function snapshotValue(value: unknown, depth: number, state: TraversalState): unknown {
  if (depth > state.budget.maxDepth) {
    throw new ArcGisFeatureSnapshotError('DEPTH_BUDGET', 'ArcGIS feature nesting exceeds the depth budget.');
  }
  if (value === null || value === undefined) {
    consume(state, 4);
    return value;
  }
  if (typeof value === 'boolean') {
    consume(state, 4);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ArcGisFeatureSnapshotError('NON_FINITE_NUMBER', 'ArcGIS feature contains a non-finite number.');
    }
    consume(state, 8);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > state.budget.maxStringLength) {
      throw new ArcGisFeatureSnapshotError('STRING_BUDGET', 'ArcGIS feature string exceeds the configured limit.');
    }
    consume(state, value.length * 2 + 8);
    return value;
  }
  if (typeof value !== 'object') {
    throw new ArcGisFeatureSnapshotError('UNSUPPORTED_VALUE', 'ArcGIS feature contains an unsupported value type.');
  }
  if (state.committedObjects.has(value) || state.pendingObjects.has(value)) {
    throw new ArcGisFeatureSnapshotError('CYCLIC_OR_ALIASED_VALUE', 'ArcGIS feature contains a cyclic or aliased object graph.');
  }
  state.pendingObjects.add(value);
  state.pendingObjectList.push(value);

  if (Array.isArray(value)) {
    consume(state, 8);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 ||
        length > state.budget.maxNodesPerFeature - state.featureNodes) {
      throw new ArcGisFeatureSnapshotError('ARRAY_BUDGET', 'ArcGIS feature array exceeds the configured limit.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys.some((key) => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) {
      throw new ArcGisFeatureSnapshotError('SPARSE_OR_EXTENDED_ARRAY', 'ArcGIS feature contains a sparse or extended array.');
    }
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new ArcGisFeatureSnapshotError('ARRAY_ACCESSOR', 'ArcGIS feature contains an accessor-backed array entry.');
      }
      copy.push(snapshotValue(descriptor.value, depth + 1, state));
    }
    return Object.freeze(copy);
  }

  if (!plainRecord(value)) {
    throw new ArcGisFeatureSnapshotError('NON_PLAIN_OBJECT', 'ArcGIS feature contains a non-plain object.');
  }
  consume(state, 16);
  const keys = Reflect.ownKeys(value);
  if (keys.length > state.budget.maxNodesPerFeature - state.featureNodes) {
    throw new ArcGisFeatureSnapshotError('OBJECT_BUDGET', 'ArcGIS feature object exceeds the configured limit.');
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > state.budget.maxKeyLength ||
        /[\u0000-\u001f\u007f]/u.test(key)) {
      throw new ArcGisFeatureSnapshotError('INVALID_OBJECT_KEY', 'ArcGIS feature contains an invalid property key.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new ArcGisFeatureSnapshotError('ACCESSOR_PROPERTY', 'ArcGIS feature contains a non-data property.');
    }
    consume(state, key.length * 2 + 4);
    const captured = snapshotValue(descriptor.value, depth + 1, state);
    Object.defineProperty(copy, key, {
      value: captured,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(copy);
}

export class ArcGisFeatureSnapshotSession {
  private readonly budget: NormalizedBudget;
  private readonly seenObjects = new WeakSet<object>();
  private pages = 0;
  private features = 0;
  private nodes = 0;
  private estimatedBytes = 0;

  constructor(budget: Partial<ArcGisFeatureSnapshotBudget> = {}) {
    this.budget = normalizeArcGisFeatureSnapshotBudget(budget);
  }

  capturePage<TFeature extends object>(
    input: unknown,
    maxPageFeatures = this.budget.maxFeatures,
    truncateExcess = false,
  ): ArcGisFeatureSnapshotPage<TFeature> {
    try {
      if (this.pages >= this.budget.maxPages) {
        throw new ArcGisFeatureSnapshotError('PAGE_BUDGET', 'ArcGIS query exceeds the page budget.');
      }
      if (!Number.isSafeInteger(maxPageFeatures) || maxPageFeatures < 1) {
        throw new ArcGisFeatureSnapshotError('INVALID_PAGE_LIMIT', 'ArcGIS page feature limit is invalid.');
      }
      if (!Array.isArray(input)) {
        throw new ArcGisFeatureSnapshotError('INVALID_FEATURES', 'ArcGIS response features must be an array.');
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
      const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
        throw new ArcGisFeatureSnapshotError('INVALID_FEATURES', 'ArcGIS response feature count is invalid.');
      }
      const remaining = this.budget.maxFeatures - this.features;
      const limit = Math.min(maxPageFeatures, remaining);
      if (length > limit && !truncateExcess) {
        throw new ArcGisFeatureSnapshotError('FEATURE_BUDGET', 'ArcGIS response exceeds the page feature limit.');
      }
      const count = Math.min(length, limit);
      // Avoid materializing every array key for an oversized server response when
      // the caller explicitly accepts a bounded prefix. Only retained indexes are inspected.
      if (length <= limit) {
        const inputKeys = Reflect.ownKeys(input);
        if (inputKeys.length !== length + 1 || inputKeys.some((key) => key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length))) {
          throw new ArcGisFeatureSnapshotError('SPARSE_OR_EXTENDED_ARRAY', 'ArcGIS response contains a sparse or extended feature array.');
        }
      }
      const state: TraversalState = {
        budget: this.budget,
        committedObjects: this.seenObjects,
        pendingObjects: new WeakSet<object>(),
        pendingObjectList: [],
        featureNodes: 0,
        featureBytes: 0,
        pageNodes: 0,
        pageBytes: 0,
        baseNodes: this.nodes,
        baseBytes: this.estimatedBytes,
      };
      const copies: TFeature[] = [];
      for (let index = 0; index < count; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new ArcGisFeatureSnapshotError('ARRAY_ACCESSOR', 'ArcGIS response contains a sparse or accessor-backed feature array.');
        }
        state.featureNodes = 0;
        state.featureBytes = 0;
        const captured = snapshotValue(descriptor.value, 0, state);
        if (!plainRecord(captured)) {
          throw new ArcGisFeatureSnapshotError('INVALID_FEATURE', 'ArcGIS response contains a non-object feature.');
        }
        const attributes = Object.getOwnPropertyDescriptor(captured, 'attributes');
        if (attributes && (!('value' in attributes) || !plainRecord(attributes.value))) {
          throw new ArcGisFeatureSnapshotError('INVALID_ATTRIBUTES', 'ArcGIS feature attributes must be a plain object.');
        }
        copies.push(captured as TFeature);
      }
      for (const object of state.pendingObjectList) this.seenObjects.add(object);
      this.pages += 1;
      this.features += count;
      this.nodes += state.pageNodes;
      this.estimatedBytes += state.pageBytes;
      return Object.freeze({
        features: Object.freeze(copies),
        featureCount: count,
        estimatedBytes: state.pageBytes,
        nodes: state.pageNodes,
        truncated: length > count,
      });
    } catch (error) {
      if (error instanceof ArcGisFeatureSnapshotError) throw error;
      throw new ArcGisFeatureSnapshotError('UNSAFE_OBJECT', 'ArcGIS response contains unsafe object behavior.');
    }
  }

  snapshot(): ArcGisFeatureSnapshotDiagnostics {
    return Object.freeze({
      pages: this.pages,
      features: this.features,
      nodes: this.nodes,
      estimatedBytes: this.estimatedBytes,
    });
  }
}

export function snapshotArcGisFeatures<TFeature extends object>(
  input: unknown,
  budget: Partial<ArcGisFeatureSnapshotBudget> = {},
): ArcGisFeatureSnapshotPage<TFeature> {
  return new ArcGisFeatureSnapshotSession(budget).capturePage<TFeature>(input);
}
