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

export type SearchGuidanceStatusV9 =
  | 'idle'
  | 'success'
  | 'recovered'
  | 'partial'
  | 'empty'
  | 'blocked';

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

interface NormalizedGuidancePolicyV9 {
  readonly maxActions: number;
  readonly maxQueryLabelLength: number;
  readonly lowResultThreshold: number;
  readonly showClearFilterAction: boolean;
  readonly showClearSpatialAction: boolean;
  readonly showClearAddressAction: boolean;
  readonly showQueryRecoveryAction: boolean;
}

interface MutableGuidanceStatsV9 {
  evaluations: number;
  success: number;
  recovered: number;
  partial: number;
  empty: number;
  blocked: number;
  actionsBuilt: number;
}

const normalizePolicy = (
  policy: SearchGuidancePolicyV9 = {},
): NormalizedGuidancePolicyV9 => Object.freeze({
  maxActions: normalizeInteger(policy.maxActions, { min: 0, max: 12, fallback: 5 }),
  maxQueryLabelLength: normalizeInteger(policy.maxQueryLabelLength, { min: 8, max: 240, fallback: 96 }),
  lowResultThreshold: normalizeInteger(policy.lowResultThreshold, { min: 0, max: 1_000, fallback: 3 }),
  showClearFilterAction: policy.showClearFilterAction !== false,
  showClearSpatialAction: policy.showClearSpatialAction !== false,
  showClearAddressAction: policy.showClearAddressAction !== false,
  showQueryRecoveryAction: policy.showQueryRecoveryAction !== false,
});

const boundedQueryLabel = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
};

const pluralResults = (count: number): string => count === 1
  ? '1 sonuç'
  : `${Math.max(0, count)} sonuç`;

const blockReasonLabel = (reason: string | null | undefined): string => {
  const normalized = normalizeSearchText(reason);
  if (normalized === 'invalid-explicit-center') return 'Konum bilgisi geçerli değil.';
  if (normalized === 'address-candidate-budget-exceeded') return 'Adres sorgusu güvenli aday sınırını aştı.';
  if (normalized === 'spatial-candidate-budget-exceeded') return 'Konumsal sorgu güvenli aday sınırını aştı.';
  if (normalized === 'text-execution-blocked') return 'Metin sorgusu güvenli yürütüm sınırını aştı.';
  if (normalized === 'result-window-offset-exceeded') return 'İstenen sonuç sayfası güvenli pencere sınırının dışında.';
  if (normalized) return 'Arama güvenlik veya iş yükü politikası nedeniyle yürütülemedi.';
  return 'Arama güvenlik veya iş yükü politikası nedeniyle yürütülemedi.';
};

const actionFingerprint = (
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

const createAction = (
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
  return Object.freeze({
    id: `${kind}:${actionFingerprint(kind, query, clearFilters, clearSpatial, clearAddressScope)}`,
    kind,
    label: normalizeText(label),
    description: normalizeText(description),
    query,
    clearFilters,
    clearSpatial,
    clearAddressScope,
    resetOffset: options.resetOffset !== false,
    fingerprint: actionFingerprint(kind, query, clearFilters, clearSpatial, clearAddressScope),
  });
};

const hasFilters = (request: SearchRequest): boolean => Boolean(request.filters?.length);

const hasSpatialConstraint = (request: SearchRequest): boolean => Boolean(
  request.center
  || (Number.isFinite(Number(request.radiusMeters)) && Number(request.radiusMeters) > 0),
);

const hasAddressScope = (request: SearchRequest): boolean => Boolean(
  normalizeText(request.district)
  || normalizeText(request.neighborhood)
  || normalizeText(request.street)
  || request.level,
);

const addUniqueAction = (
  actions: SearchGuidanceActionV9[],
  action: SearchGuidanceActionV9,
  maximum: number,
): void => {
  if (actions.length >= maximum) return;
  if (actions.some(existing => existing.fingerprint === action.fingerprint)) return;
  actions.push(action);
};

const broadenedQuery = (queryInput: unknown): string | null => {
  const parts = normalizeText(queryInput).split(/\s+/u).filter(Boolean);
  if (parts.length <= 1) return null;
  const next = parts.slice(0, Math.max(1, parts.length - 1)).join(' ');
  return next || null;
};

const guidanceActions = (
  request: SearchRequest,
  recovery: SearchRecoveryResultV8,
  status: SearchGuidanceStatusV9,
  policy: NormalizedGuidancePolicyV9,
): readonly SearchGuidanceActionV9[] => {
  const actions: SearchGuidanceActionV9[] = [];
  const originalQuery = normalizeText(recovery.diagnostics.originalQuery);
  const executedQuery = normalizeText(recovery.diagnostics.executedQuery);

  if (policy.showQueryRecoveryAction && recovery.diagnostics.recovered && executedQuery && executedQuery !== originalQuery) {
    addUniqueAction(actions, createAction(
      'use-executed-query',
      `“${boundedQueryLabel(executedQuery, policy.maxQueryLabelLength)}” ile ara`,
      'Kurtarma sorgusunu arama kutusuna uygular.',
      { query: executedQuery },
    ), policy.maxActions);
    if (originalQuery) {
      addUniqueAction(actions, createAction(
        'use-original-query',
        `“${boundedQueryLabel(originalQuery, policy.maxQueryLabelLength)}” sorgusuna dön`,
        'İlk yazdığınız sorguyu yeniden kullanır.',
        { query: originalQuery },
      ), policy.maxActions);
    }
  }

  if ((status === 'empty' || status === 'blocked' || status === 'partial')
    && policy.showClearFilterAction
    && hasFilters(request)) {
    addUniqueAction(actions, createAction(
      'clear-filters',
      'Filtreleri temizle',
      'Metin veya konum sorgusunu koruyup seçili filtreleri kaldırır.',
      { clearFilters: true },
    ), policy.maxActions);
  }

  if ((status === 'empty' || status === 'blocked' || status === 'partial')
    && policy.showClearSpatialAction
    && hasSpatialConstraint(request)) {
    addUniqueAction(actions, createAction(
      'clear-spatial',
      'Konum sınırını kaldır',
      'Merkez ve yarıçap koşulunu kaldırarak daha geniş alanda arama önerir.',
      { clearSpatial: true },
    ), policy.maxActions);
  }

  if ((status === 'empty' || status === 'blocked' || status === 'partial')
    && policy.showClearAddressAction
    && hasAddressScope(request)) {
    addUniqueAction(actions, createAction(
      'clear-address-scope',
      'Adres kapsamını genişlet',
      'İlçe, mahalle, sokak ve adres seviyesi kısıtlarını kaldırır.',
      { clearAddressScope: true },
    ), policy.maxActions);
  }

  if (status === 'empty' || status === 'partial') {
    const broader = broadenedQuery(executedQuery || originalQuery || request.query);
    if (broader) {
      addUniqueAction(actions, createAction(
        'broaden-query',
        `Daha geniş ara: “${boundedQueryLabel(broader, policy.maxQueryLabelLength)}”`,
        'Son sorgu terimini kaldırarak daha geniş bir arama önerir.',
        { query: broader },
      ), policy.maxActions);
    }
  }

  if (status === 'empty' || status === 'blocked') {
    addUniqueAction(actions, createAction(
      'show-all-results',
      'Tüm sonuçları göster',
      'Sorgu, filtre, konum ve adres kapsamını temizleyerek veri kümesindeki sonuçları listeler.',
      {
        query: '',
        clearFilters: true,
        clearSpatial: true,
        clearAddressScope: true,
      },
    ), policy.maxActions);
  }

  if (normalizeText(request.query) && actions.length < policy.maxActions) {
    addUniqueAction(actions, createAction(
      'reset-query',
      'Arama metnini temizle',
      'Filtreleri koruyarak yalnız arama metnini temizler.',
      { query: '' },
    ), policy.maxActions);
  }

  return Object.freeze(actions);
};

const statusFor = (
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  grouping: SearchGroupingResultV9 | null,
  policy: NormalizedGuidancePolicyV9,
): SearchGuidanceStatusV9 => {
  if (recovery.final.result.diagnostics.blocked) return 'blocked';
  if (cards.length === 0) return 'empty';
  if (recovery.diagnostics.recovered) return 'recovered';
  if (cards.length <= policy.lowResultThreshold || grouping?.truncated === true) return 'partial';
  return 'success';
};

const severityFor = (status: SearchGuidanceStatusV9): SearchGuidanceSeverityV9 => {
  if (status === 'success' || status === 'recovered') return 'success';
  if (status === 'partial') return 'info';
  if (status === 'empty') return 'warning';
  if (status === 'blocked') return 'error';
  return 'neutral';
};

const copyFor = (
  status: SearchGuidanceStatusV9,
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  grouping: SearchGroupingResultV9 | null,
): Readonly<{ headline: string; message: string; resultCountText: string; announcement: string }> => {
  const count = cards.length;
  const countText = pluralResults(count);
  if (status === 'blocked') {
    const reason = blockReasonLabel(recovery.final.result.diagnostics.blockReason);
    return Object.freeze({
      headline: 'Arama güvenli biçimde durduruldu',
      message: reason,
      resultCountText: 'Sonuç gösterilmedi',
      announcement: `Arama durduruldu. ${reason}`,
    });
  }
  if (status === 'empty') {
    return Object.freeze({
      headline: 'Sonuç bulunamadı',
      message: 'Yazımı, filtreleri, adres kapsamını veya konum sınırını değiştirerek tekrar deneyebilirsiniz.',
      resultCountText: '0 sonuç',
      announcement: 'Arama tamamlandı. Sonuç bulunamadı.',
    });
  }
  if (status === 'recovered') {
    const executed = normalizeText(recovery.diagnostics.executedQuery);
    const message = executed
      ? `Daha iyi sonuç için “${executed}” sorgusu kullanıldı.`
      : 'Daha iyi sonuç için güvenli kurtarma araması kullanıldı.';
    return Object.freeze({
      headline: 'Sonuçlar iyileştirildi',
      message,
      resultCountText: countText,
      announcement: `Arama tamamlandı. ${countText} bulundu. ${message}`,
    });
  }
  if (status === 'partial') {
    const truncation = grouping?.truncated === true
      ? ' Görünüm performans sınırı nedeniyle özetlenmiş olabilir.'
      : '';
    return Object.freeze({
      headline: 'Sınırlı sayıda sonuç bulundu',
      message: `Aramanızı genişleterek daha fazla sonuç bulabilirsiniz.${truncation}`,
      resultCountText: countText,
      announcement: `Arama tamamlandı. ${countText} bulundu.`,
    });
  }
  return Object.freeze({
    headline: 'Arama sonuçları',
    message: 'En uygun sonuçlar hazır.',
    resultCountText: countText,
    announcement: `Arama tamamlandı. ${countText} bulundu.`,
  });
};

const guidanceFingerprint = (
  status: SearchGuidanceStatusV9,
  recovery: SearchRecoveryResultV8,
  cards: readonly SearchResultCardV9[],
  actions: readonly SearchGuidanceActionV9[],
): string => hashFingerprint(stableSerialize({
  version: SEARCH_GUIDANCE_VERSION_V9,
  status,
  requestFingerprint: recovery.diagnostics.requestFingerprint,
  datasetFingerprint: recovery.diagnostics.datasetFingerprint,
  cardKeys: cards.map(card => card.key),
  actions: actions.map(action => action.fingerprint),
}));

export const applySearchGuidanceActionV9 = (
  request: SearchRequest,
  action: SearchGuidanceActionV9,
): SearchRequest => Object.freeze({
  ...request,
  ...(action.query === null ? {} : { query: action.query }),
  ...(action.clearFilters ? { filters: Object.freeze([]) } : {}),
  ...(action.clearSpatial ? { center: null, radiusMeters: 0 } : {}),
  ...(action.clearAddressScope
    ? { level: null, district: null, neighborhood: null, street: null }
    : {}),
  ...(action.resetOffset ? { offset: 0 } : {}),
});

export class SearchGuidanceRuntimeV9 {
  readonly #policy: NormalizedGuidancePolicyV9;
  readonly #stats: MutableGuidanceStatsV9 = {
    evaluations: 0,
    success: 0,
    recovered: 0,
    partial: 0,
    empty: 0,
    blocked: 0,
    actionsBuilt: 0,
  };

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
    const severity = severityFor(status);
    const copy = copyFor(status, recovery, cards, grouping);
    const actions = guidanceActions(request, recovery, status, this.#policy);
    const blockedReason = recovery.final.result.diagnostics.blocked
      ? blockReasonLabel(recovery.final.result.diagnostics.blockReason)
      : null;

    this.#stats.evaluations += 1;
    this.#stats[status] += 1;
    this.#stats.actionsBuilt += actions.length;

    return Object.freeze({
      version: SEARCH_GUIDANCE_VERSION_V9,
      status,
      severity,
      headline: copy.headline,
      message: copy.message,
      resultCountText: copy.resultCountText,
      announcement: copy.announcement,
      blockedReason,
      recovered: recovery.diagnostics.recovered,
      originalQuery: recovery.diagnostics.originalQuery,
      executedQuery: recovery.diagnostics.executedQuery,
      actions,
      fingerprint: guidanceFingerprint(status, recovery, cards, actions),
    });
  }

  snapshot(): SearchGuidanceSnapshotV9 {
    return Object.freeze({
      version: SEARCH_GUIDANCE_VERSION_V9,
      ...this.#stats,
      fingerprint: hashFingerprint(stableSerialize({
        version: SEARCH_GUIDANCE_VERSION_V9,
        policy: this.#policy,
        stats: this.#stats,
      })),
    });
  }
}

export const createSearchGuidanceRuntimeV9 = (
  policy: SearchGuidancePolicyV9 = {},
): SearchGuidanceRuntimeV9 => new SearchGuidanceRuntimeV9(policy);
