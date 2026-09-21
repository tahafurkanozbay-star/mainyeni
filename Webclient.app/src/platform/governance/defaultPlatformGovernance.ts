import type { RuntimeConfig } from '../config/runtimeConfig';
import {
  createPlatformGovernanceKernel,
  type PlatformGovernanceKernel,
  type PlatformGovernanceKernelOptions,
} from './governanceKernel';

export interface DefaultPlatformGovernanceOptions extends PlatformGovernanceKernelOptions {
  readonly runtimeConfig: RuntimeConfig;
}

const registerRuntimeConfigSchema = (kernel: PlatformGovernanceKernel): void => {
  kernel.config.register({
    key: 'api-base-url',
    aliases: ['api_base_url'],
    kind: 'string',
    required: true,
    minLength: 1,
    maxLength: 240,
    pattern: /^\/(?!\/)/u,
    description: 'Canonical same-origin API base path.',
  });
  kernel.config.register({
    key: 'request-timeout-ms',
    kind: 'integer',
    required: true,
    minimum: 1_000,
    maximum: 60_000,
    description: 'Upper bound for application API request lifetime.',
  });
  kernel.config.register({
    key: 'cache-ttl-ms',
    kind: 'integer',
    required: true,
    minimum: 0,
    maximum: 600_000,
    description: 'Default bounded API cache TTL.',
  });
  kernel.config.register({
    key: 'max-retries',
    kind: 'integer',
    required: true,
    minimum: 0,
    maximum: 4,
    description: 'Maximum API retry attempts.',
  });
  kernel.config.register({
    key: 'environment',
    kind: 'string',
    required: true,
    minLength: 1,
    maxLength: 40,
  });
  kernel.config.register({
    key: 'release',
    kind: 'string',
    required: true,
    minLength: 1,
    maxLength: 120,
  });
  kernel.config.register({
    key: 'esri-api-version',
    kind: 'string',
    required: true,
    pattern: /^5\.1\.24$/u,
    maxLength: 16,
  });
  kernel.config.register({
    key: 'tkgm-city-id',
    kind: 'string',
    secret: true,
    maxLength: 40,
    description: 'Configured city identifier; presence is public, raw value is not.',
  });
  kernel.config.register({
    key: 'build-mode',
    kind: 'enum',
    required: true,
    values: ['legacy-cra', 'vite-ready', 'unknown'],
  });
};

const registerFeatureRules = (kernel: PlatformGovernanceKernel, config: RuntimeConfig): void => {
  kernel.features.register({
    id: 'adaptive-runtime',
    mode: config.features.adaptiveRuntime ? 'on' : 'off',
    description: 'Adaptive runtime budgets and capability response.',
  });
  kernel.features.register({
    id: 'typed-bootstrap',
    mode: config.features.typedBootstrap ? 'on' : 'off',
    requires: ['strict-endpoint-policy'],
    description: 'Typed deterministic application bootstrap composition.',
  });
  kernel.features.register({
    id: 'strict-endpoint-policy',
    mode: config.features.strictEndpointPolicy ? 'on' : 'off',
    description: 'Same-origin application endpoint enforcement.',
  });
  kernel.features.register({
    id: 'privacy-telemetry',
    mode: config.features.privacyTelemetry ? 'on' : 'off',
    description: 'Local bounded privacy-safe runtime diagnostics.',
  });
  kernel.features.register({
    id: 'debug-logging',
    mode: config.features.debugLogging ? 'on' : 'off',
    excludeEnvironments: ['production'],
    description: 'Developer diagnostics; never enabled by default in production.',
  });
};

const registerManifest = (kernel: PlatformGovernanceKernel): void => {
  kernel.manifest.register({
    id: 'platform-config',
    version: '1',
    domain: 'platform',
    required: true,
    startup: 'eager',
    provides: ['runtime-config'],
  });
  kernel.manifest.register({
    id: 'platform-network',
    version: '1',
    domain: 'platform',
    required: true,
    startup: 'eager',
    dependsOn: ['platform-config'],
    consumes: ['runtime-config'],
    provides: ['governed-http', 'endpoint-policy'],
  });
  kernel.manifest.register({
    id: 'platform-runtime',
    version: '1',
    domain: 'platform',
    required: true,
    startup: 'eager',
    dependsOn: ['platform-config'],
    consumes: ['runtime-config'],
    provides: ['runtime-supervision', 'resource-budget'],
  });
  kernel.manifest.register({
    id: 'platform-offline',
    version: '1',
    domain: 'platform',
    required: false,
    startup: 'lazy',
    dependsOn: ['platform-runtime', 'platform-network'],
    consumes: ['runtime-supervision', 'governed-http'],
    provides: ['offline-persistence', 'offline-replay'],
  });
  kernel.manifest.register({
    id: 'gis-runtime',
    version: '1',
    domain: 'gis',
    required: true,
    startup: 'eager',
    dependsOn: ['platform-network', 'platform-runtime'],
    consumes: ['governed-http', 'resource-budget'],
    provides: ['spatial-runtime'],
  });
  kernel.manifest.register({
    id: 'experience-runtime',
    version: '1',
    domain: 'experience',
    required: true,
    startup: 'eager',
    dependsOn: ['platform-runtime', 'gis-runtime'],
    consumes: ['runtime-supervision', 'spatial-runtime'],
    provides: ['adaptive-shell'],
  });
};

const registerReadiness = (kernel: PlatformGovernanceKernel): void => {
  kernel.readiness.register({
    id: 'platform.config',
    severity: 'critical',
    required: true,
    description: 'Resolved runtime configuration must pass schema governance.',
  });
  kernel.readiness.register({
    id: 'platform.manifest',
    severity: 'critical',
    required: true,
    description: 'Runtime component dependency/capability graph must validate.',
  });
  kernel.readiness.register({
    id: 'platform.runtime-health',
    severity: 'degraded',
    required: false,
    ttlMs: 60_000,
    description: 'Optional runtime health evidence may degrade support state without blocking startup.',
  });
  kernel.readiness.register({
    id: 'platform.network-health',
    severity: 'degraded',
    required: false,
    ttlMs: 30_000,
    description: 'Optional network evidence is short-lived and never persisted as identity data.',
  });
};

const configSource = (config: RuntimeConfig): Readonly<Record<string, unknown>> => Object.freeze({
  'api-base-url': config.apiBaseUrl,
  'request-timeout-ms': config.requestTimeoutMs,
  'cache-ttl-ms': config.cacheTtlMs,
  'max-retries': config.maxRetries,
  environment: config.environment,
  release: config.release,
  'esri-api-version': config.esriApiVersion,
  'tkgm-city-id': config.tkgmCityId,
  'build-mode': config.buildMode,
});

export const createDefaultPlatformGovernance = (
  options: DefaultPlatformGovernanceOptions,
): PlatformGovernanceKernel => {
  const kernel = createPlatformGovernanceKernel(options);
  registerRuntimeConfigSchema(kernel);
  registerFeatureRules(kernel, options.runtimeConfig);
  registerManifest(kernel);
  registerReadiness(kernel);
  kernel.start({
    configSource: configSource(options.runtimeConfig),
    rejectInvalidConfig: true,
  });
  return kernel;
};

export const refreshDefaultPlatformGovernance = (
  kernel: PlatformGovernanceKernel,
  runtimeConfig: RuntimeConfig,
): void => {
  kernel.reconfigure(configSource(runtimeConfig), { rejectInvalidConfig: true });
};
