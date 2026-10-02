import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type { SearchResultCardV9 } from './searchResultPresentationRuntimeV9';

export const SEARCH_GROUPING_VERSION_V9 = 'search-grouping-v9' as const;

export type SearchGroupingModeV9 =
  | 'none'
  | 'category'
  | 'type'
  | 'district'
  | 'neighborhood'
  | 'distance';

export interface SearchGroupV9 {
  readonly key: string;
  readonly mode: SearchGroupingModeV9;
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly cards: readonly SearchResultCardV9[];
  readonly truncated: boolean;
  readonly firstSourceIndex: number;
  readonly fingerprint: string;
}

export interface SearchGroupingResultV9 {
  readonly mode: SearchGroupingModeV9;
  readonly groups: readonly SearchGroupV9[];
  readonly totalCards: number;
  readonly groupedCards: number;
  readonly omittedCards: number;
  readonly truncated: boolean;
  readonly fingerprint: string;
}

export interface SearchGroupingPolicyV9 {
  readonly mode?: SearchGroupingModeV9;
  readonly maxGroups?: number;
  readonly maxCardsPerGroup?: number;
  readonly maxCards?: number;
  readonly includeUnknownGroup?: boolean;
  readonly unknownLabel?: string;
  readonly distanceBandsMeters?: readonly number[];
}

export interface SearchGroupingSnapshotV9 {
  readonly version: typeof SEARCH_GROUPING_VERSION_V9;
  readonly executions: number;
  readonly groupsBuilt: number;
  readonly cardsGrouped: number;
  readonly omittedCards: number;
  readonly truncatedExecutions: number;
  readonly fingerprint: string;
}

interface NormalizedGroupingPolicyV9 {
  readonly mode: SearchGroupingModeV9;
  readonly maxGroups: number;
  readonly maxCardsPerGroup: number;
  readonly maxCards: number;
  readonly includeUnknownGroup: boolean;
  readonly unknownLabel: string;
  readonly distanceBandsMeters: readonly number[];
}

interface MutableGroupingStatsV9 {
  executions: number;
  groupsBuilt: number;
  cardsGrouped: number;
  omittedCards: number;
  truncatedExecutions: number;
}

interface MutableGroupV9 {
  readonly key: string;
  readonly value: string;
  readonly label: string;
  readonly firstOrdinal: number;
  readonly firstSourceIndex: number;
  readonly cards: SearchResultCardV9[];
  totalCount: number;
  truncated: boolean;
}

const DEFAULT_DISTANCE_BANDS = Object.freeze([500, 2_000, 10_000, 25_000]);

const normalizeMode = (value: unknown): SearchGroupingModeV9 => {
  const normalized = normalizeSearchText(value);
  if (normalized === 'category'
    || normalized === 'type'
    || normalized === 'district'
    || normalized === 'neighborhood'
    || normalized === 'distance') return normalized;
  return 'none';
};

const normalizeDistanceBands = (values: readonly number[] | undefined): readonly number[] => {
  const normalized = Array.from(new Set((values ?? DEFAULT_DISTANCE_BANDS)
    .map(value => Math.trunc(Number(value)))
    .filter(value => Number.isFinite(value) && value > 0 && value <= 1_000_000)))
    .sort((left, right) => left - right)
    .slice(0, 16);
  return Object.freeze(normalized.length ? normalized : [...DEFAULT_DISTANCE_BANDS]);
};

const normalizePolicy = (
  policy: SearchGroupingPolicyV9 = {},
): NormalizedGroupingPolicyV9 => Object.freeze({
  mode: normalizeMode(policy.mode),
  maxGroups: normalizeInteger(policy.maxGroups, { min: 1, max: 256, fallback: 24 }),
  maxCardsPerGroup: normalizeInteger(policy.maxCardsPerGroup, { min: 1, max: 2_000, fallback: 100 }),
  maxCards: normalizeInteger(policy.maxCards, { min: 1, max: 5_000, fallback: 500 }),
  includeUnknownGroup: policy.includeUnknownGroup !== false,
  unknownLabel: normalizeText(policy.unknownLabel) || 'Diğer sonuçlar',
  distanceBandsMeters: normalizeDistanceBands(policy.distanceBandsMeters),
});

const canonicalGroupKey = (mode: SearchGroupingModeV9, value: string): string =>
  `${mode}:${normalizeSearchText(value).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'unknown'}`;

const humanDistance = (meters: number): string => {
  if (meters < 1_000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1_000).toFixed(1)} km`;
  return `${Math.round(meters / 1_000)} km`;
};

const distanceBucket = (
  distanceMeters: number | null,
  bands: readonly number[],
  unknownLabel: string,
): Readonly<{ value: string; label: string }> => {
  if (distanceMeters === null || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return Object.freeze({ value: 'unknown', label: unknownLabel });
  }
  let lower = 0;
  for (const upper of bands) {
    if (distanceMeters < upper) {
      const value = `${lower}-${upper}`;
      const label = lower === 0
        ? `${humanDistance(upper)} içinde`
        : `${humanDistance(lower)} – ${humanDistance(upper)}`;
      return Object.freeze({ value, label });
    }
    lower = upper;
  }
  return Object.freeze({
    value: `${lower}-plus`,
    label: `${humanDistance(lower)} ve üzeri`,
  });
};

const groupIdentity = (
  card: SearchResultCardV9,
  policy: NormalizedGroupingPolicyV9,
): Readonly<{ value: string; label: string }> => {
  if (policy.mode === 'category') {
    const value = normalizeText(card.category);
    return Object.freeze({ value: value || 'unknown', label: value || policy.unknownLabel });
  }
  if (policy.mode === 'type') {
    const value = normalizeText(card.type);
    return Object.freeze({ value: value || 'unknown', label: value || policy.unknownLabel });
  }
  if (policy.mode === 'district') {
    const value = normalizeText(card.district);
    return Object.freeze({ value: value || 'unknown', label: value || policy.unknownLabel });
  }
  if (policy.mode === 'neighborhood') {
    const value = normalizeText(card.neighborhood);
    return Object.freeze({ value: value || 'unknown', label: value || policy.unknownLabel });
  }
  if (policy.mode === 'distance') {
    return distanceBucket(card.distanceMeters, policy.distanceBandsMeters, policy.unknownLabel);
  }
  return Object.freeze({ value: 'all', label: 'Tüm sonuçlar' });
};

const shouldKeepIdentity = (
  identity: Readonly<{ value: string; label: string }>,
  policy: NormalizedGroupingPolicyV9,
): boolean => identity.value !== 'unknown' || policy.includeUnknownGroup;

const groupFingerprint = (
  mode: SearchGroupingModeV9,
  group: MutableGroupV9,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_GROUPING_VERSION_V9,
  mode,
  key: group.key,
  value: group.value,
  totalCount: group.totalCount,
  cardKeys: group.cards.map(card => card.key),
  truncated: group.truncated,
}));

const freezeGroup = (
  mode: SearchGroupingModeV9,
  group: MutableGroupV9,
): SearchGroupV9 => Object.freeze({
  key: group.key,
  mode,
  value: group.value,
  label: group.label,
  count: group.totalCount,
  cards: Object.freeze([...group.cards]),
  truncated: group.truncated,
  firstSourceIndex: group.firstSourceIndex,
  fingerprint: groupFingerprint(mode, group),
});

const resultFingerprint = (
  mode: SearchGroupingModeV9,
  groups: readonly SearchGroupV9[],
  totalCards: number,
  groupedCards: number,
  omittedCards: number,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_GROUPING_VERSION_V9,
  mode,
  totalCards,
  groupedCards,
  omittedCards,
  groups: groups.map(group => [group.key, group.count, group.fingerprint]),
}));

export class SearchGroupingRuntimeV9 {
  readonly #policy: NormalizedGroupingPolicyV9;
  readonly #stats: MutableGroupingStatsV9 = {
    executions: 0,
    groupsBuilt: 0,
    cardsGrouped: 0,
    omittedCards: 0,
    truncatedExecutions: 0,
  };

  constructor(policy: SearchGroupingPolicyV9 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  group(
    cardsInput: readonly SearchResultCardV9[],
    modeInput?: SearchGroupingModeV9,
  ): SearchGroupingResultV9 {
    const mode = modeInput === undefined ? this.#policy.mode : normalizeMode(modeInput);
    const cards = cardsInput.slice(0, this.#policy.maxCards);
    const omittedByGlobalLimit = Math.max(0, cardsInput.length - cards.length);
    const groups = new Map<string, MutableGroupV9>();
    let ordinal = 0;
    let omitted = omittedByGlobalLimit;

    for (const card of cards) {
      const policyForMode: NormalizedGroupingPolicyV9 = mode === this.#policy.mode
        ? this.#policy
        : Object.freeze({ ...this.#policy, mode });
      const identity = groupIdentity(card, policyForMode);
      if (!shouldKeepIdentity(identity, policyForMode)) {
        omitted += 1;
        ordinal += 1;
        continue;
      }
      const key = canonicalGroupKey(mode, identity.value);
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= this.#policy.maxGroups) {
          omitted += 1;
          ordinal += 1;
          continue;
        }
        group = {
          key,
          value: identity.value,
          label: identity.label,
          firstOrdinal: ordinal,
          firstSourceIndex: card.sourceIndex,
          cards: [],
          totalCount: 0,
          truncated: false,
        };
        groups.set(key, group);
      }
      group.totalCount += 1;
      if (group.cards.length < this.#policy.maxCardsPerGroup) group.cards.push(card);
      else {
        group.truncated = true;
        omitted += 1;
      }
      ordinal += 1;
    }

    const orderedMutable = Array.from(groups.values()).sort((left, right) =>
      left.firstOrdinal - right.firstOrdinal
      || left.firstSourceIndex - right.firstSourceIndex
      || left.label.localeCompare(right.label, 'tr-TR', { sensitivity: 'base', numeric: true }));
    const frozenGroups = Object.freeze(orderedMutable.map(group => freezeGroup(mode, group)));
    const groupedCards = frozenGroups.reduce((total, group) => total + group.cards.length, 0);
    const truncated = omitted > 0 || frozenGroups.some(group => group.truncated);

    this.#stats.executions += 1;
    this.#stats.groupsBuilt += frozenGroups.length;
    this.#stats.cardsGrouped += groupedCards;
    this.#stats.omittedCards += omitted;
    if (truncated) this.#stats.truncatedExecutions += 1;

    return Object.freeze({
      mode,
      groups: frozenGroups,
      totalCards: cardsInput.length,
      groupedCards,
      omittedCards: omitted,
      truncated,
      fingerprint: resultFingerprint(mode, frozenGroups, cardsInput.length, groupedCards, omitted),
    });
  }

  snapshot(): SearchGroupingSnapshotV9 {
    return Object.freeze({
      version: SEARCH_GROUPING_VERSION_V9,
      ...this.#stats,
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_GROUPING_VERSION_V9,
        policy: this.#policy,
        stats: this.#stats,
      })),
    });
  }
}

export const createSearchGroupingRuntimeV9 = (
  policy: SearchGroupingPolicyV9 = {},
): SearchGroupingRuntimeV9 => new SearchGroupingRuntimeV9(policy);
