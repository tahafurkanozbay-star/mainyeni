import type { NormalizedRecord, SearchHit, SearchRequest } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
  tokenizeSearchText,
} from './normalization';
import type { SearchRecoveryResultV8 } from './searchRecoveryRuntimeV8';

export const SEARCH_RESULT_PRESENTATION_VERSION_V9 = 'search-result-presentation-v9' as const;

export type SearchResultBadgeKindV9 =
  | 'category'
  | 'type'
  | 'district'
  | 'neighborhood'
  | 'distance'
  | 'score'
  | 'recovery'
  | 'address'
  | 'spatial';

export interface SearchHighlightRangeV9 {
  readonly start: number;
  readonly end: number;
  readonly term: string;
}

export interface SearchResultTextV9 {
  readonly value: string;
  readonly highlights: readonly SearchHighlightRangeV9[];
}

export interface SearchResultBadgeV9 {
  readonly kind: SearchResultBadgeKindV9;
  readonly value: string;
  readonly label: string;
}

export interface SearchResultExplanationV9 {
  readonly primary: string;
  readonly details: readonly string[];
  readonly reasons: readonly string[];
  readonly recovered: boolean;
  readonly originalQuery: string;
  readonly executedQuery: string;
}

export interface SearchResultCardV9 {
  readonly key: string;
  readonly sourceIndex: number;
  readonly datasetKey: string;
  readonly datasetRevision: number;
  readonly datasetFingerprint: string;
  readonly recordFingerprint: string;
  readonly recordId: string | null;
  readonly title: SearchResultTextV9;
  readonly subtitle: SearchResultTextV9 | null;
  readonly snippet: SearchResultTextV9 | null;
  readonly category: string;
  readonly type: string;
  readonly district: string;
  readonly neighborhood: string;
  readonly street: string;
  readonly address: string;
  readonly hasCoordinates: boolean;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly score: number;
  readonly distanceMeters: number | null;
  readonly badges: readonly SearchResultBadgeV9[];
  readonly explanation: SearchResultExplanationV9;
  readonly fingerprint: string;
}

export interface SearchResultPresentationPolicyV9 {
  readonly maxCards?: number;
  readonly maxQueryTerms?: number;
  readonly maxHighlightsPerField?: number;
  readonly maxBadgesPerCard?: number;
  readonly maxExplanationDetails?: number;
  readonly maxTitleLength?: number;
  readonly maxSubtitleLength?: number;
  readonly maxSnippetLength?: number;
  readonly includeScoreBadge?: boolean;
  readonly includeDistanceBadge?: boolean;
  readonly includeRecoveryBadge?: boolean;
}

export interface SearchResultPresentationSnapshotV9 {
  readonly version: typeof SEARCH_RESULT_PRESENTATION_VERSION_V9;
  readonly cardsBuilt: number;
  readonly truncatedCards: number;
  readonly highlightedFields: number;
  readonly highlightRanges: number;
  readonly recoveryCards: number;
  readonly fingerprint: string;
}

interface Policy {
  readonly maxCards: number;
  readonly maxQueryTerms: number;
  readonly maxHighlightsPerField: number;
  readonly maxBadgesPerCard: number;
  readonly maxExplanationDetails: number;
  readonly maxTitleLength: number;
  readonly maxSubtitleLength: number;
  readonly maxSnippetLength: number;
  readonly includeScoreBadge: boolean;
  readonly includeDistanceBadge: boolean;
  readonly includeRecoveryBadge: boolean;
}

interface Stats {
  cardsBuilt: number;
  truncatedCards: number;
  highlightedFields: number;
  highlightRanges: number;
  recoveryCards: number;
}

interface FoldedText {
  readonly folded: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

const policyFor = (policy: SearchResultPresentationPolicyV9 = {}): Policy => Object.freeze({
  maxCards: normalizeInteger(policy.maxCards, { min: 1, max: 2_000, fallback: 250 }),
  maxQueryTerms: normalizeInteger(policy.maxQueryTerms, { min: 1, max: 64, fallback: 16 }),
  maxHighlightsPerField: normalizeInteger(policy.maxHighlightsPerField, { min: 0, max: 128, fallback: 16 }),
  maxBadgesPerCard: normalizeInteger(policy.maxBadgesPerCard, { min: 0, max: 24, fallback: 8 }),
  maxExplanationDetails: normalizeInteger(policy.maxExplanationDetails, { min: 0, max: 24, fallback: 8 }),
  maxTitleLength: normalizeInteger(policy.maxTitleLength, { min: 16, max: 1_000, fallback: 180 }),
  maxSubtitleLength: normalizeInteger(policy.maxSubtitleLength, { min: 16, max: 2_000, fallback: 260 }),
  maxSnippetLength: normalizeInteger(policy.maxSnippetLength, { min: 32, max: 4_000, fallback: 360 }),
  includeScoreBadge: policy.includeScoreBadge !== false,
  includeDistanceBadge: policy.includeDistanceBadge !== false,
  includeRecoveryBadge: policy.includeRecoveryBadge !== false,
});

const boundText = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
};

const termsFor = (
  request: SearchRequest,
  recovery: SearchRecoveryResultV8,
  maximum: number,
): readonly string[] => {
  const values = [...tokenizeSearchText(request.query), ...tokenizeSearchText(recovery.diagnostics.executedQuery)];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const term = normalizeSearchText(value);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    output.push(term);
    if (output.length >= maximum) break;
  }
  return Object.freeze(output);
};

const fold = (value: string): FoldedText => {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    const start = offset;
    offset += character.length;
    const normalized = normalizeSearchText(character);
    if (!normalized) continue;
    for (const output of normalized) {
      folded += output;
      starts.push(start);
      ends.push(offset);
    }
  }
  return Object.freeze({ folded, starts: Object.freeze(starts), ends: Object.freeze(ends) });
};

const mergeRanges = (
  ranges: readonly SearchHighlightRangeV9[],
  maximum: number,
): readonly SearchHighlightRangeV9[] => {
  if (maximum <= 0) return Object.freeze([]);
  const ordered = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end || a.term.localeCompare(b.term, 'en'));
  const merged: SearchHighlightRangeV9[] = [];
  for (const range of ordered) {
    if (merged.length >= maximum) break;
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = Object.freeze({
        start: previous.start,
        end: Math.max(previous.end, range.end),
        term: previous.term.length >= range.term.length ? previous.term : range.term,
      });
    } else merged.push(Object.freeze({ ...range }));
  }
  return Object.freeze(merged);
};

export const createSearchHighlightRangesV9 = (
  valueInput: unknown,
  termsInput: readonly string[],
  maximum = 16,
): readonly SearchHighlightRangeV9[] => {
  const value = normalizeText(valueInput);
  if (!value || maximum <= 0) return Object.freeze([]);
  const folded = fold(value);
  if (!folded.folded) return Object.freeze([]);
  const terms = Array.from(new Set(termsInput.map(value => normalizeSearchText(value)).filter(Boolean)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b, 'en'));
  const ranges: SearchHighlightRangeV9[] = [];
  for (const term of terms) {
    let cursor = 0;
    while (cursor < folded.folded.length && ranges.length < maximum * 4) {
      const index = folded.folded.indexOf(term, cursor);
      if (index < 0) break;
      const last = index + term.length - 1;
      const start = folded.starts[index];
      const end = folded.ends[last];
      if (start !== undefined && end !== undefined && end > start) ranges.push(Object.freeze({ start, end, term }));
      cursor = index + Math.max(1, term.length);
    }
    if (ranges.length >= maximum * 4) break;
  }
  return mergeRanges(ranges, maximum);
};

const textModel = (
  value: string,
  maxLength: number,
  terms: readonly string[],
  maxHighlights: number,
  stats: Stats,
): SearchResultTextV9 => {
  const bounded = boundText(value, maxLength);
  const highlights = createSearchHighlightRangesV9(bounded, terms, maxHighlights);
  if (highlights.length) stats.highlightedFields += 1;
  stats.highlightRanges += highlights.length;
  return Object.freeze({ value: bounded, highlights });
};

const subtitle = (record: NormalizedRecord): string => Array.from(new Set(
  [record.category, record.type, record.district, record.neighborhood].map(value => normalizeText(value)).filter(Boolean),
)).slice(0, 4).join(' · ');

const snippet = (record: NormalizedRecord): string => Array.from(new Set(
  [record.address, record.street, record.neighborhood, record.district, record.postalCode].map(value => normalizeText(value)).filter(Boolean),
)).slice(0, 5).join(', ');

const distanceLabel = (meters: number): string => {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1_000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1_000).toFixed(1)} km`;
  return `${Math.round(meters / 1_000)} km`;
};

const scoreLabel = (score: number): string => {
  if (score >= 900) return 'Çok güçlü eşleşme';
  if (score >= 700) return 'Güçlü eşleşme';
  if (score >= 400) return 'İlgili eşleşme';
  return score > 0 ? 'Olası eşleşme' : '';
};

const addBadge = (
  badges: SearchResultBadgeV9[],
  max: number,
  kind: SearchResultBadgeKindV9,
  valueInput: unknown,
  labelInput?: string,
): void => {
  if (badges.length >= max) return;
  const value = normalizeText(valueInput);
  if (!value || badges.some(item => item.kind === kind && item.value === value)) return;
  badges.push(Object.freeze({ kind, value, label: normalizeText(labelInput) || value }));
};

const badgesFor = (hit: SearchHit, recovery: SearchRecoveryResultV8, policy: Policy): readonly SearchResultBadgeV9[] => {
  const badges: SearchResultBadgeV9[] = [];
  const record = hit.record;
  addBadge(badges, policy.maxBadgesPerCard, 'category', record.category);
  addBadge(badges, policy.maxBadgesPerCard, 'type', record.type);
  addBadge(badges, policy.maxBadgesPerCard, 'district', record.district);
  addBadge(badges, policy.maxBadgesPerCard, 'neighborhood', record.neighborhood);
  if (policy.includeDistanceBadge && hit.distanceMeters !== null) addBadge(badges, policy.maxBadgesPerCard, 'distance', distanceLabel(hit.distanceMeters));
  if (policy.includeScoreBadge && scoreLabel(hit.score)) addBadge(badges, policy.maxBadgesPerCard, 'score', String(hit.score), scoreLabel(hit.score));
  if (policy.includeRecoveryBadge && recovery.diagnostics.recovered) addBadge(badges, policy.maxBadgesPerCard, 'recovery', recovery.diagnostics.mode, 'Yazım veya sorgu kurtarmasıyla bulundu');
  if (hit.reasons.includes('address') || hit.reasons.includes('address-semantics-v4')) addBadge(badges, policy.maxBadgesPerCard, 'address', 'address', 'Adres eşleşmesi');
  if (hit.reasons.includes('spatial') || hit.reasons.includes('spatial-index')) addBadge(badges, policy.maxBadgesPerCard, 'spatial', 'spatial', 'Konumsal eşleşme');
  return Object.freeze(badges);
};

const explanationFor = (hit: SearchHit, recovery: SearchRecoveryResultV8, policy: Policy): SearchResultExplanationV9 => {
  const details: string[] = [];
  if (hit.reasons.includes('text') || hit.reasons.includes('text-relevance-v6')) details.push('Arama metniyle eşleşiyor.');
  if (hit.reasons.includes('address') || hit.reasons.includes('address-semantics-v4')) details.push('Adres alanlarıyla eşleşiyor.');
  if (hit.reasons.includes('spatial') || hit.reasons.includes('spatial-index')) details.push(hit.distanceMeters === null ? 'Konumsal filtreyi karşılıyor.' : `Arama merkezine yaklaşık ${distanceLabel(hit.distanceMeters)} uzaklıkta.`);
  if (recovery.diagnostics.recovered) details.push(`Orijinal sorgu yerine “${recovery.diagnostics.executedQuery}” varyantı daha iyi sonuç verdi.`);
  const bounded = Object.freeze(details.slice(0, policy.maxExplanationDetails));
  return Object.freeze({
    primary: bounded[0] ?? scoreLabel(hit.score) || 'Arama koşullarını karşılıyor.',
    details: bounded,
    reasons: Object.freeze([...hit.reasons].slice(0, policy.maxExplanationDetails)),
    recovered: recovery.diagnostics.recovered,
    originalQuery: recovery.diagnostics.originalQuery,
    executedQuery: recovery.diagnostics.executedQuery,
  });
};

const keyFor = (recovery: SearchRecoveryResultV8, hit: SearchHit): string => hashFingerprint(stableSerialize({
  version: SEARCH_RESULT_PRESENTATION_VERSION_V9,
  datasetKey: recovery.diagnostics.datasetKey,
  revision: recovery.diagnostics.datasetRevision,
  datasetFingerprint: recovery.diagnostics.datasetFingerprint,
  recordFingerprint: hit.record.fingerprint,
  sourceIndex: hit.record.sourceIndex,
}));

export class SearchResultPresentationRuntimeV9 {
  readonly #policy: Policy;
  readonly #stats: Stats = { cardsBuilt: 0, truncatedCards: 0, highlightedFields: 0, highlightRanges: 0, recoveryCards: 0 };

  constructor(policy: SearchResultPresentationPolicyV9 = {}) {
    this.#policy = policyFor(policy);
  }

  cards(request: SearchRequest, recovery: SearchRecoveryResultV8): readonly SearchResultCardV9[] {
    const terms = termsFor(request, recovery, this.#policy.maxQueryTerms);
    const hits = recovery.response.results;
    if (hits.length > this.#policy.maxCards) this.#stats.truncatedCards += hits.length - this.#policy.maxCards;
    const cards: SearchResultCardV9[] = [];
    for (const hit of hits.slice(0, this.#policy.maxCards)) {
      const record = hit.record;
      const subtitleValue = subtitle(record);
      const snippetValue = snippet(record);
      const key = keyFor(recovery, hit);
      const title = textModel(record.title || record.address || record.street || record.id || 'Adsız kayıt', this.#policy.maxTitleLength, terms, this.#policy.maxHighlightsPerField, this.#stats);
      const subtitleModel = subtitleValue ? textModel(subtitleValue, this.#policy.maxSubtitleLength, terms, this.#policy.maxHighlightsPerField, this.#stats) : null;
      const snippetModel = snippetValue ? textModel(snippetValue, this.#policy.maxSnippetLength, terms, this.#policy.maxHighlightsPerField, this.#stats) : null;
      const badges = badgesFor(hit, recovery, this.#policy);
      const explanation = explanationFor(hit, recovery, this.#policy);
      if (explanation.recovered) this.#stats.recoveryCards += 1;
      const base = {
        key,
        sourceIndex: record.sourceIndex,
        datasetKey: recovery.diagnostics.datasetKey,
        datasetRevision: recovery.diagnostics.datasetRevision,
        datasetFingerprint: recovery.diagnostics.datasetFingerprint,
        recordFingerprint: record.fingerprint,
        recordId: record.id,
        title,
        subtitle: subtitleModel,
        snippet: snippetModel,
        category: record.category,
        type: record.type,
        district: record.district,
        neighborhood: record.neighborhood,
        street: record.street,
        address: record.address,
        hasCoordinates: record.coordinates !== null,
        latitude: record.coordinates?.latitude ?? null,
        longitude: record.coordinates?.longitude ?? null,
        score: hit.score,
        distanceMeters: hit.distanceMeters,
        badges,
        explanation,
      } as const;
      cards.push(Object.freeze({
        ...base,
        fingerprint: hashFingerprint(stableSerialize({
          key,
          title: title.value,
          subtitle: subtitleModel?.value ?? '',
          snippet: snippetModel?.value ?? '',
          score: hit.score,
          distanceMeters: hit.distanceMeters,
          badges: badges.map(item => [item.kind, item.value]),
          explanation: explanation.details,
        })),
      }));
      this.#stats.cardsBuilt += 1;
    }
    return Object.freeze(cards);
  }

  snapshot(): SearchResultPresentationSnapshotV9 {
    return Object.freeze({
      version: SEARCH_RESULT_PRESENTATION_VERSION_V9,
      ...this.#stats,
      fingerprint: hashFingerprint(stableSerialize({ version: SEARCH_RESULT_PRESENTATION_VERSION_V9, policy: this.#policy, stats: this.#stats })),
    });
  }
}

export const createSearchResultPresentationRuntimeV9 = (policy: SearchResultPresentationPolicyV9 = {}): SearchResultPresentationRuntimeV9 =>
  new SearchResultPresentationRuntimeV9(policy);
