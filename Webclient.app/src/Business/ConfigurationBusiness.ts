import { AppError } from '../platform/errors/appError';
import { apiClient } from '../platform/http/httpClient';
import type { RawRequestConfig } from '../platform/http/contracts';

export interface ServiceResult<TData = unknown> {
  readonly isSuccess: boolean;
  readonly data?: TData;
}

export interface MapConfigurationPayload {
  readonly configValue?: string | null;
  readonly [key: string]: unknown;
}

type ConfigurationRequestOptions = Omit<RawRequestConfig, 'method' | 'url' | 'data' | 'params'>;

const isServiceResult = (value: unknown): value is ServiceResult<unknown> => {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { readonly isSuccess?: unknown }).isSuccess === 'boolean';
};

const ensureServiceResult = <TData>(result: unknown): ServiceResult<TData> => {
  if (isServiceResult(result)) return result as ServiceResult<TData>;
  throw new AppError('Geçersiz API yanıtı.', {
    code: 'INVALID_RESPONSE',
    retryable: false,
  });
};

const publicBootstrapOptions = (
  options: ConfigurationRequestOptions = {},
): ConfigurationRequestOptions => ({
  ...options,
  cache: true,
  dedupe: !options.signal,
  cacheTtlMs: options.cacheTtlMs ?? 120_000,
});

export const resolveLocalBootstrapPreviewEnabled = (
  dev: unknown,
  mode: unknown,
  configured: unknown,
): boolean => {
  if (dev !== true) return false;

  const normalizedMode = String(mode ?? '').trim().toLowerCase();
  if (normalizedMode === 'test') return false;

  const normalizedSetting = String(configured ?? '').trim().toLowerCase();
  if (!normalizedSetting) return true;

  return !['0', 'false', 'no', 'off', 'disabled'].includes(normalizedSetting);
};

const localBootstrapPreviewEnabled = resolveLocalBootstrapPreviewEnabled(
  import.meta.env.DEV,
  import.meta.env.MODE,
  import.meta.env.VITE_LOCAL_BOOTSTRAP_PREVIEW,
);

const localPreviewMapConfiguration = Object.freeze({
  Centerx: 32.854,
  Centery: 39.92,
  Zoom: 12,
});

const getMapConfiguration = async (
  options: ConfigurationRequestOptions = {},
): Promise<ServiceResult<MapConfigurationPayload>> => {
  if (localBootstrapPreviewEnabled) {
    return {
      isSuccess: true,
      data: { configValue: JSON.stringify(localPreviewMapConfiguration) },
    };
  }

  const result = await apiClient.get<unknown>('/AppSettings/List', {
    ...publicBootstrapOptions(options),
    params: { key: 'GisMapConfig' },
  });
  return ensureServiceResult<MapConfigurationPayload>(result);
};

const getConfigServices = async (
  options: ConfigurationRequestOptions = {},
): Promise<ServiceResult<readonly unknown[]>> => {
  if (localBootstrapPreviewEnabled) {
    return { isSuccess: true, data: [] };
  }

  const result = await apiClient.get<unknown>(
    '/Gis/ConfigService/List',
    publicBootstrapOptions(options),
  );
  return ensureServiceResult<readonly unknown[]>(result);
};

export const ConfigurationBusiness = Object.freeze({
  GetMapConfiguration: getMapConfiguration,
  GetConfigServices: getConfigServices,
});
