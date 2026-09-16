export type GisViewKind = '2d' | '3d';
export type GisQualityTier = 'economy' | 'balanced' | 'quality' | 'ultra';
export type GisCircuitState = 'closed' | 'open' | 'half-open';
export type GisHealthState = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type GisNetworkClass = 'offline' | 'constrained' | 'normal' | 'fast' | 'unknown';
export type GisMemoryPressure = 'low' | 'moderate' | 'high' | 'critical';
export type GisFramePressure = 'none' | 'mild' | 'high' | 'critical';

export interface GisSpatialReference {
  readonly wkid?: number;
  readonly wkt?: string;
}

export interface GisExtent {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly spatialReference?: GisSpatialReference;
}

export interface GisViewSnapshot {
  readonly kind: GisViewKind;
  readonly scale?: number | null;
  readonly cameraDistance?: number | null;
  readonly stationary?: boolean;
  readonly interacting?: boolean;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly devicePixelRatio?: number | null;
  readonly extent?: GisExtent | null;
  readonly timestamp?: number;
}

export interface GisDeviceSnapshot {
  readonly memoryGb?: number | null;
  readonly logicalCores?: number | null;
  readonly devicePixelRatio?: number | null;
  readonly reducedMotion?: boolean;
  readonly saveData?: boolean;
  readonly effectiveType?: string | null;
  readonly networkClass?: GisNetworkClass;
}

export interface GisRenderBudget {
  readonly tier: GisQualityTier;
  readonly maxVisibleFeatures: number;
  readonly maxPointSymbols: number;
  readonly maxLabels: number;
  readonly maxSceneNodes: number;
  readonly maxResidentBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxConcurrentLayerLoads: number;
  readonly sceneQuality: number;
  readonly labelDensity: number;
  readonly enableShadows: boolean;
  readonly enableExtrusion: boolean;
  readonly allowPrefetch: boolean;
  readonly geometryDetail: number;
  readonly framePressure: GisFramePressure;
  readonly memoryPressure: GisMemoryPressure;
}

export interface GisLayerDescriptor {
  readonly id: string;
  readonly serviceId?: string | null;
  readonly resourceUrl?: string | null;
  readonly resourceKind?: string | null;
  readonly geometryType?: string | null;
  readonly estimatedFeatureCount?: number | null;
  readonly estimatedBytes?: number | null;
  readonly importance?: number | null;
  readonly minScale?: number | null;
  readonly maxScale?: number | null;
  readonly visible?: boolean;
  readonly pinned?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GisRequestMetric {
  readonly serviceId: string;
  readonly startedAt: number;
  readonly durationMs?: number | null;
  readonly ok?: boolean;
  readonly status?: number | null;
  readonly bytes?: number | null;
  readonly transferLimitExceeded?: boolean;
  readonly cancelled?: boolean;
  readonly timeout?: boolean;
  readonly retryable?: boolean;
  readonly errorCode?: string | null;
}

export interface GisServiceHealthSnapshot {
  readonly serviceId: string;
  readonly resourceUrl: string;
  readonly state: GisHealthState;
  readonly circuit: GisCircuitState;
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly timeoutCount: number;
  readonly cancellationCount: number;
  readonly transferLimitCount: number;
  readonly averageLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly circuitOpenedAt: number | null;
  readonly nextProbeAt: number | null;
  readonly inFlight: number;
  readonly healthScore: number;
}

export interface GisDiagnosticEvent {
  readonly sequence: number;
  readonly timestamp: number;
  readonly type: string;
  readonly severity: 'debug' | 'info' | 'warning' | 'error';
  readonly serviceId?: string | null;
  readonly layerId?: string | null;
  readonly traceId?: string | null;
  readonly durationMs?: number | null;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface GisStreamingCandidate {
  readonly id: string;
  readonly layerId: string;
  readonly serviceId?: string | null;
  readonly resourceUrl?: string | null;
  readonly resourceKind?: string | null;
  readonly estimatedBytes: number;
  readonly distance?: number | null;
  readonly screenArea?: number | null;
  readonly importance?: number | null;
  readonly visible?: boolean;
  readonly loaded?: boolean;
  readonly loading?: boolean;
  readonly lastUsedAt?: number | null;
  readonly revision?: string | number | null;
}

export interface GisStreamingDecision {
  readonly load: readonly string[];
  readonly prefetch: readonly string[];
  readonly retain: readonly string[];
  readonly evict: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly estimatedLoadBytes: number;
  readonly estimatedResidentBytes: number;
  readonly maxResidentBytes: number;
  readonly maxLoads: number;
}

export interface GisKernelSnapshot {
  readonly destroyed: boolean;
  readonly registeredServices: number;
  readonly registeredLayers: number;
  readonly inFlightRequests: number;
  readonly qualityTier: GisQualityTier;
  readonly renderBudget: GisRenderBudget;
  readonly metrics: Readonly<Record<string, number>>;
  readonly services: readonly GisServiceHealthSnapshot[];
}

export class GisContractError extends Error {
  readonly code: string;
  readonly field: string | null;

  constructor(message: string, details: { code?: string; field?: string | null } = {}) {
    super(message);
    this.name = 'GisContractError';
    this.code = details.code || 'GIS_CONTRACT_ERROR';
    this.field = details.field || null;
  }
}

export const finiteNumber = (value: unknown, fallback: number | null = null): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const clampNumber = (value: unknown, min: number, max: number, fallback = min): number => {
  const number = finiteNumber(value, fallback) ?? fallback;
  return Math.min(max, Math.max(min, number));
};

export const positiveInteger = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
};

export const nonNegativeInteger = (
  value: unknown,
  fallback = 0,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const number = finiteNumber(value);
  if (number === null || number < 0) return fallback;
  return Math.min(max, Math.max(0, Math.floor(number)));
};

export const normalizeIdentifier = (value: unknown, field = 'id'): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new GisContractError(`${field} is required.`, {
      code: 'MISSING_IDENTIFIER',
      field,
    });
  }
  if (normalized.length > 256) {
    throw new GisContractError(`${field} exceeds the bounded identifier length.`, {
      code: 'IDENTIFIER_TOO_LONG',
      field,
    });
  }
  if (/[^\P{C}\t\n\r]/u.test(normalized)) {
    throw new GisContractError(`${field} contains unsupported control characters.`, {
      code: 'INVALID_IDENTIFIER',
      field,
    });
  }
  return normalized;
};

export const normalizeSpatialReference = (value: unknown): GisSpatialReference | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const wkid = positiveInteger(value, 0, 100000000);
    return wkid > 0 ? Object.freeze({ wkid }) : null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const wkid = positiveInteger(record.latestWkid ?? record.wkid, 0, 100000000);
  if (wkid > 0) return Object.freeze({ wkid });
  const wkt = typeof record.wkt === 'string' ? record.wkt.trim() : '';
  if (!wkt) return null;
  if (wkt.length > 32768) {
    throw new GisContractError('Spatial reference WKT exceeds the bounded length.', {
      code: 'SPATIAL_REFERENCE_TOO_LONG',
      field: 'wkt',
    });
  }
  return Object.freeze({ wkt });
};

export const normalizeExtent = (value: unknown): GisExtent | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const xmin = finiteNumber(record.xmin);
  const ymin = finiteNumber(record.ymin);
  const xmax = finiteNumber(record.xmax);
  const ymax = finiteNumber(record.ymax);
  if (xmin === null || ymin === null || xmax === null || ymax === null) return null;
  if (xmin > xmax || ymin > ymax) {
    throw new GisContractError('Extent bounds are inverted.', {
      code: 'INVALID_EXTENT_BOUNDS',
      field: 'extent',
    });
  }
  const spatialReference = normalizeSpatialReference(record.spatialReference);
  return Object.freeze({
    xmin,
    ymin,
    xmax,
    ymax,
    ...(spatialReference ? { spatialReference } : {}),
  });
};

const canonicalize = (value: unknown, depth = 0): unknown => {
  if (depth > 16) return '[depth-limit]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((accumulator, key) => {
      const item = record[key];
      if (item !== undefined) accumulator[key] = canonicalize(item, depth + 1);
      return accumulator;
    }, {});
};

export const stableSerialize = (value: unknown): string => JSON.stringify(canonicalize(value));

export const fnv1aHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const createDeterministicFingerprint = (namespace: string, value: unknown): string => {
  const serialized = stableSerialize(value);
  return `${normalizeIdentifier(namespace, 'namespace')}:${fnv1aHash(serialized)}:${serialized.length}`;
};

export const uniqueStrings = (values: readonly unknown[] = []): string[] => [...new Set(
  values
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim()),
)];

export const classifyNetwork = (input: {
  online?: boolean;
  saveData?: boolean;
  effectiveType?: string | null;
} = {}): GisNetworkClass => {
  if (input.online === false) return 'offline';
  if (input.saveData === true) return 'constrained';
  const effectiveType = String(input.effectiveType || '').toLowerCase();
  if (effectiveType === 'slow-2g' || effectiveType === '2g') return 'constrained';
  if (effectiveType === '4g') return 'fast';
  if (effectiveType === '3g') return 'normal';
  return 'unknown';
};

export const classifyMemoryPressure = (
  residentBytes: unknown,
  maxBytes: unknown,
): GisMemoryPressure => {
  const resident = Math.max(0, finiteNumber(residentBytes, 0) ?? 0);
  const maximum = Math.max(1, finiteNumber(maxBytes, 1) ?? 1);
  const ratio = resident / maximum;
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.82) return 'high';
  if (ratio >= 0.62) return 'moderate';
  return 'low';
};

export const classifyFramePressure = (
  p95FrameMs: unknown,
  longFrameRatio: unknown,
): GisFramePressure => {
  const p95 = Math.max(0, finiteNumber(p95FrameMs, 0) ?? 0);
  const ratio = clampNumber(longFrameRatio, 0, 1, 0);
  if (p95 >= 80 || ratio >= 0.4) return 'critical';
  if (p95 >= 50 || ratio >= 0.25) return 'high';
  if (p95 >= 28 || ratio >= 0.12) return 'mild';
  return 'none';
};

export const percentile = (values: readonly number[], ratio: number): number => {
  if (!values.length) return 0;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const normalized = clampNumber(ratio, 0, 1, 0.95);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * normalized) - 1));
  return sorted[index] ?? 0;
};

export const average = (values: readonly number[]): number => {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return 0;
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
};

export const createMonotonicSequence = (initial = 0): (() => number) => {
  let value = nonNegativeInteger(initial);
  return () => {
    value += 1;
    if (!Number.isSafeInteger(value)) value = 1;
    return value;
  };
};
