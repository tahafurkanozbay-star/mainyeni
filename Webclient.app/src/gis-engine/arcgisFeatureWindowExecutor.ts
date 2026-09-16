import { type ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { type ArcGisQuerySpec } from './arcgisQueryContract';
import {
  createArcGisQueryExecutor,
  type ArcGisFeature,
  type ArcGisQueryExecutionOptions,
  type ArcGisQueryTransport,
  type ArcGisScheduler,
} from './arcgisQueryExecutor';
import { readArcgisFeatureWindow, type FeatureWindowResult } from './arcgisFeatureWindow';

export type ArcGisFeatureWindowExecutionOptions = ArcGisQueryExecutionOptions & Readonly<{
  pageSize?: number;
  maxFeatures?: number;
  maxPages?: number;
}>;

export class ArcGisFeatureWindowExecutionError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARCGIS_FEATURE_WINDOW_EXECUTION_ERROR') {
    super(message);
    this.name = 'ArcGisFeatureWindowExecutionError';
    this.code = code;
  }
}

const boundedPositiveInteger = (value: unknown, fallback: number, maximum: number): number => {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return fallback;
  return Math.min(numeric, maximum);
};

const featureIdentity = (contract: ArcGisMetadataContract, feature: ArcGisFeature): string | number | undefined => {
  const objectIdField = contract.objectIdField;
  if (objectIdField) {
    const value = feature.attributes[objectIdField];
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  const globalIdField = contract.globalIdField;
  if (globalIdField) {
    const value = feature.attributes[globalIdField];
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  return undefined;
};

const windowSpec = (spec: ArcGisQuerySpec, offset: number, limit: number): ArcGisQuerySpec => Object.freeze({
  ...spec,
  window: Object.freeze({ resultOffset: offset, resultRecordCount: limit }),
});

/**
 * Composes verified metadata, the existing query executor and the bounded feature-window primitive.
 * It deliberately owns no endpoint discovery or direct network transport.
 */
export const createArcGisFeatureWindowExecutor = (dependencies: Readonly<{
  transport: ArcGisQueryTransport;
  scheduler?: ArcGisScheduler;
  defaultPageSize?: number;
  defaultMaxFeatures?: number;
  defaultMaxPages?: number;
}>): Readonly<{
  execute(
    contract: ArcGisMetadataContract,
    spec: ArcGisQuerySpec,
    options?: ArcGisFeatureWindowExecutionOptions,
  ): Promise<FeatureWindowResult<ArcGisFeature>>;
}> => {
  const queryExecutor = createArcGisQueryExecutor(dependencies);
  const defaultPageSize = boundedPositiveInteger(dependencies.defaultPageSize, 500, 10_000);
  const defaultMaxFeatures = boundedPositiveInteger(dependencies.defaultMaxFeatures, 10_000, 100_000);
  const defaultMaxPages = boundedPositiveInteger(dependencies.defaultMaxPages, 50, 1_000);

  const execute = async (
    contract: ArcGisMetadataContract,
    spec: ArcGisQuerySpec,
    options: ArcGisFeatureWindowExecutionOptions = {},
  ): Promise<FeatureWindowResult<ArcGisFeature>> => {
    if (!contract.queryReady) {
      throw new ArcGisFeatureWindowExecutionError('ArcGIS metadata contract is not query-ready.', 'METADATA_NOT_QUERY_READY');
    }
    if (!contract.supportsPagination) {
      throw new ArcGisFeatureWindowExecutionError(
        'Bounded feature-window execution requires verified ArcGIS pagination support.',
        'PAGINATION_UNSUPPORTED',
      );
    }
    if (!contract.objectIdField && !contract.globalIdField) {
      throw new ArcGisFeatureWindowExecutionError(
        'Bounded feature-window execution requires a verified stable service identity.',
        'STABLE_IDENTITY_REQUIRED',
      );
    }

    const pageSize = boundedPositiveInteger(options.pageSize, defaultPageSize, Math.max(1, contract.maxRecordCount));
    const maxFeatures = boundedPositiveInteger(options.maxFeatures, defaultMaxFeatures, 100_000);
    const maxPages = boundedPositiveInteger(options.maxPages, defaultMaxPages, 1_000);
    const signal = options.signal ?? new AbortController().signal;

    return readArcgisFeatureWindow<ArcGisFeature>({
      pageSize,
      maxFeatures,
      maxPages,
      identity: (feature) => featureIdentity(contract, feature),
      fetchPage: async (offset, limit, pageSignal) => {
        const result = await queryExecutor.execute(contract, windowSpec(spec, offset, limit), {
          ...options,
          signal: pageSignal,
          rejectTransferLimit: false,
          requireStableIdentity: true,
        });
        return Object.freeze({
          features: result.features,
          exceededTransferLimit: result.exceededTransferLimit,
          nextOffset: offset + result.rawFeatureCount,
        });
      },
    }, signal);
  };

  return Object.freeze({ execute });
};
