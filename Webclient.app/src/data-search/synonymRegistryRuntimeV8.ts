import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeSearchToken,
  stableSerialize,
  tokenizeSearchText,
} from './normalization';

export const SYNONYM_REGISTRY_VERSION_V8 = 'search-synonym-v8' as const;

export type SynonymScopeV8 =
  | 'any'
  | 'title'
  | 'category'
  | 'type'
  | 'district'
  | 'neighborhood'
  | 'street'
  | 'address';

export interface SynonymAliasInputV8 {
  readonly value: string;
  readonly weight?: number;
}

export interface SynonymGroupInputV8 {
  readonly id: string;
  readonly canonical: string;
  readonly aliases: readonly (string | SynonymAliasInputV8)[];
  readonly scopes?: readonly SynonymScopeV8[];
  readonly bidirectional?: boolean;
  readonly weight?: number;
  readonly enabled?: boolean;
  readonly tags?: readonly string[];
}

export interface SynonymRegistryPolicyV8 {
  readonly maximumGroups?: number;
  readonly maximumAliasesPerGroup?: number;
  readonly maximumTokensPerAlias?: number;
  readonly maximumExpansionsPerToken?: number;
  readonly maximumExpansionTokens?: number;
  readonly minimumAliasLength?: number;
  readonly maximumAliasLength?: number;
  readonly maximumTagsPerGroup?: number;
}

export interface SynonymAliasV8 {
  readonly value: string;
  readonly tokens: readonly string[];
  readonly weight: number;
}

export interface SynonymGroupV8 {
  readonly id: string;
  readonly canonical: string;
  readonly canonicalTokens: readonly string[];
  readonly aliases: readonly SynonymAliasV8[];
  readonly scopes: readonly SynonymScopeV8[];
  readonly bidirectional: boolean;
  readonly weight: number;
  readonly tags: readonly string[];
  readonly ordinal: number;
}

export interface SynonymExpansionV8 {
  readonly input: string;
  readonly value: string;
  readonly tokens: readonly string[];
  readonly groupId: string;
  readonly scope: SynonymScopeV8;
  readonly weight: number;
  readonly canonical: boolean;
}

export interface SynonymExpansionResultV8 {
  readonly input: string;
  readonly canonical: string;
  readonly scope: SynonymScopeV8;
  readonly expansions: readonly SynonymExpansionV8[];
  readonly matchedGroups: readonly string[];
  readonly truncated: boolean;
}

export interface SynonymRegistrySnapshotV8 {
  readonly version: typeof SYNONYM_REGISTRY_VERSION_V8;
  readonly groupCount: number;
  readonly aliasCount: number;
  readonly indexedPhraseCount: number;
  readonly droppedGroups: number;
  readonly droppedAliases: number;
  readonly collisions: number;
  readonly expansions: number;
  readonly fingerprint: string;
}

interface NormalizedSynonymPolicyV8 {
  readonly maximumGroups: number;
  readonly maximumAliasesPerGroup: number;
  readonly maximumTokensPerAlias: number;
  readonly maximumExpansionsPerToken: number;
  readonly maximumExpansionTokens: number;
  readonly minimumAliasLength: number;
  readonly maximumAliasLength: number;
  readonly maximumTagsPerGroup: number;
}

interface MutableSynonymStatsV8 {
  droppedGroups: number;
  droppedAliases: number;
  collisions: number;
  expansions: number;
}

interface PhraseBindingV8 {
  readonly groupOrdinal: number;
  readonly alias: SynonymAliasV8;
  readonly canonical: boolean;
}

const DEFAULT_POLICY_V8: NormalizedSynonymPolicyV8 = Object.freeze({
  maximumGroups: 4_096,
  maximumAliasesPerGroup: 64,
  maximumTokensPerAlias: 8,
  maximumExpansionsPerToken: 12,
  maximumExpansionTokens: 32,
  minimumAliasLength: 2,
  maximumAliasLength: 120,
  maximumTagsPerGroup: 16,
});

const SCOPES: readonly SynonymScopeV8[] = Object.freeze([
  'any',
  'title',
  'category',
  'type',
  'district',
  'neighborhood',
  'street',
  'address',
]);

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalizeInteger(value, { min: minimum, max: maximum, fallback });
};

const boundedWeight = (value: number | undefined, fallback = 1): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new RangeError('synonym weight must be greater than 0 and at most 100');
  }
  return value;
};

const normalizePolicy = (input: SynonymRegistryPolicyV8 = {}): NormalizedSynonymPolicyV8 => Object.freeze({
  maximumGroups: boundedInteger(input.maximumGroups, DEFAULT_POLICY_V8.maximumGroups, 1, 100_000, 'maximumGroups'),
  maximumAliasesPerGroup: boundedInteger(
    input.maximumAliasesPerGroup,
    DEFAULT_POLICY_V8.maximumAliasesPerGroup,
    1,
    1_000,
    'maximumAliasesPerGroup',
  ),
  maximumTokensPerAlias: boundedInteger(
    input.maximumTokensPerAlias,
    DEFAULT_POLICY_V8.maximumTokensPerAlias,
    1,
    32,
    'maximumTokensPerAlias',
  ),
  maximumExpansionsPerToken: boundedInteger(
    input.maximumExpansionsPerToken,
    DEFAULT_POLICY_V8.maximumExpansionsPerToken,
    1,
    256,
    'maximumExpansionsPerToken',
  ),
  maximumExpansionTokens: boundedInteger(
    input.maximumExpansionTokens,
    DEFAULT_POLICY_V8.maximumExpansionTokens,
    1,
    512,
    'maximumExpansionTokens',
  ),
  minimumAliasLength: boundedInteger(
    input.minimumAliasLength,
    DEFAULT_POLICY_V8.minimumAliasLength,
    1,
    32,
    'minimumAliasLength',
  ),
  maximumAliasLength: boundedInteger(
    input.maximumAliasLength,
    DEFAULT_POLICY_V8.maximumAliasLength,
    2,
    512,
    'maximumAliasLength',
  ),
  maximumTagsPerGroup: boundedInteger(
    input.maximumTagsPerGroup,
    DEFAULT_POLICY_V8.maximumTagsPerGroup,
    0,
    128,
    'maximumTagsPerGroup',
  ),
});

const normalizeId = (value: unknown): string => normalizeSearchToken(value)
  .replace(/[^a-z0-9._:-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120);

const canonicalPhrase = (value: unknown, maximumLength: number): string => normalizeSearchText(value)
  .replace(/[^a-z0-9\s]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximumLength);

const phraseTokens = (
  value: string,
  maximumTokens: number,
): readonly string[] => Object.freeze(tokenizeSearchText(value).slice(0, maximumTokens));

const normalizeScope = (value: unknown): SynonymScopeV8 | null => {
  const scope = normalizeSearchToken(value) as SynonymScopeV8;
  return SCOPES.includes(scope) ? scope : null;
};

const normalizeScopes = (values: readonly SynonymScopeV8[] | undefined): readonly SynonymScopeV8[] => {
  const normalized = new Set<SynonymScopeV8>();
  for (const value of values ?? ['any']) {
    const scope = normalizeScope(value);
    if (scope) normalized.add(scope);
  }
  if (normalized.size === 0) normalized.add('any');
  return Object.freeze(Array.from(normalized).sort());
};

const normalizeTags = (
  values: readonly string[] | undefined,
  maximum: number,
): readonly string[] => {
  const tags = new Set<string>();
  for (const value of values ?? []) {
    const tag = normalizeId(value);
    if (!tag) continue;
    tags.add(tag);
    if (tags.size >= maximum) break;
  }
  return Object.freeze(Array.from(tags).sort());
};

const normalizeAlias = (
  input: string | SynonymAliasInputV8,
  policy: NormalizedSynonymPolicyV8,
): SynonymAliasV8 | null => {
  const raw = typeof input === 'string' ? input : input.value;
  const value = canonicalPhrase(raw, policy.maximumAliasLength);
  if (value.length < policy.minimumAliasLength) return null;
  const tokens = phraseTokens(value, policy.maximumTokensPerAlias);
  if (tokens.length === 0) return null;
  return Object.freeze({
    value,
    tokens,
    weight: boundedWeight(typeof input === 'string' ? undefined : input.weight, 1),
  });
};

const dedupeAliases = (
  aliases: readonly SynonymAliasV8[],
  maximum: number,
): readonly SynonymAliasV8[] => {
  const byValue = new Map<string, SynonymAliasV8>();
  for (const alias of aliases) {
    const previous = byValue.get(alias.value);
    if (!previous || alias.weight > previous.weight) byValue.set(alias.value, alias);
    if (byValue.size >= maximum) break;
  }
  return Object.freeze(Array.from(byValue.values())
    .sort((left, right) => right.weight - left.weight || left.value.localeCompare(right.value)));
};

const normalizeGroup = (
  input: SynonymGroupInputV8,
  ordinal: number,
  policy: NormalizedSynonymPolicyV8,
): SynonymGroupV8 | null => {
  if (input.enabled === false) return null;
  const id = normalizeId(input.id);
  const canonical = canonicalPhrase(input.canonical, policy.maximumAliasLength);
  const canonicalTokens = phraseTokens(canonical, policy.maximumTokensPerAlias);
  if (!id || canonical.length < policy.minimumAliasLength || canonicalTokens.length === 0) return null;
  const aliases: SynonymAliasV8[] = [];
  for (const inputAlias of input.aliases) {
    const alias = normalizeAlias(inputAlias, policy);
    if (alias && alias.value !== canonical) aliases.push(alias);
    if (aliases.length >= policy.maximumAliasesPerGroup) break;
  }
  return Object.freeze({
    id,
    canonical,
    canonicalTokens,
    aliases: dedupeAliases(aliases, policy.maximumAliasesPerGroup),
    scopes: normalizeScopes(input.scopes),
    bidirectional: input.bidirectional !== false,
    weight: boundedWeight(input.weight, 1),
    tags: normalizeTags(input.tags, policy.maximumTagsPerGroup),
    ordinal,
  });
};

const bindingKey = (scope: SynonymScopeV8, phrase: string): string => `${scope}|${phrase}`;

const appendBinding = (
  index: Map<string, PhraseBindingV8[]>,
  scope: SynonymScopeV8,
  phrase: string,
  binding: PhraseBindingV8,
): boolean => {
  const key = bindingKey(scope, phrase);
  const existing = index.get(key);
  if (existing) {
    const duplicate = existing.some(item => item.groupOrdinal === binding.groupOrdinal
      && item.alias.value === binding.alias.value
      && item.canonical === binding.canonical);
    if (duplicate) return false;
    existing.push(binding);
    return true;
  }
  index.set(key, [binding]);
  return false;
};

const indexAliasesForScope = (
  index: Map<string, PhraseBindingV8[]>,
  group: SynonymGroupV8,
  scope: SynonymScopeV8,
  collisions: { value: number },
): void => {
  for (const alias of group.aliases) {
    if (appendBinding(index, scope, alias.value, Object.freeze({
      groupOrdinal: group.ordinal,
      alias,
      canonical: false,
    }))) collisions.value += 1;
  }
};

const indexGroup = (
  index: Map<string, PhraseBindingV8[]>,
  group: SynonymGroupV8,
  collisions: { value: number },
): void => {
  const canonicalAlias: SynonymAliasV8 = Object.freeze({
    value: group.canonical,
    tokens: group.canonicalTokens,
    weight: 1,
  });
  for (const scope of group.scopes) {
    if (appendBinding(index, scope, group.canonical, Object.freeze({
      groupOrdinal: group.ordinal,
      alias: canonicalAlias,
      canonical: true,
    }))) collisions.value += 1;
    indexAliasesForScope(index, group, scope, collisions);
  }
};

const freezeIndex = (
  input: Map<string, PhraseBindingV8[]>,
): ReadonlyMap<string, readonly PhraseBindingV8[]> => {
  const result = new Map<string, readonly PhraseBindingV8[]>();
  for (const [key, bindings] of input) {
    result.set(key, Object.freeze(bindings.slice().sort((left, right) =>
      left.groupOrdinal - right.groupOrdinal || left.alias.value.localeCompare(right.alias.value))));
  }
  return result;
};

const scopeMatches = (group: SynonymGroupV8, scope: SynonymScopeV8): boolean =>
  group.scopes.includes('any') || group.scopes.includes(scope);

const expansionFor = (
  input: string,
  value: string,
  group: SynonymGroupV8,
  scope: SynonymScopeV8,
  weight: number,
  canonical: boolean,
  policy: NormalizedSynonymPolicyV8,
): SynonymExpansionV8 => Object.freeze({
  input,
  value,
  tokens: phraseTokens(value, policy.maximumExpansionTokens),
  groupId: group.id,
  scope,
  weight: group.weight * weight,
  canonical,
});

const aliasExpansions = (
  input: string,
  group: SynonymGroupV8,
  scope: SynonymScopeV8,
  policy: NormalizedSynonymPolicyV8,
): readonly SynonymExpansionV8[] => {
  const result: SynonymExpansionV8[] = [];
  for (const alias of group.aliases) {
    if (alias.value === input) continue;
    result.push(expansionFor(input, alias.value, group, scope, alias.weight, false, policy));
  }
  return Object.freeze(result);
};

const expansionCandidates = (
  input: string,
  binding: PhraseBindingV8,
  groups: readonly SynonymGroupV8[],
  scope: SynonymScopeV8,
  policy: NormalizedSynonymPolicyV8,
): readonly SynonymExpansionV8[] => {
  const group = groups[binding.groupOrdinal];
  if (!group || !scopeMatches(group, scope)) return Object.freeze([]);
  const result: SynonymExpansionV8[] = [];
  if (!binding.canonical) {
    result.push(expansionFor(input, group.canonical, group, scope, binding.alias.weight, true, policy));
  }
  if (group.bidirectional || binding.canonical) result.push(...aliasExpansions(input, group, scope, policy));
  return Object.freeze(result);
};

const compareExpansions = (left: SynonymExpansionV8, right: SynonymExpansionV8): number => {
  if (right.weight !== left.weight) return right.weight - left.weight;
  if (left.canonical !== right.canonical) return left.canonical ? -1 : 1;
  if (left.groupId !== right.groupId) return left.groupId.localeCompare(right.groupId);
  return left.value.localeCompare(right.value, 'tr-TR', { sensitivity: 'base', numeric: true });
};

const dedupeExpansions = (
  values: readonly SynonymExpansionV8[],
  maximum: number,
): readonly SynonymExpansionV8[] => {
  const byValue = new Map<string, SynonymExpansionV8>();
  const ordered = values.slice().sort(compareExpansions);
  for (const value of ordered) {
    const previous = byValue.get(value.value);
    if (!previous || value.weight > previous.weight) byValue.set(value.value, value);
    if (byValue.size >= maximum) break;
  }
  return Object.freeze(Array.from(byValue.values()).sort(compareExpansions));
};

const appendExpansionTokens = (
  result: Set<string>,
  expansion: SynonymExpansionV8,
  maximum: number,
): boolean => {
  for (const token of expansion.tokens) {
    result.add(token);
    if (result.size >= maximum) return true;
  }
  return false;
};

const appendExpansionList = (
  result: Set<string>,
  expansions: readonly SynonymExpansionV8[],
  maximum: number,
): boolean => {
  for (const expansion of expansions) {
    if (appendExpansionTokens(result, expansion, maximum)) return true;
  }
  return false;
};

export class SynonymRegistryRuntimeV8 {
  readonly #policy: NormalizedSynonymPolicyV8;
  readonly #groups: readonly SynonymGroupV8[];
  readonly #index: ReadonlyMap<string, readonly PhraseBindingV8[]>;
  readonly #stats: MutableSynonymStatsV8;
  readonly #fingerprint: string;

  constructor(
    inputs: readonly SynonymGroupInputV8[] = [],
    policyInput: SynonymRegistryPolicyV8 = {},
  ) {
    this.#policy = normalizePolicy(policyInput);
    this.#stats = { droppedGroups: 0, droppedAliases: 0, collisions: 0, expansions: 0 };
    const groups: SynonymGroupV8[] = [];
    const ids = new Set<string>();
    for (const input of inputs) {
      if (groups.length >= this.#policy.maximumGroups) {
        this.#stats.droppedGroups += 1;
        continue;
      }
      const group = normalizeGroup(input, groups.length, this.#policy);
      if (!group) continue;
      if (ids.has(group.id)) {
        this.#stats.droppedGroups += 1;
        continue;
      }
      ids.add(group.id);
      this.#stats.droppedAliases += Math.max(0, input.aliases.length - group.aliases.length);
      groups.push(group);
    }
    this.#groups = Object.freeze(groups);
    const index = new Map<string, PhraseBindingV8[]>();
    const collisions = { value: 0 };
    for (const group of this.#groups) indexGroup(index, group, collisions);
    this.#stats.collisions = collisions.value;
    this.#index = freezeIndex(index);
    this.#fingerprint = hashFingerprint(stableSerialize({
      version: SYNONYM_REGISTRY_VERSION_V8,
      policy: this.#policy,
      groups: this.#groups.map(group => ({
        id: group.id,
        canonical: group.canonical,
        aliases: group.aliases,
        scopes: group.scopes,
        bidirectional: group.bidirectional,
        weight: group.weight,
        tags: group.tags,
      })),
    }));
  }

  policy(): SynonymRegistryPolicyV8 {
    return Object.freeze({ ...this.#policy });
  }

  groups(): readonly SynonymGroupV8[] {
    return this.#groups;
  }

  group(idInput: unknown): SynonymGroupV8 | null {
    const id = normalizeId(idInput);
    return this.#groups.find(group => group.id === id) ?? null;
  }

  expand(inputValue: unknown, scopeInput: SynonymScopeV8 = 'any'): SynonymExpansionResultV8 {
    const input = canonicalPhrase(inputValue, this.#policy.maximumAliasLength);
    const scope = normalizeScope(scopeInput) ?? 'any';
    if (!input) {
      return Object.freeze({
        input: '',
        canonical: '',
        scope,
        expansions: Object.freeze([]),
        matchedGroups: Object.freeze([]),
        truncated: false,
      });
    }
    const direct = [
      ...(this.#index.get(bindingKey(scope, input)) ?? []),
      ...(scope === 'any' ? [] : this.#index.get(bindingKey('any', input)) ?? []),
    ];
    const expansions: SynonymExpansionV8[] = [];
    const matchedGroups = new Set<string>();
    for (const binding of direct) {
      const values = expansionCandidates(input, binding, this.#groups, scope, this.#policy);
      const group = this.#groups[binding.groupOrdinal];
      if (group) matchedGroups.add(group.id);
      expansions.push(...values);
      if (expansions.length >= this.#policy.maximumExpansionsPerToken * 4) break;
    }
    const selected = dedupeExpansions(expansions, this.#policy.maximumExpansionsPerToken);
    this.#stats.expansions += selected.length;
    return Object.freeze({
      input,
      canonical: direct.find(binding => binding.canonical)
        ? input
        : selected.find(item => item.canonical)?.value ?? input,
      scope,
      expansions: selected,
      matchedGroups: Object.freeze(Array.from(matchedGroups).sort()),
      truncated: expansions.length > selected.length,
    });
  }

  expandTokens(
    tokensInput: readonly string[],
    scope: SynonymScopeV8 = 'any',
  ): readonly string[] {
    const result = new Set<string>();
    for (const raw of tokensInput) {
      const token = canonicalPhrase(raw, this.#policy.maximumAliasLength);
      if (!token) continue;
      result.add(token);
      const expanded = this.expand(token, scope);
      if (appendExpansionList(result, expanded.expansions, this.#policy.maximumExpansionTokens)) break;
      if (result.size >= this.#policy.maximumExpansionTokens) break;
    }
    return Object.freeze(Array.from(result).slice(0, this.#policy.maximumExpansionTokens));
  }

  snapshot(): SynonymRegistrySnapshotV8 {
    let aliasCount = 0;
    for (const group of this.#groups) aliasCount += group.aliases.length;
    return Object.freeze({
      version: SYNONYM_REGISTRY_VERSION_V8,
      groupCount: this.#groups.length,
      aliasCount,
      indexedPhraseCount: this.#index.size,
      droppedGroups: this.#stats.droppedGroups,
      droppedAliases: this.#stats.droppedAliases,
      collisions: this.#stats.collisions,
      expansions: this.#stats.expansions,
      fingerprint: this.#fingerprint,
    });
  }
}

export const createSynonymRegistryRuntimeV8 = (
  groups: readonly SynonymGroupInputV8[] = [],
  policy: SynonymRegistryPolicyV8 = {},
): SynonymRegistryRuntimeV8 => new SynonymRegistryRuntimeV8(groups, policy);

export const createDefaultCivicSynonymsV8 = (): readonly SynonymGroupInputV8[] => Object.freeze([
  Object.freeze({
    id: 'health-hospital',
    canonical: 'saglik',
    aliases: Object.freeze(['hastane', 'hastanesi', 'saglik merkezi', 'saglik tesisi']),
    scopes: Object.freeze(['any', 'category', 'type'] as const),
    weight: 1,
  }),
  Object.freeze({
    id: 'education-school',
    canonical: 'okul',
    aliases: Object.freeze(['mektep', 'egitim kurumu', 'egitim merkezi']),
    scopes: Object.freeze(['any', 'category', 'type'] as const),
    weight: 1,
  }),
  Object.freeze({
    id: 'transport-station',
    canonical: 'durak',
    aliases: Object.freeze(['istasyon', 'terminal', 'otobus duragi', 'toplu tasima duragi']),
    scopes: Object.freeze(['any', 'category', 'type'] as const),
    weight: 1,
  }),
  Object.freeze({
    id: 'green-park',
    canonical: 'park',
    aliases: Object.freeze(['yesil alan', 'rekreasyon alani', 'mesire alani']),
    scopes: Object.freeze(['any', 'category', 'type'] as const),
    weight: 1,
  }),
  Object.freeze({
    id: 'public-municipality',
    canonical: 'belediye',
    aliases: Object.freeze(['belediyesi', 'belediye binasi', 'yerel yonetim']),
    scopes: Object.freeze(['any', 'category', 'type', 'title'] as const),
    weight: 1,
  }),
]);
