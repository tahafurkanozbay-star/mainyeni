export interface ServiceResult<TData = unknown> {
  readonly isSuccess: boolean;
  readonly data?: TData;
}

export interface MapConfigurationPayload {
  readonly configValue?: string | null;
  readonly [key: string]: unknown;
}

export interface BootstrapConfigurationOptions {
  readonly signal?: AbortSignal;
}

const DEFAULT_PUBLIC_MAP_CONFIGURATION = Object.freeze({
  Centerx: 32.854,
  Centery: 39.92,
  Zoom: 12,
});

const mapConfigurationResult = (): ServiceResult<MapConfigurationPayload> => ({
  isSuccess: true,
  data: { configValue: JSON.stringify(DEFAULT_PUBLIC_MAP_CONFIGURATION) },
});

const configurationServicesResult = (): ServiceResult<readonly unknown[]> => ({
  isSuccess: true,
  data: [],
});

/**
 * The public map no longer depends on the retired application API for startup.
 * Its initial view is local configuration; Kent Rehberi features are loaded
 * directly from the official PlanASKI endpoint by the browser.
 */
export const ConfigurationBusiness = Object.freeze({
  GetMapConfiguration: async (
    options: BootstrapConfigurationOptions = {},
  ): Promise<ServiceResult<MapConfigurationPayload>> => {
    options.signal?.throwIfAborted();
    return mapConfigurationResult();
  },

  /**
   * No private API catalogue is required. Feature data must be supplied by
   * explicitly integrated external services rather than a server-side proxy.
   */
  GetConfigServices: async (
    options: BootstrapConfigurationOptions = {},
  ): Promise<ServiceResult<readonly unknown[]>> => {
    options.signal?.throwIfAborted();
    return configurationServicesResult();
  },
});
