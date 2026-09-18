import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import MapManager from '../../Store/Managers/MapManager';
import { createBootstrapDiagnostics } from './bootstrapDiagnostics';
import {
  runApplicationBootstrap,
  type BootstrapDependencies,
  type BootstrapOptions,
  type BootstrapResult,
} from './bootstrapCore';
import {
  arcgisProxyPolicy,
  resolveConfigurationServiceUrl,
} from '../network/arcgisProxyPolicy';

const defaultDiagnostics = createBootstrapDiagnostics();

export const applicationBootstrapDependencies: BootstrapDependencies = Object.freeze({
  loadMapConfiguration: (options = {}) => ConfigurationBusiness.GetMapConfiguration(options),
  loadConfigurationServices: (options = {}) => ConfigurationBusiness.GetConfigServices(options),
  generateServiceUrl: resolveConfigurationServiceUrl,
  addProxyRule: (url: string) => arcgisProxyPolicy.register(url),
  setMapConfiguration: (configuration) => MapManager.SetMapConfiguration(configuration),
  setConfigurationServices: (services) => MapManager.SetConfigurationServices(services),
});

export const bootstrapApplication = (
  options: BootstrapOptions = {},
): Promise<BootstrapResult> => {
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  return runApplicationBootstrap(applicationBootstrapDependencies, {
    ...options,
    diagnostics,
  });
};

export const getApplicationBootstrapDiagnostics = () =>
  defaultDiagnostics.snapshot();

export const getApplicationBootstrapDiagnosticSummary = () =>
  defaultDiagnostics.summary();

export const clearApplicationBootstrapDiagnostics = (): void => {
  defaultDiagnostics.clear();
};
