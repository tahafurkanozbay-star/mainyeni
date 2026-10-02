import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type { SearchResultCardV9 } from './searchResultPresentationRuntimeV9';

export const SEARCH_SELECTION_VERSION_V9 = 'search-selection-v9' as const;

export interface SearchSelectionDatasetIdentityV9 {
  readonly key: string;
  readonly revision: number;
  readonly fingerprint: string;
}

export interface SearchSelectionPositionV9 {
  readonly key: string;
  readonly index: number;
  readonly position: number;
  readonly setSize: number;
  readonly selected: boolean;
}

export interface SearchSelectionSnapshotV9 {
  readonly version: typeof SEARCH_SELECTION_VERSION_V9;
  readonly dataset: SearchSelectionDatasetIdentityV9 | null;
  readonly resultCount: number;
  readonly activeKey: string | null;
  readonly activeIndex: number;
  readonly activePosition: SearchSelectionPositionV9 | null;
  readonly selectedKeys: readonly string[];
  readonly selectedCount: number;
  readonly multiSelect: boolean;
  readonly revisionResets: number;
  readonly movements: number;
  readonly selections: number;
  readonly fingerprint: string;
}

export interface SearchSelectionPolicyV9 {
  readonly maxResults?: number;
  readonly maxSelected?: number;
  readonly multiSelect?: boolean;
  readonly wrapNavigation?: boolean;
  readonly pageStep?: number;
  readonly activateFirstResult?: boolean;
}

interface NormalizedSelectionPolicyV9 {
  readonly maxResults: number;
  readonly maxSelected: number;
  readonly multiSelect: boolean;
  readonly wrapNavigation: boolean;
  readonly pageStep: number;
  readonly activateFirstResult: boolean;
}

interface MutableSelectionStatsV9 {
  revisionResets: number;
  movements: number;
  selections: number;
}

const normalizePolicy = (
  policy: SearchSelectionPolicyV9 = {},
): NormalizedSelectionPolicyV9 => {
  const maxResults = normalizeInteger(policy.maxResults, { min: 1, max: 5_000, fallback: 500 });
  return Object.freeze({
    maxResults,
    maxSelected: normalizeInteger(policy.maxSelected, { min: 1, max: maxResults, fallback: 50 }),
    multiSelect: policy.multiSelect === true,
    wrapNavigation: policy.wrapNavigation === true,
    pageStep: normalizeInteger(policy.pageStep, { min: 1, max: 100, fallback: 10 }),
    activateFirstResult: policy.activateFirstResult !== false,
  });
};

const normalizeDatasetIdentity = (
  input: SearchSelectionDatasetIdentityV9,
): SearchSelectionDatasetIdentityV9 => Object.freeze({
  key: normalizeSearchText(input.key).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160),
  revision: normalizeInteger(input.revision, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  fingerprint: normalizeText(input.fingerprint).slice(0, 256),
});

const sameDataset = (
  left: SearchSelectionDatasetIdentityV9 | null,
  right: SearchSelectionDatasetIdentityV9,
): boolean => Boolean(left
  && left.key === right.key
  && left.revision === right.revision
  && left.fingerprint === right.fingerprint);

const resultKeys = (
  cards: readonly SearchResultCardV9[],
  maximum: number,
): readonly string[] => {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (keys.length >= maximum) break;
    const key = normalizeText(card.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return Object.freeze(keys);
};

const boundedIndex = (
  desired: number,
  count: number,
  wrap: boolean,
): number => {
  if (count <= 0) return -1;
  if (wrap) {
    const modulo = desired % count;
    return modulo < 0 ? modulo + count : modulo;
  }
  return Math.min(count - 1, Math.max(0, desired));
};

export class SearchSelectionRuntimeV9 {
  readonly #policy: NormalizedSelectionPolicyV9;
  readonly #stats: MutableSelectionStatsV9 = {
    revisionResets: 0,
    movements: 0,
    selections: 0,
  };
  #dataset: SearchSelectionDatasetIdentityV9 | null = null;
  #keys: readonly string[] = Object.freeze([]);
  #activeKey: string | null = null;
  #selected = new Set<string>();

  constructor(policy: SearchSelectionPolicyV9 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  setResults(
    datasetInput: SearchSelectionDatasetIdentityV9,
    cards: readonly SearchResultCardV9[],
  ): SearchSelectionSnapshotV9 {
    const dataset = normalizeDatasetIdentity(datasetInput);
    const revisionChanged = !sameDataset(this.#dataset, dataset);
    const keys = resultKeys(cards, this.#policy.maxResults);
    const valid = new Set(keys);

    if (revisionChanged) {
      this.#selected.clear();
      this.#activeKey = null;
      if (this.#dataset !== null) this.#stats.revisionResets += 1;
    } else {
      for (const key of [...this.#selected]) {
        if (!valid.has(key)) this.#selected.delete(key);
      }
      if (this.#activeKey && !valid.has(this.#activeKey)) this.#activeKey = null;
    }

    this.#dataset = dataset;
    this.#keys = keys;
    if (!this.#activeKey && this.#policy.activateFirstResult && keys.length) {
      this.#activeKey = keys[0] ?? null;
    }
    return this.snapshot();
  }

  activeKey(): string | null {
    return this.#activeKey;
  }

  selectedKeys(): readonly string[] {
    return Object.freeze(this.#keys.filter(key => this.#selected.has(key)));
  }

  position(keyInput?: unknown): SearchSelectionPositionV9 | null {
    const key = normalizeText(keyInput === undefined ? this.#activeKey : keyInput);
    if (!key) return null;
    const index = this.#keys.indexOf(key);
    if (index < 0) return null;
    return Object.freeze({
      key,
      index,
      position: index + 1,
      setSize: this.#keys.length,
      selected: this.#selected.has(key),
    });
  }

  setActive(keyInput: unknown): SearchSelectionSnapshotV9 {
    const key = normalizeText(keyInput);
    if (!key || !this.#keys.includes(key)) return this.snapshot();
    if (this.#activeKey !== key) this.#stats.movements += 1;
    this.#activeKey = key;
    return this.snapshot();
  }

  move(deltaInput: unknown): SearchSelectionSnapshotV9 {
    const count = this.#keys.length;
    if (!count) return this.snapshot();
    const delta = normalizeInteger(deltaInput, {
      min: -count,
      max: count,
      fallback: 0,
    });
    if (!delta) return this.snapshot();
    const current = this.#activeKey ? this.#keys.indexOf(this.#activeKey) : -1;
    const base = current >= 0 ? current : delta > 0 ? -1 : count;
    const index = boundedIndex(base + delta, count, this.#policy.wrapNavigation);
    const next = this.#keys[index] ?? null;
    if (next && next !== this.#activeKey) {
      this.#activeKey = next;
      this.#stats.movements += 1;
    }
    return this.snapshot();
  }

  next(): SearchSelectionSnapshotV9 {
    return this.move(1);
  }

  previous(): SearchSelectionSnapshotV9 {
    return this.move(-1);
  }

  first(): SearchSelectionSnapshotV9 {
    const key = this.#keys[0];
    return key ? this.setActive(key) : this.snapshot();
  }

  last(): SearchSelectionSnapshotV9 {
    const key = this.#keys[this.#keys.length - 1];
    return key ? this.setActive(key) : this.snapshot();
  }

  pageNext(): SearchSelectionSnapshotV9 {
    return this.move(this.#policy.pageStep);
  }

  pagePrevious(): SearchSelectionSnapshotV9 {
    return this.move(-this.#policy.pageStep);
  }

  select(keyInput?: unknown): SearchSelectionSnapshotV9 {
    const key = normalizeText(keyInput === undefined ? this.#activeKey : keyInput);
    if (!key || !this.#keys.includes(key)) return this.snapshot();
    if (!this.#policy.multiSelect) this.#selected.clear();
    if (!this.#selected.has(key)) {
      if (this.#selected.size >= this.#policy.maxSelected) {
        const oldest = this.#selected.values().next().value as string | undefined;
        if (oldest) this.#selected.delete(oldest);
      }
      this.#selected.add(key);
      this.#stats.selections += 1;
    }
    this.#activeKey = key;
    return this.snapshot();
  }

  toggle(keyInput?: unknown): SearchSelectionSnapshotV9 {
    const key = normalizeText(keyInput === undefined ? this.#activeKey : keyInput);
    if (!key || !this.#keys.includes(key)) return this.snapshot();
    if (!this.#policy.multiSelect) {
      if (this.#selected.has(key)) this.#selected.clear();
      else {
        this.#selected.clear();
        this.#selected.add(key);
        this.#stats.selections += 1;
      }
      this.#activeKey = key;
      return this.snapshot();
    }
    if (this.#selected.has(key)) this.#selected.delete(key);
    else {
      if (this.#selected.size >= this.#policy.maxSelected) {
        const oldest = this.#selected.values().next().value as string | undefined;
        if (oldest) this.#selected.delete(oldest);
      }
      this.#selected.add(key);
      this.#stats.selections += 1;
    }
    this.#activeKey = key;
    return this.snapshot();
  }

  clearSelection(): SearchSelectionSnapshotV9 {
    this.#selected.clear();
    return this.snapshot();
  }

  reset(): SearchSelectionSnapshotV9 {
    this.#dataset = null;
    this.#keys = Object.freeze([]);
    this.#activeKey = null;
    this.#selected.clear();
    return this.snapshot();
  }

  snapshot(): SearchSelectionSnapshotV9 {
    const selectedKeys = this.selectedKeys();
    const activeIndex = this.#activeKey ? this.#keys.indexOf(this.#activeKey) : -1;
    const activePosition = this.position();
    return Object.freeze({
      version: SEARCH_SELECTION_VERSION_V9,
      dataset: this.#dataset,
      resultCount: this.#keys.length,
      activeKey: this.#activeKey,
      activeIndex,
      activePosition,
      selectedKeys,
      selectedCount: selectedKeys.length,
      multiSelect: this.#policy.multiSelect,
      revisionResets: this.#stats.revisionResets,
      movements: this.#stats.movements,
      selections: this.#stats.selections,
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_SELECTION_VERSION_V9,
        dataset: this.#dataset,
        keys: this.#keys,
        activeKey: this.#activeKey,
        selectedKeys,
        stats: this.#stats,
      })),
    });
  }
}

export const createSearchSelectionRuntimeV9 = (
  policy: SearchSelectionPolicyV9 = {},
): SearchSelectionRuntimeV9 => new SearchSelectionRuntimeV9(policy);
