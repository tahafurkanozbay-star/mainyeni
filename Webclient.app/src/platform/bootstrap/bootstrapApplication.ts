import { ConfigurationBusiness } from '../../Business/ConfigurationBusiness';
import { CommonBusiness } from '../../Business/CommonBusiness';
import MapManager from '../../Store/Managers/MapManager';
import { createBootstrapDiagnostics } from './bootstrapDiagnostics';
import {
  runApplicationBootstrap,
  type BootstrapDependencies,
  type BootstrapDiagnostics,
  type BootstrapOptions,
  type BootstrapResult,
  type BootstrapRequestOptions,
  type ConfigurationService,
  type MapConfiguration,
  type ServiceResult,
} from './bootstrapCore';

/**
 * Typed application composition root for the configuration bootstrap pipeline.
 *
 * This adapter deliberately owns no transport policy of its own. Network access
 * remains behind ConfigurationBusiness, proxy registration remains behind
 * CommonBusiness, and committed state remains behind MapManager. Keeping those
 * boundaries explicit lets bootstrapCore stay deterministic and independently
 * testable while preventing a second fetch/cache/retry implementation here.
 */

export interface ApplicationBootstrapOptions extends BootstrapOptions {
  readonly diagnostics?: BootstrapDiagnostics | null;
}

export interface ApplicationBootstrapDiagnosticCollector {
  readonly snapshot: () => readonly unknown[];
  readonly summary: () => Readonly<Record<string, unknown>>;
  readonly clear: () => void;
}

const defaultDiagnostics = createBootstrapDiagnostics();

const loadMapConfiguration = (
  options: BootstrapRequestOptions = {},
): Promise<ServiceResult> | ServiceResult =>
  ConfigurationBusiness.GetMapConfiguration(options) as Promise<ServiceResult> | ServiceResult;

const loadConfigurationServices = (
  options: BootstrapRequestOptions = {},
): Promise<ServiceResult> | ServiceResult =>
  ConfigurationBusiness.GetConfigServices(options) as Promise<ServiceResult> | ServiceResult;

const generateServiceUrl = (service: ConfigurationService): unknown =>
  CommonBusiness.GenerateUrl(service);

const addProxyRule = (url: string, source: string): Promise<unknown> | unknown =>
  CommonBusiness.AddProxyRule(url, source);

const setMapConfiguration = (configuration: MapConfiguration): Promise<unknown> | unknown =>
  MapManager.SetMapConfiguration(configuration);

const setConfigurationServices = (
  services: readonly ConfigurationService[],
): Promise<unknown> | unknown =>
  MapManager.SetConfigurationServices(services);

/**
 * Production dependencies are frozen so callers cannot mutate the composition
 * root between bootstrap stages. Tests should exercise bootstrapCore with an
 * injected dependency set instead of patching this object at runtime.
 */
export const applicationBootstrapDependencies: BootstrapDependencies = Object.freeze({
  loadMapConfiguration,
  loadConfigurationServices,
  generateServiceUrl,
  addProxyRule,
  setMapConfiguration,
  setConfigurationServices,
});

/**
 * Run the application bootstrap using the production composition root.
 * A caller-provided diagnostics collector is isolated from the shared support
 * collector; otherwise the bounded default collector is used.
 */
export const bootstrapApplication = (
  options: ApplicationBootstrapOptions = {},
): Promise<BootstrapResult> => {
  const diagnostics = options.diagnostics ?? defaultDiagnostics;
  return runApplicationBootstrap(applicationBootstrapDependencies, {
    ...options,
    diagnostics,
  });
};

/** Return an immutable support snapshot from the bounded default collector. */
export const getApplicationBootstrapDiagnostics = (): readonly unknown[] =>
  defaultDiagnostics.snapshot();

/** Return aggregate bootstrap counters without exposing mutable collector state. */
export const getApplicationBootstrapDiagnosticSummary = (): Readonly<Record<string, unknown>> =>
  defaultDiagnostics.summary();

/** Clear only the shared support collector between application sessions/tests. */
export const clearApplicationBootstrapDiagnostics = (): void => {
  defaultDiagnostics.clear();
};
