import { MapManager } from '../Store/Managers/MapManager';
import { GisQueryHelper } from '../Toolbox/GisQueryHelper';
import { CommonBusiness } from './CommonBusiness';
import {
  type ArcGisQueryOptions,
  type FastAccessQuery,
  type QueryBusiness,
  type QueryExecutionControl,
  type ServiceDescriptor,
  normalizeServiceDescriptor,
  serviceTitle,
  serviceUrl,
} from './contracts';
import { createBusinessQueryRuntime } from './serviceRuntime';

const configurationServices = (): readonly ServiceDescriptor[] => {
  const value = MapManager.GetConfigurationServices?.();
  if (!Array.isArray(value)) return Object.freeze([]);
  const services = value
    .map(normalizeServiceDescriptor)
    .filter((service): service is ServiceDescriptor => service !== null);
  return Object.freeze(services);
};

const findService = (serviceKey: string): ServiceDescriptor | null => {
  const services = configurationServices();
  return services.find((service) => serviceTitle(service) === serviceKey) ?? null;
};

const resolveUrl = (service: ServiceDescriptor): string | null => {
  const generated = CommonBusiness.GenerateUrl?.(service);
  return typeof generated === 'string' && generated.trim().length > 0
    ? generated.trim()
    : serviceUrl(service);
};

const executeQuery = async (
  options: ArcGisQueryOptions,
  control: QueryExecutionControl = {},
): Promise<unknown> => {
  if (control.signal?.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
  return GisQueryHelper.ExecuteQuery(options);
};

const executeSpatialQuery = async (
  options: ArcGisQueryOptions,
  control: QueryExecutionControl = {},
): Promise<unknown> => {
  if (control.signal?.aborted) throw control.signal.reason ?? new DOMException('Aborted', 'AbortError');
  return GisQueryHelper.ExecuteSpatialQuery(options);
};

export const fastAccessRuntime = createBusinessQueryRuntime({
  resolveService: Object.freeze({
    list: configurationServices,
    find: findService,
    resolveUrl,
  }),
  executor: Object.freeze({
    execute: executeQuery,
    executeSpatial: executeSpatialQuery,
  }),
  maxDiagnostics: 160,
  maxCacheEntries: 160,
  maxConcurrent: 6,
});

export const createFastAccessBusiness = (serviceKey: string): QueryBusiness =>
  fastAccessRuntime.createBusiness(serviceKey);

export const queryFastAccessService = (
  serviceKey: string,
  query: FastAccessQuery = {},
  returnGeometry = false,
  control: QueryExecutionControl = {},
): Promise<unknown> => fastAccessRuntime.query(serviceKey, query, returnGeometry, control);
