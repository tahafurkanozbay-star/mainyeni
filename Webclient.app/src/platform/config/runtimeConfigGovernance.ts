import {
  RUNTIME_CONFIG_SOURCE_KEYS,
  type RuntimeConfig,
  type RuntimeConfigFieldEvidence,
  type RuntimeConfigFieldId,
  type RuntimeConfigResolution,
} from './runtimeConfig';

export type RuntimeConfigGovernanceStatus = 'healthy' | 'degraded' | 'critical';

export type RuntimeConfigRiskCode =
  | 'legacy-source'
  | 'shadowed-source'
  | 'invalid-fallback'
  | 'policy-pinned'
  | 'legacy-build-mode'
  | 'unknown-build-mode'
  | 'debug-logging-production'
  | 'strict-endpoint-disabled'
  | 'typed-bootstrap-disabled'
  | 'local-release-production';

export interface RuntimeConfigGovernancePolicy {
  readonly legacySourceWarningCount: number;
  readonly legacySourceCriticalCount: number;
  readonly shadowedSourceWarningCount: number;
  readonly shadowedSourceCriticalCount: number;
  readonly rejectedFieldWarningCount: number;
  readonly rejectedFieldCriticalCount: number;
  readonly pinnedFieldWarningCount: number;
  readonly pinnedFieldCriticalCount: number;
  readonly maxRiskEntries: number;
}

export interface RuntimeConfigRisk {
  readonly code: RuntimeConfigRiskCode;
  readonly status: Exclude<RuntimeConfigGovernanceStatus, 'healthy'>;
  readonly count: number;
  readonly threshold: number;
  readonly affectedFields: readonly RuntimeConfigFieldId[];
}

export interface RuntimeConfigGovernanceSummary {
  readonly status: RuntimeConfigGovernanceStatus;
  readonly production: boolean;
  readonly configFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly configuredFields: number;
  readonly defaultedFields: number;
  readonly normalizedFields: number;
  readonly clampedFields: number;
  readonly rejectedFields: number;
  readonly pinnedFields: number;
  readonly legacySourceFields: number;
  readonly shadowedSourceCount: number;
  readonly risks: readonly RuntimeConfigRisk[];
}

export type RuntimeConfigAdmissionViolationCode =
  | 'legacy-build-mode'
  | 'unknown-build-mode'
  | 'debug-logging-production'
  | 'strict-endpoint-disabled'
  | 'typed-bootstrap-disabled'
  | 'too-many-rejected-fields'
  | 'too-many-legacy-fields'
  | 'too-many-shadowed-sources';

export interface RuntimeConfigAdmissionPolicy {
  readonly allowLegacyBuildMode: boolean;
  readonly allowUnknownBuildMode: boolean;
  readonly allowDebugLoggingInProduction: boolean;
  readonly requireStrictEndpointPolicy: boolean;
  readonly requireTypedBootstrap: boolean;
  readonly maxRejectedFields: number;
  readonly maxLegacySourceFields: number;
  readonly maxShadowedSourceCount: number;
  readonly maxViolations: number;
}

export interface RuntimeConfigAdmissionViolation {
  readonly code: RuntimeConfigAdmissionViolationCode;
  readonly affectedFields: readonly RuntimeConfigFieldId[];
  readonly actualCount?: number;
  readonly threshold?: number;
}

export interface RuntimeConfigAdmissionResult {
  readonly admitted: boolean;
  readonly production: boolean;
  readonly configFingerprint: string;
  readonly violations: readonly RuntimeConfigAdmissionViolation[];
}

export type RuntimeConfigChangeClass =
  | 'network-boundary'
  | 'resilience'
  | 'identity'
  | 'release'
  | 'runtime-mode'
  | 'feature'
  | 'security-boundary';

export interface RuntimeConfigChange {
  readonly fieldId: RuntimeConfigFieldId;
  readonly changeClass: RuntimeConfigChangeClass;
  readonly sensitive: boolean;
}

export interface RuntimeConfigChangeSet {
  readonly changed: boolean;
  readonly count: number;
  readonly changes: readonly RuntimeConfigChange[];
  readonly beforeFingerprint: string;
  readonly afterFingerprint: string;
  readonly fingerprint: string;
}

export interface RuntimeConfigMigrationStep {
  readonly fieldId: RuntimeConfigFieldId;
  readonly legacyKey: string;
  readonly replacementKey: string;
  readonly shadowed: boolean;
}

export interface RuntimeConfigMigrationPlan {
  readonly required: boolean;
  readonly stepCount: number;
  readonly steps: readonly RuntimeConfigMigrationStep[];
  readonly fingerprint: string;
}

export type RuntimeConfigAuditEventKind =
  | 'sampled'
  | 'change-detected'
  | 'admitted'
  | 'rejected'
  | 'observer-failed';

export interface RuntimeConfigAuditEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: RuntimeConfigAuditEventKind;
  readonly status?: RuntimeConfigGovernanceStatus;
  readonly configFingerprint?: string;
  readonly changeCount?: number;
  readonly violationCount?: number;
  readonly errorName?: string;
}

export interface RuntimeConfigAuditSample {
  readonly sequence: number;
  readonly sampledAt: number;
  readonly status: RuntimeConfigGovernanceStatus;
  readonly production: boolean;
  readonly configFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly riskCount: number;
  readonly legacySourceFields: number;
  readonly shadowedSourceCount: number;
  readonly rejectedFields: number;
  readonly pinnedFields: number;
  readonly changeCount: number;
  readonly admitted: boolean;
  readonly violationCount: number;
  readonly fingerprint: string;
}

export interface RuntimeConfigGovernanceJournalOptions {
  readonly historyLimit?: number;
  readonly eventLimit?: number;
  readonly now?: () => number;
  readonly governancePolicy?: Partial<RuntimeConfigGovernancePolicy>;
  readonly admissionPolicy?: Partial<RuntimeConfigAdmissionPolicy>;
  readonly onEvent?: (event: RuntimeConfigAuditEvent) => void;
}

export interface RuntimeConfigGovernanceJournalSnapshot {
  readonly samples: number;
  readonly observerFailures: number;
  readonly current: RuntimeConfigAuditSample | null;
  readonly history: readonly RuntimeConfigAuditSample[];
  readonly events: readonly RuntimeConfigAuditEvent[];
}

export interface RuntimeConfigGovernanceJournal {
  readonly sample: (
    resolution: RuntimeConfigResolution,
    baseline?: RuntimeConfigResolution,
  ) => RuntimeConfigAuditSample;
  readonly snapshot: () => RuntimeConfigGovernanceJournalSnapshot;
  readonly reset: () => void;
}

export type RuntimeConfigAdmissionErrorCode = 'RUNTIME_CONFIG_REJECTED';

export class RuntimeConfigAdmissionError extends Error {
  readonly code: RuntimeConfigAdmissionErrorCode = 'RUNTIME_CONFIG_REJECTED';

  constructor(
    message: string,
    readonly result: RuntimeConfigAdmissionResult,
  ) {
    super(message);
    this.name = 'RuntimeConfigAdmissionError';
  }
}

const DEFAULT_GOVERNANCE_POLICY: RuntimeConfigGovernancePolicy = Object.freeze({
  legacySourceWarningCount: 1,
  legacySourceCriticalCount: 6,
  shadowedSourceWarningCount: 1,
  shadowedSourceCriticalCount: 5,
  rejectedFieldWarningCount: 1,
  rejectedFieldCriticalCount: 4,
  pinnedFieldWarningCount: 1,
  pinnedFieldCriticalCount: 3,
  maxRiskEntries: 16,
});

const DEFAULT_ADMISSION_POLICY: RuntimeConfigAdmissionPolicy = Object.freeze({
  allowLegacyBuildMode: false,
  allowUnknownBuildMode: true,
  allowDebugLoggingInProduction: false,
  requireStrictEndpointPolicy: true,
  requireTypedBootstrap: true,
  maxRejectedFields: 0,
  maxLegacySourceFields: 4,
  maxShadowedSourceCount: 4,
  maxViolations: 16,
});

const STATUS_RANK: Readonly<Record<RuntimeConfigGovernanceStatus, number>> =
  Object.freeze({
    healthy: 0,
    degraded: 1,
    critical: 2,
  });

const SECURITY_FIELDS = new Set<RuntimeConfigFieldId>([
  'apiBaseUrl',
  'features.debugLogging',
  'features.typedBootstrap',
  'features.strictEndpointPolicy',
]);

const FIELD_CLASS: Readonly<Record<RuntimeConfigFieldId, RuntimeConfigChangeClass>> =
  Object.freeze({
    apiBaseUrl: 'network-boundary',
    requestTimeoutMs: 'resilience',
    cacheTtlMs: 'resilience',
    maxRetries: 'resilience',
    environment: 'runtime-mode',
    release: 'release',
    esriApiVersion: 'runtime-mode',
    tkgmCityId: 'identity',
    'features.adaptiveRuntime': 'feature',
    'features.debugLogging': 'security-boundary',
    'features.privacyTelemetry': 'feature',
    'features.typedBootstrap': 'security-boundary',
    'features.strictEndpointPolicy': 'security-boundary',
    buildMode: 'runtime-mode',
  });

const FIELDS: readonly RuntimeConfigFieldId[] = Object.freeze([
  'apiBaseUrl',
  'requestTimeoutMs',
  'cacheTtlMs',
  'maxRetries',
  'environment',
  'release',
  'esriApiVersion',
  'tkgmCityId',
  'buildMode',
  'features.adaptiveRuntime',
  'features.debugLogging',
  'features.privacyTelemetry',
  'features.typedBootstrap',
  'features.strictEndpointPolicy',
]);

const integer = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      name + ' must be an integer between ' + minimum + ' and ' + maximum,
    );
  }
  return value;
};

const validatePair = (
  name: string,
  warning: number,
  critical: number,
): void => {
  if (critical < warning) {
    throw new RangeError(name + ' critical threshold cannot be below warning threshold');
  }
};

const governancePolicy = (
  overrides: Partial<RuntimeConfigGovernancePolicy> = {},
): RuntimeConfigGovernancePolicy => {
  const policy = Object.freeze({
    legacySourceWarningCount: integer(
      'legacySourceWarningCount',
      overrides.legacySourceWarningCount
        ?? DEFAULT_GOVERNANCE_POLICY.legacySourceWarningCount,
      1,
      100,
    ),
    legacySourceCriticalCount: integer(
      'legacySourceCriticalCount',
      overrides.legacySourceCriticalCount
        ?? DEFAULT_GOVERNANCE_POLICY.legacySourceCriticalCount,
      1,
      100,
    ),
    shadowedSourceWarningCount: integer(
      'shadowedSourceWarningCount',
      overrides.shadowedSourceWarningCount
        ?? DEFAULT_GOVERNANCE_POLICY.shadowedSourceWarningCount,
      1,
      100,
    ),
    shadowedSourceCriticalCount: integer(
      'shadowedSourceCriticalCount',
      overrides.shadowedSourceCriticalCount
        ?? DEFAULT_GOVERNANCE_POLICY.shadowedSourceCriticalCount,
      1,
      100,
    ),
    rejectedFieldWarningCount: integer(
      'rejectedFieldWarningCount',
      overrides.rejectedFieldWarningCount
        ?? DEFAULT_GOVERNANCE_POLICY.rejectedFieldWarningCount,
      1,
      100,
    ),
    rejectedFieldCriticalCount: integer(
      'rejectedFieldCriticalCount',
      overrides.rejectedFieldCriticalCount
        ?? DEFAULT_GOVERNANCE_POLICY.rejectedFieldCriticalCount,
      1,
      100,
    ),
    pinnedFieldWarningCount: integer(
      'pinnedFieldWarningCount',
      overrides.pinnedFieldWarningCount
        ?? DEFAULT_GOVERNANCE_POLICY.pinnedFieldWarningCount,
      1,
      100,
    ),
    pinnedFieldCriticalCount: integer(
      'pinnedFieldCriticalCount',
      overrides.pinnedFieldCriticalCount
        ?? DEFAULT_GOVERNANCE_POLICY.pinnedFieldCriticalCount,
      1,
      100,
    ),
    maxRiskEntries: integer(
      'maxRiskEntries',
      overrides.maxRiskEntries ?? DEFAULT_GOVERNANCE_POLICY.maxRiskEntries,
      1,
      128,
    ),
  });

  validatePair(
    'legacy source',
    policy.legacySourceWarningCount,
    policy.legacySourceCriticalCount,
  );
  validatePair(
    'shadowed source',
    policy.shadowedSourceWarningCount,
    policy.shadowedSourceCriticalCount,
  );
  validatePair(
    'rejected field',
    policy.rejectedFieldWarningCount,
    policy.rejectedFieldCriticalCount,
  );
  validatePair(
    'pinned field',
    policy.pinnedFieldWarningCount,
    policy.pinnedFieldCriticalCount,
  );
  return policy;
};

const admissionPolicy = (
  overrides: Partial<RuntimeConfigAdmissionPolicy> = {},
): RuntimeConfigAdmissionPolicy => Object.freeze({
  allowLegacyBuildMode:
    overrides.allowLegacyBuildMode ?? DEFAULT_ADMISSION_POLICY.allowLegacyBuildMode,
  allowUnknownBuildMode:
    overrides.allowUnknownBuildMode ?? DEFAULT_ADMISSION_POLICY.allowUnknownBuildMode,
  allowDebugLoggingInProduction:
    overrides.allowDebugLoggingInProduction
    ?? DEFAULT_ADMISSION_POLICY.allowDebugLoggingInProduction,
  requireStrictEndpointPolicy:
    overrides.requireStrictEndpointPolicy
    ?? DEFAULT_ADMISSION_POLICY.requireStrictEndpointPolicy,
  requireTypedBootstrap:
    overrides.requireTypedBootstrap
    ?? DEFAULT_ADMISSION_POLICY.requireTypedBootstrap,
  maxRejectedFields: integer(
    'maxRejectedFields',
    overrides.maxRejectedFields ?? DEFAULT_ADMISSION_POLICY.maxRejectedFields,
    0,
    100,
  ),
  maxLegacySourceFields: integer(
    'maxLegacySourceFields',
    overrides.maxLegacySourceFields
      ?? DEFAULT_ADMISSION_POLICY.maxLegacySourceFields,
    0,
    100,
  ),
  maxShadowedSourceCount: integer(
    'maxShadowedSourceCount',
    overrides.maxShadowedSourceCount
      ?? DEFAULT_ADMISSION_POLICY.maxShadowedSourceCount,
    0,
    100,
  ),
  maxViolations: integer(
    'maxViolations',
    overrides.maxViolations ?? DEFAULT_ADMISSION_POLICY.maxViolations,
    1,
    128,
  ),
});

const productionEnvironment = (config: RuntimeConfig): boolean => {
  const normalized = config.environment.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
};

const affectedBy = (
  evidenceValues: readonly RuntimeConfigFieldEvidence[],
  predicate: (item: RuntimeConfigFieldEvidence) => boolean,
): readonly RuntimeConfigFieldId[] => Object.freeze(
  evidenceValues.filter(predicate).map((item) => item.fieldId),
);

const thresholdStatus = (
  count: number,
  warning: number,
  critical: number,
): RuntimeConfigGovernanceStatus => {
  if (count >= critical) return 'critical';
  if (count >= warning) return 'degraded';
  return 'healthy';
};

const thresholdRisk = (
  code: RuntimeConfigRiskCode,
  count: number,
  warning: number,
  critical: number,
  affectedFields: readonly RuntimeConfigFieldId[],
): RuntimeConfigRisk | null => {
  const status = thresholdStatus(count, warning, critical);
  if (status === 'healthy') return null;
  return Object.freeze({
    code,
    status,
    count,
    threshold: status === 'critical' ? critical : warning,
    affectedFields: Object.freeze([...affectedFields]),
  });
};

const fixedRisk = (
  code: RuntimeConfigRiskCode,
  status: Exclude<RuntimeConfigGovernanceStatus, 'healthy'>,
  affectedFields: readonly RuntimeConfigFieldId[],
): RuntimeConfigRisk => Object.freeze({
  code,
  status,
  count: Math.max(1, affectedFields.length),
  threshold: 1,
  affectedFields: Object.freeze([...affectedFields]),
});

const stronger = (
  left: RuntimeConfigGovernanceStatus,
  right: RuntimeConfigGovernanceStatus,
): RuntimeConfigGovernanceStatus =>
  STATUS_RANK[right] > STATUS_RANK[left] ? right : left;

const sortedRisks = (
  risks: readonly RuntimeConfigRisk[],
  maximum: number,
): readonly RuntimeConfigRisk[] => Object.freeze(
  [...risks]
    .sort((left, right) =>
      STATUS_RANK[right.status] - STATUS_RANK[left.status]
      || right.count - left.count
      || left.code.localeCompare(right.code))
    .slice(0, maximum),
);

export const evaluateRuntimeConfigGovernance = (
  resolution: RuntimeConfigResolution,
  overrides: Partial<RuntimeConfigGovernancePolicy> = {},
): RuntimeConfigGovernanceSummary => {
  const policy = governancePolicy(overrides);
  const production = productionEnvironment(resolution.config);
  const evidenceValues = resolution.evidence;

  const legacyFields = affectedBy(
    evidenceValues,
    (item) => item.sourceKind === 'legacy-cra',
  );
  const shadowedFields = affectedBy(
    evidenceValues,
    (item) => item.shadowedSourceCount > 0,
  );
  const rejectedFields = affectedBy(
    evidenceValues,
    (item) => item.disposition === 'invalid-fallback',
  );
  const pinnedFields = affectedBy(
    evidenceValues,
    (item) => item.disposition === 'policy-pinned',
  );

  const risks = [
    thresholdRisk(
      'legacy-source',
      resolution.summary.legacySourceFields,
      policy.legacySourceWarningCount,
      policy.legacySourceCriticalCount,
      legacyFields,
    ),
    thresholdRisk(
      'shadowed-source',
      resolution.summary.shadowedSourceCount,
      policy.shadowedSourceWarningCount,
      policy.shadowedSourceCriticalCount,
      shadowedFields,
    ),
    thresholdRisk(
      'invalid-fallback',
      resolution.summary.rejectedFields,
      policy.rejectedFieldWarningCount,
      policy.rejectedFieldCriticalCount,
      rejectedFields,
    ),
    thresholdRisk(
      'policy-pinned',
      resolution.summary.pinnedFields,
      policy.pinnedFieldWarningCount,
      policy.pinnedFieldCriticalCount,
      pinnedFields,
    ),
    resolution.config.buildMode === 'legacy-cra'
      ? fixedRisk('legacy-build-mode', production ? 'critical' : 'degraded', ['buildMode'])
      : null,
    resolution.config.buildMode === 'unknown'
      ? fixedRisk('unknown-build-mode', 'degraded', ['buildMode'])
      : null,
    production && resolution.config.features.debugLogging
      ? fixedRisk(
        'debug-logging-production',
        'critical',
        ['features.debugLogging'],
      )
      : null,
    !resolution.config.features.strictEndpointPolicy
      ? fixedRisk(
        'strict-endpoint-disabled',
        'critical',
        ['features.strictEndpointPolicy'],
      )
      : null,
    !resolution.config.features.typedBootstrap
      ? fixedRisk(
        'typed-bootstrap-disabled',
        'critical',
        ['features.typedBootstrap'],
      )
      : null,
    production && resolution.config.release.trim().toLowerCase() === 'local'
      ? fixedRisk('local-release-production', 'degraded', ['release'])
      : null,
  ].filter((risk): risk is RuntimeConfigRisk => risk !== null);

  const bounded = sortedRisks(risks, policy.maxRiskEntries);
  const status = bounded.reduce<RuntimeConfigGovernanceStatus>(
    (current, risk) => stronger(current, risk.status),
    'healthy',
  );

  return Object.freeze({
    status,
    production,
    configFingerprint: resolution.configFingerprint,
    evidenceFingerprint: resolution.evidenceFingerprint,
    configuredFields: resolution.summary.configuredFields,
    defaultedFields: resolution.summary.defaultedFields,
    normalizedFields: resolution.summary.normalizedFields,
    clampedFields: resolution.summary.clampedFields,
    rejectedFields: resolution.summary.rejectedFields,
    pinnedFields: resolution.summary.pinnedFields,
    legacySourceFields: resolution.summary.legacySourceFields,
    shadowedSourceCount: resolution.summary.shadowedSourceCount,
    risks: bounded,
  });
};

const violation = (
  code: RuntimeConfigAdmissionViolationCode,
  affectedFields: readonly RuntimeConfigFieldId[],
  actualCount?: number,
  threshold?: number,
): RuntimeConfigAdmissionViolation => Object.freeze({
  code,
  affectedFields: Object.freeze([...affectedFields]),
  ...(actualCount === undefined ? {} : { actualCount }),
  ...(threshold === undefined ? {} : { threshold }),
});

export const assessRuntimeConfigAdmission = (
  resolution: RuntimeConfigResolution,
  overrides: Partial<RuntimeConfigAdmissionPolicy> = {},
): RuntimeConfigAdmissionResult => {
  const policy = admissionPolicy(overrides);
  const config = resolution.config;
  const production = productionEnvironment(config);
  const violations: RuntimeConfigAdmissionViolation[] = [];

  if (!policy.allowLegacyBuildMode && config.buildMode === 'legacy-cra') {
    violations.push(violation('legacy-build-mode', ['buildMode']));
  }
  if (!policy.allowUnknownBuildMode && config.buildMode === 'unknown') {
    violations.push(violation('unknown-build-mode', ['buildMode']));
  }
  if (
    production
    && config.features.debugLogging
    && !policy.allowDebugLoggingInProduction
  ) {
    violations.push(violation(
      'debug-logging-production',
      ['features.debugLogging'],
    ));
  }
  if (policy.requireStrictEndpointPolicy && !config.features.strictEndpointPolicy) {
    violations.push(violation(
      'strict-endpoint-disabled',
      ['features.strictEndpointPolicy'],
    ));
  }
  if (policy.requireTypedBootstrap && !config.features.typedBootstrap) {
    violations.push(violation(
      'typed-bootstrap-disabled',
      ['features.typedBootstrap'],
    ));
  }
  if (resolution.summary.rejectedFields > policy.maxRejectedFields) {
    violations.push(violation(
      'too-many-rejected-fields',
      affectedBy(
        resolution.evidence,
        (item) => item.disposition === 'invalid-fallback',
      ),
      resolution.summary.rejectedFields,
      policy.maxRejectedFields,
    ));
  }
  if (resolution.summary.legacySourceFields > policy.maxLegacySourceFields) {
    violations.push(violation(
      'too-many-legacy-fields',
      affectedBy(
        resolution.evidence,
        (item) => item.sourceKind === 'legacy-cra',
      ),
      resolution.summary.legacySourceFields,
      policy.maxLegacySourceFields,
    ));
  }
  if (resolution.summary.shadowedSourceCount > policy.maxShadowedSourceCount) {
    violations.push(violation(
      'too-many-shadowed-sources',
      affectedBy(
        resolution.evidence,
        (item) => item.shadowedSourceCount > 0,
      ),
      resolution.summary.shadowedSourceCount,
      policy.maxShadowedSourceCount,
    ));
  }

  const bounded = Object.freeze(violations.slice(0, policy.maxViolations));
  return Object.freeze({
    admitted: bounded.length === 0,
    production,
    configFingerprint: resolution.configFingerprint,
    violations: bounded,
  });
};

export const assertRuntimeConfigAdmissible = (
  resolution: RuntimeConfigResolution,
  overrides: Partial<RuntimeConfigAdmissionPolicy> = {},
): true => {
  const result = assessRuntimeConfigAdmission(resolution, overrides);
  if (!result.admitted) {
    throw new RuntimeConfigAdmissionError(
      'Runtime configuration does not satisfy admission policy.',
      result,
    );
  }
  return true;
};

const configValue = (
  config: RuntimeConfig,
  fieldId: RuntimeConfigFieldId,
): string | number | boolean => {
  switch (fieldId) {
    case 'apiBaseUrl':
      return config.apiBaseUrl;
    case 'requestTimeoutMs':
      return config.requestTimeoutMs;
    case 'cacheTtlMs':
      return config.cacheTtlMs;
    case 'maxRetries':
      return config.maxRetries;
    case 'environment':
      return config.environment;
    case 'release':
      return config.release;
    case 'esriApiVersion':
      return config.esriApiVersion;
    case 'tkgmCityId':
      return config.tkgmCityId;
    case 'buildMode':
      return config.buildMode;
    case 'features.adaptiveRuntime':
      return config.features.adaptiveRuntime;
    case 'features.debugLogging':
      return config.features.debugLogging;
    case 'features.privacyTelemetry':
      return config.features.privacyTelemetry;
    case 'features.typedBootstrap':
      return config.features.typedBootstrap;
    case 'features.strictEndpointPolicy':
      return config.features.strictEndpointPolicy;
  }
};

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const compareRuntimeConfigResolutions = (
  before: RuntimeConfigResolution,
  after: RuntimeConfigResolution,
): RuntimeConfigChangeSet => {
  const changes = Object.freeze(
    FIELDS
      .filter((fieldId) =>
        !Object.is(configValue(before.config, fieldId), configValue(after.config, fieldId)))
      .map((fieldId) => Object.freeze({
        fieldId,
        changeClass: FIELD_CLASS[fieldId],
        sensitive: fieldId === 'tkgmCityId',
      })),
  );
  const fingerprint = fnv1a([
    before.configFingerprint,
    after.configFingerprint,
    ...changes.map((change) => [
      change.fieldId,
      change.changeClass,
      Number(change.sensitive),
    ].join(':')),
  ].join('|'));

  return Object.freeze({
    changed: changes.length > 0,
    count: changes.length,
    changes,
    beforeFingerprint: before.configFingerprint,
    afterFingerprint: after.configFingerprint,
    fingerprint,
  });
};

const firstModernReplacement = (
  fieldId: Exclude<RuntimeConfigFieldId, 'buildMode'>,
): string | null => {
  const keys = RUNTIME_CONFIG_SOURCE_KEYS[fieldId];
  return keys.find((key) => !key.startsWith('REACT_APP_')) ?? null;
};

export const createRuntimeConfigMigrationPlan = (
  resolution: RuntimeConfigResolution,
): RuntimeConfigMigrationPlan => {
  const steps = resolution.evidence
    .filter((item) =>
      item.sourceKind === 'legacy-cra'
      && item.sourceKey
      && item.fieldId !== 'buildMode')
    .map((item): RuntimeConfigMigrationStep | null => {
      const fieldId = item.fieldId as Exclude<RuntimeConfigFieldId, 'buildMode'>;
      const replacementKey = firstModernReplacement(fieldId);
      if (!replacementKey || !item.sourceKey) return null;
      return Object.freeze({
        fieldId: item.fieldId,
        legacyKey: item.sourceKey,
        replacementKey,
        shadowed: item.shadowedSourceCount > 0,
      });
    })
    .filter((item): item is RuntimeConfigMigrationStep => item !== null)
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));

  return Object.freeze({
    required: steps.length > 0,
    stepCount: steps.length,
    steps: Object.freeze(steps),
    fingerprint: fnv1a(
      steps.map((step) => [
        step.fieldId,
        step.legacyKey,
        step.replacementKey,
        Number(step.shadowed),
      ].join(':')).join('|'),
    ),
  });
};

const sampleFingerprint = (
  sample: Omit<RuntimeConfigAuditSample, 'sequence' | 'sampledAt' | 'fingerprint'>,
): string => fnv1a([
  sample.status,
  Number(sample.production),
  sample.configFingerprint,
  sample.evidenceFingerprint,
  sample.riskCount,
  sample.legacySourceFields,
  sample.shadowedSourceCount,
  sample.rejectedFields,
  sample.pinnedFields,
  sample.changeCount,
  Number(sample.admitted),
  sample.violationCount,
].join('|'));

const safeErrorName = (error: unknown): string =>
  error instanceof Error && error.name.trim()
    ? error.name.trim().slice(0, 80)
    : 'UnknownError';

export const createRuntimeConfigGovernanceJournal = (
  options: RuntimeConfigGovernanceJournalOptions = {},
): RuntimeConfigGovernanceJournal => {
  const historyLimit = integer('historyLimit', options.historyLimit ?? 64, 0, 1_024);
  const eventLimit = integer('eventLimit', options.eventLimit ?? 128, 0, 2_048);
  const now = options.now ?? Date.now;
  const policy = governancePolicy(options.governancePolicy);
  const admission = admissionPolicy(options.admissionPolicy);
  const history: RuntimeConfigAuditSample[] = [];
  const events: RuntimeConfigAuditEvent[] = [];
  let sequence = 0;
  let eventSequence = 0;
  let observerFailures = 0;
  let lastObservedAt: number | undefined;
  let current: RuntimeConfigAuditSample | null = null;

  const timestamp = (): number => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('runtime config governance clock returned invalid timestamp');
    }
    if (lastObservedAt !== undefined && value < lastObservedAt) {
      throw new RangeError('runtime config governance clock must be monotonic');
    }
    lastObservedAt = value;
    return value;
  };

  const emit = (
    kind: RuntimeConfigAuditEventKind,
    at: number,
    details: Omit<RuntimeConfigAuditEvent, 'sequence' | 'at' | 'kind'> = {},
  ): void => {
    const event: RuntimeConfigAuditEvent = Object.freeze({
      sequence: ++eventSequence,
      at,
      kind,
      ...details,
    });
    if (eventLimit > 0) {
      events.push(event);
      const overflow = events.length - eventLimit;
      if (overflow > 0) events.splice(0, overflow);
    }
    if (!options.onEvent) return;
    try {
      options.onEvent(event);
    } catch (error) {
      observerFailures += 1;
      if (eventLimit > 0) {
        events.push(Object.freeze({
          sequence: ++eventSequence,
          at,
          kind: 'observer-failed',
          errorName: safeErrorName(error),
        }));
        const overflow = events.length - eventLimit;
        if (overflow > 0) events.splice(0, overflow);
      }
    }
  };

  const sample = (
    resolution: RuntimeConfigResolution,
    baseline?: RuntimeConfigResolution,
  ): RuntimeConfigAuditSample => {
    const sampledAt = timestamp();
    const governance = evaluateRuntimeConfigGovernance(resolution, policy);
    const admissionResult = assessRuntimeConfigAdmission(resolution, admission);
    const changes = baseline
      ? compareRuntimeConfigResolutions(baseline, resolution)
      : Object.freeze({
        changed: false,
        count: 0,
        changes: Object.freeze([]),
        beforeFingerprint: resolution.configFingerprint,
        afterFingerprint: resolution.configFingerprint,
        fingerprint: fnv1a(resolution.configFingerprint),
      }) as RuntimeConfigChangeSet;

    const core = Object.freeze({
      status: governance.status,
      production: governance.production,
      configFingerprint: resolution.configFingerprint,
      evidenceFingerprint: resolution.evidenceFingerprint,
      riskCount: governance.risks.length,
      legacySourceFields: governance.legacySourceFields,
      shadowedSourceCount: governance.shadowedSourceCount,
      rejectedFields: governance.rejectedFields,
      pinnedFields: governance.pinnedFields,
      changeCount: changes.count,
      admitted: admissionResult.admitted,
      violationCount: admissionResult.violations.length,
    });
    const next = Object.freeze({
      sequence: ++sequence,
      sampledAt,
      ...core,
      fingerprint: sampleFingerprint(core),
    });
    current = next;

    if (historyLimit > 0) {
      history.push(next);
      const overflow = history.length - historyLimit;
      if (overflow > 0) history.splice(0, overflow);
    }

    emit('sampled', sampledAt, {
      status: next.status,
      configFingerprint: next.configFingerprint,
    });
    if (changes.changed) {
      emit('change-detected', sampledAt, {
        status: next.status,
        configFingerprint: next.configFingerprint,
        changeCount: changes.count,
      });
    }
    emit(admissionResult.admitted ? 'admitted' : 'rejected', sampledAt, {
      status: next.status,
      configFingerprint: next.configFingerprint,
      violationCount: admissionResult.violations.length,
    });
    return next;
  };

  const snapshot = (): RuntimeConfigGovernanceJournalSnapshot => Object.freeze({
    samples: sequence,
    observerFailures,
    current,
    history: Object.freeze(history.slice()),
    events: Object.freeze(events.slice()),
  });

  const reset = (): void => {
    sequence = 0;
    eventSequence = 0;
    observerFailures = 0;
    lastObservedAt = undefined;
    current = null;
    history.splice(0, history.length);
    events.splice(0, events.length);
  };

  return Object.freeze({
    sample,
    snapshot,
    reset,
  });
};

export const runtimeConfigSecurityFields = (): readonly RuntimeConfigFieldId[] =>
  Object.freeze([...SECURITY_FIELDS].sort());
