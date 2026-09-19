import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import { CommonBusiness } from '../../Business/CommonBusiness';
import type { ServiceDescriptor } from '../../Business/contracts';
import MapManager from '../../Store/Managers/MapManager';
import {
  createOfflineRuntime,
  type OfflineRuntime,
} from '../offline/offlineRuntime';
import type {
  BootstrapDiagnostics as BootstrapDiagnosticsContract,
  BootstrapOptions,
  BootstrapResult,
  ConfigurationService,
} from './bootstrapCore';
import { createBootstrapDiagnostics } from './bootstrapDiagnostics';
import { runApplicationBootstrap } from './bootstrapCore';

export interface ApplicationBootstrapOptions extends BootstrapOptions {
  readonly offline?: boolean;
}

const defaultDiagnostics = createBootstrapDiagnostics();
const defaultOfflineRuntime: OfflineRuntime = createOfflineRuntime();

export const applicationBootstrapDependencies = Object.freeze({
  loadMapConfiguration: (options: { readonly signal?: AbortSignal } = {}) =>
    ConfigurationBusiness.GetMapConfiguration(options),
  loadConfigurationServices: (options: { readonly signal?: AbortSignal } = {}) =>
    ConfigurationBusiness.GetConfigServices(options),
  generateServiceUrl: (service: ConfigurationService): unknown =>
    CommonBusiness.GenerateUrl(service),
  addProxyRule: (url: string, source: string) =>
    CommonBusiness.AddProxyRule(url, source),
  setMapConfiguration: (configuration: Readonly<Record<string, unknown>>) =>
    MapManager.SetMapConfiguration(configuration),
  setConfigurationServices: (services: readonly ConfigurationService[]) =>
    MapManager.SetConfigurationServices(services as readonly ServiceDescriptor[]),
});

const scheduleOfflineRuntime = (): void => {
  queueMicrotask(() => {
    void defaultOfflineRuntime.start();
  });
};

export const bootstrapApplication = async (
  options: ApplicationBootstrapOptions = {},
): Promise<BootstrapResult> => {
  const {
    offline = true,
    diagnostics = defaultDiagnostics as unknown as BootstrapDiagnosticsContract,
    ...bootstrapOptions
  } = options;

  const result = await runApplicationBootstrap(applicationBootstrapDependencies, {
    ...bootstrapOptions,
    diagnostics,
  });

  if (offline) scheduleOfflineRuntime();
  return result;
};

export const getApplicationBootstrapDiagnostics = () => defaultDiagnostics.snapshot();

export const getApplicationBootstrapDiagnosticSummary = () => defaultDiagnostics.summary();

export const clearApplicationBootstrapDiagnostics = (): void => {
  defaultDiagnostics.clear();
};

export const getApplicationOfflineSnapshot = () => defaultOfflineRuntime.snapshot();

export const startApplicationOfflineRuntime = () => defaultOfflineRuntime.start();

export const stopApplicationOfflineRuntime = () => defaultOfflineRuntime.stop();
