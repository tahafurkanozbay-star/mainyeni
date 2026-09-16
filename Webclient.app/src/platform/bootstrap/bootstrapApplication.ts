import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import { CommonBusiness } from '../../Business/CommonBusiness';
import MapManager from '../../Store/Managers/MapManager';
import { createBootstrapDiagnostics } from './bootstrapDiagnostics';
import { runApplicationBootstrap } from './bootstrapCore';
import type { BootstrapDependencies, BootstrapRunOptions, BootstrapResult, PlainRecord } from './bootstrapCore';

const defaultDiagnostics = createBootstrapDiagnostics();

export const applicationBootstrapDependencies: BootstrapDependencies = Object.freeze({
  loadMapConfiguration: (options = {}) => ConfigurationBusiness.GetMapConfiguration(options),
  loadConfigurationServices: (options = {}) => ConfigurationBusiness.GetConfigServices(options),
  generateServiceUrl: (service: PlainRecord) => CommonBusiness.GenerateUrl(service),
  addProxyRule: (url: string, source: string) => CommonBusiness.AddProxyRule(url, source),
  setMapConfiguration: (configuration: PlainRecord) => MapManager.SetMapConfiguration(configuration),
  setConfigurationServices: (services: readonly PlainRecord[]) => MapManager.SetConfigurationServices(services)
});

export const bootstrapApplication = (options: BootstrapRunOptions = {}): Promise<BootstrapResult> => {
  const diagnostics = options.diagnostics || defaultDiagnostics;
  return runApplicationBootstrap(applicationBootstrapDependencies, { ...options, diagnostics });
};

export const getApplicationBootstrapDiagnostics = () => defaultDiagnostics.snapshot();
export const getApplicationBootstrapDiagnosticSummary = () => defaultDiagnostics.summary();
export const clearApplicationBootstrapDiagnostics = (): void => defaultDiagnostics.clear();
