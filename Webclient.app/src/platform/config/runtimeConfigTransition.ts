import {
  compareRuntimeConfigResolutions,
  type RuntimeConfigChange,
  type RuntimeConfigChangeClass,
  type RuntimeConfigChangeSet,
} from './runtimeConfigGovernance';
import type {
  RuntimeConfigFieldId,
  RuntimeConfigResolution,
} from './runtimeConfig';

export type RuntimeConfigTransitionViolationCode =
  | 'change-budget-exceeded'
  | 'network-boundary-change'
  | 'security-boundary-change'
  | 'sensitive-identity-change'
  | 'environment-change'
  | 'sdk-version-change'
  | 'build-mode-regression'
  | 'legacy-source-regression'
  | 'rejected-field-regression'
  | 'shadowed-source-regression';

export interface RuntimeConfigTransitionPolicy {
  readonly maxChangedFields: number;
  readonly allowNetworkBoundaryChange: boolean;
  readonly allowSecurityBoundaryChange: boolean;
  readonly allowSensitiveIdentityChange: boolean;
  readonly allowEnvironmentChange: boolean;
  readonly allowSdkVersionChange: boolean;
  readonly allowBuildModeRegression: boolean;
  readonly maxLegacySourceIncrease: number;
  readonly maxRejectedFieldIncrease: number;
  readonly maxShadowedSourceIncrease: number;
  readonly maxViolations: number;
}

export interface RuntimeConfigTransitionViolation {
  readonly code: RuntimeConfigTransitionViolationCode;
  readonly affectedFields: readonly RuntimeConfigFieldId[];
  readonly actualCount?: number;
  readonly threshold?: number;
}

export interface RuntimeConfigTransitionAssessment {
  readonly allowed: boolean;
  readonly changes: RuntimeConfigChangeSet;
  readonly violations: readonly RuntimeConfigTransitionViolation[];
  readonly beforeEvidenceFingerprint: string;
  readonly afterEvidenceFingerprint: string;
  readonly fingerprint: string;
}

export type RuntimeConfigTransitionErrorCode = 'RUNTIME_CONFIG_TRANSITION_REJECTED';

export class RuntimeConfigTransitionError extends Error {
  readonly code: RuntimeConfigTransitionErrorCode =
    'RUNTIME_CONFIG_TRANSITION_REJECTED';

  constructor(
    message: string,
    readonly assessment: RuntimeConfigTransitionAssessment,
  ) {
    super(message);
    this.name = 'RuntimeConfigTransitionError';
  }
}

const DEFAULT_POLICY: RuntimeConfigTransitionPolicy = Object.freeze({
  maxChangedFields: 6,
  allowNetworkBoundaryChange: false,
  allowSecurityBoundaryChange: false,
  allowSensitiveIdentityChange: true,
  allowEnvironmentChange: false,
  allowSdkVersionChange: false,
  allowBuildModeRegression: false,
  maxLegacySourceIncrease: 0,
  maxRejectedFieldIncrease: 0,
  maxShadowedSourceIncrease: 0,
  maxViolations: 16,
});

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

const createPolicy = (
  overrides: Partial<RuntimeConfigTransitionPolicy> = {},
): RuntimeConfigTransitionPolicy => Object.freeze({
  maxChangedFields: integer(
    'maxChangedFields',
    overrides.maxChangedFields ?? DEFAULT_POLICY.maxChangedFields,
    0,
    100,
  ),
  allowNetworkBoundaryChange:
    overrides.allowNetworkBoundaryChange ?? DEFAULT_POLICY.allowNetworkBoundaryChange,
  allowSecurityBoundaryChange:
    overrides.allowSecurityBoundaryChange ?? DEFAULT_POLICY.allowSecurityBoundaryChange,
  allowSensitiveIdentityChange:
    overrides.allowSensitiveIdentityChange
    ?? DEFAULT_POLICY.allowSensitiveIdentityChange,
  allowEnvironmentChange:
    overrides.allowEnvironmentChange ?? DEFAULT_POLICY.allowEnvironmentChange,
  allowSdkVersionChange:
    overrides.allowSdkVersionChange ?? DEFAULT_POLICY.allowSdkVersionChange,
  allowBuildModeRegression:
    overrides.allowBuildModeRegression ?? DEFAULT_POLICY.allowBuildModeRegression,
  maxLegacySourceIncrease: integer(
    'maxLegacySourceIncrease',
    overrides.maxLegacySourceIncrease ?? DEFAULT_POLICY.maxLegacySourceIncrease,
    0,
    100,
  ),
  maxRejectedFieldIncrease: integer(
    'maxRejectedFieldIncrease',
    overrides.maxRejectedFieldIncrease ?? DEFAULT_POLICY.maxRejectedFieldIncrease,
    0,
    100,
  ),
  maxShadowedSourceIncrease: integer(
    'maxShadowedSourceIncrease',
    overrides.maxShadowedSourceIncrease ?? DEFAULT_POLICY.maxShadowedSourceIncrease,
    0,
    100,
  ),
  maxViolations: integer(
    'maxViolations',
    overrides.maxViolations ?? DEFAULT_POLICY.maxViolations,
    1,
    128,
  ),
});

const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const violation = (
  code: RuntimeConfigTransitionViolationCode,
  affectedFields: readonly RuntimeConfigFieldId[],
  actualCount?: number,
  threshold?: number,
): RuntimeConfigTransitionViolation => Object.freeze({
  code,
  affectedFields: Object.freeze([...affectedFields]),
  ...(actualCount === undefined ? {} : { actualCount }),
  ...(threshold === undefined ? {} : { threshold }),
});

const fieldsByClass = (
  changes: readonly RuntimeConfigChange[],
  changeClass: RuntimeConfigChangeClass,
): readonly RuntimeConfigFieldId[] => Object.freeze(
  changes
    .filter((change) => change.changeClass === changeClass)
    .map((change) => change.fieldId),
);

const fieldsBy = (
  changes: readonly RuntimeConfigChange[],
  predicate: (change: RuntimeConfigChange) => boolean,
): readonly RuntimeConfigFieldId[] => Object.freeze(
  changes.filter(predicate).map((change) => change.fieldId),
);

const buildModeRank = (
  mode: RuntimeConfigResolution['config']['buildMode'],
): number => {
  if (mode === 'vite-ready') return 2;
  if (mode === 'unknown') return 1;
  return 0;
};

const positiveIncrease = (before: number, after: number): number =>
  Math.max(0, after - before);

export const assessRuntimeConfigTransition = (
  before: RuntimeConfigResolution,
  after: RuntimeConfigResolution,
  overrides: Partial<RuntimeConfigTransitionPolicy> = {},
): RuntimeConfigTransitionAssessment => {
  const policy = createPolicy(overrides);
  const changes = compareRuntimeConfigResolutions(before, after);
  const violations: RuntimeConfigTransitionViolation[] = [];

  if (changes.count > policy.maxChangedFields) {
    violations.push(violation(
      'change-budget-exceeded',
      changes.changes.map((change) => change.fieldId),
      changes.count,
      policy.maxChangedFields,
    ));
  }

  const networkFields = fieldsByClass(changes.changes, 'network-boundary');
  if (!policy.allowNetworkBoundaryChange && networkFields.length > 0) {
    violations.push(violation('network-boundary-change', networkFields));
  }

  const securityFields = fieldsByClass(changes.changes, 'security-boundary');
  if (!policy.allowSecurityBoundaryChange && securityFields.length > 0) {
    violations.push(violation('security-boundary-change', securityFields));
  }

  const sensitiveFields = fieldsBy(
    changes.changes,
    (change) => change.sensitive,
  );
  if (!policy.allowSensitiveIdentityChange && sensitiveFields.length > 0) {
    violations.push(violation('sensitive-identity-change', sensitiveFields));
  }

  const environmentChanged = changes.changes.some(
    (change) => change.fieldId === 'environment',
  );
  if (!policy.allowEnvironmentChange && environmentChanged) {
    violations.push(violation('environment-change', ['environment']));
  }

  const sdkChanged = changes.changes.some(
    (change) => change.fieldId === 'esriApiVersion',
  );
  if (!policy.allowSdkVersionChange && sdkChanged) {
    violations.push(violation('sdk-version-change', ['esriApiVersion']));
  }

  const buildModeRegressed =
    buildModeRank(after.config.buildMode) < buildModeRank(before.config.buildMode);
  if (!policy.allowBuildModeRegression && buildModeRegressed) {
    violations.push(violation('build-mode-regression', ['buildMode']));
  }

  const legacyIncrease = positiveIncrease(
    before.summary.legacySourceFields,
    after.summary.legacySourceFields,
  );
  if (legacyIncrease > policy.maxLegacySourceIncrease) {
    violations.push(violation(
      'legacy-source-regression',
      after.evidence
        .filter((item) => item.sourceKind === 'legacy-cra')
        .map((item) => item.fieldId),
      legacyIncrease,
      policy.maxLegacySourceIncrease,
    ));
  }

  const rejectedIncrease = positiveIncrease(
    before.summary.rejectedFields,
    after.summary.rejectedFields,
  );
  if (rejectedIncrease > policy.maxRejectedFieldIncrease) {
    violations.push(violation(
      'rejected-field-regression',
      after.evidence
        .filter((item) => item.disposition === 'invalid-fallback')
        .map((item) => item.fieldId),
      rejectedIncrease,
      policy.maxRejectedFieldIncrease,
    ));
  }

  const shadowedIncrease = positiveIncrease(
    before.summary.shadowedSourceCount,
    after.summary.shadowedSourceCount,
  );
  if (shadowedIncrease > policy.maxShadowedSourceIncrease) {
    violations.push(violation(
      'shadowed-source-regression',
      after.evidence
        .filter((item) => item.shadowedSourceCount > 0)
        .map((item) => item.fieldId),
      shadowedIncrease,
      policy.maxShadowedSourceIncrease,
    ));
  }

  const bounded = Object.freeze(violations.slice(0, policy.maxViolations));
  const fingerprint = fnv1a([
    changes.fingerprint,
    before.evidenceFingerprint,
    after.evidenceFingerprint,
    ...bounded.map((item) => [
      item.code,
      item.affectedFields.join(','),
      item.actualCount ?? '',
      item.threshold ?? '',
    ].join(':')),
  ].join('|'));

  return Object.freeze({
    allowed: bounded.length === 0,
    changes,
    violations: bounded,
    beforeEvidenceFingerprint: before.evidenceFingerprint,
    afterEvidenceFingerprint: after.evidenceFingerprint,
    fingerprint,
  });
};

export const assertRuntimeConfigTransitionSafe = (
  before: RuntimeConfigResolution,
  after: RuntimeConfigResolution,
  overrides: Partial<RuntimeConfigTransitionPolicy> = {},
): true => {
  const assessment = assessRuntimeConfigTransition(before, after, overrides);
  if (!assessment.allowed) {
    throw new RuntimeConfigTransitionError(
      'Runtime configuration transition does not satisfy policy.',
      assessment,
    );
  }
  return true;
};

export const runtimeConfigTransitionPolicyDefaults =
  (): RuntimeConfigTransitionPolicy => Object.freeze({ ...DEFAULT_POLICY });
