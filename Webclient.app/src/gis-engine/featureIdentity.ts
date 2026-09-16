import type { ArcGisMetadataContract } from './arcgisMetadataAdapter';

export type ArcGisAttributeValue = string | number | boolean | Date | null | undefined | unknown;
export type ArcGisAttributes = Readonly<Record<string, ArcGisAttributeValue>>;

export type FeatureIdentityKind = 'object-id' | 'global-id' | 'composite' | 'anonymous';

export type FeatureIdentity = Readonly<{
  kind: FeatureIdentityKind;
  key: string;
  objectId: string | number | null;
  globalId: string | null;
  stable: boolean;
  sourceFields: readonly string[];
}>;

export type FeatureIdentityPolicy = Readonly<{
  allowCompositeFallback?: boolean;
  compositeFields?: readonly string[];
  namespace?: string;
  maxCompositeFields?: number;
  maxValueLength?: number;
}>;

export type IdentityCollectionDiagnostics = Readonly<{
  total: number;
  stable: number;
  anonymous: number;
  duplicateKeys: number;
  duplicateObjectIds: number;
  duplicateGlobalIds: number;
  conflictingIdentityPairs: number;
  missingObjectIds: number;
  missingGlobalIds: number;
  stableRatio: number;
}>;

export class FeatureIdentityError extends Error {
  readonly code: string;

  constructor(message: string, code = 'FEATURE_IDENTITY_ERROR') {
    super(message);
    this.name = 'FeatureIdentityError';
    this.code = code;
  }
}

const DEFAULT_MAX_COMPOSITE_FIELDS = 8;
const DEFAULT_MAX_VALUE_LENGTH = 512;

const normalizeNamespace = (value: unknown): string => {
  const candidate = String(value ?? '').trim();
  return candidate ? candidate.replace(/[^A-Za-z0-9_.:-]+/g, '-') : 'arcgis';
};

const normalizeGlobalId = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const candidate = String(value).trim();
  if (!candidate) return null;
  return candidate.replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
};

const normalizeObjectId = (value: unknown): string | number | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (!candidate) return null;
    const numeric = Number(candidate);
    if (Number.isSafeInteger(numeric) && String(numeric) === candidate) return numeric;
    return candidate;
  }
  return null;
};

const boundedText = (value: unknown, maxLength: number): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'invalid-date';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'non-finite-number';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = String(text ?? '').trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
};

const fnv1a = (input: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const fieldValue = (attributes: ArcGisAttributes, field: string | null): unknown => (
  field ? attributes[field] : undefined
);

const identityKey = (namespace: string, kind: FeatureIdentityKind, value: string): string => (
  `${namespace}:${kind}:${value}`
);

const normalizeCompositeFields = (
  contract: ArcGisMetadataContract,
  policy: FeatureIdentityPolicy,
): readonly string[] => {
  const maxFields = Math.max(1, Math.min(32, Math.floor(Number(policy.maxCompositeFields) || DEFAULT_MAX_COMPOSITE_FIELDS)));
  const requested = Array.isArray(policy.compositeFields) ? policy.compositeFields : [];
  const knownFields = new Set(contract.fields.map((field) => field.name));
  const selected: string[] = [];
  for (const raw of requested) {
    const name = String(raw ?? '').trim();
    if (!name || !knownFields.has(name) || selected.includes(name)) continue;
    selected.push(name);
    if (selected.length >= maxFields) break;
  }
  if (!selected.length && contract.displayField && knownFields.has(contract.displayField)) selected.push(contract.displayField);
  return Object.freeze(selected);
};

export const resolveFeatureIdentity = (
  contract: ArcGisMetadataContract,
  attributes: ArcGisAttributes,
  policy: FeatureIdentityPolicy = {},
): FeatureIdentity => {
  const namespace = normalizeNamespace(policy.namespace ?? contract.resourceUrl);
  const objectId = normalizeObjectId(fieldValue(attributes, contract.objectIdField));
  const globalId = normalizeGlobalId(fieldValue(attributes, contract.globalIdField));

  if (objectId !== null) {
    return Object.freeze({
      kind: 'object-id' as const,
      key: identityKey(namespace, 'object-id', String(objectId)),
      objectId,
      globalId,
      stable: true,
      sourceFields: Object.freeze(contract.objectIdField ? [contract.objectIdField] : []),
    });
  }

  if (globalId !== null) {
    return Object.freeze({
      kind: 'global-id' as const,
      key: identityKey(namespace, 'global-id', globalId),
      objectId: null,
      globalId,
      stable: true,
      sourceFields: Object.freeze(contract.globalIdField ? [contract.globalIdField] : []),
    });
  }

  if (policy.allowCompositeFallback === true) {
    const fields = normalizeCompositeFields(contract, policy);
    if (fields.length) {
      const maxLength = Math.max(32, Math.min(4096, Math.floor(Number(policy.maxValueLength) || DEFAULT_MAX_VALUE_LENGTH)));
      const parts = fields.map((field) => `${field}=${boundedText(attributes[field], maxLength)}`);
      if (parts.some((part) => !part.endsWith('=') && !part.endsWith('=null') && !part.endsWith('=undefined'))) {
        return Object.freeze({
          kind: 'composite' as const,
          key: identityKey(namespace, 'composite', fnv1a(parts.join('|'))),
          objectId: null,
          globalId: null,
          stable: false,
          sourceFields: fields,
        });
      }
    }
  }

  return Object.freeze({
    kind: 'anonymous' as const,
    key: identityKey(namespace, 'anonymous', fnv1a(JSON.stringify(attributes) || 'empty')),
    objectId: null,
    globalId: null,
    stable: false,
    sourceFields: Object.freeze([]),
  });
};

export const featureIdentityEquals = (left: FeatureIdentity | null, right: FeatureIdentity | null): boolean => {
  if (!left || !right) return false;
  if (left.stable && right.stable) return left.key === right.key;
  if (left.objectId !== null && right.objectId !== null) return String(left.objectId) === String(right.objectId);
  if (left.globalId && right.globalId) return left.globalId === right.globalId;
  return left.key === right.key;
};

export const createFeatureIdentityIndex = (
  contract: ArcGisMetadataContract,
  records: readonly ArcGisAttributes[],
  policy: FeatureIdentityPolicy = {},
): Readonly<{
  identities: readonly FeatureIdentity[];
  byKey: ReadonlyMap<string, number[]>;
  byObjectId: ReadonlyMap<string, number[]>;
  byGlobalId: ReadonlyMap<string, number[]>;
  diagnostics: IdentityCollectionDiagnostics;
}> => {
  const identities: FeatureIdentity[] = [];
  const byKey = new Map<string, number[]>();
  const byObjectId = new Map<string, number[]>();
  const byGlobalId = new Map<string, number[]>();
  const pairMap = new Map<string, string>();
  let stable = 0;
  let anonymous = 0;
  let missingObjectIds = 0;
  let missingGlobalIds = 0;
  let conflictingIdentityPairs = 0;

  const append = (map: Map<string, number[]>, key: string, index: number): void => {
    const current = map.get(key);
    if (current) current.push(index);
    else map.set(key, [index]);
  };

  records.forEach((attributes, index) => {
    const identity = resolveFeatureIdentity(contract, attributes, policy);
    identities.push(identity);
    if (identity.stable) stable += 1;
    if (identity.kind === 'anonymous') anonymous += 1;
    if (identity.objectId === null) missingObjectIds += 1;
    if (identity.globalId === null) missingGlobalIds += 1;
    append(byKey, identity.key, index);
    if (identity.objectId !== null) append(byObjectId, String(identity.objectId), index);
    if (identity.globalId !== null) append(byGlobalId, identity.globalId, index);

    if (identity.objectId !== null && identity.globalId !== null) {
      const oid = String(identity.objectId);
      const previousGlobal = pairMap.get(oid);
      if (previousGlobal && previousGlobal !== identity.globalId) conflictingIdentityPairs += 1;
      else pairMap.set(oid, identity.globalId);
    }
  });

  const duplicateCount = (map: ReadonlyMap<string, readonly number[]>): number => {
    let duplicates = 0;
    map.forEach((indices) => {
      if (indices.length > 1) duplicates += indices.length - 1;
    });
    return duplicates;
  };

  const total = records.length;
  const diagnostics: IdentityCollectionDiagnostics = Object.freeze({
    total,
    stable,
    anonymous,
    duplicateKeys: duplicateCount(byKey),
    duplicateObjectIds: duplicateCount(byObjectId),
    duplicateGlobalIds: duplicateCount(byGlobalId),
    conflictingIdentityPairs,
    missingObjectIds,
    missingGlobalIds,
    stableRatio: total ? stable / total : 1,
  });

  return Object.freeze({
    identities: Object.freeze(identities),
    byKey,
    byObjectId,
    byGlobalId,
    diagnostics,
  });
};

export const dedupeFeaturesByIdentity = <T extends Readonly<{ attributes: ArcGisAttributes }>>(
  contract: ArcGisMetadataContract,
  features: readonly T[],
  policy: FeatureIdentityPolicy = {},
): Readonly<{
  features: readonly T[];
  identities: readonly FeatureIdentity[];
  duplicateCount: number;
}> => {
  const output: T[] = [];
  const identities: FeatureIdentity[] = [];
  const seen = new Map<string, number>();
  let duplicateCount = 0;

  for (const feature of features) {
    const identity = resolveFeatureIdentity(contract, feature.attributes, policy);
    if (seen.has(identity.key)) {
      duplicateCount += 1;
      continue;
    }
    seen.set(identity.key, output.length);
    output.push(feature);
    identities.push(identity);
  }

  return Object.freeze({
    features: Object.freeze(output),
    identities: Object.freeze(identities),
    duplicateCount,
  });
};

export const assessFeatureIdentityQuality = (
  diagnostics: IdentityCollectionDiagnostics,
  thresholds: Readonly<{
    minimumStableRatio?: number;
    maximumDuplicateRatio?: number;
    maximumConflictCount?: number;
  }> = {},
): Readonly<{
  status: 'healthy' | 'degraded' | 'blocked';
  reasons: readonly string[];
}> => {
  const minimumStableRatio = Math.min(1, Math.max(0, Number(thresholds.minimumStableRatio ?? 0.98)));
  const maximumDuplicateRatio = Math.min(1, Math.max(0, Number(thresholds.maximumDuplicateRatio ?? 0.01)));
  const maximumConflictCount = Math.max(0, Math.floor(Number(thresholds.maximumConflictCount ?? 0)));
  const duplicateRatio = diagnostics.total ? diagnostics.duplicateKeys / diagnostics.total : 0;
  const reasons: string[] = [];
  if (diagnostics.stableRatio < minimumStableRatio) reasons.push('stable-identity-ratio-below-threshold');
  if (duplicateRatio > maximumDuplicateRatio) reasons.push('duplicate-identity-ratio-above-threshold');
  if (diagnostics.conflictingIdentityPairs > maximumConflictCount) reasons.push('conflicting-object-global-id-pairs');
  const status = diagnostics.conflictingIdentityPairs > maximumConflictCount
    ? 'blocked'
    : reasons.length
      ? 'degraded'
      : 'healthy';
  return Object.freeze({ status, reasons: Object.freeze(reasons) });
};
