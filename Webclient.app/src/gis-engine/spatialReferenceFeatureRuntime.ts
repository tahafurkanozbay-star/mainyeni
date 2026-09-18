import {
  type NormalizedSpatialReference,
  type SpatialReferenceRuntimeOptions,
  spatialReferencesEquivalent,
} from "./spatialReferenceRuntime";
import {
  type Geometry2D,
  type GeometryProjectionOptions,
  geometryExtent2D,
  normalizeGeometry2D,
  projectGeometry2D,
} from "./spatialReferenceGeometryRuntime";

export type ArcGisAttributeValue = string | number | boolean | null;
export type ArcGisAttributes = Readonly<Record<string, ArcGisAttributeValue>>;

export type SpatialFeature = Readonly<{
  id: string | number;
  geometry: Geometry2D;
  attributes: ArcGisAttributes;
}>;

export type SpatialFeatureIssueCode =
  | "duplicate-id"
  | "invalid-id"
  | "invalid-attribute"
  | "attribute-budget"
  | "geometry-invalid"
  | "spatial-reference-mismatch"
  | "projection-unsupported";

export type SpatialFeatureIssue = Readonly<{
  code: SpatialFeatureIssueCode;
  featureIndex: number;
  featureId?: string | number;
  message: string;
}>;

export type SpatialFeatureIntegrityOptions = GeometryProjectionOptions &
  SpatialReferenceRuntimeOptions &
  Readonly<{
    maxFeatures?: number;
    maxAttributesPerFeature?: number;
    maxAttributeKeyLength?: number;
    maxStringValueLength?: number;
    maxIdLength?: number;
    maxAttributeBytesPerFeature?: number;
    maxTotalAttributeBytes?: number;
    maxIssues?: number;
    targetSpatialReference?: NormalizedSpatialReference;
    projectToTarget?: boolean;
    rejectDuplicateIds?: boolean;
    rejectInvalidFeatures?: boolean;
  }>;

export type SpatialFeatureIntegrityResult = Readonly<{
  features: readonly SpatialFeature[];
  issues: readonly SpatialFeatureIssue[];
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  projectedCount: number;
  estimatedAttributeBytes: number;
}>;

const DEFAULT_MAX_FEATURES = 100_000;
const DEFAULT_MAX_ATTRIBUTES = 256;
const DEFAULT_MAX_ATTRIBUTE_KEY_LENGTH = 256;
const DEFAULT_MAX_STRING_VALUE_LENGTH = 16_384;
const DEFAULT_MAX_ID_LENGTH = 512;
const DEFAULT_MAX_ATTRIBUTE_BYTES_PER_FEATURE = 256 * 1024;
const DEFAULT_MAX_TOTAL_ATTRIBUTE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ISSUES = 2_000;

function positiveBudget(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function normalizeId(id: string | number, maxLength = DEFAULT_MAX_ID_LENGTH): string | number {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id)) {
      throw new TypeError("feature id must be a safe integer or non-empty string");
    }
    return id;
  }
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TypeError("feature id must be a safe integer or non-empty string");
  }
  if (id.length > maxLength) {
    throw new RangeError("feature id exceeds configured length budget");
  }
  return id;
}

function identityKey(id: string | number): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function normalizeAttributes(
  attributes: ArcGisAttributes,
  options: SpatialFeatureIntegrityOptions,
): ArcGisAttributes {
  const entries = Object.entries(attributes);
  const maxAttributes = positiveBudget(
    options.maxAttributesPerFeature,
    DEFAULT_MAX_ATTRIBUTES,
    "maxAttributesPerFeature",
  );
  if (entries.length > maxAttributes) {
    throw new RangeError("feature exceeds attribute budget");
  }

  const maxKeyLength = positiveBudget(
    options.maxAttributeKeyLength,
    DEFAULT_MAX_ATTRIBUTE_KEY_LENGTH,
    "maxAttributeKeyLength",
  );
  const maxStringLength = positiveBudget(
    options.maxStringValueLength,
    DEFAULT_MAX_STRING_VALUE_LENGTH,
    "maxStringValueLength",
  );
  const normalized: Record<string, ArcGisAttributeValue> = Object.create(null) as Record<
    string,
    ArcGisAttributeValue
  >;

  for (const [key, value] of entries) {
    throwIfAborted(options.signal);
    if (key.length === 0 || key.length > maxKeyLength) {
      throw new RangeError("attribute key exceeds configured bounds");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`attribute ${key} must be finite`);
    }
    if (typeof value === "string" && value.length > maxStringLength) {
      throw new RangeError(`attribute ${key} exceeds string value budget`);
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError(`attribute ${key} has unsupported value type`);
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function estimateAttributesBytes(attributes: ArcGisAttributes): number {
  let bytes = 0;
  for (const [key, value] of Object.entries(attributes)) {
    bytes += key.length * 2;
    if (value === null) bytes += 4;
    else if (typeof value === "string") bytes += value.length * 2;
    else bytes += 8;
  }
  return bytes;
}

function issueCode(error: unknown): SpatialFeatureIssueCode {
  if (error instanceof RangeError && error.message.includes("attribute")) {
    return "attribute-budget";
  }
  if (error instanceof TypeError && error.message.includes("attribute")) {
    return "invalid-attribute";
  }
  if (error instanceof TypeError && error.message.includes("feature id")) {
    return "invalid-id";
  }
  if (error instanceof Error && error.message.toLowerCase().includes("projection")) {
    return "projection-unsupported";
  }
  return "geometry-invalid";
}

function issueMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown spatial feature integrity error";
}

function appendIssue(
  issues: SpatialFeatureIssue[],
  issue: SpatialFeatureIssue,
  maxIssues: number,
): void {
  if (issues.length >= maxIssues) {
    throw new RangeError("spatial feature issue budget exhausted");
  }
  issues.push(Object.freeze(issue));
}

function normalizeFeature(
  feature: SpatialFeature,
  options: SpatialFeatureIntegrityOptions,
): SpatialFeature {
  const maxIdLength = positiveBudget(options.maxIdLength, DEFAULT_MAX_ID_LENGTH, "maxIdLength");
  const id = normalizeId(feature.id, maxIdLength);
  const attributes = normalizeAttributes(feature.attributes, options);
  const attributeBytes = estimateAttributesBytes(attributes);
  const maxAttributeBytes = positiveBudget(
    options.maxAttributeBytesPerFeature,
    DEFAULT_MAX_ATTRIBUTE_BYTES_PER_FEATURE,
    "maxAttributeBytesPerFeature",
  );
  if (attributeBytes > maxAttributeBytes) {
    throw new RangeError("feature exceeds attribute byte budget");
  }
  const geometry = normalizeGeometry2D(feature.geometry, options);
  return Object.freeze({ id, geometry, attributes });
}

function alignFeatureSpatialReference(
  feature: SpatialFeature,
  options: SpatialFeatureIntegrityOptions,
): Readonly<{ feature: SpatialFeature; projected: boolean }> {
  const target = options.targetSpatialReference;
  if (!target) {
    return Object.freeze({ feature, projected: false });
  }
  if (spatialReferencesEquivalent(feature.geometry.spatialReference, target)) {
    return Object.freeze({
      feature: Object.freeze({
        ...feature,
        geometry: Object.freeze({ ...feature.geometry, spatialReference: target }) as Geometry2D,
      }),
      projected: false,
    });
  }
  if (options.projectToTarget !== true) {
    throw new TypeError("spatial-reference-mismatch");
  }
  const geometry = projectGeometry2D(feature.geometry, target, options);
  return Object.freeze({
    feature: Object.freeze({ ...feature, geometry }),
    projected: true,
  });
}

export function inspectSpatialFeatures(
  input: readonly SpatialFeature[],
  options: SpatialFeatureIntegrityOptions = {},
): SpatialFeatureIntegrityResult {
  const maxFeatures = positiveBudget(options.maxFeatures, DEFAULT_MAX_FEATURES, "maxFeatures");
  const maxIssues = positiveBudget(options.maxIssues, DEFAULT_MAX_ISSUES, "maxIssues");
  const maxIdLength = positiveBudget(options.maxIdLength, DEFAULT_MAX_ID_LENGTH, "maxIdLength");
  const maxTotalAttributeBytes = positiveBudget(
    options.maxTotalAttributeBytes,
    DEFAULT_MAX_TOTAL_ATTRIBUTE_BYTES,
    "maxTotalAttributeBytes",
  );
  if (input.length > maxFeatures) {
    throw new RangeError("feature collection exceeds configured budget");
  }

  const seen = new Set<string>();
  const features: SpatialFeature[] = [];
  const issues: SpatialFeatureIssue[] = [];
  let rejectedCount = 0;
  let duplicateCount = 0;
  let projectedCount = 0;
  let estimatedAttributeBytes = 0;

  for (let index = 0; index < input.length; index += 1) {
    throwIfAborted(options.signal);
    const candidate = input[index]!;
    let normalizedId: string | number | undefined;
    try {
      normalizedId = normalizeId(candidate.id, maxIdLength);
      const key = identityKey(normalizedId);
      if (seen.has(key)) {
        duplicateCount += 1;
        appendIssue(
          issues,
          {
            code: "duplicate-id",
            featureIndex: index,
            featureId: normalizedId,
            message: "duplicate feature identity",
          },
          maxIssues,
        );
        if (options.rejectDuplicateIds !== false) {
          rejectedCount += 1;
          continue;
        }
      } else {
        seen.add(key);
      }

      const normalized = normalizeFeature(candidate, options);
      const aligned = alignFeatureSpatialReference(normalized, options);
      const featureAttributeBytes = estimateAttributesBytes(aligned.feature.attributes);
      if (estimatedAttributeBytes + featureAttributeBytes > maxTotalAttributeBytes) {
        throw new RangeError("feature collection exceeds attribute byte budget");
      }
      features.push(aligned.feature);
      estimatedAttributeBytes += featureAttributeBytes;
      if (aligned.projected) projectedCount += 1;
    } catch (error) {
      const mismatch = error instanceof TypeError && error.message === "spatial-reference-mismatch";
      appendIssue(
        issues,
        {
          code: mismatch ? "spatial-reference-mismatch" : issueCode(error),
          featureIndex: index,
          ...(normalizedId === undefined ? {} : { featureId: normalizedId }),
          message: issueMessage(error),
        },
        maxIssues,
      );
      rejectedCount += 1;
      if (options.rejectInvalidFeatures === true) {
        throw error;
      }
    }
  }

  return Object.freeze({
    features: Object.freeze(features),
    issues: Object.freeze(issues),
    acceptedCount: features.length,
    rejectedCount,
    duplicateCount,
    projectedCount,
    estimatedAttributeBytes,
  });
}

export function projectSpatialFeatures(
  input: readonly SpatialFeature[],
  target: NormalizedSpatialReference,
  options: Omit<SpatialFeatureIntegrityOptions, "targetSpatialReference" | "projectToTarget"> = {},
): SpatialFeatureIntegrityResult {
  return inspectSpatialFeatures(input, {
    ...options,
    targetSpatialReference: target,
    projectToTarget: true,
  });
}

export function spatialFeatureCollectionExtent(
  input: readonly SpatialFeature[],
  options: SpatialFeatureIntegrityOptions = {},
): Readonly<{ extent: ReturnType<typeof geometryExtent2D>; spatialReference: NormalizedSpatialReference }> {
  const result = inspectSpatialFeatures(input, { ...options, rejectInvalidFeatures: true });
  if (result.features.length === 0) {
    throw new RangeError("feature collection has no accepted geometries");
  }

  const target = options.targetSpatialReference ?? result.features[0]!.geometry.spatialReference;
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;

  for (const feature of result.features) {
    throwIfAborted(options.signal);
    if (!spatialReferencesEquivalent(feature.geometry.spatialReference, target)) {
      throw new TypeError("feature collection contains mixed spatial references");
    }
    const extent = geometryExtent2D(feature.geometry, options);
    xmin = Math.min(xmin, extent.xmin);
    ymin = Math.min(ymin, extent.ymin);
    xmax = Math.max(xmax, extent.xmax);
    ymax = Math.max(ymax, extent.ymax);
  }

  return Object.freeze({
    extent: Object.freeze({ xmin, ymin, xmax, ymax }),
    spatialReference: target,
  });
}
