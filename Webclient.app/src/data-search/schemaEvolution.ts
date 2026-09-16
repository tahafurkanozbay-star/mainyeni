import type { RecordAliasSchema } from './contracts';
import { isRecord } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type SchemaScalarKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | 'undefined'
  | 'unknown';

export type SchemaDriftKind =
  | 'field-added'
  | 'field-removed'
  | 'type-expanded'
  | 'type-narrowed'
  | 'requiredness-changed'
  | 'nullability-changed'
  | 'alias-coverage-lost'
  | 'alias-coverage-added';

export type SchemaCompatibility = 'compatible' | 'warning' | 'breaking';

export interface FieldSchemaProfile {
  readonly name: string;
  readonly normalizedName: string;
  readonly seenCount: number;
  readonly missingCount: number;
  readonly nullCount: number;
  readonly emptyStringCount: number;
  readonly nonEmptyCount: number;
  readonly distinctSampleCount: number;
  readonly kinds: Readonly<Record<SchemaScalarKind, number>>;
  readonly dominantKind: SchemaScalarKind;
  readonly nullable: boolean;
  readonly required: boolean;
  readonly examples: readonly string[];
}

export interface DatasetSchemaProfile {
  readonly version: 1;
  readonly inputCount: number;
  readonly sampledCount: number;
  readonly fieldCount: number;
  readonly fields: Readonly<Record<string, FieldSchemaProfile>>;
  readonly fieldOrder: readonly string[];
  readonly fingerprint: string;
}

export interface SchemaDriftFinding {
  readonly key: string;
  readonly kind: SchemaDriftKind;
  readonly compatibility: SchemaCompatibility;
  readonly field: string;
  readonly before: FieldSchemaProfile | null;
  readonly after: FieldSchemaProfile | null;
  readonly detail: string;
}

export interface SchemaDriftReport {
  readonly baselineFingerprint: string;
  readonly candidateFingerprint: string;
  readonly compatibility: SchemaCompatibility;
  readonly breakingCount: number;
  readonly warningCount: number;
  readonly compatibleCount: number;
  readonly findings: readonly SchemaDriftFinding[];
  readonly addedFields: readonly string[];
  readonly removedFields: readonly string[];
  readonly changedFields: readonly string[];
}

export interface SchemaProfileOptions {
  readonly maxRecords?: number;
  readonly maxFields?: number;
  readonly maxExamplesPerField?: number;
  readonly includeNestedFields?: boolean;
  readonly maxNestedDepth?: number;
}

export interface SchemaMigrationContext {
  readonly datasetKey: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly stepId: string;
  readonly index: number;
}

export interface SchemaMigrationStep {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly transform: (
    record: Readonly<Record<string, unknown>>,
    context: SchemaMigrationContext,
  ) => Readonly<Record<string, unknown>>;
}

export interface SchemaMigrationResult {
  readonly datasetKey: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly path: readonly string[];
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly transformedCount: number;
  readonly rejectedCount: number;
  readonly errors: readonly SchemaMigrationError[];
}

export interface SchemaMigrationError {
  readonly index: number;
  readonly stepId: string;
  readonly message: string;
}

export interface AliasCoverageEntry {
  readonly semanticField: keyof RecordAliasSchema;
  readonly aliases: readonly string[];
  readonly matchedFields: readonly string[];
  readonly covered: boolean;
}

export interface AliasCoverageReport {
  readonly coveredCount: number;
  readonly missingCount: number;
  readonly entries: readonly AliasCoverageEntry[];
}

const SCALAR_KINDS: readonly SchemaScalarKind[] = Object.freeze([
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'null',
  'undefined',
  'unknown',
]);

const DEFAULT_MAX_RECORDS = 5_000;
const DEFAULT_MAX_FIELDS = 256;
const DEFAULT_MAX_EXAMPLES = 5;
const DEFAULT_MAX_NESTED_DEPTH = 2;
const MAX_DISTINCT_SAMPLES = 1_000;

interface MutableFieldProfile {
  name: string;
  normalizedName: string;
  seenCount: number;
  nullCount: number;
  emptyStringCount: number;
  kinds: Record<SchemaScalarKind, number>;
  examples: Set<string>;
  distinctSamples: Set<string>;
}

const createKindCounters = (): Record<SchemaScalarKind, number> => ({
  string: 0,
  number: 0,
  boolean: 0,
  object: 0,
  array: 0,
  null: 0,
  undefined: 0,
  unknown: 0,
});

export const classifySchemaValue = (value: unknown): SchemaScalarKind => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return kind;
  if (kind === 'object') return 'object';
  return 'unknown';
};

const previewValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.slice(0, 120);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return stableSerialize(value).slice(0, 120);
  } catch {
    return `[${classifySchemaValue(value)}]`;
  }
};

const normalizeFieldName = (value: unknown): string =>
  normalizeSearchText(value).replace(/\s+/g, '_');

const collectRecordFields = (
  value: unknown,
  includeNested: boolean,
  maxDepth: number,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return Object.freeze({});
  if (!includeNested || maxDepth <= 0) return value;

  const output: Record<string, unknown> = {};
  const visited = new WeakSet<object>();
  const visit = (record: Readonly<Record<string, unknown>>, prefix: string, depth: number): void => {
    if (visited.has(record)) return;
    visited.add(record);
    Object.entries(record).reduce((_, [key, fieldValue]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(path in output)) output[path] = fieldValue;
      if (depth < maxDepth && isRecord(fieldValue)) visit(fieldValue, path, depth + 1);
      return undefined;
    }, undefined as void);
  };

  visit(value, '', 0);
  return Object.freeze(output);
};

const dominantKind = (kinds: Readonly<Record<SchemaScalarKind, number>>): SchemaScalarKind => {
  const selected = SCALAR_KINDS.reduce<{ kind: SchemaScalarKind; count: number }>((current, kind) => {
    if (kind === 'null' || kind === 'undefined') return current;
    const count = kinds[kind] ?? 0;
    return count > current.count ? { kind, count } : current;
  }, { kind: 'unknown', count: -1 });

  if (selected.count > 0) return selected.kind;
  if ((kinds.null ?? 0) > 0) return 'null';
  if ((kinds.undefined ?? 0) > 0) return 'undefined';
  return 'unknown';
};

const createMutableField = (name: string, normalizedName: string): MutableFieldProfile => ({
  name,
  normalizedName,
  seenCount: 0,
  nullCount: 0,
  emptyStringCount: 0,
  kinds: createKindCounters(),
  examples: new Set<string>(),
  distinctSamples: new Set<string>(),
});

const observeField = (
  mutable: Map<string, MutableFieldProfile>,
  fieldOrder: string[],
  maxFields: number,
  maxExamples: number,
  name: string,
  value: unknown,
): void => {
  const normalizedName = normalizeFieldName(name);
  if (!normalizedName) return;

  let field = mutable.get(normalizedName);
  if (!field) {
    if (mutable.size >= maxFields) return;
    field = createMutableField(name, normalizedName);
    mutable.set(normalizedName, field);
    fieldOrder.push(normalizedName);
  }

  field.seenCount += 1;
  const kind = classifySchemaValue(value);
  field.kinds[kind] += 1;
  if (value === null || value === undefined) field.nullCount += 1;
  if (typeof value === 'string' && !value.trim()) field.emptyStringCount += 1;
  const preview = previewValue(value);
  if (field.examples.size < maxExamples) field.examples.add(preview);
  if (field.distinctSamples.size < MAX_DISTINCT_SAMPLES) field.distinctSamples.add(preview);
};

const finalizeField = (
  field: MutableFieldProfile,
  sampleCount: number,
): FieldSchemaProfile => {
  const missingCount = Math.max(0, sampleCount - field.seenCount);
  const nonEmptyCount = Math.max(0, field.seenCount - field.nullCount - field.emptyStringCount);
  return Object.freeze({
    name: field.name,
    normalizedName: field.normalizedName,
    seenCount: field.seenCount,
    missingCount,
    nullCount: field.nullCount,
    emptyStringCount: field.emptyStringCount,
    nonEmptyCount,
    distinctSampleCount: field.distinctSamples.size,
    kinds: Object.freeze({ ...field.kinds }),
    dominantKind: dominantKind(field.kinds),
    nullable: field.nullCount > 0,
    required: sampleCount > 0 && missingCount === 0 && field.nullCount === 0,
    examples: Object.freeze([...field.examples]),
  });
};

export const profileDatasetSchema = (
  input: unknown,
  options: SchemaProfileOptions = {},
): DatasetSchemaProfile => {
  const records = Array.isArray(input) ? input : [];
  const maxRecords = normalizeInteger(options.maxRecords, {
    min: 1,
    max: 100_000,
    fallback: DEFAULT_MAX_RECORDS,
  });
  const maxFields = normalizeInteger(options.maxFields, {
    min: 1,
    max: 4_096,
    fallback: DEFAULT_MAX_FIELDS,
  });
  const maxExamples = normalizeInteger(options.maxExamplesPerField, {
    min: 0,
    max: 25,
    fallback: DEFAULT_MAX_EXAMPLES,
  });
  const maxDepth = normalizeInteger(options.maxNestedDepth, {
    min: 0,
    max: 8,
    fallback: DEFAULT_MAX_NESTED_DEPTH,
  });
  const sample = records.slice(0, maxRecords);
  const mutable = new Map<string, MutableFieldProfile>();
  const fieldOrder: string[] = [];

  sample.reduce((_, raw) => {
    const fields = collectRecordFields(raw, options.includeNestedFields === true, maxDepth);
    Object.entries(fields).reduce((__, [name, value]) => {
      observeField(mutable, fieldOrder, maxFields, maxExamples, name, value);
      return undefined;
    }, undefined as void);
    return undefined;
  }, undefined as void);

  const fields = fieldOrder.reduce<Record<string, FieldSchemaProfile>>((result, normalizedName) => {
    const field = mutable.get(normalizedName);
    if (field) result[normalizedName] = finalizeField(field, sample.length);
    return result;
  }, {});

  const fingerprintPayload = fieldOrder.map(name => {
    const field = fields[name];
    return field
      ? [name, field.dominantKind, field.required, field.nullable, field.kinds]
      : [name];
  });

  return Object.freeze({
    version: 1 as const,
    inputCount: records.length,
    sampledCount: sample.length,
    fieldCount: fieldOrder.length,
    fields: Object.freeze(fields),
    fieldOrder: Object.freeze(fieldOrder),
    fingerprint: hashFingerprint(stableSerialize(fingerprintPayload)),
  });
};

const nonNullKinds = (profile: FieldSchemaProfile): Set<SchemaScalarKind> =>
  new Set(SCALAR_KINDS.filter(kind =>
    kind !== 'null'
    && kind !== 'undefined'
    && kind !== 'unknown'
    && (profile.kinds[kind] ?? 0) > 0));

const setContains = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
  Array.from(right).every(item => left.has(item));

const compatibilityRank = (value: SchemaCompatibility): number =>
  value === 'breaking' ? 2 : value === 'warning' ? 1 : 0;

const worstCompatibility = (values: readonly SchemaCompatibility[]): SchemaCompatibility =>
  values.reduce<SchemaCompatibility>((result, value) =>
    compatibilityRank(value) > compatibilityRank(result) ? value : result, 'compatible');

const finding = (
  kind: SchemaDriftKind,
  compatibility: SchemaCompatibility,
  field: string,
  before: FieldSchemaProfile | null,
  after: FieldSchemaProfile | null,
  detail: string,
): SchemaDriftFinding => Object.freeze({
  key: `${kind}:${field}`,
  kind,
  compatibility,
  field,
  before,
  after,
  detail,
});

const appendCandidateAddition = (
  findings: SchemaDriftFinding[],
  baselineNames: ReadonlySet<string>,
  candidate: DatasetSchemaProfile,
  name: string,
): void => {
  if (baselineNames.has(name)) return;
  const after = candidate.fields[name] ?? null;
  findings.push(finding(
    'field-added',
    after?.required ? 'warning' : 'compatible',
    name,
    null,
    after,
    `Field ${name} was added`,
  ));
};

const appendBaselineComparison = (
  findings: SchemaDriftFinding[],
  candidateNames: ReadonlySet<string>,
  baseline: DatasetSchemaProfile,
  candidate: DatasetSchemaProfile,
  name: string,
): void => {
  const before = baseline.fields[name] ?? null;
  if (!candidateNames.has(name)) {
    findings.push(finding(
      'field-removed',
      'breaking',
      name,
      before,
      null,
      `Field ${name} was removed`,
    ));
    return;
  }

  const after = candidate.fields[name] ?? null;
  if (!before || !after) return;
  const beforeKinds = nonNullKinds(before);
  const afterKinds = nonNullKinds(after);
  if (!setContains(beforeKinds, afterKinds)) {
    findings.push(finding(
      'type-expanded',
      'warning',
      name,
      before,
      after,
      `Field ${name} now contains additional value kinds`,
    ));
  } else if (!setContains(afterKinds, beforeKinds)) {
    findings.push(finding(
      'type-narrowed',
      before.required ? 'breaking' : 'warning',
      name,
      before,
      after,
      `Field ${name} no longer contains all baseline value kinds`,
    ));
  }

  if (before.required !== after.required) {
    findings.push(finding(
      'requiredness-changed',
      before.required && !after.required ? 'breaking' : 'warning',
      name,
      before,
      after,
      `Field ${name} requiredness changed from ${before.required} to ${after.required}`,
    ));
  }
  if (before.nullable !== after.nullable) {
    findings.push(finding(
      'nullability-changed',
      !before.nullable && after.nullable ? 'warning' : 'compatible',
      name,
      before,
      after,
      `Field ${name} nullability changed from ${before.nullable} to ${after.nullable}`,
    ));
  }
};

export const compareSchemaProfiles = (
  baseline: DatasetSchemaProfile,
  candidate: DatasetSchemaProfile,
): SchemaDriftReport => {
  const findings: SchemaDriftFinding[] = [];
  const baselineNames = new Set(Object.keys(baseline.fields));
  const candidateNames = new Set(Object.keys(candidate.fields));

  Array.from(candidateNames).sort().reduce((_, name) => {
    appendCandidateAddition(findings, baselineNames, candidate, name);
    return undefined;
  }, undefined as void);
  Array.from(baselineNames).sort().reduce((_, name) => {
    appendBaselineComparison(findings, candidateNames, baseline, candidate, name);
    return undefined;
  }, undefined as void);

  findings.sort((left, right) =>
    compatibilityRank(right.compatibility) - compatibilityRank(left.compatibility)
    || left.key.localeCompare(right.key));
  const addedFields = findings.filter(item => item.kind === 'field-added').map(item => item.field);
  const removedFields = findings.filter(item => item.kind === 'field-removed').map(item => item.field);
  const changedFields = Array.from(new Set(findings
    .filter(item => item.kind !== 'field-added' && item.kind !== 'field-removed')
    .map(item => item.field))).sort();
  const compatibility = worstCompatibility(findings.map(item => item.compatibility));

  return Object.freeze({
    baselineFingerprint: baseline.fingerprint,
    candidateFingerprint: candidate.fingerprint,
    compatibility,
    breakingCount: findings.filter(item => item.compatibility === 'breaking').length,
    warningCount: findings.filter(item => item.compatibility === 'warning').length,
    compatibleCount: findings.filter(item => item.compatibility === 'compatible').length,
    findings: Object.freeze(findings),
    addedFields: Object.freeze(addedFields),
    removedFields: Object.freeze(removedFields),
    changedFields: Object.freeze(changedFields),
  });
};

export const evaluateAliasCoverage = (
  profile: DatasetSchemaProfile,
  schema: RecordAliasSchema,
): AliasCoverageReport => {
  const available = new Set(Object.keys(profile.fields));
  const entries = Object.entries(schema).map(([semanticField, rawAliases]) => {
    const aliases = (rawAliases ?? []).map(normalizeFieldName).filter(Boolean);
    const matchedFields = aliases.filter(alias => available.has(alias));
    return Object.freeze({
      semanticField: semanticField as keyof RecordAliasSchema,
      aliases: Object.freeze(aliases),
      matchedFields: Object.freeze(matchedFields),
      covered: matchedFields.length > 0,
    });
  });

  return Object.freeze({
    coveredCount: entries.filter(item => item.covered).length,
    missingCount: entries.filter(item => !item.covered).length,
    entries: Object.freeze(entries),
  });
};

export const compareAliasCoverage = (
  baseline: AliasCoverageReport,
  candidate: AliasCoverageReport,
): readonly SchemaDriftFinding[] => {
  const before = new Map(baseline.entries.map(entry => [entry.semanticField, entry]));
  const findings = candidate.entries.reduce<SchemaDriftFinding[]>((result, entry) => {
    const previous = before.get(entry.semanticField);
    if (!previous) return result;
    if (previous.covered && !entry.covered) {
      result.push(finding(
        'alias-coverage-lost',
        'breaking',
        String(entry.semanticField),
        null,
        null,
        `No known alias remains for semantic field ${String(entry.semanticField)}`,
      ));
    } else if (!previous.covered && entry.covered) {
      result.push(finding(
        'alias-coverage-added',
        'compatible',
        String(entry.semanticField),
        null,
        null,
        `Alias coverage was added for semantic field ${String(entry.semanticField)}`,
      ));
    }
    return result;
  }, []);
  return Object.freeze(findings);
};

const versionKey = (value: unknown): string => normalizeText(value).trim();

export class SchemaMigrationRegistry {
  private readonly byFrom = new Map<string, SchemaMigrationStep[]>();
  private readonly byId = new Map<string, SchemaMigrationStep>();

  register(step: SchemaMigrationStep): void {
    const id = normalizeSearchText(step.id);
    const fromVersion = versionKey(step.fromVersion);
    const toVersion = versionKey(step.toVersion);
    if (!id || !fromVersion || !toVersion) throw new TypeError('Migration id/fromVersion/toVersion are required');
    if (fromVersion === toVersion) throw new TypeError('Migration must change schema version');
    if (typeof step.transform !== 'function') throw new TypeError('Migration transform must be a function');
    if (this.byId.has(id)) throw new Error(`Duplicate migration id: ${id}`);
    const normalized = Object.freeze({ ...step, id, fromVersion, toVersion });
    this.byId.set(id, normalized);
    const list = this.byFrom.get(fromVersion) ?? [];
    list.push(normalized);
    list.sort((left, right) => left.toVersion.localeCompare(right.toVersion));
    this.byFrom.set(fromVersion, list);
  }

  unregister(stepId: unknown): boolean {
    const id = normalizeSearchText(stepId);
    const step = this.byId.get(id);
    if (!step) return false;
    this.byId.delete(id);
    const list = (this.byFrom.get(step.fromVersion) ?? []).filter(candidate => candidate.id !== id);
    if (list.length) this.byFrom.set(step.fromVersion, list);
    else this.byFrom.delete(step.fromVersion);
    return true;
  }

  findPath(fromVersionInput: unknown, toVersionInput: unknown, maxSteps = 32): readonly SchemaMigrationStep[] {
    const fromVersion = versionKey(fromVersionInput);
    const toVersion = versionKey(toVersionInput);
    if (!fromVersion || !toVersion) throw new TypeError('Schema versions are required');
    if (fromVersion === toVersion) return Object.freeze([]);

    const boundedMax = normalizeInteger(maxSteps, { min: 1, max: 128, fallback: 32 });
    const queue: Array<{ version: string; path: readonly SchemaMigrationStep[] }> = [
      { version: fromVersion, path: [] },
    ];
    const visited = new Set<string>([fromVersion]);

    while (queue.length) {
      const current = queue.shift();
      if (!current || current.path.length >= boundedMax) continue;
      let resolved: readonly SchemaMigrationStep[] | null = null;
      (this.byFrom.get(current.version) ?? []).some(step => {
        const path = [...current.path, step];
        if (step.toVersion === toVersion) {
          resolved = path;
          return true;
        }
        if (!visited.has(step.toVersion)) {
          visited.add(step.toVersion);
          queue.push({ version: step.toVersion, path });
        }
        return false;
      });
      if (resolved) return Object.freeze(resolved);
    }
    return Object.freeze([]);
  }

  migrate(
    datasetKeyInput: unknown,
    input: unknown,
    fromVersionInput: unknown,
    toVersionInput: unknown,
  ): SchemaMigrationResult {
    const datasetKey = normalizeText(datasetKeyInput) || 'dataset';
    const fromVersion = versionKey(fromVersionInput);
    const toVersion = versionKey(toVersionInput);
    const path = this.findPath(fromVersion, toVersion);
    if (fromVersion !== toVersion && !path.length) {
      throw new Error(`No schema migration path from ${fromVersion} to ${toVersion}`);
    }

    const source = Array.isArray(input) ? input : [];
    const migrated = source.reduce<{
      records: Readonly<Record<string, unknown>>[];
      errors: SchemaMigrationError[];
    }>((result, raw, index) => {
      if (!isRecord(raw)) {
        result.errors.push(Object.freeze({ index, stepId: 'input', message: 'Record is not an object' }));
        return result;
      }

      let activeStepId = 'migration';
      try {
        const initial = Object.freeze({ ...raw });
        const current = path.reduce<Readonly<Record<string, unknown>>>((record, step) => {
          activeStepId = step.id;
          return Object.freeze({ ...step.transform(record, {
            datasetKey,
            fromVersion: step.fromVersion,
            toVersion: step.toVersion,
            stepId: step.id,
            index,
          }) });
        }, initial);
        result.records.push(current);
      } catch (error) {
        result.errors.push(Object.freeze({
          index,
          stepId: activeStepId,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
      return result;
    }, { records: [], errors: [] });

    return Object.freeze({
      datasetKey,
      fromVersion,
      toVersion,
      path: Object.freeze(path.map(step => step.id)),
      records: Object.freeze(migrated.records),
      transformedCount: migrated.records.length,
      rejectedCount: migrated.errors.length,
      errors: Object.freeze(migrated.errors),
    });
  }

  snapshot(): Readonly<{ steps: number; versions: readonly string[] }> {
    return Object.freeze({
      steps: this.byId.size,
      versions: Object.freeze([...this.byFrom.keys()].sort()),
    });
  }
}

export const createSchemaEvolutionFingerprint = (
  profile: DatasetSchemaProfile,
  aliases?: AliasCoverageReport | null,
): string => hashFingerprint(stableSerialize({
  profile: profile.fingerprint,
  aliases: aliases?.entries.map(entry => [entry.semanticField, entry.matchedFields]) ?? [],
}));
