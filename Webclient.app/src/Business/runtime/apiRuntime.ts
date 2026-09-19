import type { RawRequestConfig } from '../../platform/http/contracts';
import type {
  ApiRequestControl,
  ApiRuntime,
  ApiRuntimeDependencies,
} from './contracts';
import {
  DEFAULT_BUSINESS_RUNTIME_POLICY,
  normalizeApiRequestControl,
} from './policy';

const errorCode = (error: unknown): string => {
  if (error instanceof Error) return error.name || 'Error';
  if (error && typeof error === 'object') {
    const record = error as Readonly<Record<string, unknown>>;
    if (typeof record.code === 'string') return record.code.slice(0, 120);
  }
  return 'ERROR';
};

const requestOptions = (
  params: Readonly<Record<string, unknown>> | undefined,
  control: ApiRequestControl,
): RawRequestConfig => {
  const normalized = normalizeApiRequestControl(
    control,
    DEFAULT_BUSINESS_RUNTIME_POLICY,
  );
  return {
    ...(params ? { params } : {}),
    cache: normalized.cache,
    dedupe: normalized.dedupe,
    cacheTtlMs: normalized.cacheTtlMs,
    timeoutMs: normalized.timeoutMs,
    ...(normalized.signal ? { signal: normalized.signal } : {}),
  };
};

export const createApiRuntime = (
  dependencies: ApiRuntimeDependencies,
): ApiRuntime => Object.freeze({
  async get<TResult = unknown>(
    operation: string,
    url: string,
    options = {},
  ): Promise<TResult> {
    const diagnostic = dependencies.diagnostics.begin(operation, {
      ...(options.serviceKey ? { serviceKey: options.serviceKey } : {}),
      metadata: Object.freeze({ method: 'GET' }),
    });

    try {
      const result = await dependencies.client.get<TResult>(
        url,
        requestOptions(options.params, options.control ?? {}),
      );
      diagnostic.finish('success');
      return result;
    } catch (error) {
      diagnostic.finish(
        options.control?.signal?.aborted === true ? 'cancelled' : 'failure',
        { code: errorCode(error) },
      );
      throw error;
    }
  },
});
