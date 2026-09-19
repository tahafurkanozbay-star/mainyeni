import type {
  FastAccessQuery,
  QueryExecutionControl,
  UnknownRecord,
} from './contracts';
import { createFastAccessBusiness } from './fastAccessRuntime';

interface FastAccessGeometryResult {
  readonly latitude?: unknown;
  readonly longitude?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly centroid?: FastAccessGeometryResult | null;
  readonly extent?: {
    readonly center?: FastAccessGeometryResult | null;
  } | null;
}

interface FastAccessFeatureResult {
  readonly attr?: UnknownRecord | null;
  readonly attributes?: UnknownRecord | null;
  readonly geometry?: FastAccessGeometryResult | null;
  readonly raw?: {
    readonly geometry?: FastAccessGeometryResult | null;
  } | null;
}

interface FastAccessServiceResult {
  readonly type?: unknown;
  readonly data?: readonly FastAccessFeatureResult[] | null;
  readonly message?: unknown;
  readonly errorMessage?: unknown;
}

export interface FastAccessQueryBusiness {
  readonly Query: (
    query?: FastAccessQuery,
    returnGeometry?: boolean,
    options?: QueryExecutionControl,
  ) => Promise<FastAccessServiceResult>;
}

const asFastAccessServiceResult = (value: unknown): FastAccessServiceResult => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as FastAccessServiceResult;
};

export const createFastAccessQueryBusiness = (serviceKey: string): FastAccessQueryBusiness => {
  const business = createFastAccessBusiness(serviceKey);

  return Object.freeze({
    Query: async (
      query: FastAccessQuery = {},
      returnGeometry = false,
      options: QueryExecutionControl = {},
    ): Promise<FastAccessServiceResult> => asFastAccessServiceResult(
      await business.Query(query, returnGeometry, options),
    ),
  });
};
