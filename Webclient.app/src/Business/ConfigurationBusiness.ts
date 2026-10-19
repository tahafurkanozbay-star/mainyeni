export interface ServiceResult<TData = unknown> {
  readonly isSuccess: true;
  readonly data: TData;
}
export interface MapConfigurationPayload { readonly configValue: string; }
export interface ConfigurationRequestOptions { readonly signal?: AbortSignal; }
const STATIC_MAP_CONFIGURATION = Object.freeze({ Centerx: 32.854, Centery: 39.92, Zoom: 12 });
const completed = <TData>(data: TData): ServiceResult<TData> => Object.freeze({ isSuccess: true as const, data });
const assertNotAborted = (options: ConfigurationRequestOptions): void => { options.signal?.throwIfAborted(); };
const getMapConfiguration = async (options: ConfigurationRequestOptions = {}): Promise<ServiceResult<MapConfigurationPayload>> => {
  assertNotAborted(options);
  return completed(Object.freeze({ configValue: JSON.stringify(STATIC_MAP_CONFIGURATION) }));
};
const getConfigServices = async (options: ConfigurationRequestOptions = {}): Promise<ServiceResult<readonly unknown[]>> => {
  assertNotAborted(options);
  return completed(Object.freeze([]) as readonly unknown[]);
};
export const ConfigurationBusiness = Object.freeze({ GetMapConfiguration: getMapConfiguration, GetConfigServices: getConfigServices });
