import MapManager from '../../Store/Managers/MapManager';
import { GisQueryHelper } from '../../Toolbox/GisQueryHelper';
import { apiClient } from '../../platform/http/httpClient';
import { createApiRuntime } from './apiRuntime';
import { businessDiagnostics } from './diagnostics';
import { createQueryPlanner } from './queryPlan';
import { createQueryRuntime } from './queryRuntime';
import { createServiceRegistry } from './serviceRegistry';

export const businessServiceRegistry = createServiceRegistry({
  listServices: () => MapManager.GetConfigurationServices(),
});

export const businessQueryPlanner = createQueryPlanner(
  serviceKey => businessServiceRegistry.requireUrl(serviceKey),
);

export const businessQueryRuntime = createQueryRuntime({
  services: businessServiceRegistry,
  diagnostics: businessDiagnostics,
  executeQuery: options => GisQueryHelper.ExecuteQuery(options),
  executeSpatialQuery: options => GisQueryHelper.ExecuteSpatialQuery(options),
});

export const businessApiRuntime = createApiRuntime({
  client: apiClient,
  diagnostics: businessDiagnostics,
});

export const getBusinessRuntimeSnapshot = () => Object.freeze({
  services: businessServiceRegistry.snapshot(),
  diagnostics: businessDiagnostics.snapshot(),
});

export const clearBusinessRuntimeDiagnostics = (): number =>
  businessDiagnostics.clear();
