import { executeQueryJSON } from '@arcgis/core/rest/query.js';
import type Geometry from '@arcgis/core/geometry/Geometry.js';

type ArcGisQueryInput = Parameters<typeof executeQueryJSON>[1];
type ArcGisRequestOptions = NonNullable<Parameters<typeof executeQueryJSON>[2]>;

export interface GisQueryOptions {
  readonly url: string;
  readonly returnDistinctValues?: boolean;
  readonly orderByFields?: readonly string[] | null;
  readonly returnGeometry?: boolean;
  readonly outFields?: readonly string[] | null;
  readonly where?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface GisSpatialQueryOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly [key: string]: unknown;
}

export interface GisQueryResult {
  readonly attr: Readonly<Record<string, unknown>>;
  readonly geometry: Geometry | null;
}

const DEFAULT_QUERY_TIMEOUT_MS = 20_000;
const MIN_QUERY_TIMEOUT_MS = 1_000;
const MAX_QUERY_TIMEOUT_MS = 60_000;

const clampTimeout = (value: unknown): number => {
  const timeout = typeof value === 'number' && Number.isFinite(value)
    ? value
    : DEFAULT_QUERY_TIMEOUT_MS;
  return Math.min(MAX_QUERY_TIMEOUT_MS, Math.max(MIN_QUERY_TIMEOUT_MS, timeout));
};

const normalizeServiceUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('ArcGIS query URL is required.');
  }
  return value.trim();
};

const createBoundedSignal = (
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; cleanup: () => void }> => {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(new DOMException('ArcGIS query timed out.', 'TimeoutError')),
    clampTimeout(timeoutMs),
  );

  const abortFromExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }

  return Object.freeze({
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  });
};

const toResult = (
  feature: Readonly<{
    attributes?: Record<string, unknown> | null;
    geometry?: Geometry | null;
  }>,
): GisQueryResult => Object.freeze({
  attr: Object.freeze(Object.assign({}, feature.attributes)),
  geometry: feature.geometry ?? null,
});

const executeBoundedQuery = async (
  url: string,
  query: ArcGisQueryInput,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<readonly GisQueryResult[] | null> => {
  const bounded = createBoundedSignal(signal, timeoutMs);
  try {
    const featureSet = await executeQueryJSON(
      normalizeServiceUrl(url),
      query,
      { signal: bounded.signal } as ArcGisRequestOptions,
    );
    return Object.freeze(featureSet.features.map(toResult));
  } catch {
    return null;
  } finally {
    bounded.cleanup();
  }
};

const buildAttributeQuery = (options: GisQueryOptions): ArcGisQueryInput => ({
  returnDistinctValues: options.returnDistinctValues ?? false,
  orderByFields: options.orderByFields ? [...options.orderByFields] : undefined,
  returnGeometry: options.returnGeometry ?? false,
  outFields: options.outFields ? [...options.outFields] : undefined,
  where: options.where ?? undefined,
});

const executeAttributeQuery = (
  options: GisQueryOptions,
): Promise<readonly GisQueryResult[] | null> =>
  executeBoundedQuery(
    options.url,
    buildAttributeQuery(options),
    options.signal,
    options.timeoutMs,
  );

const executeSpatialQuery = (
  options: GisSpatialQueryOptions,
): Promise<readonly GisQueryResult[] | null> => {
  const {
    url,
    signal,
    timeoutMs,
    ...queryProperties
  } = options;

  return executeBoundedQuery(
    url,
    queryProperties as ArcGisQueryInput,
    signal,
    timeoutMs,
  );
};

export const GisQueryHelper = Object.freeze({
  ExecuteQueryAsync: executeAttributeQuery,
  ExecuteQuery: executeAttributeQuery,
  ExecuteSpatialQuery: executeSpatialQuery,
});
