import type { SearchRequest } from './contracts';
import {
  hashFingerprint,
  normalizeInteger,
  normalizeSearchText,
  normalizeText,
  stableSerialize,
} from './normalization';
import type { SearchRecoveryResultV8 } from './searchRecoveryRuntimeV8';
import type { SearchGroupingResultV9 } from './searchGroupingRuntimeV9';
import type { SearchResultCardV9 } from './searchResultPresentationRuntimeV9';

export const SEARCH_GUIDANCE_VERSION_V9 = 'search-guidance-v9' as const;

export type SearchGuidanceStatusV9 = 'idle' | 'success' | 'recovered' | 'partial' | 'empty' | 'blocked';
export type SearchGuidanceSeverityV9 = 'neutral' | 'success' | 'info' | 'warning' | 'error';
export type SearchGuidanceActionKindV9 =
  | 'use-executed-query'
  | 'use-original-query'
  | 'clear-filters'
  | 'clear-spatial'
  | 'clear-address-scope'
  | 'reset-query'
  | 'broaden-query'
  | 'show-all-results';

export interface SearchGuidanceActionV9 {
  readonly id: string;
  readonly kind: SearchGuidanceActionKindV9;
  readonly label: string;
  readonly description: string;
  readonly query: string | null;
  readonly clearFilters: boolean;
  readonly clearSpatial: boolean;
  readonly clearAddressScope: boolean;
  readonly resetOffset: boolean;
  readonly fingerprint: string;
}

export interface SearchGuidanceV9 {
  readonly version: typeof SEARCH_GUIDANCE_VERSION_V9;
  readonly status: SearchGuidanceStatusV9;
  readonly severity: SearchGuidanceSeverityV9;
  readonly headline: string;
  readonly message: string;
  readonly resultCountText: string;
  readonly announcement: string;
  readonly blockedReason: string | null;
  readonly recovered: boolean;
  readonly originalQuery: string;
  readonly executedQuery: string;
  readonly actions: readonly SearchGuidanceActionV9[];
  readonly fingerprint: string;
}

export interface SearchGuidancePolicyV9 {
  readonly maxActions?: number;
  readonly maxQueryLabelLength?: number;
  readonly lowResultThreshold?: number;
  readonly showClearFilterAction?: boolean;
  readonly showClearSpatialAction?: boolean;
  readonly showClearAddressAction?: boolean;
  readonly showQueryRecoveryAction?: boolean;
}

export interface SearchGuidanceSnapshotV9 {
  readonly version: typeof SEARCH_GUIDANCE_VERSION_V9;
  readonly evaluations: number;
  readonly success: number;
  readonly recovered: number;
  readonly partial: number;
  readonly empty: number;
  readonly blocked: number;
  readonly actionsBuilt: number;
  readonly fingerprint: string;
}

interface NormalizedPolicy {
  readonly maxActions: number;
  readonly maxQueryLabelLength: number;
  readonly lowResultThreshold: number;
  readonly showClearFilterAction: boolean;
  readonly showClearSpatialAction: boolean;
  readonly showClearAddressAction: boolean;
  readonly showQueryRecoveryAction: boolean;
}

interface MutableStats {
  evaluations: number;
  success: number;
  recovered: number;
  partial: number;
  empty: number;
  blocked: number;
  actionsBuilt: number;
}

const normalizePolicy = (policy: SearchGuidancePolicyV9 = {}): NormalizedPolicy => Object.freeze({
  maxActions: normalizeInteger(policy.maxActions, { min: 0, max: 12, fallback: 5 }),
  maxQueryLabelLength: normalizeInteger(policy.maxQueryLabelLength, { min: 8, max: 240, fallback: 96 }),
  lowResultThreshold: normalizeInteger(policy.lowResultThreshold, { min: 0, max: 1_000, fallback: 3 }),
  showClearFilterAction: policy.showClearFilterAction !== false,
  showClearSpatialAction: policy.showClearSpatialAction !== false,
  showClearAddressAction: policy.showClearAddressAction !== false,
  showQueryRecoveryAction: policy.showQueryRecoveryAction !== false,
});

const boundLabel = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
};

const resultText = (count: number): string => count === 1 ? '1 sonuç' : `${Math.max(0, count)} sonuç`;

const blockedCopy = (reason: unknown): string => {
  const value = normalizeSearchText(reason);
  if (value === 'invalid-explicit-center') return 'Konum bilgisi geçerli değil.';
  if (value === 'address-candidate-budget-exceeded') return 'Adres sorgusu güvenli aday sınırını aştı.';
  if (value === 'spatial-candidate-budget-exceeded') return 'Konumsal sorgu güvenli aday sınırını aştı.';
  if (value === 'text-execution-blocked') return 'Metin sorgusu güvenli yürütüm sınırını aştı.';
  if (value === 'result-window-offset-exceeded') return 'İstenen sonuç sayfası güvenli pencere sınırının dışında.';
  return 'Arama güvenlik veya iş yükü politikası nedeniyle yürütülemedi.';
};

const actionKey = (
  kind: SearchGuidanceActionKindV9,
  query: string | null,
  clearFilters: boolean,
  clearSpatial: boolean,
  clearAddressScope: boolean,
): string => hashFingerprint(stableSerialize({
  version: SEARCH_GUIDANCE_VERSION_V9,
  kind,
  query,
  clearFilters,
  clearSpatial,
  clearAddressScope,
}));

const action = (
  kind: SearchGuidanceActionKindV9,
  label: string,
  description: string,
  options: Readonly<{
    query?: string | null;
    clearFilters?: boolean;
    clearSpatial?: boolean;
    clearAddressScope?: boolean;
    resetOffset?: boolean;
  }> = {},
): SearchGuidanceActionV9 => {
  const query = options.query === undefined ? null : normalizeText(options.query);
  const clearFilters = options.clearFilters === true;
  const clearSpatial = options.clearSpatial === true;
  const clearAddressScope = options.clearAddressScope === true;
  const fingerprint = actionKey(kind, query, clearFilters, clearSpatial, clearAddressScope);
  return Object.freeze({
    id: `${kind}:${fingerprint}`,
    kind,
    label: normalizeText(label),
    description: normalizeText(description),
    query,
    clearFilters,
    clearSpatial,
    clearAddressScope,
    resetOffset: options.resetOffset !== false,
    fingerprint,
  });
};

const addAction = (
  actions: SearchGuidanceActionV9[],
  candidate: SearchGuidanceActionV9,
  maximum: number,
): void => {
  if (actions.length >= maximum || actions.some(item => item.fingerprint === candidate.fingerprint)) return;
  actions.push(candidate);
};

const hasFilters = (request: SearchRequest): boolean => Boolean(request.filters?.length);
const hasSpatial = (request: SearchRequest): boolean => Boolean(
  request.center || (Number.isFinite(Number(request.radiusMeters)) && Number(request.radiusMeters) > 0),
);
const hasAddress = (request: SearchRequest): boolean => Boolean(
  request.level || normalizeText(request.district) || normalizeText(request.neighborhood) || normalizeText(request.street),
);

const broaden = (value: unknown): string | null => {
  const tokens = normalizeText(value).split(/\s+/u).filter(Boolean);
  return tokens.length > 1 ? tokens.slice(0, -1).join(' ') || null : null;
};

const statusFor = (
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  grouping: SearchGroupingResultV9 | null,
  policy: NormalizedPolicy,
): Exclude<SearchGuidanceStatusV9, 'idle'> => {
  if (recovery.final.result.diagnostics.blocked) return 'blocked';
  if (cards.length === 0) return 'empty';
  if (recovery.diagnostics.recovered) return 'recovered';
  if (cards.length <= policy.lowResultThreshold || grouping?.truncated === true) return 'partial';
  return 'success';
};

const severityFor = (status: Exclude<SearchGuidanceStatusV9, 'idle'>): SearchGuidanceSeverityV9 => {
  if (status === 'success' || status === 'recovered') return 'success';
  if (status === 'partial') return 'info';
  if (status === 'empty') return 'warning';
  return 'error';
};

const actionsFor = (
  request: SearchRequest,
  recovery: SearchRecoveryResultV8,
  status: Exclude<SearchGuidanceStatusV9, 'idle'>,
  policy: NormalizedPolicy,
): readonly SearchGuidanceActionV9[] => {
  const actions: SearchGuidanceActionV9[] = [];
  const original = normalizeText(recovery.diagnostics.originalQuery);
  const executed = normalizeText(recovery.diagnostics.executedQuery);

  if (policy.showQueryRecoveryAction && recovery.diagnostics.recovered && executed && executed !== original) {
    addAction(actions, action(
      'use-executed-query',
      `“${boundLabel(executed, policy.maxQueryLabelLength)}” ile ara`,
      'Kurtarma sorgusunu arama kutusuna uygular.',
      { query: executed },
    ), policy.maxActions);
    if (original) addAction(actions, action(
      'use-original-query',
      `“${boundLabel(original, policy.maxQueryLabelLength)}” sorgusuna dön`,
      'İlk yazdığınız sorguyu yeniden kullanır.',
      { query: original },
    ), policy.maxActions);
  }

  const restrictive = status === 'empty' || status === 'blocked' || status === 'partial';
  if (restrictive && policy.showClearFilterAction && hasFilters(request)) addAction(actions, action(
    'clear-filters', 'Filtreleri temizle', 'Metin veya konum sorgusunu koruyup seçili filtreleri kaldırır.', { clearFilters: true },
  ), policy.maxActions);
  if (restrictive && policy.showClearSpatialAction && hasSpatial(request)) addAction(actions, action(
    'clear-spatial', 'Konum sınırını kaldır', 'Merkez ve yarıçap koşulunu kaldırarak daha geniş alanda arama önerir.', { clearSpatial: true },
  ), policy.maxActions);
  if (restrictive && policy.showClearAddressAction && hasAddress(request)) addAction(actions, action(
    'clear-address-scope', 'Adres kapsamını genişlet', 'İlçe, mahalle, sokak ve adres seviyesi kısıtlarını kaldırır.', { clearAddressScope: true },
  ), policy.maxActions);

  if (status === 'empty' || status === 'partial') {
    const broader = broaden(executed || original || request.query);
    if (broader) addAction(actions, action(
      'broaden-query',
      `Daha geniş ara: “${boundLabel(broader, policy.maxQueryLabelLength)}”`,
      'Son sorgu terimini kaldırarak daha geniş bir arama önerir.',
      { query: broader },
    ), policy.maxActions);
  }
  if (status === 'empty' || status === 'blocked') addAction(actions, action(
    'show-all-results',
    'Tüm sonuçları göster',
    'Sorgu, filtre, konum ve adres kapsamını temizleyerek veri kümesindeki sonuçları listeler.',
    { query: '', clearFilters: true, clearSpatial: true, clearAddressScope: true },
  ), policy.maxActions);
  if (normalizeText(request.query)) addAction(actions, action(
    'reset-query', 'Arama metnini temizle', 'Filtreleri koruyarak yalnız arama metnini temizler.', { query: '' },
  ), policy.maxActions);
  return Object.freeze(actions);
};

const copyFor = (
  status: Exclude<SearchGuidanceStatusV9, 'idle'>,
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  grouping: SearchGroupingResultV9 | null,
): Readonly<{ headline: string; message: string; resultCountText: string; announcement: string }> => {
  const countText = resultText(cards.length);
  if (status === 'blocked') {
    const reason = blockedCopy(recovery.final.result.diagnostics.blockReason);
    return Object.freeze({ headline: 'Arama güvenli biçimde durduruldu', message: reason, resultCountText: 'Sonuç gösterilmedi', announcement: `Arama durduruldu. ${reason}` });
  }
  if (status === 'empty') return Object.freeze({
    headline: 'Sonuç bulunamadı',
    message: 'Yazımı, filtreleri, adres kapsamını veya konum sınırını değiştirerek tekrar deneyebilirsiniz.',
    resultCountText: '0 sonuç',
    announcement: 'Arama tamamlandı. Sonuç bulunamadı.',
  });
  if (status === 'recovered') {
    const executed = normalizeText(recovery.diagnostics.executedQuery);
    const message = executed ? `Daha iyi sonuç için “${executed}” sorgusu kullanıldı.` : 'Daha iyi sonuç için güvenli kurtarma araması kullanıldı.';
    return Object.freeze({ headline: 'Sonuçlar iyileştirildi', message, resultCountText: countText, announcement: `Arama tamamlandı. ${countText} bulundu. ${message}` });
  }
  if (status === 'partial') {
    const suffix = grouping?.truncated === true ? ' Görünüm performans sınırı nedeniyle özetlenmiş olabilir.' : '';
    return Object.freeze({ headline: 'Sınırlı sayıda sonuç bulundu', message: `Aramanızı genişleterek daha fazla sonuç bulabilirsiniz.${suffix}`, resultCountText: countText, announcement: `Arama tamamlandı. ${countText} bulundu.` });
  }
  return Object.freeze({ headline: 'Arama sonuçları', message: 'En uygun sonuçlar hazır.', resultCountText: countText, announcement: `Arama tamamlandı. ${countText} bulundu.` });
};

const fingerprintFor = (
  status: SearchGuidanceStatusV9,
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  actions: readonly SearchGuidanceActionV9[],
): string => hashFingerprint(stableSerialize({
  version: SEARCH_GUIDANCE_VERSION_V9,
  status,
  requestFingerprint: recovery.diagnostics.requestFingerprint,
  datasetFingerprint: recovery.diagnostics.datasetFingerprint,
  cards: cards.map(card => card.key),
  actions: actions.map(item => item.fingerprint),
}));

export const applySearchGuidanceActionV9 = (
  request: SearchRequest,
  selected: SearchGuidanceActionV9,
): SearchRequest => Object.freeze({
  ...request,
  ...(selected.query === null ? {} : { query: selected.query }),
  ...(selected.clearFilters ? { filters: Object.freeze([]) } : {}),
  ...(selected.clearSpatial ? { center: null, radiusMeters: 0 } : {}),
  ...(selected.clearAddressScope ? { level: null, district: null, neighborhood: null, street: null } : {}),
  ...(selected.resetOffset ? { offset: 0 } : {}),
});

export class SearchGuidanceRuntimeV9 {
  readonly #policy: NormalizedPolicy;
  readonly #stats: MutableStats = { evaluations: 0, success: 0, recovered: 0, partial: 0, empty: 0, blocked: 0, actionsBuilt: 0 };

  constructor(policy: SearchGuidancePolicyV9 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  evaluate(
    request: SearchRequest,
    recovery: SearchRecoveryResultV8,
    cards: readonly SearchResultCardV9[],
    grouping: SearchGroupingResultV9 | null = null,
  ): SearchGuidanceV9 {
    const status = statusFor(recovery, cards, grouping, this.#policy);
    const actions = actionsFor(request, recovery, status, this.#policy);
    const copy = copyFor(status, recovery, cards, grouping);
    this.#stats.evaluations += 1;
    this.#stats[status] += 1;
    this.#stats.actionsBuilt += actions.length;
    const blockedReason = status === 'blocked' ? blockedCopy(recovery.final.result.diagnostics.blockReason) : null;
    return Object.freeze({
      version: SEARCH_GUIDANCE_VERSION_V9,
      status,
      severity: severityFor(status),
      headline: copy.headline,
      message: copy.message,
      resultCountText: copy.resultCountText,
      announcement: copy.announcement,
      blockedReason,
      recovered: recovery.diagnostics.recovered,
      originalQuery: recovery.diagnostics.originalQuery,
      executedQuery: recovery.diagnostics.executedQuery,
      actions,
      fingerprint: fingerprintFor(status, recovery, cards, actions),
    });
  }

  snapshot(): SearchGuidanceSnapshotV9 {
    return Object.freeze({
      version: SEARCH_GUIDANCE_VERSION_V9,
      ...this.#stats,
      fingerprint: hashFingerprint(stableSerialize({ version: SEARCH_GUIDANCE_VERSION_V9, policy: this.#policy, stats: this.#stats })),
    });
  }
}

export const createSearchGuidanceRuntimeV9 = (policy: SearchGuidancePolicyV9 = {}): SearchGuidanceRuntimeV9 =>
  new SearchGuidanceRuntimeV9(policy);
