import {
  hashFingerprint,
  normalizeInteger,
  normalizeText,
  stableSerialize,
} from './normalization';
import type {
  SearchWorkspaceActionV10,
  SearchWorkspaceHandoffModelV10,
  SearchWorkspaceResultV10,
  SearchWorkspaceSurfaceV10,
} from './searchWorkspaceHandoffRuntimeV10';
import type { SearchWorkspaceStateSnapshotV10 } from './searchWorkspaceStateRuntimeV10';

export const SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10 = 'search-workspace-accessibility-v10' as const;

export type SearchWorkspaceAnnouncementPriorityV10 = 'polite' | 'assertive';
export type SearchWorkspaceAccessibilityRoleV10 =
  | 'search'
  | 'region'
  | 'status'
  | 'alert'
  | 'listbox'
  | 'option'
  | 'group'
  | 'button'
  | 'navigation';

export interface SearchWorkspaceAccessibilityPolicyV10 {
  readonly maxAnnouncements?: number;
  readonly maxInstructions?: number;
  readonly maxResultFacts?: number;
  readonly maxActionFacts?: number;
  readonly maxLabelLength?: number;
  readonly includeKeyboardInstructions?: boolean;
  readonly announceSelectionCount?: boolean;
  readonly announcePageChanges?: boolean;
}

export interface SearchWorkspaceAnnouncementV10 {
  readonly id: string;
  readonly priority: SearchWorkspaceAnnouncementPriorityV10;
  readonly text: string;
  readonly fingerprint: string;
}

export interface SearchWorkspaceInstructionV10 {
  readonly id: string;
  readonly surface: SearchWorkspaceSurfaceV10;
  readonly text: string;
}

export interface SearchWorkspaceResultAccessibilityV10 {
  readonly key: string;
  readonly role: 'option';
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
  readonly active: boolean;
  readonly position: number;
  readonly setSize: number;
  readonly id: string;
}

export interface SearchWorkspaceActionAccessibilityV10 {
  readonly id: string;
  readonly role: 'button';
  readonly label: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly surface: SearchWorkspaceSurfaceV10;
}

export interface SearchWorkspaceSurfaceAccessibilityV10 {
  readonly surface: SearchWorkspaceSurfaceV10;
  readonly role: SearchWorkspaceAccessibilityRoleV10;
  readonly label: string;
  readonly describedBy: readonly string[];
  readonly current: boolean;
}

export interface SearchWorkspaceAccessibilityModelV10 {
  readonly version: typeof SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10;
  readonly statusRole: 'status' | 'alert';
  readonly statusLabel: string;
  readonly announcements: readonly SearchWorkspaceAnnouncementV10[];
  readonly instructions: readonly SearchWorkspaceInstructionV10[];
  readonly results: readonly SearchWorkspaceResultAccessibilityV10[];
  readonly actions: readonly SearchWorkspaceActionAccessibilityV10[];
  readonly surfaces: readonly SearchWorkspaceSurfaceAccessibilityV10[];
  readonly activeDescendantId: string | null;
  readonly resultSetSize: number;
  readonly selectedCount: number;
  readonly pageLabel: string;
  readonly fingerprint: string;
}

export interface SearchWorkspaceAccessibilitySnapshotV10 {
  readonly version: typeof SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10;
  readonly modelsBuilt: number;
  readonly announcementsBuilt: number;
  readonly assertiveAnnouncements: number;
  readonly resultFactsBuilt: number;
  readonly actionFactsBuilt: number;
  readonly instructionFactsBuilt: number;
  readonly lastModelFingerprint: string | null;
  readonly fingerprint: string;
}

interface NormalizedAccessibilityPolicyV10 {
  readonly maxAnnouncements: number;
  readonly maxInstructions: number;
  readonly maxResultFacts: number;
  readonly maxActionFacts: number;
  readonly maxLabelLength: number;
  readonly includeKeyboardInstructions: boolean;
  readonly announceSelectionCount: boolean;
  readonly announcePageChanges: boolean;
}

interface MutableAccessibilityStatsV10 {
  modelsBuilt: number;
  announcementsBuilt: number;
  assertiveAnnouncements: number;
  resultFactsBuilt: number;
  actionFactsBuilt: number;
  instructionFactsBuilt: number;
  lastModelFingerprint: string | null;
}

const normalizePolicy = (
  policy: SearchWorkspaceAccessibilityPolicyV10 = {},
): NormalizedAccessibilityPolicyV10 => Object.freeze({
  maxAnnouncements: normalizeInteger(policy.maxAnnouncements, { min: 1, max: 32, fallback: 8 }),
  maxInstructions: normalizeInteger(policy.maxInstructions, { min: 0, max: 32, fallback: 8 }),
  maxResultFacts: normalizeInteger(policy.maxResultFacts, { min: 1, max: 2_000, fallback: 250 }),
  maxActionFacts: normalizeInteger(policy.maxActionFacts, { min: 1, max: 512, fallback: 128 }),
  maxLabelLength: normalizeInteger(policy.maxLabelLength, { min: 16, max: 1_000, fallback: 240 }),
  includeKeyboardInstructions: policy.includeKeyboardInstructions !== false,
  announceSelectionCount: policy.announceSelectionCount !== false,
  announcePageChanges: policy.announcePageChanges !== false,
});

const bound = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const safeId = (prefix: string, value: unknown): string => {
  const fingerprint = hashFingerprint(stableSerialize({ prefix, value }));
  return `${prefix}-${fingerprint}`;
};

const announcement = (
  priority: SearchWorkspaceAnnouncementPriorityV10,
  text: string,
  maximum: number,
): SearchWorkspaceAnnouncementV10 => {
  const bounded = bound(text, maximum);
  const fingerprint = hashFingerprint(stableSerialize({ priority, text: bounded }));
  return Object.freeze({
    id: `search-announcement-${fingerprint}`,
    priority,
    text: bounded,
    fingerprint,
  });
};

const addAnnouncement = (
  output: SearchWorkspaceAnnouncementV10[],
  candidate: SearchWorkspaceAnnouncementV10,
  maximum: number,
): void => {
  if (output.length >= maximum) return;
  if (output.some(item => item.fingerprint === candidate.fingerprint)) return;
  output.push(candidate);
};

const resultFact = (
  result: SearchWorkspaceResultV10,
  policy: NormalizedAccessibilityPolicyV10,
): SearchWorkspaceResultAccessibilityV10 => Object.freeze({
  key: result.key,
  role: 'option',
  label: bound(result.label, policy.maxLabelLength),
  description: bound(result.description, policy.maxLabelLength * 2),
  selected: result.selected,
  active: result.active,
  position: result.position,
  setSize: result.setSize,
  id: safeId('search-result', result.key),
});

const actionFact = (
  action: SearchWorkspaceActionV10,
  policy: NormalizedAccessibilityPolicyV10,
): SearchWorkspaceActionAccessibilityV10 => Object.freeze({
  id: safeId('search-action', action.id),
  role: 'button',
  label: bound(action.label, policy.maxLabelLength),
  description: bound(action.description, policy.maxLabelLength * 2),
  disabled: !action.enabled,
  surface: action.surface,
});

const surfaceLabel = (surface: SearchWorkspaceSurfaceV10): string => {
  if (surface === 'query') return 'Arama';
  if (surface === 'filters') return 'Filtreler';
  if (surface === 'results') return 'Arama sonuçları';
  if (surface === 'map') return 'Harita sonuçları';
  if (surface === 'details') return 'Sonuç ayrıntıları';
  if (surface === 'history') return 'Son aramalar';
  return 'Arama önerileri ve durum';
};

const surfaceRole = (surface: SearchWorkspaceSurfaceV10): SearchWorkspaceAccessibilityRoleV10 => {
  if (surface === 'query') return 'search';
  if (surface === 'results') return 'listbox';
  if (surface === 'guidance') return 'status';
  if (surface === 'history') return 'navigation';
  return 'region';
};

const surfacesFor = (
  model: SearchWorkspaceHandoffModelV10,
  state: SearchWorkspaceStateSnapshotV10 | null,
): readonly SearchWorkspaceSurfaceAccessibilityV10[] => {
  const surfaces: SearchWorkspaceSurfaceV10[] = ['query'];
  if (model.facets.length > 0 || model.request.filterCount > 0) surfaces.push('filters');
  if (model.results.length > 0) surfaces.push('results');
  if (model.hasMappableResults) surfaces.push('map');
  if (model.hasDetails) surfaces.push('details');
  if (model.actions.some(action => action.surface === 'history')) surfaces.push('history');
  if (model.status.status !== 'ready' || model.actions.some(action => action.surface === 'guidance')) surfaces.push('guidance');
  const unique = Array.from(new Set(surfaces));
  return Object.freeze(unique.map(surface => Object.freeze({
    surface,
    role: surfaceRole(surface),
    label: surfaceLabel(surface),
    describedBy: Object.freeze(surface === 'results'
      ? ['search-workspace-status', 'search-workspace-results-help']
      : surface === 'map'
        ? ['search-workspace-status', 'search-workspace-map-help']
        : ['search-workspace-status']),
    current: (state?.surface ?? model.preferredSurface) === surface,
  })));
};

const instructionsFor = (
  model: SearchWorkspaceHandoffModelV10,
  policy: NormalizedAccessibilityPolicyV10,
): readonly SearchWorkspaceInstructionV10[] => {
  if (!policy.includeKeyboardInstructions || policy.maxInstructions <= 0) return Object.freeze([]);
  const output: SearchWorkspaceInstructionV10[] = [];
  const add = (surface: SearchWorkspaceSurfaceV10, id: string, text: string): void => {
    if (output.length >= policy.maxInstructions) return;
    output.push(Object.freeze({ id, surface, text: bound(text, policy.maxLabelLength * 2) }));
  };
  add('query', 'search-workspace-query-help', 'Arama metnini değiştirin ve güncel sonuçları isteyin. Öneriler otomatik ağ çağrısı başlatmaz.');
  if (model.results.length > 0) {
    add('results', 'search-workspace-results-help', 'Sonuçlar arasında yön tuşlarıyla hareket edin; seçim ve ayrıntı eylemlerini açıkça çalıştırın.');
  }
  if (model.hasMappableResults) {
    add('map', 'search-workspace-map-help', 'Haritada göster eylemi yalnız koordinat handoff bilgisi üretir; mevcut GIS otoritesi gerçek harita odağını yönetir.');
  }
  if (model.facets.length > 0) {
    add('filters', 'search-workspace-filter-help', 'Filtreleri değiştirirken sonuç sayfası ilk ofsete döner ve mevcut arama bağlamı korunur.');
  }
  if (model.status.status === 'blocked') {
    add('guidance', 'search-workspace-blocked-help', 'Arama güvenli yürütüm sınırında durduruldu. Sunulan genişletme eylemlerinden birini seçin.');
  } else if (model.status.status === 'empty') {
    add('guidance', 'search-workspace-empty-help', 'Sonuç bulunamadı. Filtreleri veya konum/adres kapsamını gevşeten önerileri kullanabilirsiniz.');
  }
  return Object.freeze(output);
};

const announcementsFor = (
  model: SearchWorkspaceHandoffModelV10,
  state: SearchWorkspaceStateSnapshotV10 | null,
  previous: SearchWorkspaceAccessibilityModelV10 | null,
  policy: NormalizedAccessibilityPolicyV10,
): readonly SearchWorkspaceAnnouncementV10[] => {
  const output: SearchWorkspaceAnnouncementV10[] = [];
  const priority: SearchWorkspaceAnnouncementPriorityV10 = model.status.status === 'blocked' ? 'assertive' : 'polite';
  addAnnouncement(output, announcement(priority, model.status.announcement || model.status.message, policy.maxLabelLength * 2), policy.maxAnnouncements);
  if (policy.announcePageChanges && (!previous || previous.pageLabel !== model.pagination.label)) {
    addAnnouncement(output, announcement('polite', `${model.pagination.label}. ${model.status.resultCountText}.`, policy.maxLabelLength), policy.maxAnnouncements);
  }
  const selectedCount = state?.selectedResultKeys.length ?? model.selectedResultKeys.length;
  const previousSelected = previous?.selectedCount ?? -1;
  if (policy.announceSelectionCount && selectedCount !== previousSelected) {
    addAnnouncement(output, announcement(
      'polite',
      selectedCount === 0 ? 'Seçili sonuç yok.' : `${selectedCount} sonuç seçili.`,
      policy.maxLabelLength,
    ), policy.maxAnnouncements);
  }
  if (model.recovered && !previous?.announcements.some(item => item.text.includes('kurtar'))) {
    addAnnouncement(output, announcement(
      'polite',
      'Arama yazım veya sorgu kurtarması kullanılarak sonuçlandırıldı.',
      policy.maxLabelLength,
    ), policy.maxAnnouncements);
  }
  return Object.freeze(output);
};

const accessibilityFingerprint = (
  model: SearchWorkspaceHandoffModelV10,
  state: SearchWorkspaceStateSnapshotV10 | null,
  results: readonly SearchWorkspaceResultAccessibilityV10[],
  actions: readonly SearchWorkspaceActionAccessibilityV10[],
  announcements: readonly SearchWorkspaceAnnouncementV10[],
  instructions: readonly SearchWorkspaceInstructionV10[],
): string => hashFingerprint(stableSerialize({
  version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10,
  modelFingerprint: model.fingerprint,
  stateFingerprint: state?.fingerprint ?? null,
  results,
  actions,
  announcements: announcements.map(item => item.fingerprint),
  instructions,
}));

export class SearchWorkspaceAccessibilityRuntimeV10 {
  readonly #policy: NormalizedAccessibilityPolicyV10;
  readonly #stats: MutableAccessibilityStatsV10 = {
    modelsBuilt: 0,
    announcementsBuilt: 0,
    assertiveAnnouncements: 0,
    resultFactsBuilt: 0,
    actionFactsBuilt: 0,
    instructionFactsBuilt: 0,
    lastModelFingerprint: null,
  };
  #last: SearchWorkspaceAccessibilityModelV10 | null = null;

  constructor(policy: SearchWorkspaceAccessibilityPolicyV10 = {}) {
    this.#policy = normalizePolicy(policy);
  }

  build(
    model: SearchWorkspaceHandoffModelV10,
    state: SearchWorkspaceStateSnapshotV10 | null = null,
  ): SearchWorkspaceAccessibilityModelV10 {
    if (model.version !== 'search-workspace-handoff-v10') {
      throw new TypeError('Search accessibility v10 requires the canonical workspace handoff model');
    }
    const results = Object.freeze(model.results.slice(0, this.#policy.maxResultFacts).map(result => resultFact(result, this.#policy)));
    const actions = Object.freeze(model.actions.slice(0, this.#policy.maxActionFacts).map(action => actionFact(action, this.#policy)));
    const instructions = instructionsFor(model, this.#policy);
    const announcements = announcementsFor(model, state, this.#last, this.#policy);
    const activeKey = state?.activeResultKey ?? model.activeResultKey;
    const activeDescendantId = activeKey
      ? results.find(result => result.key === activeKey)?.id ?? null
      : null;
    const selectedCount = state?.selectedResultKeys.length ?? model.selectedResultKeys.length;
    const result: SearchWorkspaceAccessibilityModelV10 = Object.freeze({
      version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10,
      statusRole: model.status.status === 'blocked' ? 'alert' : 'status',
      statusLabel: bound(model.status.message || model.status.headline, this.#policy.maxLabelLength * 2),
      announcements,
      instructions,
      results,
      actions,
      surfaces: surfacesFor(model, state),
      activeDescendantId,
      resultSetSize: model.totalResultCount,
      selectedCount,
      pageLabel: model.pagination.label,
      fingerprint: accessibilityFingerprint(model, state, results, actions, announcements, instructions),
    });
    this.#stats.modelsBuilt += 1;
    this.#stats.announcementsBuilt += announcements.length;
    this.#stats.assertiveAnnouncements += announcements.filter(item => item.priority === 'assertive').length;
    this.#stats.resultFactsBuilt += results.length;
    this.#stats.actionFactsBuilt += actions.length;
    this.#stats.instructionFactsBuilt += instructions.length;
    this.#stats.lastModelFingerprint = model.fingerprint;
    this.#last = result;
    return result;
  }

  clearPrevious(): void {
    this.#last = null;
  }

  snapshot(): SearchWorkspaceAccessibilitySnapshotV10 {
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10,
      stats: this.#stats,
    }));
    return Object.freeze({
      version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10,
      ...this.#stats,
      fingerprint,
    });
  }
}

export const createSearchWorkspaceAccessibilityRuntimeV10 = (
  policy: SearchWorkspaceAccessibilityPolicyV10 = {},
): SearchWorkspaceAccessibilityRuntimeV10 => new SearchWorkspaceAccessibilityRuntimeV10(policy);
