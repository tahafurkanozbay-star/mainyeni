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
  readonly priority: 'polite' | 'assertive';
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
  readonly role: 'search' | 'region' | 'status' | 'listbox' | 'navigation';
  readonly label: string;
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

interface Policy {
  readonly maxAnnouncements: number;
  readonly maxInstructions: number;
  readonly maxResultFacts: number;
  readonly maxActionFacts: number;
  readonly maxLabelLength: number;
  readonly includeKeyboardInstructions: boolean;
  readonly announceSelectionCount: boolean;
  readonly announcePageChanges: boolean;
}

interface Stats {
  modelsBuilt: number;
  announcementsBuilt: number;
  assertiveAnnouncements: number;
  resultFactsBuilt: number;
  actionFactsBuilt: number;
  instructionFactsBuilt: number;
  lastModelFingerprint: string | null;
}

const policyFor = (input: SearchWorkspaceAccessibilityPolicyV10 = {}): Policy => Object.freeze({
  maxAnnouncements: normalizeInteger(input.maxAnnouncements, { min: 1, max: 32, fallback: 8 }),
  maxInstructions: normalizeInteger(input.maxInstructions, { min: 0, max: 32, fallback: 8 }),
  maxResultFacts: normalizeInteger(input.maxResultFacts, { min: 1, max: 2_000, fallback: 250 }),
  maxActionFacts: normalizeInteger(input.maxActionFacts, { min: 1, max: 512, fallback: 128 }),
  maxLabelLength: normalizeInteger(input.maxLabelLength, { min: 16, max: 1_000, fallback: 240 }),
  includeKeyboardInstructions: input.includeKeyboardInstructions !== false,
  announceSelectionCount: input.announceSelectionCount !== false,
  announcePageChanges: input.announcePageChanges !== false,
});

const bound = (value: unknown, maximum: number): string => {
  const text = normalizeText(value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
};

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${hashFingerprint(stableSerialize({ prefix, value }))}`;

const resultFact = (result: SearchWorkspaceResultV10, policy: Policy): SearchWorkspaceResultAccessibilityV10 =>
  Object.freeze({
    key: result.key,
    role: 'option',
    label: bound(result.label, policy.maxLabelLength),
    description: bound(result.description, policy.maxLabelLength * 2),
    selected: result.selected,
    active: result.active,
    position: result.position,
    setSize: result.setSize,
    id: stableId('search-result', result.key),
  });

const actionFact = (action: SearchWorkspaceActionV10, policy: Policy): SearchWorkspaceActionAccessibilityV10 =>
  Object.freeze({
    id: stableId('search-action', action.id),
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

const surfaceRole = (surface: SearchWorkspaceSurfaceV10): SearchWorkspaceSurfaceAccessibilityV10['role'] => {
  if (surface === 'query') return 'search';
  if (surface === 'results') return 'listbox';
  if (surface === 'guidance') return 'status';
  if (surface === 'history') return 'navigation';
  return 'region';
};

const surfaceFacts = (
  model: SearchWorkspaceHandoffModelV10,
  state: SearchWorkspaceStateSnapshotV10 | null,
): readonly SearchWorkspaceSurfaceAccessibilityV10[] => {
  const surfaces: SearchWorkspaceSurfaceV10[] = ['query'];
  if (model.facets.length || model.request.filterCount) surfaces.push('filters');
  if (model.results.length) surfaces.push('results');
  if (model.hasMappableResults) surfaces.push('map');
  if (model.hasDetails) surfaces.push('details');
  if (model.actions.some(action => action.surface === 'history')) surfaces.push('history');
  if (model.status.status !== 'ready' || model.actions.some(action => action.surface === 'guidance')) surfaces.push('guidance');
  const current = state?.surface ?? model.preferredSurface;
  return Object.freeze(Array.from(new Set(surfaces)).map(surface => Object.freeze({
    surface,
    role: surfaceRole(surface),
    label: surfaceLabel(surface),
    current: current === surface,
  })));
};

const instructions = (model: SearchWorkspaceHandoffModelV10, policy: Policy): readonly SearchWorkspaceInstructionV10[] => {
  if (!policy.includeKeyboardInstructions || policy.maxInstructions === 0) return Object.freeze([]);
  const output: SearchWorkspaceInstructionV10[] = [];
  const add = (surface: SearchWorkspaceSurfaceV10, id: string, text: string): void => {
    if (output.length < policy.maxInstructions) output.push(Object.freeze({ id, surface, text: bound(text, policy.maxLabelLength * 2) }));
  };
  add('query', 'search-workspace-query-help', 'Arama metnini düzenleyin. Öneriler kendiliğinden ağ çağrısı başlatmaz.');
  if (model.results.length) add('results', 'search-workspace-results-help', 'Sonuçlar arasında hareket edin; seçim, ayrıntı ve harita eylemlerini açıkça çalıştırın.');
  if (model.hasMappableResults) add('map', 'search-workspace-map-help', 'Haritada göster eylemi yalnız mevcut GIS otoritesine koordinat handoff bilgisi üretir.');
  if (model.facets.length) add('filters', 'search-workspace-filter-help', 'Filtre değişiklikleri yeni bir arama isteği üretir ve sayfalamayı ilk sonuca döndürür.');
  if (model.status.status === 'blocked') add('guidance', 'search-workspace-blocked-help', 'Arama güvenli yürütüm sınırında durduruldu. Sunulan genişletme eylemlerinden birini seçin.');
  if (model.status.status === 'empty') add('guidance', 'search-workspace-empty-help', 'Sonuç bulunamadı. Filtre veya konum kapsamını gevşeten önerileri kullanabilirsiniz.');
  return Object.freeze(output);
};

const announcement = (priority: 'polite' | 'assertive', text: string, policy: Policy): SearchWorkspaceAnnouncementV10 => {
  const bounded = bound(text, policy.maxLabelLength * 2);
  const fingerprint = hashFingerprint(stableSerialize({ priority, bounded }));
  return Object.freeze({ id: `search-announcement-${fingerprint}`, priority, text: bounded, fingerprint });
};

const announcementFacts = (
  model: SearchWorkspaceHandoffModelV10,
  state: SearchWorkspaceStateSnapshotV10 | null,
  previous: SearchWorkspaceAccessibilityModelV10 | null,
  policy: Policy,
): readonly SearchWorkspaceAnnouncementV10[] => {
  const candidates: SearchWorkspaceAnnouncementV10[] = [];
  const push = (candidate: SearchWorkspaceAnnouncementV10): void => {
    if (candidates.length >= policy.maxAnnouncements) return;
    if (!candidates.some(item => item.fingerprint === candidate.fingerprint)) candidates.push(candidate);
  };
  push(announcement(model.status.status === 'blocked' ? 'assertive' : 'polite', model.status.announcement || model.status.message, policy));
  if (policy.announcePageChanges && previous?.pageLabel !== model.pagination.label) {
    push(announcement('polite', `${model.pagination.label}. ${model.status.resultCountText}.`, policy));
  }
  const selectedCount = state?.selectedResultKeys.length ?? model.selectedResultKeys.length;
  if (policy.announceSelectionCount && previous?.selectedCount !== selectedCount) {
    push(announcement('polite', selectedCount ? `${selectedCount} sonuç seçili.` : 'Seçili sonuç yok.', policy));
  }
  if (model.status.recovered && !previous?.announcements.some(item => item.text.includes('kurtarma'))) {
    push(announcement('polite', 'Arama sorgu kurtarması kullanılarak sonuçlandırıldı.', policy));
  }
  return Object.freeze(candidates);
};

export class SearchWorkspaceAccessibilityRuntimeV10 {
  readonly #policy: Policy;
  readonly #stats: Stats = {
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
    this.#policy = policyFor(policy);
  }

  build(model: SearchWorkspaceHandoffModelV10, state: SearchWorkspaceStateSnapshotV10 | null = null): SearchWorkspaceAccessibilityModelV10 {
    if (model.version !== 'search-workspace-handoff-v10') throw new TypeError('Canonical v10 handoff model is required');
    const results = Object.freeze(model.results.slice(0, this.#policy.maxResultFacts).map(result => resultFact(result, this.#policy)));
    const actions = Object.freeze(model.actions.slice(0, this.#policy.maxActionFacts).map(action => actionFact(action, this.#policy)));
    const instructionFacts = instructions(model, this.#policy);
    const announcements = announcementFacts(model, state, this.#last, this.#policy);
    const activeKey = state?.activeResultKey ?? model.activeResultKey;
    const activeDescendantId = activeKey ? results.find(result => result.key === activeKey)?.id ?? null : null;
    const selectedCount = state?.selectedResultKeys.length ?? model.selectedResultKeys.length;
    const surfaces = surfaceFacts(model, state);
    const fingerprint = hashFingerprint(stableSerialize({
      version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10,
      model: model.fingerprint,
      state: state?.fingerprint ?? null,
      results,
      actions,
      announcements: announcements.map(item => item.fingerprint),
      instructionFacts,
      surfaces,
    }));
    const result: SearchWorkspaceAccessibilityModelV10 = Object.freeze({
      version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10,
      statusRole: model.status.status === 'blocked' ? 'alert' : 'status',
      statusLabel: bound(model.status.message || model.status.headline, this.#policy.maxLabelLength * 2),
      announcements,
      instructions: instructionFacts,
      results,
      actions,
      surfaces,
      activeDescendantId,
      resultSetSize: model.totalResultCount,
      selectedCount,
      pageLabel: model.pagination.label,
      fingerprint,
    });
    this.#stats.modelsBuilt += 1;
    this.#stats.announcementsBuilt += announcements.length;
    this.#stats.assertiveAnnouncements += announcements.filter(item => item.priority === 'assertive').length;
    this.#stats.resultFactsBuilt += results.length;
    this.#stats.actionFactsBuilt += actions.length;
    this.#stats.instructionFactsBuilt += instructionFacts.length;
    this.#stats.lastModelFingerprint = model.fingerprint;
    this.#last = result;
    return result;
  }

  clearPrevious(): void { this.#last = null; }

  snapshot(): SearchWorkspaceAccessibilitySnapshotV10 {
    const fingerprint = hashFingerprint(stableSerialize({ version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10, stats: this.#stats }));
    return Object.freeze({ version: SEARCH_WORKSPACE_ACCESSIBILITY_VERSION_V10, ...this.#stats, fingerprint });
  }
}

export const createSearchWorkspaceAccessibilityRuntimeV10 = (
  policy: SearchWorkspaceAccessibilityPolicyV10 = {},
): SearchWorkspaceAccessibilityRuntimeV10 => new SearchWorkspaceAccessibilityRuntimeV10(policy);
