import type { RecordAliasSchema } from './contracts';
import {
  compareAliasCoverage,
  compareSchemaProfiles,
  createSchemaEvolutionFingerprint,
  evaluateAliasCoverage,
  profileDatasetSchema,
  type AliasCoverageReport,
  type DatasetSchemaProfile,
  type SchemaCompatibility,
  type SchemaDriftFinding,
  type SchemaDriftReport,
  type SchemaProfileOptions,
} from './schemaEvolution';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type SchemaRegistryMode = 'strict' | 'warning' | 'observe';
export type SchemaRegistryDecision = 'accepted' | 'rejected' | 'unchanged';

export interface SchemaRegistryOptions {
  readonly mode?: SchemaRegistryMode;
  readonly maxDatasets?: number;
  readonly maxHistoryPerDataset?: number;
  readonly maxWarnings?: number;
  readonly maxBreakingChanges?: number;
  readonly requireAliasCoverage?: readonly (keyof RecordAliasSchema)[];
  readonly profile?: SchemaProfileOptions;
}

export interface SchemaContractInput {
  readonly datasetKey: string;
  readonly version: string;
  readonly records: unknown;
  readonly aliases?: RecordAliasSchema;
  readonly expectedRevision?: number | null;
  readonly observedAt?: number;
}

export interface SchemaContractSnapshot {
  readonly datasetKey: string;
  readonly version: string;
  readonly revision: number;
  readonly profile: DatasetSchemaProfile;
  readonly aliases: AliasCoverageReport | null;
  readonly fingerprint: string;
  readonly observedAt: number;
}

export interface SchemaRegistryEvaluation {
  readonly decision: SchemaRegistryDecision;
  readonly datasetKey: string;
  readonly version: string;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly compatibility: SchemaCompatibility;
  readonly profile: DatasetSchemaProfile;
  readonly aliasCoverage: AliasCoverageReport | null;
  readonly drift: SchemaDriftReport | null;
  readonly aliasFindings: readonly SchemaDriftFinding[];
  readonly violations: readonly string[];
  readonly warnings: readonly string[];
  readonly fingerprint: string;
}

export interface SchemaRegistryHistoryEntry {
  readonly datasetKey: string;
  readonly version: string;
  readonly revision: number;
  readonly decision: SchemaRegistryDecision;
  readonly compatibility: SchemaCompatibility;
  readonly fingerprint: string;
  readonly previousFingerprint: string | null;
  readonly breakingCount: number;
  readonly warningCount: number;
  readonly observedAt: number;
}

export interface SchemaRegistrySnapshot {
  readonly version: 1;
  readonly datasetCount: number;
  readonly historyCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly unchangedCount: number;
  readonly fingerprint: string;
  readonly datasets: readonly SchemaContractSnapshot[];
}

interface NormalizedSchemaRegistryOptions {
  readonly mode: SchemaRegistryMode;
  readonly maxDatasets: number;
  readonly maxHistoryPerDataset: number;
  readonly maxWarnings: number;
  readonly maxBreakingChanges: number;
  readonly requireAliasCoverage: readonly (keyof RecordAliasSchema)[];
  readonly profile: SchemaProfileOptions;
}

const DEFAULT_MAX_DATASETS = 64;
const DEFAULT_MAX_HISTORY = 64;
const DEFAULT_MAX_WARNINGS = 50;
const DEFAULT_MAX_BREAKING = 0;

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 160);

const normalizeVersion = (value: unknown): string => normalizeText(value).slice(0, 120);

const normalizeTimestamp = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : Date.now();
};

const normalizeMode = (value: unknown): SchemaRegistryMode =>
  value === 'warning' || value === 'observe' ? value : 'strict';

const normalizeRequiredAliasFields = (
  values: readonly (keyof RecordAliasSchema)[] | undefined,
): readonly (keyof RecordAliasSchema)[] => {
  const allowed = new Set<keyof RecordAliasSchema>([
    'id',
    'title',
    'category',
    'type',
    'address',
    'district',
    'neighborhood',
    'street',
    'door',
    'postalCode',
    'phone',
    'url',
    'latitude',
    'longitude',
  ]);
  const output: (keyof RecordAliasSchema)[] = [];
  for (const value of values ?? []) {
    if (!allowed.has(value) || output.includes(value)) continue;
    output.push(value);
  }
  return Object.freeze(output);
};

const normalizeOptions = (
  options: SchemaRegistryOptions = {},
): NormalizedSchemaRegistryOptions => Object.freeze({
  mode: normalizeMode(options.mode),
  maxDatasets: normalizeInteger(options.maxDatasets, {
    min: 1,
    max: 1_024,
    fallback: DEFAULT_MAX_DATASETS,
  }),
  maxHistoryPerDataset: normalizeInteger(options.maxHistoryPerDataset, {
    min: 1,
    max: 1_000,
    fallback: DEFAULT_MAX_HISTORY,
  }),
  maxWarnings: normalizeInteger(options.maxWarnings, {
    min: 0,
    max: 10_000,
    fallback: DEFAULT_MAX_WARNINGS,
  }),
  maxBreakingChanges: normalizeInteger(options.maxBreakingChanges, {
    min: 0,
    max: 10_000,
    fallback: DEFAULT_MAX_BREAKING,
  }),
  requireAliasCoverage: normalizeRequiredAliasFields(options.requireAliasCoverage),
  profile: Object.freeze({ ...options.profile }),
});

const compatibilityRank = (value: SchemaCompatibility): number =>
  value === 'breaking' ? 2 : value === 'warning' ? 1 : 0;

const worstCompatibility = (
  left: SchemaCompatibility,
  right: SchemaCompatibility,
): SchemaCompatibility => compatibilityRank(right) > compatibilityRank(left) ? right : left;

const aliasCoverageFor = (
  profile: DatasetSchemaProfile,
  aliases: RecordAliasSchema | undefined,
): AliasCoverageReport | null => aliases ? evaluateAliasCoverage(profile, aliases) : null;

const missingRequiredAliases = (
  coverage: AliasCoverageReport | null,
  required: readonly (keyof RecordAliasSchema)[],
): readonly string[] => {
  if (!required.length) return Object.freeze([]);
  if (!coverage) return Object.freeze(required.map(field => `alias-coverage-missing:${String(field)}`));
  const byField = new Map(coverage.entries.map(entry => [entry.semanticField, entry]));
  return Object.freeze(required
    .filter(field => byField.get(field)?.covered !== true)
    .map(field => `alias-coverage-missing:${String(field)}`));
};

const createEvaluationFingerprint = (
  datasetKey: string,
  version: string,
  profile: DatasetSchemaProfile,
  aliases: AliasCoverageReport | null,
  drift: SchemaDriftReport | null,
  aliasFindings: readonly SchemaDriftFinding[],
): string => hashFingerprint(stableSerialize({
  datasetKey,
  version,
  profile: profile.fingerprint,
  aliases: aliases?.entries.map(entry => [entry.semanticField, entry.covered, entry.matchedFields]) ?? [],
  drift: drift?.findings.map(item => [item.kind, item.compatibility, item.field]) ?? [],
  aliasFindings: aliasFindings.map(item => [item.kind, item.compatibility, item.field]),
}));

const freezeContract = (
  datasetKey: string,
  version: string,
  revision: number,
  profile: DatasetSchemaProfile,
  aliases: AliasCoverageReport | null,
  observedAt: number,
): SchemaContractSnapshot => Object.freeze({
  datasetKey,
  version,
  revision,
  profile,
  aliases,
  fingerprint: createSchemaEvolutionFingerprint(profile, aliases),
  observedAt,
});

const freezeHistory = (
  evaluation: SchemaRegistryEvaluation,
  previousFingerprint: string | null,
  observedAt: number,
): SchemaRegistryHistoryEntry => Object.freeze({
  datasetKey: evaluation.datasetKey,
  version: evaluation.version,
  revision: evaluation.nextRevision,
  decision: evaluation.decision,
  compatibility: evaluation.compatibility,
  fingerprint: evaluation.fingerprint,
  previousFingerprint,
  breakingCount: evaluation.drift?.breakingCount ?? 0,
  warningCount: (evaluation.drift?.warningCount ?? 0)
    + evaluation.aliasFindings.filter(item => item.compatibility === 'warning').length,
  observedAt,
});

export class SchemaRegistryRuntime {
  readonly #options: NormalizedSchemaRegistryOptions;
  readonly #contracts = new Map<string, SchemaContractSnapshot>();
  readonly #history = new Map<string, SchemaRegistryHistoryEntry[]>();
  #acceptedCount = 0;
  #rejectedCount = 0;
  #unchangedCount = 0;

  constructor(options: SchemaRegistryOptions = {}) {
    this.#options = normalizeOptions(options);
  }

  evaluate(input: SchemaContractInput): SchemaRegistryEvaluation {
    const datasetKey = normalizeDatasetKey(input.datasetKey);
    const version = normalizeVersion(input.version);
    if (!datasetKey) throw new TypeError('Schema registry dataset key is required');
    if (!version) throw new TypeError('Schema registry version is required');

    const previous = this.#contracts.get(datasetKey) ?? null;
    const expectedRevision = input.expectedRevision === null || input.expectedRevision === undefined
      ? null
      : normalizeInteger(input.expectedRevision, {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        fallback: -1,
      });
    const profile = profileDatasetSchema(input.records, this.#options.profile);
    const aliasCoverage = aliasCoverageFor(profile, input.aliases);
    const drift = previous ? compareSchemaProfiles(previous.profile, profile) : null;
    const aliasFindings = previous?.aliases && aliasCoverage
      ? compareAliasCoverage(previous.aliases, aliasCoverage)
      : Object.freeze([]);

    let compatibility: SchemaCompatibility = drift?.compatibility ?? 'compatible';
    for (const finding of aliasFindings) {
      compatibility = worstCompatibility(compatibility, finding.compatibility);
    }

    const violations: string[] = [];
    const warnings: string[] = [];
    if (expectedRevision !== null && expectedRevision !== (previous?.revision ?? 0)) {
      violations.push(`revision-conflict:expected=${String(expectedRevision)}:actual=${String(previous?.revision ?? 0)}`);
    }

    const requiredAliasViolations = missingRequiredAliases(
      aliasCoverage,
      this.#options.requireAliasCoverage,
    );
    violations.push(...requiredAliasViolations);

    const breakingCount = (drift?.breakingCount ?? 0)
      + aliasFindings.filter(item => item.compatibility === 'breaking').length;
    const warningCount = (drift?.warningCount ?? 0)
      + aliasFindings.filter(item => item.compatibility === 'warning').length;

    if (breakingCount > this.#options.maxBreakingChanges) {
      violations.push(`breaking-change-budget:${String(breakingCount)}>${String(this.#options.maxBreakingChanges)}`);
    }
    if (warningCount > this.#options.maxWarnings) {
      if (this.#options.mode === 'strict') {
        violations.push(`warning-budget:${String(warningCount)}>${String(this.#options.maxWarnings)}`);
      } else {
        warnings.push(`warning-budget:${String(warningCount)}>${String(this.#options.maxWarnings)}`);
      }
    }
    if (compatibility === 'breaking' && this.#options.mode === 'strict') {
      violations.push('breaking-schema-drift');
    } else if (compatibility !== 'compatible') {
      warnings.push(`schema-compatibility:${compatibility}`);
    }

    const fingerprint = createEvaluationFingerprint(
      datasetKey,
      version,
      profile,
      aliasCoverage,
      drift,
      aliasFindings,
    );
    const previousFingerprint = previous
      ? createEvaluationFingerprint(
        previous.datasetKey,
        previous.version,
        previous.profile,
        previous.aliases,
        null,
        Object.freeze([]),
      )
      : null;
    const unchanged = Boolean(previous
      && previous.profile.fingerprint === profile.fingerprint
      && createSchemaEvolutionFingerprint(previous.profile, previous.aliases)
        === createSchemaEvolutionFingerprint(profile, aliasCoverage));
    const blocked = violations.length > 0 && this.#options.mode !== 'observe';
    const decision: SchemaRegistryDecision = blocked
      ? 'rejected'
      : unchanged
        ? 'unchanged'
        : 'accepted';
    const previousRevision = previous?.revision ?? 0;
    const nextRevision = decision === 'accepted' ? previousRevision + 1 : previousRevision;

    void previousFingerprint;
    return Object.freeze({
      decision,
      datasetKey,
      version,
      previousRevision,
      nextRevision,
      compatibility,
      profile,
      aliasCoverage,
      drift,
      aliasFindings: Object.freeze([...aliasFindings]),
      violations: Object.freeze(violations),
      warnings: Object.freeze(warnings),
      fingerprint,
    });
  }

  register(input: SchemaContractInput): SchemaRegistryEvaluation {
    const evaluation = this.evaluate(input);
    const previous = this.#contracts.get(evaluation.datasetKey) ?? null;
    const observedAt = normalizeTimestamp(input.observedAt);

    if (evaluation.decision === 'accepted') {
      if (!previous && this.#contracts.size >= this.#options.maxDatasets) {
        const rejected = Object.freeze({
          ...evaluation,
          decision: 'rejected' as const,
          violations: Object.freeze([...evaluation.violations, 'dataset-capacity-exceeded']),
        });
        this.#rejectedCount += 1;
        this.#appendHistory(rejected, null, observedAt);
        return rejected;
      }
      this.#contracts.set(evaluation.datasetKey, freezeContract(
        evaluation.datasetKey,
        evaluation.version,
        evaluation.nextRevision,
        evaluation.profile,
        evaluation.aliasCoverage,
        observedAt,
      ));
      this.#acceptedCount += 1;
    } else if (evaluation.decision === 'rejected') {
      this.#rejectedCount += 1;
    } else {
      this.#unchangedCount += 1;
    }

    this.#appendHistory(evaluation, previous?.fingerprint ?? null, observedAt);
    return evaluation;
  }

  contract(datasetKeyInput: unknown): SchemaContractSnapshot | null {
    const datasetKey = normalizeDatasetKey(datasetKeyInput);
    return this.#contracts.get(datasetKey) ?? null;
  }

  history(datasetKeyInput: unknown): readonly SchemaRegistryHistoryEntry[] {
    const datasetKey = normalizeDatasetKey(datasetKeyInput);
    return Object.freeze([...(this.#history.get(datasetKey) ?? [])]);
  }

  remove(datasetKeyInput: unknown): boolean {
    const datasetKey = normalizeDatasetKey(datasetKeyInput);
    const removed = this.#contracts.delete(datasetKey);
    this.#history.delete(datasetKey);
    return removed;
  }

  clear(): void {
    this.#contracts.clear();
    this.#history.clear();
    this.#acceptedCount = 0;
    this.#rejectedCount = 0;
    this.#unchangedCount = 0;
  }

  snapshot(): SchemaRegistrySnapshot {
    const datasets = [...this.#contracts.values()]
      .sort((left, right) => left.datasetKey.localeCompare(right.datasetKey));
    const historyCount = [...this.#history.values()]
      .reduce((total, items) => total + items.length, 0);
    const fingerprint = hashFingerprint(stableSerialize({
      datasets: datasets.map(item => [
        item.datasetKey,
        item.version,
        item.revision,
        item.fingerprint,
      ]),
      acceptedCount: this.#acceptedCount,
      rejectedCount: this.#rejectedCount,
      unchangedCount: this.#unchangedCount,
    }));
    return Object.freeze({
      version: 1 as const,
      datasetCount: datasets.length,
      historyCount,
      acceptedCount: this.#acceptedCount,
      rejectedCount: this.#rejectedCount,
      unchangedCount: this.#unchangedCount,
      fingerprint,
      datasets: Object.freeze(datasets),
    });
  }

  #appendHistory(
    evaluation: SchemaRegistryEvaluation,
    previousFingerprint: string | null,
    observedAt: number,
  ): void {
    const history = this.#history.get(evaluation.datasetKey) ?? [];
    history.push(freezeHistory(evaluation, previousFingerprint, observedAt));
    if (history.length > this.#options.maxHistoryPerDataset) {
      history.splice(0, history.length - this.#options.maxHistoryPerDataset);
    }
    this.#history.set(evaluation.datasetKey, history);
  }
}

export const createSchemaRegistryRuntime = (
  options: SchemaRegistryOptions = {},
): SchemaRegistryRuntime => new SchemaRegistryRuntime(options);