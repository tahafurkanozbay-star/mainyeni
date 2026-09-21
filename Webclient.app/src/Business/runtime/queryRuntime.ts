import type { QueryExecutionControl } from '../contracts';
import type {
  QueryPlan,
  QueryRuntime,
  QueryRuntimeDependencies,
} from './contracts';

const resultType = (value: unknown): number | null => {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Readonly<Record<string, unknown>>;
  const numeric = Number(record.type ?? record.Type);
  return Number.isFinite(numeric) ? numeric : null;
};

const resultFeatureCount = (value: unknown): number => {
  if (value === null || typeof value !== 'object') return 0;
  const record = value as Readonly<Record<string, unknown>>;
  const data = record.data ?? record.Data;
  return Array.isArray(data) ? data.length : 0;
};

const errorCode = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error && typeof error === 'object') {
    const record = error as Readonly<Record<string, unknown>>;
    if (typeof record.code === 'string') return record.code.slice(0, 120);
    if (typeof record.name === 'string') return record.name.slice(0, 120);
  }
  return 'ERROR';
};

export const createQueryRuntime = (
  dependencies: QueryRuntimeDependencies,
): QueryRuntime => Object.freeze({
  async execute(
    plan: QueryPlan,
    control: QueryExecutionControl = {},
  ): Promise<unknown> {
    const diagnostic = dependencies.diagnostics.begin('business.query.execute', {
      serviceKey: plan.serviceKey,
      metadata: Object.freeze({
        fingerprint: plan.fingerprint,
        spatial: plan.spatial,
      }),
    });

    const options = {
      ...plan.options,
      ...(control.signal ? { signal: control.signal } : {}),
      ...(control.cache !== undefined ? { cache: control.cache } : {}),
      ...(control.cacheTtlMs !== undefined
        ? { ttlMs: control.cacheTtlMs }
        : {}),
    };

    try {
      const result = plan.spatial
        ? await dependencies.executeSpatialQuery(options)
        : await dependencies.executeQuery(options);
      const featureCount = resultFeatureCount(result);
      const status = resultType(result) === 20
        ? 'failure'
        : featureCount === 0
          ? 'empty'
          : 'success';
      diagnostic.finish(status, { featureCount });
      return result;
    } catch (error) {
      const cancelled = control.signal?.aborted === true;
      diagnostic.finish(cancelled ? 'cancelled' : 'failure', {
        code: errorCode(error),
      });
      throw error;
    }
  },
});
