import type { ArcGisQueryOptions } from '../contracts';
import type {
  BusinessRuntimePolicy,
  QueryPlan,
  QueryPlanner,
  QueryPlannerInput,
} from './contracts';
import { BusinessQueryPlanError } from './contracts';
import { DEFAULT_BUSINESS_RUNTIME_POLICY, normalizeNearbyDistance } from './policy';

const stableText = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const record = input as Readonly<Record<string, unknown>>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'))) {
      output[key] = normalize(record[key]);
    }
    return output;
  };
  return JSON.stringify(normalize(value));
};

const hash = (value: string): string => {
  let state = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16_777_619);
  }
  return (state >>> 0).toString(16).padStart(8, '0');
};

const normalizeFields = (
  values: readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] => {
  const source = values ?? fallback;
  const result = Array.from(
    new Set(
      source
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .slice(0, 128),
    ),
  );
  return Object.freeze(result);
};

const normalizeWhere = (
  value: unknown,
  policy: BusinessRuntimePolicy,
): string => {
  const text = String(value ?? '1=1').trim() || '1=1';
  if (text.length > policy.maxWhereLength) {
    throw new BusinessQueryPlanError(
      'BUSINESS_WHERE_LIMIT_EXCEEDED',
      'Sorgu filtresi güvenli uzunluk sınırını aştı.',
      Object.freeze({ length: text.length, max: policy.maxWhereLength }),
    );
  }
  return text;
};

export const createQueryPlanner = (
  requireServiceUrl: (serviceKey: string) => string,
  policy: BusinessRuntimePolicy = DEFAULT_BUSINESS_RUNTIME_POLICY,
): QueryPlanner => Object.freeze({
  plan(input: QueryPlannerInput): QueryPlan {
    const serviceKey = String(input.serviceKey ?? '').trim();
    if (!serviceKey) {
      throw new BusinessQueryPlanError(
        'BUSINESS_SERVICE_KEY_REQUIRED',
        'Servis anahtarı zorunludur.',
      );
    }

    const options: ArcGisQueryOptions = {
      url: requireServiceUrl(serviceKey),
      returnGeometry: input.returnGeometry === true,
      orderByFields: normalizeFields(input.orderByFields, []),
      outFields: normalizeFields(input.outFields, ['*']),
      where: normalizeWhere(input.where, policy),
    };

    let spatial = false;
    if (input.spatial) {
      spatial = true;
      options.geometry = input.spatial.geometry;
      const explicitMeters = Number(input.spatial.distanceMeters);
      options.distance = Number.isFinite(explicitMeters) && explicitMeters >= 0
        ? explicitMeters
        : normalizeNearbyDistance(input.spatial.distance, policy) * 100;
      options.units = input.spatial.units ?? 'meters';
      options.spatialRelationship =
        input.spatial.spatialRelationship ?? 'intersects';
    }

    const fingerprint = hash(stableText({
      serviceKey,
      returnGeometry: options.returnGeometry,
      orderByFields: options.orderByFields,
      outFields: options.outFields,
      where: options.where,
      spatial,
      distance: options.distance ?? null,
      units: options.units ?? null,
      spatialRelationship: options.spatialRelationship ?? null,
    }));

    return Object.freeze({
      serviceKey,
      options: Object.freeze({ ...options }),
      spatial,
      fingerprint,
    });
  },
});
