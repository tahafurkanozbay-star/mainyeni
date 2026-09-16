import type { RecordAliasSchema } from './contracts';
import type { IntegrityReport } from './dataIntegrity';
import type { DatasetSchemaProfile, SchemaDriftReport } from './schemaEvolution';
import { compareSchemaProfiles } from './schemaEvolution';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';

export type DatasetLifecycleState = 'active' | 'stale' | 'quarantined' | 'disabled';
export type DatasetSourceKind = 'local' | 'backend' | 'arcgis' | 'derived' | 'unknown';

export interface DatasetCatalogRegistration {
  readonly key: string;
  readonly title?: string;
  readonly sourceKind?: DatasetSourceKind;
  readonly sourceId?: string | null;
  readonly schemaVersion?: string;
  readonly aliases?: RecordAliasSchema;
  readonly tags?: readonly string[];
  readonly ttlMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly schemaProfile?: DatasetSchemaProfile | null;
  readonly integrity?: IntegrityReport | null;
  readonly state?: DatasetLifecycleState;
  readonly now?: number;
}

export interface DatasetCatalogEntry {
  readonly key: string;
  readonly title: string;
  readonly sourceKind: DatasetSourceKind;
  readonly sourceId: string | null;
  readonly schemaVersion: string;
  readonly aliases: RecordAliasSchema | null;
  readonly tags: readonly string[];
  readonly ttlMs: number;
  readonly state: DatasetLifecycleState;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly staleAt: number | null;
  readonly schemaProfile: DatasetSchemaProfile | null;
  readonly previousSchemaProfile: DatasetSchemaProfile | null;
  readonly schemaDrift: SchemaDriftReport | null;
  readonly integrity: IntegrityReport | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
}

export interface DatasetCatalogSnapshot {
  readonly size: number;
  readonly maxEntries: number;
  readonly activeCount: number;
  readonly staleCount: number;
  readonly quarantinedCount: number;
  readonly disabledCount: number;
  readonly revisions: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly aliases: number;
  readonly tagCount: number;
}

export interface DatasetCatalogOptions {
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number;
  readonly maxTtlMs?: number;
  readonly clock?: () => number;
}

const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

const normalizeDatasetKey = (value: unknown): string => normalizeSearchText(value)
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120);

const normalizeTag = (value: unknown): string => normalizeDatasetKey(value).slice(0, 64);

const normalizeTags = (values: readonly string[] | undefined): readonly string[] => Object.freeze(
  Array.from(new Set((values ?? []).map(normalizeTag).filter(Boolean))).sort(),
);

const normalizeSourceKind = (value: unknown): DatasetSourceKind => {
  const normalized = normalizeSearchText(value);
  return normalized === 'local'
    || normalized === 'backend'
    || normalized === 'arcgis'
    || normalized === 'derived'
    ? normalized
    : 'unknown';
};

const normalizeState = (value: unknown): DatasetLifecycleState => {
  const normalized = normalizeSearchText(value);
  return normalized === 'stale'
    || normalized === 'quarantined'
    || normalized === 'disabled'
    ? normalized
    : 'active';
};

const safeNow = (clock: () => number): number => {
  const value = Number(clock());
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
};

const createEntryFingerprint = (
  value: Omit<DatasetCatalogEntry, 'fingerprint'>,
): string => hashFingerprint(stableSerialize({
  key: value.key,
  sourceKind: value.sourceKind,
  sourceId: value.sourceId,
  schemaVersion: value.schemaVersion,
  tags: value.tags,
  state: value.state,
  revision: value.revision,
  schemaFingerprint: value.schemaProfile?.fingerprint ?? null,
  integrityFingerprint: value.integrity?.fingerprint ?? null,
  metadata: value.metadata,
}));

const freezeEntry = (
  value: Omit<DatasetCatalogEntry, 'fingerprint'>,
): DatasetCatalogEntry => Object.freeze({
  ...value,
  aliases: value.aliases ? Object.freeze({ ...value.aliases }) : null,
  tags: Object.freeze([...value.tags]),
  metadata: Object.freeze({ ...value.metadata }),
  fingerprint: createEntryFingerprint(value),
});

export class DatasetCatalog {
  private readonly entries = new Map<string, DatasetCatalogEntry>();
  private readonly aliasToKey = new Map<string, string>();
  private readonly tags = new Map<string, Set<string>>();
  private readonly options: Required<Omit<DatasetCatalogOptions, 'clock'>> & { readonly clock: () => number };
  private revisions = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options: DatasetCatalogOptions = {}) {
    const maxTtlMs = normalizeInteger(options.maxTtlMs, {
      min: 1_000,
      max: 7 * MAX_TTL_MS,
      fallback: MAX_TTL_MS,
    });
    this.options = Object.freeze({
      maxEntries: normalizeInteger(options.maxEntries, { min: 1, max: 512, fallback: DEFAULT_MAX_ENTRIES }),
      defaultTtlMs: normalizeInteger(options.defaultTtlMs, {
        min: 1_000,
        max: maxTtlMs,
        fallback: DEFAULT_TTL_MS,
      }),
      maxTtlMs,
      clock: typeof options.clock === 'function' ? options.clock : () => Date.now(),
    });
  }

  private now(): number {
    return safeNow(this.options.clock);
  }

  private touch(key: string, entry: DatasetCatalogEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private removeTagReferences(key: string): void {
    for (const [tag, keys] of this.tags) {
      keys.delete(key);
      if (!keys.size) this.tags.delete(tag);
    }
  }

  private addTagReferences(entry: DatasetCatalogEntry): void {
    for (const tag of entry.tags) {
      const keys = this.tags.get(tag) ?? new Set<string>();
      keys.add(entry.key);
      this.tags.set(tag, keys);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.remove(oldestKey);
      this.evictions += 1;
    }
  }

  register(input: DatasetCatalogRegistration): DatasetCatalogEntry {
    const key = normalizeDatasetKey(input.key);
    if (!key) throw new TypeError('Dataset catalog key is required');
    const previous = this.entries.get(key) ?? null;
    const now = Number.isFinite(Number(input.now)) ? Math.trunc(Number(input.now)) : this.now();
    const ttlMs = normalizeInteger(input.ttlMs, {
      min: 1_000,
      max: this.options.maxTtlMs,
      fallback: previous?.ttlMs ?? this.options.defaultTtlMs,
    });
    const schemaProfile = input.schemaProfile ?? previous?.schemaProfile ?? null;
    const previousSchemaProfile = previous?.schemaProfile ?? null;
    const schemaDrift = previousSchemaProfile && schemaProfile
      && previousSchemaProfile.fingerprint !== schemaProfile.fingerprint
      ? compareSchemaProfiles(previousSchemaProfile, schemaProfile)
      : null;
    const state = input.state
      ? normalizeState(input.state)
      : input.integrity && !input.integrity.releaseReady
        ? 'quarantined'
        : 'active';
    const base: Omit<DatasetCatalogEntry, 'fingerprint'> = {
      key,
      title: normalizeText(input.title) || previous?.title || key,
      sourceKind: input.sourceKind ? normalizeSourceKind(input.sourceKind) : previous?.sourceKind ?? 'unknown',
      sourceId: input.sourceId === undefined
        ? previous?.sourceId ?? null
        : normalizeText(input.sourceId) || null,
      schemaVersion: normalizeText(input.schemaVersion) || previous?.schemaVersion || '1',
      aliases: input.aliases ?? previous?.aliases ?? null,
      tags: normalizeTags(input.tags ?? previous?.tags),
      ttlMs,
      state,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      staleAt: state === 'stale' ? now : null,
      schemaProfile,
      previousSchemaProfile,
      schemaDrift,
      integrity: input.integrity ?? previous?.integrity ?? null,
      metadata: Object.freeze({ ...(previous?.metadata ?? {}), ...(input.metadata ?? {}) }),
    };
    const entry = freezeEntry(base);
    this.removeTagReferences(key);
    this.entries.set(key, entry);
    this.touch(key, entry);
    this.addTagReferences(entry);
    this.revisions += 1;
    this.evictOverflow();
    return entry;
  }

  alias(aliasInput: unknown, datasetKeyInput: unknown): void {
    const alias = normalizeDatasetKey(aliasInput);
    const key = normalizeDatasetKey(datasetKeyInput);
    if (!alias || !key) throw new TypeError('Alias and dataset key are required');
    if (alias === key) return;
    if (!this.entries.has(key)) throw new Error(`Cannot alias unknown dataset: ${key}`);
    const existing = this.aliasToKey.get(alias);
    if (existing && existing !== key) throw new Error(`Dataset alias already points to ${existing}: ${alias}`);
    this.aliasToKey.set(alias, key);
  }

  unalias(aliasInput: unknown): boolean {
    return this.aliasToKey.delete(normalizeDatasetKey(aliasInput));
  }

  resolveKey(input: unknown): string {
    const key = normalizeDatasetKey(input);
    return this.aliasToKey.get(key) ?? key;
  }

  get(input: unknown, options: { readonly allowStale?: boolean; readonly now?: number } = {}): DatasetCatalogEntry | null {
    const key = this.resolveKey(input);
    const current = this.entries.get(key) ?? null;
    if (!current) return null;
    const now = Number.isFinite(Number(options.now)) ? Math.trunc(Number(options.now)) : this.now();
    const expired = current.state === 'active' && now - current.updatedAt >= current.ttlMs;
    const entry = expired ? this.markStale(key, now) ?? current : current;
    if (entry.state === 'stale' && options.allowStale === false) return null;
    this.touch(key, entry);
    return entry;
  }

  list(options: { readonly state?: DatasetLifecycleState; readonly tag?: string } = {}): readonly DatasetCatalogEntry[] {
    const state = options.state ? normalizeState(options.state) : null;
    const tag = options.tag ? normalizeTag(options.tag) : null;
    const tagKeys = tag ? this.tags.get(tag) ?? new Set<string>() : null;
    return Object.freeze([...this.entries.values()].filter(entry => {
      if (state && entry.state !== state) return false;
      if (tagKeys && !tagKeys.has(entry.key)) return false;
      return true;
    }));
  }

  markStale(input: unknown, nowInput?: number): DatasetCatalogEntry | null {
    const key = this.resolveKey(input);
    const previous = this.entries.get(key);
    if (!previous) return null;
    const now = Number.isFinite(Number(nowInput)) ? Math.trunc(Number(nowInput)) : this.now();
    if (previous.state === 'stale') return previous;
    const entry = freezeEntry({
      ...previous,
      state: 'stale',
      staleAt: now,
      updatedAt: previous.updatedAt,
      fingerprint: undefined as never,
    } as Omit<DatasetCatalogEntry, 'fingerprint'>);
    this.entries.set(key, entry);
    this.invalidations += 1;
    return entry;
  }

  setState(input: unknown, stateInput: DatasetLifecycleState): DatasetCatalogEntry | null {
    const key = this.resolveKey(input);
    const previous = this.entries.get(key);
    if (!previous) return null;
    const state = normalizeState(stateInput);
    const entry = freezeEntry({
      key: previous.key,
      title: previous.title,
      sourceKind: previous.sourceKind,
      sourceId: previous.sourceId,
      schemaVersion: previous.schemaVersion,
      aliases: previous.aliases,
      tags: previous.tags,
      ttlMs: previous.ttlMs,
      state,
      revision: previous.revision,
      createdAt: previous.createdAt,
      updatedAt: this.now(),
      staleAt: state === 'stale' ? this.now() : null,
      schemaProfile: previous.schemaProfile,
      previousSchemaProfile: previous.previousSchemaProfile,
      schemaDrift: previous.schemaDrift,
      integrity: previous.integrity,
      metadata: previous.metadata,
    });
    this.entries.set(key, entry);
    return entry;
  }

  invalidateTag(tagInput: unknown): readonly string[] {
    const tag = normalizeTag(tagInput);
    const keys = [...(this.tags.get(tag) ?? [])];
    for (const key of keys) this.markStale(key);
    return Object.freeze(keys.sort());
  }

  remove(input: unknown): boolean {
    const key = this.resolveKey(input);
    if (!key || !this.entries.has(key)) return false;
    this.removeTagReferences(key);
    this.entries.delete(key);
    for (const [alias, target] of [...this.aliasToKey.entries()]) {
      if (target === key) this.aliasToKey.delete(alias);
    }
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.aliasToKey.clear();
    this.tags.clear();
  }

  snapshot(): DatasetCatalogSnapshot {
    const values = [...this.entries.values()];
    return Object.freeze({
      size: values.length,
      maxEntries: this.options.maxEntries,
      activeCount: values.filter(entry => entry.state === 'active').length,
      staleCount: values.filter(entry => entry.state === 'stale').length,
      quarantinedCount: values.filter(entry => entry.state === 'quarantined').length,
      disabledCount: values.filter(entry => entry.state === 'disabled').length,
      revisions: this.revisions,
      evictions: this.evictions,
      invalidations: this.invalidations,
      aliases: this.aliasToKey.size,
      tagCount: this.tags.size,
    });
  }
}

export const createDatasetCatalog = (options: DatasetCatalogOptions = {}): DatasetCatalog =>
  new DatasetCatalog(options);
