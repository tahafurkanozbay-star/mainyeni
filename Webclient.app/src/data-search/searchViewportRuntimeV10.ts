import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';
import type { SearchResultCardV9 } from './searchResultPresentationRuntimeV9';

export const SEARCH_VIEWPORT_VERSION_V10 = 'search-viewport-v10' as const;

export interface SearchViewportPolicyV10 {
  readonly visibleCount?: number;
  readonly overscan?: number;
  readonly maximumCards?: number;
  readonly pageStep?: number;
  readonly keepActiveMounted?: boolean;
}

export interface SearchViewportItemV10 {
  readonly key: string;
  readonly card: SearchResultCardV9;
  readonly index: number;
  readonly position: number;
  readonly setSize: number;
  readonly active: boolean;
  readonly selected: boolean;
  readonly inPrimaryWindow: boolean;
  readonly ariaPosInSet: number;
  readonly ariaSetSize: number;
}

export interface SearchViewportSnapshotV10 {
  readonly version: typeof SEARCH_VIEWPORT_VERSION_V10;
  readonly totalCards: number;
  readonly retainedCards: number;
  readonly truncatedCards: number;
  readonly visibleCount: number;
  readonly overscan: number;
  readonly requestedStart: number;
  readonly start: number;
  readonly endExclusive: number;
  readonly activeKey: string | null;
  readonly activeIndex: number;
  readonly selectedKeys: readonly string[];
  readonly items: readonly SearchViewportItemV10[];
  readonly hasPreviousWindow: boolean;
  readonly hasNextWindow: boolean;
  readonly previousStart: number | null;
  readonly nextStart: number | null;
  readonly fingerprint: string;
}

interface NormalizedViewportPolicyV10 {
  readonly visibleCount: number;
  readonly overscan: number;
  readonly maximumCards: number;
  readonly pageStep: number;
  readonly keepActiveMounted: boolean;
}

const normalizePolicy = (
  policy: SearchViewportPolicyV10 = {},
): NormalizedViewportPolicyV10 => {
  const maximumCards = normalizeInteger(policy.maximumCards, { min: 1, max: 10_000, fallback: 1_000 });
  const visibleCount = normalizeInteger(policy.visibleCount, {
    min: 1,
    max: Math.min(500, maximumCards),
    fallback: Math.min(24, maximumCards),
  });
  return Object.freeze({
    visibleCount,
    overscan: normalizeInteger(policy.overscan, { min: 0, max: 200, fallback: 8 }),
    maximumCards,
    pageStep: normalizeInteger(policy.pageStep, { min: 1, max: 500, fallback: visibleCount }),
    keepActiveMounted: policy.keepActiveMounted !== false,
  });
};

const uniqueCards = (
  cards: readonly SearchResultCardV9[],
  maximum: number,
): readonly SearchResultCardV9[] => {
  const output: SearchResultCardV9[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (output.length >= maximum) break;
    const key = normalizeText(card.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(card);
  }
  return Object.freeze(output);
};

const uniqueKeys = (
  values: readonly string[],
  allowed: ReadonlySet<string>,
): readonly string[] => {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    const key = normalizeText(input);
    if (!key || seen.has(key) || !allowed.has(key)) continue;
    seen.add(key);
    output.push(key);
  }
  return Object.freeze(output);
};

const clampStart = (
  requested: number,
  total: number,
  visibleCount: number,
): number => {
  if (total <= 0) return 0;
  const maximumStart = Math.max(0, total - visibleCount);
  return Math.min(maximumStart, Math.max(0, requested));
};

const rangeIndexes = (
  start: number,
  endExclusive: number,
): readonly number[] => Object.freeze(Array.from(
  { length: Math.max(0, endExclusive - start) },
  (_value, index) => start + index,
));

const unionIndexes = (
  primary: readonly number[],
  extra: number | null,
): readonly number[] => {
  const values = [...primary];
  if (extra !== null && !values.includes(extra)) values.push(extra);
  values.sort((left, right) => left - right);
  return Object.freeze(values);
};

export class SearchViewportRuntimeV10 {
  readonly #policy: NormalizedViewportPolicyV10;
  #cards: readonly SearchResultCardV9[] = Object.freeze([]);
  #requestedStart = 0;
  #activeKey: string | null = null;
  #selectedKeys: readonly string[] = Object.freeze([]);

  constructor(policy: SearchViewportPolicyV10 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  setResults(
    cardsInput: readonly SearchResultCardV9[],
    options: Readonly<{
      activeKey?: string | null;
      selectedKeys?: readonly string[];
      preserveStart?: boolean;
    }> = {},
  ): SearchViewportSnapshotV10 {
    const previousKeys = new Set(this.#cards.map(card => card.key));
    const cards = uniqueCards(cardsInput, this.#policy.maximumCards);
    const keys = new Set(cards.map(card => card.key));
    const requestedActive = options.activeKey === undefined ? this.#activeKey : normalizeText(options.activeKey);
    const preservedActive = requestedActive && keys.has(requestedActive)
      ? requestedActive
      : null;
    const incomingSelected = options.selectedKeys === undefined ? this.#selectedKeys : options.selectedKeys;
    this.#cards = cards;
    this.#activeKey = preservedActive;
    this.#selectedKeys = uniqueKeys(incomingSelected, keys);
    const canPreserveStart = options.preserveStart !== false
      && previousKeys.size > 0
      && [...keys].some(key => previousKeys.has(key));
    if (!canPreserveStart) this.#requestedStart = 0;
    this.#requestedStart = clampStart(this.#requestedStart, cards.length, this.#policy.visibleCount);
    this.#ensureActiveVisible();
    return this.snapshot();
  }

  #ensureActiveVisible(): void {
    if (!this.#activeKey) return;
    const index = this.#cards.findIndex(card => card.key === this.#activeKey);
    if (index < 0) return;
    const start = clampStart(this.#requestedStart, this.#cards.length, this.#policy.visibleCount);
    const endExclusive = Math.min(this.#cards.length, start + this.#policy.visibleCount);
    if (index < start) this.#requestedStart = index;
    else if (index >= endExclusive) this.#requestedStart = index - this.#policy.visibleCount + 1;
    this.#requestedStart = clampStart(this.#requestedStart, this.#cards.length, this.#policy.visibleCount);
  }

  setStart(startInput: unknown): SearchViewportSnapshotV10 {
    const requested = normalizeInteger(startInput, {
      min: 0,
      max: Math.max(0, this.#cards.length),
      fallback: 0,
    });
    this.#requestedStart = clampStart(requested, this.#cards.length, this.#policy.visibleCount);
    if (this.#policy.keepActiveMounted) this.#ensureActiveVisible();
    return this.snapshot();
  }

  setActive(keyInput: unknown): SearchViewportSnapshotV10 {
    const key = normalizeText(keyInput);
    this.#activeKey = key && this.#cards.some(card => card.key === key) ? key : null;
    this.#ensureActiveVisible();
    return this.snapshot();
  }

  setSelected(keys: readonly string[]): SearchViewportSnapshotV10 {
    const allowed = new Set(this.#cards.map(card => card.key));
    this.#selectedKeys = uniqueKeys(keys, allowed);
    return this.snapshot();
  }

  moveActive(deltaInput: unknown): SearchViewportSnapshotV10 {
    if (!this.#cards.length) return this.snapshot();
    const delta = normalizeInteger(deltaInput, {
      min: -this.#cards.length,
      max: this.#cards.length,
      fallback: 0,
    });
    if (!delta) return this.snapshot();
    const current = this.#activeKey
      ? this.#cards.findIndex(card => card.key === this.#activeKey)
      : -1;
    const base = current >= 0 ? current : delta > 0 ? -1 : this.#cards.length;
    const next = Math.min(this.#cards.length - 1, Math.max(0, base + delta));
    this.#activeKey = this.#cards[next]?.key ?? null;
    this.#ensureActiveVisible();
    return this.snapshot();
  }

  next(): SearchViewportSnapshotV10 {
    return this.moveActive(1);
  }

  previous(): SearchViewportSnapshotV10 {
    return this.moveActive(-1);
  }

  pageNext(): SearchViewportSnapshotV10 {
    return this.moveActive(this.#policy.pageStep);
  }

  pagePrevious(): SearchViewportSnapshotV10 {
    return this.moveActive(-this.#policy.pageStep);
  }

  first(): SearchViewportSnapshotV10 {
    if (!this.#cards.length) return this.snapshot();
    this.#activeKey = this.#cards[0]?.key ?? null;
    this.#requestedStart = 0;
    return this.snapshot();
  }

  last(): SearchViewportSnapshotV10 {
    if (!this.#cards.length) return this.snapshot();
    this.#activeKey = this.#cards[this.#cards.length - 1]?.key ?? null;
    this.#requestedStart = clampStart(
      this.#cards.length - this.#policy.visibleCount,
      this.#cards.length,
      this.#policy.visibleCount,
    );
    return this.snapshot();
  }

  activeCard(): SearchResultCardV9 | null {
    if (!this.#activeKey) return null;
    return this.#cards.find(card => card.key === this.#activeKey) ?? null;
  }

  cards(): readonly SearchResultCardV9[] {
    return this.#cards;
  }

  snapshot(): SearchViewportSnapshotV10 {
    const total = this.#cards.length;
    const start = clampStart(this.#requestedStart, total, this.#policy.visibleCount);
    const endExclusive = Math.min(total, start + this.#policy.visibleCount);
    const overscanStart = Math.max(0, start - this.#policy.overscan);
    const overscanEnd = Math.min(total, endExclusive + this.#policy.overscan);
    const primaryIndexes = rangeIndexes(overscanStart, overscanEnd);
    const activeIndex = this.#activeKey
      ? this.#cards.findIndex(card => card.key === this.#activeKey)
      : -1;
    const indexes = unionIndexes(
      primaryIndexes,
      this.#policy.keepActiveMounted && activeIndex >= 0 ? activeIndex : null,
    );
    const selected = new Set(this.#selectedKeys);
    const items: SearchViewportItemV10[] = [];
    for (const index of indexes) {
      const card = this.#cards[index];
      if (!card) continue;
      items.push(Object.freeze({
        key: card.key,
        card,
        index,
        position: index + 1,
        setSize: total,
        active: card.key === this.#activeKey,
        selected: selected.has(card.key),
        inPrimaryWindow: index >= start && index < endExclusive,
        ariaPosInSet: index + 1,
        ariaSetSize: total,
      }));
    }
    const previousStart = start > 0
      ? Math.max(0, start - this.#policy.visibleCount)
      : null;
    const nextStart = endExclusive < total
      ? Math.min(total - 1, start + this.#policy.visibleCount)
      : null;
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_VIEWPORT_VERSION_V10,
      keys: this.#cards.map(card => card.key),
      start,
      endExclusive,
      activeKey: this.#activeKey,
      selectedKeys: this.#selectedKeys,
    }));
    return Object.freeze({
      version: SEARCH_VIEWPORT_VERSION_V10,
      totalCards: total,
      retainedCards: this.#cards.length,
      truncatedCards: Math.max(0, total - this.#cards.length),
      visibleCount: this.#policy.visibleCount,
      overscan: this.#policy.overscan,
      requestedStart: this.#requestedStart,
      start,
      endExclusive,
      activeKey: this.#activeKey,
      activeIndex,
      selectedKeys: this.#selectedKeys,
      items: Object.freeze(items),
      hasPreviousWindow: previousStart !== null,
      hasNextWindow: nextStart !== null,
      previousStart,
      nextStart,
      fingerprint,
    });
  }
}

export const createSearchViewportRuntimeV10 = (
  policy: SearchViewportPolicyV10 = {},
): SearchViewportRuntimeV10 => new SearchViewportRuntimeV10(policy);
