import type { ArcGisServiceCapabilities } from './arcgisCapabilityAdapter';

export interface ArcGisFeatureResponseLike {
  readonly attributes?: unknown;
  readonly geometry?: unknown;
}

export interface ArcGisQueryResponseLike<TFeature extends ArcGisFeatureResponseLike = ArcGisFeatureResponseLike> {
  readonly features?: readonly TFeature[];
  readonly exceededTransferLimit?: boolean;
}

export interface ArcGisQueryPageContext {
  readonly requestKey: string;
  readonly offset: number;
  readonly expectedRecordCount?: number;
}

export type ArcGisDuplicateObjectIdPolicy = 'reject' | 'drop';

export interface ArcGisQueryResponseGuardConfiguration {
  readonly objectIdField: string | null;
  readonly allowedFields: readonly string[];
  readonly requireObjectId: boolean;
  readonly rejectUnknownFields: boolean;
  readonly duplicateObjectIdPolicy: ArcGisDuplicateObjectIdPolicy;
  readonly maxFeaturesPerPage: number;
  readonly maxTotalFeatures: number;
  readonly maxPages: number;
  readonly maxEstimatedBytes: number;
  readonly maxFeatureBytes: number;
  readonly maxAttributesPerFeature: number;
  readonly maxAttributeNameLength: number;
  readonly maxStringValueLength: number;
  readonly maxTraversalDepth: number;
  readonly maxNodesPerFeature: number;
  readonly maxArrayEntriesPerFeature: number;
  readonly maxGeometryNumericValues: number;
  readonly maxRequestKeyLength: number;
}

export interface ArcGisQueryGuardedPage<TFeature extends ArcGisFeatureResponseLike = ArcGisFeatureResponseLike> {
  readonly requestKey: string;
  readonly page: number;
  readonly offset: number;
  readonly nextOffset: number;
  readonly rawFeatureCount: number;
  readonly acceptedFeatureCount: number;
  readonly duplicateFeatureCount: number;
  readonly estimatedBytes: number;
  readonly totalEstimatedBytes: number;
  readonly exceededTransferLimit: boolean | null;
  readonly complete: boolean;
  readonly continuationRequired: boolean;
  readonly features: readonly TFeature[];
  readonly warnings: readonly string[];
}

export interface ArcGisQueryResponseGuardSnapshot {
  readonly pages: number;
  readonly rawFeatures: number;
  readonly acceptedFeatures: number;
  readonly duplicateFeatures: number;
  readonly estimatedBytes: number;
  readonly expectedOffset: number | null;
  readonly completed: boolean;
  readonly warnings: readonly string[];
  readonly seenObjectIds: number;
  readonly seenRequestKeys: number;
}

interface ValueInspection {
  readonly estimatedBytes: number;
  readonly nodes: number;
  readonly arrayEntries: number;
  readonly numericValues: number;
}

const DEFAULT_CONFIGURATION: ArcGisQueryResponseGuardConfiguration = Object.freeze({
  objectIdField: null,
  allowedFields: Object.freeze([]),
  requireObjectId: false,
  rejectUnknownFields: false,
  duplicateObjectIdPolicy: 'drop',
  maxFeaturesPerPage: 5_000,
  maxTotalFeatures: 100_000,
  maxPages: 256,
  maxEstimatedBytes: 128 * 1024 * 1024,
  maxFeatureBytes: 2 * 1024 * 1024,
  maxAttributesPerFeature: 512,
  maxAttributeNameLength: 128,
  maxStringValueLength: 65_536,
  maxTraversalDepth: 32,
  maxNodesPerFeature: 200_000,
  maxArrayEntriesPerFeature: 100_000,
  maxGeometryNumericValues: 1_000_000,
  maxRequestKeyLength: 2_048,
});

export class ArcGisResponseIntegrityError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ArcGisResponseIntegrityError';
    this.code = code;
  }
}

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(label + ' must be a positive safe integer');
  }
  return value;
};

const nonNegativeSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(label + ' must be a non-negative safe integer');
  }
  return value;
};

const normalizeText = (value: string, label: string, maxLength: number): string => {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string');
  const normalized = value.trim();
  if (!normalized) throw new TypeError(label + ' must not be empty');
  if (normalized.length > maxLength) throw new RangeError(label + ' exceeds length budget');
  return normalized;
};

const normalizeOptionalField = (
  value: string | null | undefined,
  maxLength: number,
): string | null => {
  if (value === null || value === undefined) return null;
  return normalizeText(value, 'objectIdField', maxLength);
};

const normalizeAllowedFields = (
  fields: readonly string[],
  maxAttributeNameLength: number,
): readonly string[] => {
  const output = new Map<string, string>();
  for (const field of fields) {
    const normalized = normalizeText(field, 'allowed field', maxAttributeNameLength);
    const key = normalized.toLowerCase();
    if (!output.has(key)) output.set(key, normalized);
  }
  return Object.freeze([...output.values()].sort((left, right) => left.localeCompare(right)));
};

const normalizeConfiguration = (
  input: Partial<ArcGisQueryResponseGuardConfiguration>,
): ArcGisQueryResponseGuardConfiguration => {
  const resolved = { ...DEFAULT_CONFIGURATION, ...input };
  const maxAttributeNameLength = positiveSafeInteger(
    resolved.maxAttributeNameLength,
    'maxAttributeNameLength',
  );
  const maxFeaturesPerPage = positiveSafeInteger(
    resolved.maxFeaturesPerPage,
    'maxFeaturesPerPage',
  );
  const maxTotalFeatures = positiveSafeInteger(
    resolved.maxTotalFeatures,
    'maxTotalFeatures',
  );
  const maxPages = positiveSafeInteger(resolved.maxPages, 'maxPages');
  const maxEstimatedBytes = positiveSafeInteger(
    resolved.maxEstimatedBytes,
    'maxEstimatedBytes',
  );
  const maxFeatureBytes = positiveSafeInteger(resolved.maxFeatureBytes, 'maxFeatureBytes');
  const maxAttributesPerFeature = positiveSafeInteger(
    resolved.maxAttributesPerFeature,
    'maxAttributesPerFeature',
  );
  const maxStringValueLength = positiveSafeInteger(
    resolved.maxStringValueLength,
    'maxStringValueLength',
  );
  const maxTraversalDepth = positiveSafeInteger(
    resolved.maxTraversalDepth,
    'maxTraversalDepth',
  );
  const maxNodesPerFeature = positiveSafeInteger(
    resolved.maxNodesPerFeature,
    'maxNodesPerFeature',
  );
  const maxArrayEntriesPerFeature = positiveSafeInteger(
    resolved.maxArrayEntriesPerFeature,
    'maxArrayEntriesPerFeature',
  );
  const maxGeometryNumericValues = positiveSafeInteger(
    resolved.maxGeometryNumericValues,
    'maxGeometryNumericValues',
  );
  const maxRequestKeyLength = positiveSafeInteger(
    resolved.maxRequestKeyLength,
    'maxRequestKeyLength',
  );

  if (maxTotalFeatures < maxFeaturesPerPage) {
    throw new RangeError('maxTotalFeatures must be at least maxFeaturesPerPage');
  }
  if (maxEstimatedBytes < maxFeatureBytes) {
    throw new RangeError('maxEstimatedBytes must be at least maxFeatureBytes');
  }
  if (
    resolved.duplicateObjectIdPolicy !== 'drop'
    && resolved.duplicateObjectIdPolicy !== 'reject'
  ) {
    throw new TypeError('duplicateObjectIdPolicy must be drop or reject');
  }

  const objectIdField = normalizeOptionalField(
    resolved.objectIdField,
    maxAttributeNameLength,
  );
  if (resolved.requireObjectId && !objectIdField) {
    throw new TypeError('requireObjectId requires objectIdField');
  }

  return Object.freeze({
    objectIdField,
    allowedFields: normalizeAllowedFields(
      resolved.allowedFields,
      maxAttributeNameLength,
    ),
    requireObjectId: resolved.requireObjectId === true,
    rejectUnknownFields: resolved.rejectUnknownFields === true,
    duplicateObjectIdPolicy: resolved.duplicateObjectIdPolicy,
    maxFeaturesPerPage,
    maxTotalFeatures,
    maxPages,
    maxEstimatedBytes,
    maxFeatureBytes,
    maxAttributesPerFeature,
    maxAttributeNameLength,
    maxStringValueLength,
    maxTraversalDepth,
    maxNodesPerFeature,
    maxArrayEntriesPerFeature,
    maxGeometryNumericValues,
    maxRequestKeyLength,
  });
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const estimateScalar = (
  value: unknown,
  maxStringValueLength: number,
): Readonly<{ bytes: number; numeric: number }> => {
  if (value === null || value === undefined) return Object.freeze({ bytes: 4, numeric: 0 });
  if (typeof value === 'string') {
    if (value.length > maxStringValueLength) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response string exceeds configured length budget',
        'STRING_BUDGET_EXCEEDED',
      );
    }
    return Object.freeze({ bytes: 8 + value.length * 2, numeric: 0 });
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response contains a non-finite number',
        'NON_FINITE_NUMBER',
      );
    }
    return Object.freeze({ bytes: 8, numeric: 1 });
  }
  if (typeof value === 'boolean') return Object.freeze({ bytes: 4, numeric: 0 });
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new ArcGisResponseIntegrityError(
      'ArcGIS response contains an unsupported runtime value',
      'UNSUPPORTED_VALUE',
    );
  }
  return Object.freeze({ bytes: 0, numeric: 0 });
};

const inspectValue = (
  root: unknown,
  configuration: ArcGisQueryResponseGuardConfiguration,
): ValueInspection => {
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [
    Object.freeze({ value: root, depth: 0 }),
  ];
  const seen = new WeakSet<object>();
  let estimatedBytes = 0;
  let nodes = 0;
  let arrayEntries = 0;
  let numericValues = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.depth > configuration.maxTraversalDepth) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response exceeds configured traversal depth',
        'TRAVERSAL_DEPTH_EXCEEDED',
      );
    }

    nodes += 1;
    if (nodes > configuration.maxNodesPerFeature) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS feature exceeds configured node budget',
        'NODE_BUDGET_EXCEEDED',
      );
    }

    const scalar = estimateScalar(entry.value, configuration.maxStringValueLength);
    estimatedBytes += scalar.bytes;
    numericValues += scalar.numeric;

    if (entry.value === null || typeof entry.value !== 'object') continue;
    if (seen.has(entry.value)) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response contains a cyclic object graph',
        'CYCLIC_RESPONSE_VALUE',
      );
    }
    seen.add(entry.value);

    if (Array.isArray(entry.value)) {
      arrayEntries += entry.value.length;
      if (arrayEntries > configuration.maxArrayEntriesPerFeature) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS feature exceeds configured array-entry budget',
          'ARRAY_BUDGET_EXCEEDED',
        );
      }
      estimatedBytes += entry.value.length * 8;
      for (let index = entry.value.length - 1; index >= 0; index -= 1) {
        stack.push(Object.freeze({
          value: entry.value[index],
          depth: entry.depth + 1,
        }));
      }
      continue;
    }

    const entries = Object.entries(entry.value as Readonly<Record<string, unknown>>);
    estimatedBytes += entries.length * 8;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const pair = entries[index];
      if (!pair) continue;
      const [key, value] = pair;
      if (key.length > configuration.maxAttributeNameLength) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS response object key exceeds configured length budget',
          'OBJECT_KEY_BUDGET_EXCEEDED',
        );
      }
      estimatedBytes += key.length * 2;
      stack.push(Object.freeze({
        value,
        depth: entry.depth + 1,
      }));
    }
  }

  return Object.freeze({
    estimatedBytes,
    nodes,
    arrayEntries,
    numericValues,
  });
};

const attributeRecord = (
  feature: ArcGisFeatureResponseLike,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(feature.attributes)) {
    throw new ArcGisResponseIntegrityError(
      'ArcGIS feature attributes must be a plain object',
      'INVALID_ATTRIBUTES',
    );
  }
  return feature.attributes;
};

const allowedFieldSet = (
  configuration: ArcGisQueryResponseGuardConfiguration,
): ReadonlySet<string> => new Set(
  configuration.allowedFields.map((field) => field.toLowerCase()),
);

const objectIdValue = (
  attributes: Readonly<Record<string, unknown>>,
  objectIdField: string | null,
): string | number | null => {
  if (!objectIdField) return null;
  const expected = objectIdField.toLowerCase();
  let matched: unknown = undefined;
  let matches = 0;
  for (const [name, value] of Object.entries(attributes)) {
    if (name.toLowerCase() !== expected) continue;
    matched = value;
    matches += 1;
  }
  if (matches > 1) {
    throw new ArcGisResponseIntegrityError(
      'ArcGIS feature contains ambiguous object-id field casing',
      'AMBIGUOUS_OBJECT_ID',
    );
  }
  if (matches === 0 || matched === null || matched === undefined) return null;
  if (typeof matched === 'number') {
    if (!Number.isSafeInteger(matched)) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS numeric object id must be a safe integer',
        'INVALID_OBJECT_ID',
      );
    }
    return matched;
  }
  if (typeof matched === 'string') {
    const normalized = matched.trim();
    if (!normalized) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS string object id must not be empty',
        'INVALID_OBJECT_ID',
      );
    }
    return normalized;
  }
  throw new ArcGisResponseIntegrityError(
    'ArcGIS object id must be a string or safe integer',
    'INVALID_OBJECT_ID',
  );
};

const identityKey = (value: string | number): string => (
  typeof value === 'number' ? 'n:' + value : 's:' + value
);

const normalizeRequestKey = (
  value: string,
  configuration: ArcGisQueryResponseGuardConfiguration,
): string => normalizeText(value, 'requestKey', configuration.maxRequestKeyLength);

const expectedRecordCount = (
  value: number | undefined,
  configuration: ArcGisQueryResponseGuardConfiguration,
): number | null => {
  if (value === undefined) return null;
  const normalized = positiveSafeInteger(value, 'expectedRecordCount');
  if (normalized > configuration.maxFeaturesPerPage) {
    throw new RangeError('expectedRecordCount exceeds maxFeaturesPerPage');
  }
  return normalized;
};

export const arcGisResponseGuardConfigurationFromCapabilities = (
  capabilities: ArcGisServiceCapabilities,
  overrides: Partial<ArcGisQueryResponseGuardConfiguration> = {},
): Partial<ArcGisQueryResponseGuardConfiguration> => Object.freeze({
  objectIdField: capabilities.objectIdField,
  allowedFields: capabilities.fieldNames,
  requireObjectId: capabilities.objectIdField !== null,
  maxFeaturesPerPage: Math.max(
    1,
    Math.min(capabilities.maxRecordCount, DEFAULT_CONFIGURATION.maxTotalFeatures),
  ),
  ...overrides,
});

export class ArcGisQueryResponseGuard<
  TFeature extends ArcGisFeatureResponseLike = ArcGisFeatureResponseLike,
> {
  readonly #configuration: ArcGisQueryResponseGuardConfiguration;
  readonly #seenObjectIds = new Set<string>();
  readonly #seenRequestKeys = new Set<string>();
  readonly #warnings = new Set<string>();
  #pages = 0;
  #rawFeatures = 0;
  #acceptedFeatures = 0;
  #duplicateFeatures = 0;
  #estimatedBytes = 0;
  #expectedOffset: number | null = null;
  #completed = false;

  constructor(configuration: Partial<ArcGisQueryResponseGuardConfiguration> = {}) {
    this.#configuration = normalizeConfiguration(configuration);
  }

  get configuration(): ArcGisQueryResponseGuardConfiguration {
    return this.#configuration;
  }

  inspectPage(
    response: ArcGisQueryResponseLike<TFeature>,
    context: ArcGisQueryPageContext,
  ): ArcGisQueryGuardedPage<TFeature> {
    if (this.#completed) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response guard already observed a completed page sequence',
        'SEQUENCE_ALREADY_COMPLETE',
      );
    }

    const requestKey = normalizeRequestKey(context.requestKey, this.#configuration);
    if (this.#seenRequestKeys.has(requestKey)) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response request key was already observed',
        'DUPLICATE_REQUEST_KEY',
      );
    }
    const offset = nonNegativeSafeInteger(context.offset, 'offset');
    if (this.#expectedOffset !== null && offset !== this.#expectedOffset) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS response offset does not match expected pagination progress',
        'PAGINATION_OFFSET_MISMATCH',
      );
    }
    const expectedCount = expectedRecordCount(
      context.expectedRecordCount,
      this.#configuration,
    );
    const features = response.features;
    if (!Array.isArray(features)) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS query response must contain a features array',
        'FEATURES_ARRAY_MISSING',
      );
    }
    if (features.length > this.#configuration.maxFeaturesPerPage) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS query page exceeds maxFeaturesPerPage',
        'PAGE_FEATURE_BUDGET_EXCEEDED',
      );
    }
    if (this.#pages + 1 > this.#configuration.maxPages) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS query sequence exceeds maxPages',
        'PAGE_BUDGET_EXCEEDED',
      );
    }
    if (this.#rawFeatures + features.length > this.#configuration.maxTotalFeatures) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS query sequence exceeds maxTotalFeatures',
        'TOTAL_FEATURE_BUDGET_EXCEEDED',
      );
    }

    const allowed = allowedFieldSet(this.#configuration);
    const accepted: TFeature[] = [];
    const pageWarnings = new Set<string>();
    const pageObjectIds = new Set<string>();
    let pageBytes = 0;
    let duplicateFeatureCount = 0;

    for (const feature of features) {
      if (!isRecord(feature)) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS feature must be an object',
          'INVALID_FEATURE',
        );
      }
      const typedFeature = feature as TFeature;
      const attributes = attributeRecord(typedFeature);
      const attributeEntries = Object.entries(attributes);
      if (attributeEntries.length > this.#configuration.maxAttributesPerFeature) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS feature exceeds attribute cardinality budget',
          'ATTRIBUTE_BUDGET_EXCEEDED',
        );
      }

      for (const [name] of attributeEntries) {
        if (name.length > this.#configuration.maxAttributeNameLength) {
          throw new ArcGisResponseIntegrityError(
            'ArcGIS attribute name exceeds configured length budget',
            'ATTRIBUTE_NAME_BUDGET_EXCEEDED',
          );
        }
        if (allowed.size > 0 && !allowed.has(name.toLowerCase())) {
          if (this.#configuration.rejectUnknownFields) {
            throw new ArcGisResponseIntegrityError(
              'ArcGIS feature contains a field not present in verified metadata',
              'UNKNOWN_FIELD',
            );
          }
          pageWarnings.add('unknown-field-observed');
        }
      }

      const attributeInspection = inspectValue(attributes, this.#configuration);
      const geometryInspection = inspectValue(typedFeature.geometry ?? null, this.#configuration);
      if (geometryInspection.numericValues > this.#configuration.maxGeometryNumericValues) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS geometry exceeds numeric-coordinate budget',
          'GEOMETRY_COORDINATE_BUDGET_EXCEEDED',
        );
      }
      const featureBytes = 64
        + attributeInspection.estimatedBytes
        + geometryInspection.estimatedBytes;
      if (featureBytes > this.#configuration.maxFeatureBytes) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS feature exceeds maxFeatureBytes',
          'FEATURE_BYTE_BUDGET_EXCEEDED',
        );
      }
      pageBytes += featureBytes;
      if (pageBytes > this.#configuration.maxEstimatedBytes) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS query page exceeds maxEstimatedBytes',
          'RESPONSE_BYTE_BUDGET_EXCEEDED',
        );
      }

      const objectId = objectIdValue(attributes, this.#configuration.objectIdField);
      if (this.#configuration.requireObjectId && objectId === null) {
        throw new ArcGisResponseIntegrityError(
          'ArcGIS feature is missing the verified object-id field',
          'OBJECT_ID_REQUIRED',
        );
      }
      if (objectId !== null) {
        const key = identityKey(objectId);
        if (this.#seenObjectIds.has(key) || pageObjectIds.has(key)) {
          if (this.#configuration.duplicateObjectIdPolicy === 'reject') {
            throw new ArcGisResponseIntegrityError(
              'ArcGIS response contains a duplicate object id',
              'DUPLICATE_OBJECT_ID',
            );
          }
          duplicateFeatureCount += 1;
          pageWarnings.add('duplicate-object-id-dropped');
          continue;
        }
        pageObjectIds.add(key);
      }

      accepted.push(typedFeature);
    }

    const transferLimit = typeof response.exceededTransferLimit === 'boolean'
      ? response.exceededTransferLimit
      : null;
    if (transferLimit === null) {
      pageWarnings.add('transfer-limit-evidence-missing');
    }
    if (transferLimit === true && features.length === 0) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS transfer-limited page did not advance pagination',
        'PAGINATION_NO_PROGRESS',
      );
    }
    if (
      transferLimit === true
      && expectedCount !== null
      && features.length < expectedCount
    ) {
      pageWarnings.add('transfer-limit-short-page');
    }

    const nextOffset = offset + features.length;
    const complete = transferLimit === false;
    const continuationRequired = transferLimit === true;

    if (this.#estimatedBytes + pageBytes > this.#configuration.maxEstimatedBytes) {
      throw new ArcGisResponseIntegrityError(
        'ArcGIS query sequence exceeds maxEstimatedBytes',
        'RESPONSE_BYTE_BUDGET_EXCEEDED',
      );
    }

    for (const key of pageObjectIds) this.#seenObjectIds.add(key);
    this.#pages += 1;
    this.#rawFeatures += features.length;
    this.#acceptedFeatures += accepted.length;
    this.#duplicateFeatures += duplicateFeatureCount;
    this.#estimatedBytes += pageBytes;
    this.#expectedOffset = nextOffset;
    this.#completed = complete;
    this.#seenRequestKeys.add(requestKey);
    for (const warning of pageWarnings) this.#warnings.add(warning);

    return Object.freeze({
      requestKey,
      page: this.#pages,
      offset,
      nextOffset,
      rawFeatureCount: features.length,
      acceptedFeatureCount: accepted.length,
      duplicateFeatureCount,
      estimatedBytes: pageBytes,
      totalEstimatedBytes: this.#estimatedBytes,
      exceededTransferLimit: transferLimit,
      complete,
      continuationRequired,
      features: Object.freeze(accepted),
      warnings: Object.freeze([...pageWarnings].sort()),
    });
  }

  snapshot(): ArcGisQueryResponseGuardSnapshot {
    return Object.freeze({
      pages: this.#pages,
      rawFeatures: this.#rawFeatures,
      acceptedFeatures: this.#acceptedFeatures,
      duplicateFeatures: this.#duplicateFeatures,
      estimatedBytes: this.#estimatedBytes,
      expectedOffset: this.#expectedOffset,
      completed: this.#completed,
      warnings: Object.freeze([...this.#warnings].sort()),
      seenObjectIds: this.#seenObjectIds.size,
      seenRequestKeys: this.#seenRequestKeys.size,
    });
  }

  reset(): ArcGisQueryResponseGuardSnapshot {
    this.#seenObjectIds.clear();
    this.#seenRequestKeys.clear();
    this.#warnings.clear();
    this.#pages = 0;
    this.#rawFeatures = 0;
    this.#acceptedFeatures = 0;
    this.#duplicateFeatures = 0;
    this.#estimatedBytes = 0;
    this.#expectedOffset = null;
    this.#completed = false;
    return this.snapshot();
  }
}

export const createArcGisQueryResponseGuard = <
  TFeature extends ArcGisFeatureResponseLike = ArcGisFeatureResponseLike,
>(
  configuration: Partial<ArcGisQueryResponseGuardConfiguration> = {},
): ArcGisQueryResponseGuard<TFeature> => new ArcGisQueryResponseGuard<TFeature>(configuration);
