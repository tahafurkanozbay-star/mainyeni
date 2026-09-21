import {
  boundedInteger,
  boundedText,
  deterministicBucket,
  freezeArray,
  governanceIdentifier,
  stableFingerprint,
  type FeatureEvaluation,
  type FeatureEvaluationContext,
  type FeaturePolicySnapshot,
  type FeatureRule,
} from './contracts';

export interface FeaturePolicyOptions {
  readonly maxRules?: number;
  readonly maxDependencies?: number;
  readonly defaultEnvironment?: string;
}

export interface FeaturePolicy {
  readonly register: (rule: FeatureRule) => () => void;
  readonly replace: (rule: FeatureRule) => void;
  readonly remove: (id: string) => boolean;
  readonly evaluate: (id: string, context?: FeatureEvaluationContext) => FeatureEvaluation;
  readonly evaluateAll: (context?: FeatureEvaluationContext) => readonly FeatureEvaluation[];
  readonly rule: (id: string) => FeatureRule | null;
  readonly snapshot: () => FeaturePolicySnapshot;
  readonly ids: () => readonly string[];
  readonly clear: () => void;
  readonly dispose: () => void;
}

interface NormalizedRule extends FeatureRule {
  readonly id: string;
  readonly percentage: number;
  readonly allowSubjects: readonly string[];
  readonly denySubjects: readonly string[];
  readonly environments: readonly string[];
  readonly excludeEnvironments: readonly string[];
  readonly requires: readonly string[];
  readonly disabledWhen: readonly string[];
  readonly killSwitch: boolean;
  readonly description: string;
}

const normalizeSubject = (value: unknown): string =>
  boundedText(value, '', 160).toLowerCase();

const normalizeEnvironment = (value: unknown, fallback: string): string =>
  boundedText(value, fallback, 80).toLowerCase();

const normalizeList = (
  values: readonly string[] | undefined,
  field: string,
  maximum: number,
  normalizer: (value: unknown) => string = (value) => governanceIdentifier(value, field, 120),
): readonly string[] => {
  const output = new Set<string>();
  for (const item of values ?? []) {
    const normalized = normalizer(item);
    if (!normalized) continue;
    output.add(normalized);
    if (output.size > maximum) throw new RangeError(`${field} exceeds capacity ${maximum}`);
  }
  return freezeArray(output);
};

const normalizeRule = (rule: FeatureRule, maxDependencies: number): NormalizedRule => {
  if (!rule || typeof rule !== 'object') throw new TypeError('feature rule is required');
  const id = governanceIdentifier(rule.id, 'feature id', 120);
  if (!['on', 'off', 'percentage', 'allowlist', 'denylist'].includes(rule.mode)) {
    throw new TypeError(`unsupported feature mode: ${String(rule.mode)}`);
  }
  const percentage = boundedInteger(rule.percentage, rule.mode === 'percentage' ? 0 : 100, 0, 100);
  const allowSubjects = normalizeList(rule.allowSubjects, 'allow subject', 512, normalizeSubject);
  const denySubjects = normalizeList(rule.denySubjects, 'deny subject', 512, normalizeSubject);
  const environments = normalizeList(rule.environments, 'environment', 32, (value) => normalizeEnvironment(value, ''));
  const excludeEnvironments = normalizeList(rule.excludeEnvironments, 'excluded environment', 32, (value) => normalizeEnvironment(value, ''));
  const requires = normalizeList(rule.requires, 'feature dependency', maxDependencies);
  const disabledWhen = normalizeList(rule.disabledWhen, 'feature exclusion', maxDependencies);
  if (requires.includes(id) || disabledWhen.includes(id)) {
    throw new Error(`feature ${id} cannot reference itself`);
  }
  return Object.freeze({
    ...rule,
    id,
    percentage,
    allowSubjects,
    denySubjects,
    environments,
    excludeEnvironments,
    requires,
    disabledWhen,
    killSwitch: rule.killSwitch === true,
    description: boundedText(rule.description, '', 240),
  });
};

export const createFeaturePolicy = (options: FeaturePolicyOptions = {}): FeaturePolicy => {
  const maxRules = boundedInteger(options.maxRules, 256, 1, 4096);
  const maxDependencies = boundedInteger(options.maxDependencies, 16, 0, 128);
  const defaultEnvironment = normalizeEnvironment(options.defaultEnvironment, 'production');
  const rules = new Map<string, NormalizedRule>();
  let revision = 0;
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error('feature policy has been disposed');
  };

  const register = (input: FeatureRule): (() => void) => {
    assertActive();
    if (rules.size >= maxRules) throw new RangeError('feature rule capacity exceeded');
    const rule = normalizeRule(input, maxDependencies);
    if (rules.has(rule.id)) throw new Error(`feature rule already registered: ${rule.id}`);
    rules.set(rule.id, rule);
    revision += 1;
    return () => {
      if (rules.delete(rule.id)) revision += 1;
    };
  };

  const replace = (input: FeatureRule): void => {
    assertActive();
    const rule = normalizeRule(input, maxDependencies);
    if (!rules.has(rule.id) && rules.size >= maxRules) throw new RangeError('feature rule capacity exceeded');
    rules.set(rule.id, rule);
    revision += 1;
  };

  const remove = (id: string): boolean => {
    assertActive();
    const removed = rules.delete(governanceIdentifier(id, 'feature id', 120));
    if (removed) revision += 1;
    return removed;
  };

  const evaluateInternal = (
    id: string,
    context: FeatureEvaluationContext,
    stack: readonly string[],
    memo: Map<string, FeatureEvaluation>,
  ): FeatureEvaluation => {
    const normalizedId = governanceIdentifier(id, 'feature id', 120);
    const existing = memo.get(normalizedId);
    if (existing) return existing;
    if (stack.includes(normalizedId)) {
      return Object.freeze({
        id: normalizedId,
        enabled: false,
        reason: 'cycle',
        dependencies: freezeArray(stack),
      });
    }

    const rule = rules.get(normalizedId);
    if (!rule) {
      const result: FeatureEvaluation = Object.freeze({
        id: normalizedId,
        enabled: false,
        reason: 'missing-dependency',
        dependencies: Object.freeze([]),
      });
      memo.set(normalizedId, result);
      return result;
    }

    const environment = normalizeEnvironment(context.environment, defaultEnvironment);
    const subject = normalizeSubject(context.subject);
    const nextStack = [...stack, normalizedId];

    if (rule.killSwitch) {
      const result: FeatureEvaluation = Object.freeze({
        id: normalizedId,
        enabled: false,
        reason: 'kill-switch',
        dependencies: rule.requires,
      });
      memo.set(normalizedId, result);
      return result;
    }

    if (rule.environments.length > 0 && !rule.environments.includes(environment)) {
      const result: FeatureEvaluation = Object.freeze({
        id: normalizedId,
        enabled: false,
        reason: 'environment-not-targeted',
        dependencies: rule.requires,
      });
      memo.set(normalizedId, result);
      return result;
    }
    if (rule.excludeEnvironments.includes(environment)) {
      const result: FeatureEvaluation = Object.freeze({
        id: normalizedId,
        enabled: false,
        reason: 'environment-excluded',
        dependencies: rule.requires,
      });
      memo.set(normalizedId, result);
      return result;
    }

    for (const excluded of rule.disabledWhen) {
      const dependency = evaluateInternal(excluded, context, nextStack, memo);
      if (dependency.enabled) {
        const result: FeatureEvaluation = Object.freeze({
          id: normalizedId,
          enabled: false,
          reason: 'disabled-by-rule',
          dependencies: rule.disabledWhen,
        });
        memo.set(normalizedId, result);
        return result;
      }
    }

    for (const dependencyId of rule.requires) {
      const dependency = evaluateInternal(dependencyId, context, nextStack, memo);
      if (!dependency.enabled) {
        const result: FeatureEvaluation = Object.freeze({
          id: normalizedId,
          enabled: false,
          reason: dependency.reason === 'missing-dependency' ? 'missing-dependency' : 'dependency-disabled',
          dependencies: rule.requires,
        });
        memo.set(normalizedId, result);
        return result;
      }
    }

    const dependencies = rule.requires;
    let result: FeatureEvaluation;
    switch (rule.mode) {
      case 'on':
        result = Object.freeze({ id: normalizedId, enabled: true, reason: 'enabled', dependencies });
        break;
      case 'off':
        result = Object.freeze({ id: normalizedId, enabled: false, reason: 'disabled', dependencies });
        break;
      case 'allowlist':
        result = Object.freeze({
          id: normalizedId,
          enabled: Boolean(subject && rule.allowSubjects.includes(subject)),
          reason: subject && rule.allowSubjects.includes(subject) ? 'enabled' : 'subject-not-allowed',
          dependencies,
        });
        break;
      case 'denylist':
        result = Object.freeze({
          id: normalizedId,
          enabled: !(subject && rule.denySubjects.includes(subject)),
          reason: subject && rule.denySubjects.includes(subject) ? 'subject-denied' : 'enabled',
          dependencies,
        });
        break;
      case 'percentage': {
        if (!subject) {
          result = Object.freeze({ id: normalizedId, enabled: false, reason: 'subject-not-allowed', dependencies });
          break;
        }
        const bucket = deterministicBucket(normalizedId, `${environment}|${subject}`);
        const enabled = bucket < rule.percentage * 100;
        result = Object.freeze({
          id: normalizedId,
          enabled,
          reason: 'percentage',
          bucket,
          dependencies,
        });
        break;
      }
    }
    memo.set(normalizedId, result);
    return result;
  };

  const evaluate = (id: string, context: FeatureEvaluationContext = {}): FeatureEvaluation => {
    assertActive();
    return evaluateInternal(id, context, [], new Map());
  };

  const evaluateAll = (context: FeatureEvaluationContext = {}): readonly FeatureEvaluation[] =>
    freezeArray(
      [...rules.keys()]
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((id) => evaluate(id, context)),
    );

  const snapshot = (): FeaturePolicySnapshot => {
    assertActive();
    const ordered = [...rules.values()].sort((left, right) => left.id.localeCompare(right.id, 'en'));
    const killSwitches = freezeArray(ordered.filter((rule) => rule.killSwitch).map((rule) => rule.id));
    const enabledByDefault = ordered.filter((rule) => rule.mode === 'on' && !rule.killSwitch).length;
    return Object.freeze({
      revision,
      ruleCount: ordered.length,
      enabledByDefault,
      killSwitches,
      fingerprint: stableFingerprint(ordered.map((rule) => ({
        id: rule.id,
        mode: rule.mode,
        percentage: rule.percentage,
        environments: rule.environments,
        excludeEnvironments: rule.excludeEnvironments,
        requires: rule.requires,
        disabledWhen: rule.disabledWhen,
        killSwitch: rule.killSwitch,
      }))),
    });
  };

  const clear = (): void => {
    assertActive();
    if (rules.size > 0) revision += 1;
    rules.clear();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    rules.clear();
  };

  return Object.freeze({
    register,
    replace,
    remove,
    evaluate,
    evaluateAll,
    rule: (id: string) => rules.get(governanceIdentifier(id, 'feature id', 120)) ?? null,
    snapshot,
    ids: () => freezeArray([...rules.keys()].sort((a, b) => a.localeCompare(b, 'en'))),
    clear,
    dispose,
  });
};
