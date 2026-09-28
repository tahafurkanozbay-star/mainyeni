import type { NormalizedRecord } from './contracts';
import {
  hashFingerprint,
  normalizeCategoryKey,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type CategoryResolutionKind =
  | 'canonical-key'
  | 'alias'
  | 'type-alias'
  | 'fallback'
  | 'unknown';

export interface CategoryOntologyEntry {
  readonly key: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly typeAliases?: readonly string[];
  readonly parentKey?: string | null;
  readonly tags?: readonly string[];
  readonly iconHint?: string | null;
  readonly priority?: number;
}

export interface NormalizedCategoryOntologyEntry {
  readonly key: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly typeAliases: readonly string[];
  readonly parentKey: string | null;
  readonly tags: readonly string[];
  readonly iconHint: string | null;
  readonly priority: number;
  readonly fingerprint: string;
}

export interface CategoryOntologyOptions {
  readonly maxEntries?: number;
  readonly maxAliasesPerEntry?: number;
  readonly maxTagsPerEntry?: number;
  readonly maxHierarchyDepth?: number;
  readonly unknownKey?: string;
  readonly unknownLabel?: string;
}

export interface CategoryResolutionInput {
  readonly category?: unknown;
  readonly categoryKey?: unknown;
  readonly type?: unknown;
  readonly typeKey?: unknown;
}

export interface CategoryResolution {
  readonly key: string;
  readonly label: string;
  readonly kind: CategoryResolutionKind;
  readonly matchedValue: string;
  readonly matchedBy: string | null;
  readonly parentKey: string | null;
  readonly path: readonly string[];
  readonly tags: readonly string[];
  readonly iconHint: string | null;
  readonly isFallback: boolean;
}

export interface CategoryOntologyConflict {
  readonly code:
    | 'duplicate-key'
    | 'alias-collision'
    | 'type-alias-collision'
    | 'missing-parent'
    | 'hierarchy-cycle'
    | 'depth-exceeded';
  readonly key: string;
  readonly value: string;
  readonly otherKey: string | null;
}

export interface CategoryOntologySnapshot {
  readonly version: 1;
  readonly entryCount: number;
  readonly aliasCount: number;
  readonly typeAliasCount: number;
  readonly conflictCount: number;
  readonly fingerprint: string;
  readonly keys: readonly string[];
  readonly conflicts: readonly CategoryOntologyConflict[];
}

export interface CategoryCoverageReport {
  readonly total: number;
  readonly resolved: number;
  readonly fallback: number;
  readonly unknown: number;
  readonly coverageRatio: number;
  readonly byKey: Readonly<Record<string, number>>;
  readonly byKind: Readonly<Record<CategoryResolutionKind, number>>;
  readonly unresolvedSamples: readonly string[];
}

interface NormalizedCategoryOntologyOptions {
  readonly maxEntries: number;
  readonly maxAliasesPerEntry: number;
  readonly maxTagsPerEntry: number;
  readonly maxHierarchyDepth: number;
  readonly unknownKey: string;
  readonly unknownLabel: string;
}

const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_MAX_ALIASES = 64;
const DEFAULT_MAX_TAGS = 32;
const DEFAULT_MAX_DEPTH = 12;
const MAX_UNRESOLVED_SAMPLES = 32;

const normalizeOntologyKey = (value: unknown): string =>
  normalizeCategoryKey(value).slice(0, 160);

const normalizeAlias = (value: unknown): string =>
  normalizeSearchText(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

const normalizeTag = (value: unknown): string =>
  normalizeCategoryKey(value).slice(0, 120);

const normalizeIconHint = (value: unknown): string | null => {
  const normalized = normalizeOntologyKey(value);
  return normalized || null;
};

const uniqueNormalized = (
  values: readonly unknown[] | null | undefined,
  normalize: (value: unknown) => string,
  maximum: number,
): readonly string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= maximum) break;
  }
  return Object.freeze(output);
};

const normalizeOptions = (
  options: CategoryOntologyOptions = {},
): NormalizedCategoryOntologyOptions => {
  const unknownKey = normalizeOntologyKey(options.unknownKey) || 'uncategorized';
  const unknownLabel = normalizeText(options.unknownLabel) || 'Kategorisiz';
  return Object.freeze({
    maxEntries: normalizeInteger(options.maxEntries, {
      min: 1,
      max: 20_000,
      fallback: DEFAULT_MAX_ENTRIES,
    }),
    maxAliasesPerEntry: normalizeInteger(options.maxAliasesPerEntry, {
      min: 0,
      max: 1_000,
      fallback: DEFAULT_MAX_ALIASES,
    }),
    maxTagsPerEntry: normalizeInteger(options.maxTagsPerEntry, {
      min: 0,
      max: 256,
      fallback: DEFAULT_MAX_TAGS,
    }),
    maxHierarchyDepth: normalizeInteger(options.maxHierarchyDepth, {
      min: 1,
      max: 64,
      fallback: DEFAULT_MAX_DEPTH,
    }),
    unknownKey,
    unknownLabel,
  });
};

const normalizeEntry = (
  input: CategoryOntologyEntry,
  options: NormalizedCategoryOntologyOptions,
): NormalizedCategoryOntologyEntry => {
  const key = normalizeOntologyKey(input.key);
  if (!key) throw new TypeError('Category ontology entry key is required');
  const label = normalizeText(input.label) || key;
  const aliases = uniqueNormalized(input.aliases, normalizeAlias, options.maxAliasesPerEntry);
  const typeAliases = uniqueNormalized(input.typeAliases, normalizeAlias, options.maxAliasesPerEntry);
  const tags = uniqueNormalized(input.tags, normalizeTag, options.maxTagsPerEntry);
  const parentCandidate = normalizeOntologyKey(input.parentKey);
  const parentKey = parentCandidate && parentCandidate !== key ? parentCandidate : null;
  const priority = normalizeInteger(input.priority, {
    min: -10_000,
    max: 10_000,
    fallback: 0,
  });
  const iconHint = normalizeIconHint(input.iconHint);
  const fingerprint = hashFingerprint(stableSerialize({
    key,
    label,
    aliases,
    typeAliases,
    parentKey,
    tags,
    iconHint,
    priority,
  }));
  return Object.freeze({
    key,
    label,
    aliases,
    typeAliases,
    parentKey,
    tags,
    iconHint,
    priority,
    fingerprint,
  });
};

const freezeConflict = (
  code: CategoryOntologyConflict['code'],
  key: string,
  value: string,
  otherKey: string | null = null,
): CategoryOntologyConflict => Object.freeze({ code, key, value, otherKey });

const resolutionFromEntry = (
  entry: NormalizedCategoryOntologyEntry,
  kind: CategoryResolutionKind,
  matchedValue: string,
  matchedBy: string,
  path: readonly string[],
): CategoryResolution => Object.freeze({
  key: entry.key,
  label: entry.label,
  kind,
  matchedValue,
  matchedBy,
  parentKey: entry.parentKey,
  path: Object.freeze([...path]),
  tags: entry.tags,
  iconHint: entry.iconHint,
  isFallback: false,
});

const emptyKindCounts = (): Record<CategoryResolutionKind, number> => ({
  'canonical-key': 0,
  alias: 0,
  'type-alias': 0,
  fallback: 0,
  unknown: 0,
});

export class CategoryOntologyRuntime {
  readonly #options: NormalizedCategoryOntologyOptions;
  readonly #entries = new Map<string, NormalizedCategoryOntologyEntry>();
  readonly #aliases = new Map<string, string>();
  readonly #typeAliases = new Map<string, string>();
  readonly #conflicts: CategoryOntologyConflict[] = [];
  #fingerprint = hashFingerprint('empty-category-ontology');

  constructor(
    entries: readonly CategoryOntologyEntry[] = [],
    options: CategoryOntologyOptions = {},
  ) {
    this.#options = normalizeOptions(options);
    this.replace(entries);
  }

  replace(entries: readonly CategoryOntologyEntry[]): CategoryOntologySnapshot {
    this.#entries.clear();
    this.#aliases.clear();
    this.#typeAliases.clear();
    this.#conflicts.length = 0;

    const bounded = entries.slice(0, this.#options.maxEntries);
    for (const raw of bounded) {
      const entry = normalizeEntry(raw, this.#options);
      if (this.#entries.has(entry.key)) {
        this.#conflicts.push(freezeConflict('duplicate-key', entry.key, entry.key, entry.key));
        continue;
      }
      this.#entries.set(entry.key, entry);
    }

    for (const entry of this.#entries.values()) {
      this.#registerAliasMap(entry, entry.aliases, this.#aliases, 'alias-collision');
      this.#registerAliasMap(entry, entry.typeAliases, this.#typeAliases, 'type-alias-collision');
      if (entry.parentKey && !this.#entries.has(entry.parentKey)) {
        this.#conflicts.push(freezeConflict('missing-parent', entry.key, entry.parentKey));
      }
    }

    this.#validateHierarchy();
    this.#fingerprint = this.#createFingerprint();
    return this.snapshot();
  }

  upsert(input: CategoryOntologyEntry): CategoryOntologySnapshot {
    const entry = normalizeEntry(input, this.#options);
    const next = [...this.#entries.values()].filter(candidate => candidate.key !== entry.key);
    next.push(entry);
    return this.replace(next);
  }

  remove(keyInput: unknown): boolean {
    const key = normalizeOntologyKey(keyInput);
    if (!key || !this.#entries.has(key)) return false;
    const next = [...this.#entries.values()].filter(entry => entry.key !== key);
    this.replace(next);
    return true;
  }

  resolve(input: CategoryResolutionInput): CategoryResolution {
    const categoryKey = normalizeOntologyKey(input.categoryKey);
    if (categoryKey) {
      const direct = this.#entries.get(categoryKey);
      if (direct) {
        return resolutionFromEntry(
          direct,
          'canonical-key',
          categoryKey,
          'categoryKey',
          this.pathFor(direct.key),
        );
      }
    }

    const category = normalizeAlias(input.category);
    if (category) {
      const directKey = normalizeOntologyKey(input.category);
      const direct = this.#entries.get(directKey);
      if (direct) {
        return resolutionFromEntry(
          direct,
          'canonical-key',
          category,
          'category',
          this.pathFor(direct.key),
        );
      }
      const aliasKey = this.#aliases.get(category);
      const aliasEntry = aliasKey ? this.#entries.get(aliasKey) : undefined;
      if (aliasEntry) {
        return resolutionFromEntry(
          aliasEntry,
          'alias',
          category,
          'category',
          this.pathFor(aliasEntry.key),
        );
      }
    }

    const typeKey = normalizeOntologyKey(input.typeKey);
    if (typeKey) {
      const direct = this.#entries.get(typeKey);
      if (direct) {
        return resolutionFromEntry(
          direct,
          'canonical-key',
          typeKey,
          'typeKey',
          this.pathFor(direct.key),
        );
      }
    }

    const type = normalizeAlias(input.type);
    if (type) {
      const typeAliasKey = this.#typeAliases.get(type) ?? this.#aliases.get(type);
      const typeEntry = typeAliasKey ? this.#entries.get(typeAliasKey) : undefined;
      if (typeEntry) {
        return resolutionFromEntry(
          typeEntry,
          'type-alias',
          type,
          'type',
          this.pathFor(typeEntry.key),
        );
      }
    }

    const matchedValue = category || type || categoryKey || typeKey;
    if (matchedValue) {
      return Object.freeze({
        key: this.#options.unknownKey,
        label: this.#options.unknownLabel,
        kind: 'unknown',
        matchedValue,
        matchedBy: null,
        parentKey: null,
        path: Object.freeze([this.#options.unknownKey]),
        tags: Object.freeze([]),
        iconHint: null,
        isFallback: true,
      });
    }

    return Object.freeze({
      key: this.#options.unknownKey,
      label: this.#options.unknownLabel,
      kind: 'fallback',
      matchedValue: '',
      matchedBy: null,
      parentKey: null,
      path: Object.freeze([this.#options.unknownKey]),
      tags: Object.freeze([]),
      iconHint: null,
      isFallback: true,
    });
  }

  resolveRecord(record: NormalizedRecord): CategoryResolution {
    return this.resolve({
      category: record.category,
      categoryKey: record.categoryKey,
      type: record.type,
      typeKey: record.typeKey,
    });
  }

  entry(keyInput: unknown): NormalizedCategoryOntologyEntry | null {
    const key = normalizeOntologyKey(keyInput);
    return this.#entries.get(key) ?? null;
  }

  entries(): readonly NormalizedCategoryOntologyEntry[] {
    return Object.freeze([...this.#entries.values()]
      .sort((left, right) => right.priority - left.priority
        || left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base', numeric: true })
        || left.key.localeCompare(right.key)));
  }

  pathFor(keyInput: unknown): readonly string[] {
    const key = normalizeOntologyKey(keyInput);
    if (!key || !this.#entries.has(key)) return Object.freeze([]);
    const output: string[] = [];
    const visited = new Set<string>();
    let current: string | null = key;
    while (current && output.length < this.#options.maxHierarchyDepth) {
      if (visited.has(current)) break;
      visited.add(current);
      output.unshift(current);
      current = this.#entries.get(current)?.parentKey ?? null;
    }
    return Object.freeze(output);
  }

  descendantsOf(keyInput: unknown): readonly string[] {
    const key = normalizeOntologyKey(keyInput);
    if (!key || !this.#entries.has(key)) return Object.freeze([]);
    const output: string[] = [];
    const queue: string[] = [key];
    const visited = new Set<string>([key]);
    while (queue.length) {
      const parent = queue.shift();
      if (!parent) continue;
      for (const entry of this.#entries.values()) {
        if (entry.parentKey !== parent || visited.has(entry.key)) continue;
        visited.add(entry.key);
        output.push(entry.key);
        queue.push(entry.key);
      }
    }
    return Object.freeze(output);
  }

  coverage(records: readonly NormalizedRecord[]): CategoryCoverageReport {
    const byKey: Record<string, number> = {};
    const byKind = emptyKindCounts();
    const unresolvedSamples: string[] = [];
    let fallback = 0;
    let unknown = 0;
    for (const record of records) {
      const resolution = this.resolveRecord(record);
      byKey[resolution.key] = (byKey[resolution.key] ?? 0) + 1;
      byKind[resolution.kind] += 1;
      if (resolution.isFallback) fallback += 1;
      if (resolution.kind === 'unknown') unknown += 1;
      if (resolution.isFallback && unresolvedSamples.length < MAX_UNRESOLVED_SAMPLES) {
        const sample = normalizeText(record.category || record.type || record.title).slice(0, 160);
        if (sample && !unresolvedSamples.includes(sample)) unresolvedSamples.push(sample);
      }
    }
    const total = records.length;
    return Object.freeze({
      total,
      resolved: total - fallback,
      fallback,
      unknown,
      coverageRatio: total ? (total - fallback) / total : 1,
      byKey: Object.freeze(byKey),
      byKind: Object.freeze(byKind),
      unresolvedSamples: Object.freeze(unresolvedSamples),
    });
  }

  snapshot(): CategoryOntologySnapshot {
    return Object.freeze({
      version: 1 as const,
      entryCount: this.#entries.size,
      aliasCount: this.#aliases.size,
      typeAliasCount: this.#typeAliases.size,
      conflictCount: this.#conflicts.length,
      fingerprint: this.#fingerprint,
      keys: Object.freeze([...this.#entries.keys()].sort()),
      conflicts: Object.freeze([...this.#conflicts]),
    });
  }

  #registerAliasMap(
    entry: NormalizedCategoryOntologyEntry,
    aliases: readonly string[],
    target: Map<string, string>,
    conflictCode: 'alias-collision' | 'type-alias-collision',
  ): void {
    for (const alias of aliases) {
      const previous = target.get(alias);
      if (!previous) {
        target.set(alias, entry.key);
        continue;
      }
      if (previous === entry.key) continue;
      const previousEntry = this.#entries.get(previous);
      if (!previousEntry || entry.priority > previousEntry.priority) {
        target.set(alias, entry.key);
      }
      this.#conflicts.push(freezeConflict(conflictCode, entry.key, alias, previous));
    }
  }

  #validateHierarchy(): void {
    for (const entry of this.#entries.values()) {
      const visited = new Set<string>();
      let current: string | null = entry.key;
      let depth = 0;
      while (current) {
        if (visited.has(current)) {
          this.#conflicts.push(freezeConflict('hierarchy-cycle', entry.key, current, current));
          break;
        }
        visited.add(current);
        depth += 1;
        if (depth > this.#options.maxHierarchyDepth) {
          this.#conflicts.push(freezeConflict('depth-exceeded', entry.key, current));
          break;
        }
        current = this.#entries.get(current)?.parentKey ?? null;
      }
    }
  }

  #createFingerprint(): string {
    const entries = [...this.#entries.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(entry => ({
        key: entry.key,
        label: entry.label,
        aliases: entry.aliases,
        typeAliases: entry.typeAliases,
        parentKey: entry.parentKey,
        tags: entry.tags,
        iconHint: entry.iconHint,
        priority: entry.priority,
      }));
    const conflicts = [...this.#conflicts]
      .sort((left, right) => left.code.localeCompare(right.code)
        || left.key.localeCompare(right.key)
        || left.value.localeCompare(right.value));
    return hashFingerprint(stableSerialize({ entries, conflicts }));
  }
}

export const createCategoryOntologyRuntime = (
  entries: readonly CategoryOntologyEntry[] = [],
  options: CategoryOntologyOptions = {},
): CategoryOntologyRuntime => new CategoryOntologyRuntime(entries, options);

export const createCategoryOntologyFingerprint = (
  entries: readonly CategoryOntologyEntry[],
  options: CategoryOntologyOptions = {},
): string => createCategoryOntologyRuntime(entries, options).snapshot().fingerprint;
