import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import { CommonBusiness } from '../../Business/CommonBusiness';
import MapManager from '../../Store/Managers/MapManager';
import { createBootstrapDiagnostics } from './bootstrapDiagnostics';
import { runApplicationBootstrap } from './bootstrapCore';

const defaultDiagnostics = createBootstrapDiagnostics();

export const applicationBootstrapDependencies = Object.freeze({
  loadMapConfiguration: (options = {}) => ConfigurationBusiness.GetMapConfiguration(options),
  loadConfigurationServices: (options = {}) => ConfigurationBusiness.GetConfigServices(options),
  generateServiceUrl: (service) => CommonBusiness.GenerateUrl(service),
  addProxyRule: (url, source) => CommonBusiness.AddProxyRule(url, source),
  setMapConfiguration: (configuration) => MapManager.SetMapConfiguration(configuration),
  setConfigurationServices: (services) => MapManager.SetConfigurationServices(services)
});

export const bootstrapApplication = (options = {}) => {
  const diagnostics = options.diagnostics || defaultDiagnostics;

  return runApplicationBootstrap(applicationBootstrapDependencies, {
    ...options,
    diagnostics
  });
};

export const getApplicationBootstrapDiagnostics = () => defaultDiagnostics.snapshot();

export const getApplicationBootstrapDiagnosticSummary = () => defaultDiagnostics.summary();

export const clearApplicationBootstrapDiagnostics = () => defaultDiagnostics.clear();
