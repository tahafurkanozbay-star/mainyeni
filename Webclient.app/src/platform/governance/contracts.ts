export type GovernancePhase = 'idle' | 'starting' | 'ready' | 'degraded' | 'blocked' | 'stopped' | 'disposed';

export type ConfigValueKind = 'string' | 'integer' | 'boolean' | 'enum' | 'json';
export type FeatureMode = 'on' | 'off' | 'percentage' | 'allowlist' | 'denylist';
export type ReadinessSeverity = 'critical' | 'degraded';
export type ReadinessStatus = 'pass' | 'fail' | 'unknown';
export type ReadinessState = 'ready' | 'degraded' | 'blocked' | 'unknown';

export interface GovernanceClock {
  now(): number;
}

export interface ConfigDescriptorBase {
  readonly key: string;
  readonly aliases?: readonly string[];
  readonly kind: ConfigValueKind;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly description?: string;
}

export interface StringConfigDescriptor extends ConfigDescriptorBase {
  readonly kind: 'string';
  readonly defaultValue?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly normalize?: (value: string) => string;
}

export interface IntegerConfigDescriptor extends ConfigDescriptorBase {
  readonly kind: 'integer';
  readonly defaultValue?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanConfigDescriptor extends ConfigDescriptorBase {
  readonly kind: 'boolean';
  readonly defaultValue?: boolean;
}

export interface EnumConfigDescriptor extends ConfigDescriptorBase {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly defaultValue?: string;
}

export interface JsonConfigDescriptor extends ConfigDescriptorBase {
  readonly kind: 'json';
  readonly defaultValue?: unknown;
  readonly maxBytes?: number;
  readonly validate?: (value: unknown) => boolean;
}

export type ConfigDescriptor =
  | StringConfigDescriptor
  | IntegerConfigDescriptor
  | BooleanConfigDescriptor
  | EnumConfigDescriptor
  | JsonConfigDescriptor;

export interface ConfigIssue {
  readonly key: string;
  readonly code:
    | 'missing-required'
    | 'invalid-type'
    | 'out-of-range'
    | 'invalid-pattern'
    | 'invalid-enum'
    | 'json-too-large'
    | 'json-invalid'
    | 'duplicate-key'
    | 'unknown-key';
  readonly message: string;
}

export interface ConfigEntrySnapshot {
  readonly key: string;
  readonly configured: boolean;
  readonly secret: boolean;
  readonly value?: unknown;
  readonly fingerprint: string;
}

export interface ConfigRegistrySnapshot {
  readonly revision: number;
  readonly generatedAt: number;
  readonly valid: boolean;
  readonly issues: readonly ConfigIssue[];
  readonly entries: readonly ConfigEntrySnapshot[];
  readonly fingerprint: string;
}

export interface FeatureRule {
  readonly id: string;
  readonly mode: FeatureMode;
  readonly percentage?: number;
  readonly allowSubjects?: readonly string[];
  readonly denySubjects?: readonly string[];
  readonly environments?: readonly string[];
  readonly excludeEnvironments?: readonly string[];
  readonly requires?: readonly string[];
  readonly disabledWhen?: readonly string[];
  readonly killSwitch?: boolean;
  readonly description?: string;
}

export interface FeatureEvaluationContext {
  readonly subject?: string;
  readonly environment?: string;
  readonly tags?: readonly string[];
}

export interface FeatureEvaluation {
  readonly id: string;
  readonly enabled: boolean;
  readonly reason:
    | 'enabled'
    | 'disabled'
    | 'kill-switch'
    | 'environment-not-targeted'
    | 'environment-excluded'
    | 'subject-not-allowed'
    | 'subject-denied'
    | 'percentage'
    | 'missing-dependency'
    | 'dependency-disabled'
    | 'disabled-by-rule'
    | 'cycle';
  readonly bucket?: number;
  readonly dependencies: readonly string[];
}

export interface FeaturePolicySnapshot {
  readonly revision: number;
  readonly ruleCount: number;
  readonly enabledByDefault: number;
  readonly killSwitches: readonly string[];
  readonly fingerprint: string;
}

export interface RuntimeManifestComponent {
  readonly id: string;
  readonly version: string;
  readonly domain: string;
  readonly required?: boolean;
  readonly startup?: 'eager' | 'lazy';
  readonly dependsOn?: readonly string[];
  readonly provides?: readonly string[];
  readonly consumes?: readonly string[];
  readonly description?: string;
}

export interface RuntimeManifestIssue {
  readonly componentId?: string;
  readonly code:
    | 'duplicate-component'
    | 'missing-dependency'
    | 'dependency-cycle'
    | 'missing-capability'
    | 'invalid-component';
  readonly message: string;
}

export interface RuntimeManifestSnapshot {
  readonly revision: number;
  readonly valid: boolean;
  readonly components: readonly RuntimeManifestComponent[];
  readonly startupOrder: readonly string[];
  readonly issues: readonly RuntimeManifestIssue[];
  readonly capabilities: Readonly<Record<string, readonly string[]>>;
  readonly fingerprint: string;
}

export interface ReadinessRequirement {
  readonly id: string;
  readonly severity: ReadinessSeverity;
  readonly ttlMs?: number;
  readonly required?: boolean;
  readonly description?: string;
}

export interface ReadinessEvidence {
  readonly id: string;
  readonly status: ReadinessStatus;
  readonly observedAt: number;
  readonly expiresAt: number | null;
  readonly code?: string;
  readonly detail?: string;
}

export interface ReadinessRequirementSnapshot {
  readonly requirement: ReadinessRequirement;
  readonly evidence: ReadinessEvidence | null;
  readonly stale: boolean;
  readonly effectiveStatus: ReadinessStatus;
}

export interface ReadinessSnapshot {
  readonly state: ReadinessState;
  readonly generatedAt: number;
  readonly blockers: readonly string[];
  readonly degraded: readonly string[];
  readonly unknown: readonly string[];
  readonly requirements: readonly ReadinessRequirementSnapshot[];
  readonly fingerprint: string;
}

export interface GovernanceKernelState {
  readonly phase: GovernancePhase;
  readonly generation: number;
  readonly configRevision: number;
  readonly featureRevision: number;
  readonly manifestRevision: number;
  readonly readinessState: ReadinessState;
  readonly startedAt: number | null;
  readonly lastTransitionAt: number;
}

export interface GovernanceKernelSnapshot {
  readonly state: GovernanceKernelState;
  readonly config: ConfigRegistrySnapshot;
  readonly features: FeaturePolicySnapshot;
  readonly manifest: RuntimeManifestSnapshot;
  readonly readiness: ReadinessSnapshot;
  readonly telemetryEvents: number;
  readonly fingerprint: string;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]*$/i;

export const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
};

export const boundedText = (
  value: unknown,
  fallback = '',
  maximumLength = 160,
): string => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\r\n\t]/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
  return normalized ? normalized.slice(0, Math.max(1, maximumLength)) : fallback;
};

export const governanceIdentifier = (value: unknown, field = 'identifier', maximumLength = 96): string => {
  const normalized = boundedText(value, '', maximumLength).toLowerCase();
  if (!normalized || CONTROL_CHARACTER.test(normalized) || !IDENTIFIER.test(normalized)) {
    throw new TypeError(`${field} must be a bounded platform identifier`);
  }
  return normalized;
};

export const freezeArray = <T>(value: Iterable<T>): readonly T[] =>
  Object.freeze(Array.from(value));

export const freezeRecord = <T>(value: Readonly<Record<string, T>>): Readonly<Record<string, T>> =>
  Object.freeze({ ...value });

export const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const stableStringify = (value: unknown): string => {
  const seen = new Set<object>();
  const visit = (candidate: unknown): unknown => {
    if (candidate === null || candidate === undefined) return candidate ?? null;
    if (typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') return Number.isFinite(candidate) ? candidate : null;
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (typeof candidate !== 'object') return String(candidate);
    if (seen.has(candidate)) throw new TypeError('governance value contains a cycle');
    seen.add(candidate);
    try {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right, 'en'))
          .map(([key, nested]) => [key, visit(nested)]),
      );
    } finally {
      seen.delete(candidate);
    }
  };
  return JSON.stringify(visit(value));
};

export const stableFingerprint = (value: unknown): string => {
  const source = stableStringify(value);
  let hashA = 2166136261;
  let hashB = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    hashA ^= code;
    hashA = Math.imul(hashA, 16777619);
    hashB ^= code + index;
    hashB = Math.imul(hashB, 3266489917);
  }
  return `${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}`;
};

export const deterministicBucket = (featureId: string, subject: string): number => {
  const source = `${featureId}|${subject}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 10_000;
};

export const sanitizeEvidenceDetail = (value: unknown): string | undefined => {
  const normalized = boundedText(value, '', 160);
  if (!normalized) return undefined;
  const redacted = normalized
    .replace(/(?:token|secret|password|authorization|cookie|credential)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/https?:\/\/[^\s]+/giu, '[url]');
  return redacted.slice(0, 160);
};

export const defaultGovernanceClock: GovernanceClock = Object.freeze({
  now: () => Date.now(),
});
