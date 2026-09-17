import { type ArcGisMetadataContract } from './arcgisMetadataAdapter';
import { type ArcGisQuerySpec } from './arcgisQueryContract';
import { applyArcGisFeatureWindowPlan, planArcGisFeatureWindow } from './arcgisFeatureWindowPlanner';
import {
  createArcGisQueryExecutor,
  type ArcGisFeature,
  type ArcGisQueryExecutionOptions,
  type ArcGisQueryTransport,
  type ArcGisScheduler,
} from './arcgisQueryExecutor';
import { readArcgisFeatureWindow, type FeatureWindowResult } from './arcgisFeatureWindow';

export type ArcGisFeatureWindowExecutionOptions = ArcGisQueryExecutionOptions & Readonly<{ pageSize?: number; maxFeatures?: number; maxPages?: number }>;

const featureIdentity = (contract: ArcGisMetadataContract, feature: ArcGisFeature): string | number | undefined => {
  for (const field of [contract.objectIdField, contract.globalIdField]) {
    if (!field) continue;
    const value = feature.attributes[field];
    if (typeof value === 'string' || typeof value === 'number') return value;
  }
  return undefined;
};

const windowSpec = (spec: ArcGisQuerySpec, offset: number, limit: number): ArcGisQuerySpec => Object.freeze({
  ...spec,
  window: Object.freeze({ resultOffset: offset, resultRecordCount: limit }),
});

/** Composes verified metadata, deterministic planning, query execution and bounded feature-window ownership. */
export const createArcGisFeatureWindowExecutor = (dependencies: Readonly<{
  transport: ArcGisQueryTransport;
  scheduler?: ArcGisScheduler;
  defaultPageSize?: number;
  defaultMaxFeatures?: number;
  defaultMaxPages?: number;
}>): Readonly<{
  execute(contract: ArcGisMetadataContract, spec: ArcGisQuerySpec, options?: ArcGisFeatureWindowExecutionOptions): Promise<FeatureWindowResult<ArcGisFeature>>;
}> => {
  const queryExecutor = createArcGisQueryExecutor(dependencies);
  const execute = async (contract: ArcGisMetadataContract, spec: ArcGisQuerySpec, options: ArcGisFeatureWindowExecutionOptions = {}): Promise<FeatureWindowResult<ArcGisFeature>> => {
    const plan = planArcGisFeatureWindow(contract, spec, {
      pageSize: options.pageSize ?? dependencies.defaultPageSize,
      maxFeatures: options.maxFeatures ?? dependencies.defaultMaxFeatures,
      maxPages: options.maxPages ?? dependencies.defaultMaxPages,
    });
    const plannedSpec = applyArcGisFeatureWindowPlan(spec, plan);
    const signal = options.signal ?? new AbortController().signal;
    return readArcgisFeatureWindow<ArcGisFeature>({
      pageSize: plan.pageSize,
      maxFeatures: plan.maxFeatures,
      maxPages: plan.maxPages,
      identity: (feature) => featureIdentity(contract, feature),
      fetchPage: async (offset, limit, pageSignal) => {
        const result = await queryExecutor.execute(contract, windowSpec(plannedSpec, offset, limit), {
          ...options,
          signal: pageSignal,
          rejectTransferLimit: false,
          requireStableIdentity: true,
        });
        return Object.freeze({ features: result.features, exceededTransferLimit: result.exceededTransferLimit, nextOffset: offset + result.rawFeatureCount });
      },
    }, signal);
  };
  return Object.freeze({ execute });
};
