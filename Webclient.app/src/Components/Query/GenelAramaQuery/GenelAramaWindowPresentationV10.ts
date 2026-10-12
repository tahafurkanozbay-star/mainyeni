import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from '../../../data-search/normalization';
import type { NormalizedSearchRecord } from '../_Common/QuerySearchRuntime';
import {
  GENERAL_SEARCH_FACET_LABELS_V10,
  GENERAL_SEARCH_SORT_MODES_V10,
  type GeneralSearchFacetBucketV10,
  type GeneralSearchFacetKindV10,
  type GeneralSearchFacetModelV10,
  type GeneralSearchGuidanceV10,
  type GeneralSearchHighlightSegmentV10,
  type GeneralSearchInternalRecordV10,
  type GeneralSearchKeyboardDecisionV10,
  type GeneralSearchMoveCommandV10,
  type GeneralSearchNormalizedPolicyV10,
  type GeneralSearchPresentedRecordV10,
  type GeneralSearchRenderWindowV10,
  type GeneralSearchSortModeV10,
  type GeneralSearchWindowPolicyV10,
} from './GenelAramaWindowContractsV10';

const TURKISH_LOCALE = 'tr-TR';

const DEFAULT_POLICY: GeneralSearchNormalizedPolicyV10 = Object.freeze({
  maxRecords: 50_000,
  maxRefinementLength: 160,
  maxFacetBuckets: 18,
  maxSelectedFacets: 12,
  renderWindowSize: 36,
  renderOverscan: 6,
  keyboardPageSize: 8,
  maxHighlightSegments: 32,
  maxAnnouncementLength: 220,
});

const clampInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number => normalizeInteger(value, { min: minimum, max: maximum, fallback });

export const normalizeGeneralSearchWindowPolicyV10 = (
  policy: GeneralSearchWindowPolicyV10 = {},
): GeneralSearchNormalizedPolicyV10 => {
  const renderWindowSize = clampInteger(
    policy.renderWindowSize,
    8,
    200,
    DEFAULT_POLICY.renderWindowSize,
  );
  return Object.freeze({
    maxRecords: clampInteger(policy.maxRecords, 1, 250_000, DEFAULT_POLICY.maxRecords),
    maxRefinementLength: clampInteger(
      policy.maxRefinementLength,
      16,
      1_000,
      DEFAULT_POLICY.maxRefinementLength,
    ),
    maxFacetBuckets: clampInteger(
      policy.maxFacetBuckets,
      1,
      100,
      DEFAULT_POLICY.maxFacetBuckets,
    ),
    maxSelectedFacets: clampInteger(
      policy.maxSelectedFacets,
      1,
      50,
      DEFAULT_POLICY.maxSelectedFacets,
    ),
    renderWindowSize,
    renderOverscan: clampInteger(
      policy.renderOverscan,
      0,
      renderWindowSize,
      Math.min(DEFAULT_POLICY.renderOverscan, renderWindowSize),
    ),
    keyboardPageSize: clampInteger(
      policy.keyboardPageSize,
      1,
      renderWindowSize,
      Math.min(DEFAULT_POLICY.keyboardPageSize, renderWindowSize),
    ),
    maxHighlightSegments: clampInteger(
      policy.maxHighlightSegments,
      4,
      128,
      DEFAULT_POLICY.maxHighlightSegments,
    ),
    maxAnnouncementLength: clampInteger(
      policy.maxAnnouncementLength,
      80,
      500,
      DEFAULT_POLICY.maxAnnouncementLength,
    ),
  });
};

export const normalizeGeneralSearchRefinementV10 = (
  value: unknown,
  policy: GeneralSearchNormalizedPolicyV10,
): string => normalizeText(value).slice(0, policy.maxRefinementLength);

export const normalizeGeneralSearchSortModeV10 = (
  value: unknown,
): GeneralSearchSortModeV10 => {
  const normalized = normalizeSearchText(value);
  return GENERAL_SEARCH_SORT_MODES_V10.includes(normalized as GeneralSearchSortModeV10)
    ? normalized as GeneralSearchSortModeV10
    : 'relevance';
};

export const normalizeGeneralSearchFacetValueV10 = (value: unknown): string =>
  normalizeSearchText(value).slice(0, 160);

const identityFor = (
  record: NormalizedSearchRecord,
  sourceIndex: number,
  seen: Map<string, number>,
): string => {
  const base = normalizeText(record.key) || `record:${sourceIndex}`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}#${count + 1}`;
};

const normalizedSearchableText = (record: NormalizedSearchRecord): string =>
  normalizeSearchText([
    record.title,
    record.address,
    record.phone,
    record.category,
    record.type,
  ].filter(Boolean).join(' '));

export interface GeneralSearchPreparedRecordsV10 {
  readonly records: readonly GeneralSearchInternalRecordV10[];
  readonly sourceCount: number;
  readonly duplicateIdentities: number;
  readonly invalidRecords: number;
  readonly resultLimitReached: boolean;
  readonly fingerprint: string;
}

export const prepareGeneralSearchRecordsV10 = (
  records: readonly NormalizedSearchRecord[] | null | undefined,
  policy: GeneralSearchNormalizedPolicyV10,
): GeneralSearchPreparedRecordsV10 => {
  const source = Array.isArray(records) ? records : [];
  const retained = source.slice(0, policy.maxRecords);
  const seen = new Map<string, number>();
  const output: GeneralSearchInternalRecordV10[] = [];
  let duplicateIdentities = 0;
  let invalidRecords = 0;

  for (let sourceIndex = 0; sourceIndex < retained.length; sourceIndex += 1) {
    const record = retained[sourceIndex];
    if (!record || typeof record !== 'object') {
      invalidRecords += 1;
      continue;
    }
    const previousCount = seen.get(normalizeText(record.key) || `record:${sourceIndex}`) ?? 0;
    const identity = identityFor(record, sourceIndex, seen);
    if (previousCount > 0) duplicateIdentities += 1;
    const title = normalizeText(record.title) || 'İsimsiz kayıt';
    const address = normalizeText(record.address);
    const category = normalizeText(record.category) || 'Diğer';
    const type = normalizeText(record.type);
    output.push(Object.freeze({
      identity,
      sourceIndex,
      record,
      title,
      address,
      category,
      type,
      normalizedTitle: normalizeSearchText(title),
      normalizedAddress: normalizeSearchText(address),
      normalizedCategory: normalizeSearchText(category),
      normalizedType: normalizeSearchText(type),
      normalizedPhone: normalizeSearchText(record.phone),
      normalizedSearchableText: normalizedSearchableText(record),
    }));
  }

  const fingerprint = hashFingerprint(stableSerialize(output.map(item => [
    item.identity,
    item.sourceIndex,
    item.normalizedTitle,
    item.normalizedAddress,
    item.normalizedCategory,
    item.normalizedType,
    item.normalizedPhone,
  ])));

  return Object.freeze({
    records: Object.freeze(output),
    sourceCount: source.length,
    duplicateIdentities,
    invalidRecords,
    resultLimitReached: source.length > policy.maxRecords,
    fingerprint,
  });
};

const queryTerms = (refinement: string): readonly string[] => Object.freeze(
  Array.from(new Set(
    normalizeSearchText(refinement)
      .split(/\s+/u)
      .map(item => item.trim())
      .filter(Boolean),
  )).slice(0, 16),
);

const includesEveryTerm = (
  searchableText: string,
  terms: readonly string[],
): boolean => terms.every(term => searchableText.includes(term));

const selectedFacetMatch = (
  record: GeneralSearchInternalRecordV10,
  selectedCategories: ReadonlySet<string>,
  selectedTypes: ReadonlySet<string>,
): boolean => {
  if (selectedCategories.size > 0 && !selectedCategories.has(record.normalizedCategory)) return false;
  if (selectedTypes.size > 0 && !selectedTypes.has(record.normalizedType)) return false;
  return true;
};

export const filterGeneralSearchRecordsV10 = (
  records: readonly GeneralSearchInternalRecordV10[],
  refinement: string,
  selectedCategories: ReadonlySet<string>,
  selectedTypes: ReadonlySet<string>,
): readonly GeneralSearchInternalRecordV10[] => {
  const terms = queryTerms(refinement);
  const output: GeneralSearchInternalRecordV10[] = [];
  for (const record of records) {
    if (!selectedFacetMatch(record, selectedCategories, selectedTypes)) continue;
    if (terms.length > 0 && !includesEveryTerm(record.normalizedSearchableText, terms)) continue;
    output.push(record);
  }
  return Object.freeze(output);
};

const exactFieldScore = (
  field: string,
  normalizedRefinement: string,
  terms: readonly string[],
  weight: number,
): number => {
  if (!normalizedRefinement || !field) return 0;
  let score = 0;
  if (field === normalizedRefinement) score += 180 * weight;
  else if (field.startsWith(normalizedRefinement)) score += 120 * weight;
  else if (field.includes(normalizedRefinement)) score += 70 * weight;
  for (const term of terms) {
    if (field === term) score += 45 * weight;
    else if (field.startsWith(term)) score += 30 * weight;
    else if (field.includes(term)) score += 15 * weight;
  }
  return score;
};

export const scoreGeneralSearchRecordV10 = (
  record: GeneralSearchInternalRecordV10,
  refinement: string,
): number => {
  const normalizedRefinement = normalizeSearchText(refinement);
  if (!normalizedRefinement) return 0;
  const terms = queryTerms(refinement);
  let score = 0;
  score += exactFieldScore(record.normalizedTitle, normalizedRefinement, terms, 6);
  score += exactFieldScore(record.normalizedAddress, normalizedRefinement, terms, 4);
  score += exactFieldScore(record.normalizedCategory, normalizedRefinement, terms, 3);
  score += exactFieldScore(record.normalizedType, normalizedRefinement, terms, 2);
  score += exactFieldScore(record.normalizedPhone, normalizedRefinement, terms, 1);
  if (includesEveryTerm(record.normalizedSearchableText, terms)) score += terms.length * 25;
  return score;
};

const compareTurkish = (left: string, right: string): number =>
  left.localeCompare(right, TURKISH_LOCALE, { sensitivity: 'base', numeric: true });

const compareSource = (
  left: GeneralSearchInternalRecordV10,
  right: GeneralSearchInternalRecordV10,
): number => left.sourceIndex - right.sourceIndex;

export const sortGeneralSearchRecordsV10 = (
  records: readonly GeneralSearchInternalRecordV10[],
  refinement: string,
  sortMode: GeneralSearchSortModeV10,
): readonly GeneralSearchInternalRecordV10[] => {
  const output = [...records];
  output.sort((left, right) => {
    if (sortMode === 'source-order') return compareSource(left, right);
    if (sortMode === 'title') {
      return compareTurkish(left.title, right.title)
        || compareTurkish(left.address, right.address)
        || compareSource(left, right);
    }
    if (sortMode === 'category') {
      return compareTurkish(left.category, right.category)
        || compareTurkish(left.title, right.title)
        || compareSource(left, right);
    }
    if (sortMode === 'address') {
      return compareTurkish(left.address || '\uffff', right.address || '\uffff')
        || compareTurkish(left.title, right.title)
        || compareSource(left, right);
    }
    const scoreDelta = scoreGeneralSearchRecordV10(right, refinement)
      - scoreGeneralSearchRecordV10(left, refinement);
    if (scoreDelta !== 0) return scoreDelta;
    return compareSource(left, right)
      || compareTurkish(left.title, right.title)
      || left.identity.localeCompare(right.identity, 'en');
  });
  return Object.freeze(output);
};

const countFacetValues = (
  records: readonly GeneralSearchInternalRecordV10[],
  kind: GeneralSearchFacetKindV10,
): Map<string, { display: string; count: number }> => {
  const output = new Map<string, { display: string; count: number }>();
  for (const record of records) {
    const display = kind === 'category' ? record.category : record.type;
    const normalizedValue = kind === 'category' ? record.normalizedCategory : record.normalizedType;
    if (!normalizedValue) continue;
    const previous = output.get(normalizedValue);
    output.set(normalizedValue, {
      display: previous?.display ?? display,
      count: (previous?.count ?? 0) + 1,
    });
  }
  return output;
};

const facetBaseRecords = (
  records: readonly GeneralSearchInternalRecordV10[],
  refinement: string,
  kind: GeneralSearchFacetKindV10,
  selectedCategories: ReadonlySet<string>,
  selectedTypes: ReadonlySet<string>,
): readonly GeneralSearchInternalRecordV10[] => {
  const terms = queryTerms(refinement);
  const output: GeneralSearchInternalRecordV10[] = [];
  for (const record of records) {
    if (terms.length > 0 && !includesEveryTerm(record.normalizedSearchableText, terms)) continue;
    if (kind !== 'category'
      && selectedCategories.size > 0
      && !selectedCategories.has(record.normalizedCategory)) continue;
    if (kind !== 'type'
      && selectedTypes.size > 0
      && !selectedTypes.has(record.normalizedType)) continue;
    output.push(record);
  }
  return Object.freeze(output);
};

export const createGeneralSearchFacetModelV10 = (
  records: readonly GeneralSearchInternalRecordV10[],
  refinement: string,
  kind: GeneralSearchFacetKindV10,
  selectedCategories: ReadonlySet<string>,
  selectedTypes: ReadonlySet<string>,
  policy: GeneralSearchNormalizedPolicyV10,
): GeneralSearchFacetModelV10 => {
  const base = facetBaseRecords(records, refinement, kind, selectedCategories, selectedTypes);
  const counts = countFacetValues(base, kind);
  const selected = kind === 'category' ? selectedCategories : selectedTypes;
  const buckets: GeneralSearchFacetBucketV10[] = Array.from(counts.entries())
    .map(([normalizedValue, value]) => Object.freeze({
      kind,
      value: value.display,
      normalizedValue,
      count: value.count,
      selected: selected.has(normalizedValue),
      disabled: value.count === 0,
    }))
    .sort((left, right) => Number(right.selected) - Number(left.selected)
      || right.count - left.count
      || compareTurkish(left.value, right.value));
  return Object.freeze({
    kind,
    label: GENERAL_SEARCH_FACET_LABELS_V10[kind],
    buckets: Object.freeze(buckets.slice(0, policy.maxFacetBuckets)),
    totalBuckets: buckets.length,
    truncated: buckets.length > policy.maxFacetBuckets,
  });
};

export const createGeneralSearchFacetsV10 = (
  records: readonly GeneralSearchInternalRecordV10[],
  refinement: string,
  selectedCategories: ReadonlySet<string>,
  selectedTypes: ReadonlySet<string>,
  policy: GeneralSearchNormalizedPolicyV10,
): readonly GeneralSearchFacetModelV10[] => Object.freeze([
  createGeneralSearchFacetModelV10(
    records,
    refinement,
    'category',
    selectedCategories,
    selectedTypes,
    policy,
  ),
  createGeneralSearchFacetModelV10(
    records,
    refinement,
    'type',
    selectedCategories,
    selectedTypes,
    policy,
  ),
]);

const normalizedForHighlight = (value: string): string => normalizeSearchText(value);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export const highlightGeneralSearchTextV10 = (
  valueInput: unknown,
  refinementInput: unknown,
  maxSegments = DEFAULT_POLICY.maxHighlightSegments,
): readonly GeneralSearchHighlightSegmentV10[] => {
  const value = normalizeText(valueInput);
  const refinement = normalizeText(refinementInput);
  if (!value) return Object.freeze([]);
  if (!refinement) return Object.freeze([Object.freeze({ text: value, matched: false })]);
  const normalizedValue = normalizedForHighlight(value);
  const normalizedTerms = Array.from(new Set(
    normalizedForHighlight(refinement)
      .split(/\s+/u)
      .map(item => item.trim())
      .filter(item => item.length >= 1),
  )).sort((left, right) => right.length - left.length);
  if (normalizedTerms.length === 0) {
    return Object.freeze([Object.freeze({ text: value, matched: false })]);
  }

  const matcher = new RegExp(normalizedTerms.map(escapeRegExp).join('|'), 'gu');
  const ranges: Array<readonly [number, number]> = [];
  for (const match of normalizedValue.matchAll(matcher)) {
    const index = match.index;
    const text = match[0];
    if (index === undefined || !text) continue;
    ranges.push([index, Math.min(value.length, index + text.length)]);
    if (ranges.length >= maxSegments * 2) break;
  }
  if (ranges.length === 0) {
    return Object.freeze([Object.freeze({ text: value, matched: false })]);
  }

  const segments: GeneralSearchHighlightSegmentV10[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (segments.length >= maxSegments) break;
    if (start > cursor) {
      segments.push(Object.freeze({ text: value.slice(cursor, start), matched: false }));
    }
    if (segments.length >= maxSegments) break;
    segments.push(Object.freeze({ text: value.slice(start, end), matched: true }));
    cursor = end;
  }
  if (cursor < value.length && segments.length < maxSegments) {
    segments.push(Object.freeze({ text: value.slice(cursor), matched: false }));
  }
  return Object.freeze(segments);
};

export const createGeneralSearchPresentedRecordsV10 = (
  records: readonly GeneralSearchInternalRecordV10[],
  refinement: string,
  activeIdentity: string | null,
  policy: GeneralSearchNormalizedPolicyV10,
): readonly GeneralSearchPresentedRecordV10[] => Object.freeze(records.map(record => Object.freeze({
  identity: record.identity,
  sourceIndex: record.sourceIndex,
  record: record.record,
  normalizedTitle: record.normalizedTitle,
  normalizedAddress: record.normalizedAddress,
  normalizedCategory: record.normalizedCategory,
  normalizedType: record.normalizedType,
  searchableText: record.normalizedSearchableText,
  titleSegments: highlightGeneralSearchTextV10(
    record.title,
    refinement,
    policy.maxHighlightSegments,
  ),
  addressSegments: highlightGeneralSearchTextV10(
    record.address,
    refinement,
    policy.maxHighlightSegments,
  ),
  score: scoreGeneralSearchRecordV10(record, refinement),
  active: record.identity === activeIdentity,
})));

export const createGeneralSearchRenderWindowV10 = (
  totalMatchedInput: unknown,
  activeIndexInput: unknown,
  preferredStartInput: unknown,
  policy: GeneralSearchNormalizedPolicyV10,
): GeneralSearchRenderWindowV10 => {
  const totalMatched = clampInteger(totalMatchedInput, 0, Number.MAX_SAFE_INTEGER, 0);
  if (totalMatched === 0) {
    return Object.freeze({
      startIndex: 0,
      endIndexExclusive: 0,
      count: 0,
      totalMatched: 0,
      hasBefore: false,
      hasAfter: false,
    });
  }
  const windowSize = Math.min(totalMatched, policy.renderWindowSize);
  const maximumStart = Math.max(0, totalMatched - windowSize);
  const activeIndex = clampInteger(activeIndexInput, 0, totalMatched - 1, 0);
  const hasPreferredStart = preferredStartInput !== null && preferredStartInput !== undefined;
  const preferredStart = hasPreferredStart && Number.isFinite(Number(preferredStartInput))
    ? Math.min(maximumStart, Math.max(0, Math.trunc(Number(preferredStartInput))))
    : null;

  let startIndex = preferredStart ?? Math.max(0, activeIndex - Math.floor(windowSize / 2));
  startIndex = Math.min(maximumStart, startIndex);
  if (preferredStart === null) {
    const lowerSafe = startIndex + policy.renderOverscan;
    const upperSafe = startIndex + windowSize - policy.renderOverscan - 1;
    if (activeIndex < lowerSafe) {
      startIndex = Math.max(0, activeIndex - policy.renderOverscan);
    } else if (activeIndex > upperSafe) {
      startIndex = Math.min(maximumStart, activeIndex - windowSize + policy.renderOverscan + 1);
    }
  }
  const endIndexExclusive = Math.min(totalMatched, startIndex + windowSize);
  return Object.freeze({
    startIndex,
    endIndexExclusive,
    count: Math.max(0, endIndexExclusive - startIndex),
    totalMatched,
    hasBefore: startIndex > 0,
    hasAfter: endIndexExclusive < totalMatched,
  });
};

export const moveGeneralSearchIndexV10 = (
  currentIndex: number,
  count: number,
  command: GeneralSearchMoveCommandV10,
  policy: GeneralSearchNormalizedPolicyV10,
): number => {
  if (count <= 0) return -1;
  const current = currentIndex < 0 ? 0 : Math.min(count - 1, currentIndex);
  if (command === 'first') return 0;
  if (command === 'last') return count - 1;
  if (command === 'previous') return Math.max(0, current - 1);
  if (command === 'next') return Math.min(count - 1, current + 1);
  if (command === 'page-previous') return Math.max(0, current - policy.keyboardPageSize);
  return Math.min(count - 1, current + policy.keyboardPageSize);
};

export const keyboardDecisionForGeneralSearchV10 = (
  key: string,
): GeneralSearchKeyboardDecisionV10 => {
  if (key === 'ArrowUp') return Object.freeze({ handled: true, command: 'previous', preventDefault: true });
  if (key === 'ArrowDown') return Object.freeze({ handled: true, command: 'next', preventDefault: true });
  if (key === 'Home') return Object.freeze({ handled: true, command: 'first', preventDefault: true });
  if (key === 'End') return Object.freeze({ handled: true, command: 'last', preventDefault: true });
  if (key === 'PageUp') return Object.freeze({ handled: true, command: 'page-previous', preventDefault: true });
  if (key === 'PageDown') return Object.freeze({ handled: true, command: 'page-next', preventDefault: true });
  if (key === 'Enter' || key === ' ') return Object.freeze({ handled: true, command: 'activate', preventDefault: true });
  if (key === 'Escape') return Object.freeze({ handled: true, command: 'clear', preventDefault: false });
  return Object.freeze({ handled: false, command: null, preventDefault: false });
};

export const createGeneralSearchGuidanceV10 = (
  totalCount: number,
  matchedCount: number,
  refinement: string,
  selectedFacetCount: number,
  resultLimitReached: boolean,
): GeneralSearchGuidanceV10 => {
  if (resultLimitReached) {
    return Object.freeze({
      tone: 'warning',
      title: 'Sonuç kümesi güvenli sınırda tutuldu',
      detail: 'Çok büyük sonuç kümesinin yalnız güvenli üst sınırı işlendi. Daha belirgin bir arama ifadesi kullanın.',
      actionLabel: null,
    });
  }
  if (totalCount === 0) {
    return Object.freeze({
      tone: 'neutral',
      title: 'Sonuç bulunamadı',
      detail: 'Sunucu bu arama için kayıt döndürmedi. Arama ifadesini değiştirip yeniden deneyebilirsiniz.',
      actionLabel: null,
    });
  }
  if (matchedCount === 0 && (refinement || selectedFacetCount > 0)) {
    return Object.freeze({
      tone: 'info',
      title: 'Yerel filtrelerle eşleşen sonuç yok',
      detail: 'Arama sonucunuz geldi ancak seçtiğiniz daraltma ölçütleri eşleşme bırakmadı.',
      actionLabel: 'Filtreleri temizle',
    });
  }
  if (matchedCount < totalCount) {
    return Object.freeze({
      tone: 'success',
      title: 'Sonuçlar daraltıldı',
      detail: `${totalCount} sonuç içinden ${matchedCount} kayıt gösteriliyor.`,
      actionLabel: 'Filtreleri temizle',
    });
  }
  return Object.freeze({
    tone: 'neutral',
    title: 'Tüm sonuçlar gösteriliyor',
    detail: `${matchedCount} kayıt yerel sonuç görünümünde kullanılabilir.`,
    actionLabel: null,
  });
};

const truncateAnnouncement = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;

export const createGeneralSearchAnnouncementV10 = (
  totalCount: number,
  matchedCount: number,
  activeIndex: number,
  activeRecord: NormalizedSearchRecord | null,
  renderWindow: GeneralSearchRenderWindowV10,
  policy: GeneralSearchNormalizedPolicyV10,
): string => {
  const parts: string[] = [];
  if (matchedCount === totalCount) parts.push(`${matchedCount} sonuç kullanılabilir.`);
  else parts.push(`${totalCount} sonuçtan ${matchedCount} tanesi filtrelerle eşleşiyor.`);
  if (activeRecord && activeIndex >= 0) {
    parts.push(`${activeIndex + 1}. sonuç seçili: ${normalizeText(activeRecord.title) || 'İsimsiz kayıt'}.`);
  }
  if (renderWindow.count > 0 && (renderWindow.hasBefore || renderWindow.hasAfter)) {
    parts.push(`${renderWindow.startIndex + 1}-${renderWindow.endIndexExclusive} arası ekranda.`);
  }
  return truncateAnnouncement(parts.join(' '), policy.maxAnnouncementLength);
};

export const generalSearchPresentationFingerprintV10 = (value: unknown): string => {
  const fingerprint = hashFingerprint(stableSerialize(value));
  return fingerprint.startsWith('fnv1a-') ? fingerprint.slice('fnv1a-'.length) : fingerprint;
};
