import type { ServiceDescriptor } from '../contracts';
import {
  normalizeServiceDescriptor,
  serviceTitle,
  serviceUrl,
} from '../contracts';
import type {
  ServiceRegistry,
  ServiceRegistryDependencies,
  ServiceRegistryEntry,
} from './contracts';
import { MissingBusinessServiceError } from './contracts';

const toServices = (value: unknown): readonly ServiceDescriptor[] => {
  if (!Array.isArray(value)) return Object.freeze([]);
  const result: ServiceDescriptor[] = [];
  for (const candidate of value) {
    const service = normalizeServiceDescriptor(candidate);
    if (service) result.push(service);
  }
  return Object.freeze(result);
};

export const createServiceRegistry = (
  dependencies: ServiceRegistryDependencies,
): ServiceRegistry => {
  const list = (): readonly ServiceDescriptor[] =>
    toServices(dependencies.listServices());

  const find = (serviceKey: string): ServiceDescriptor | null => {
    const normalizedKey = String(serviceKey ?? '').trim();
    if (!normalizedKey) return null;
    for (const service of list()) {
      if (serviceTitle(service) === normalizedKey) return service;
    }
    return null;
  };

  const requireService = (serviceKey: string): ServiceDescriptor => {
    const service = find(serviceKey);
    if (!service) throw new MissingBusinessServiceError(serviceKey);
    return service;
  };

  return Object.freeze({
    list,
    find,
    require: requireService,
    resolveUrl: serviceUrl,
    requireUrl(serviceKey: string) {
      const service = requireService(serviceKey);
      const url = serviceUrl(service);
      if (!url) throw new MissingBusinessServiceError(serviceKey);
      return url;
    },
    snapshot(): readonly ServiceRegistryEntry[] {
      return Object.freeze(
        list().map((service, index) => Object.freeze({
          key: serviceTitle(service) ?? `service-${index}`,
          url: serviceUrl(service),
          index,
        })),
      );
    },
  });
};
