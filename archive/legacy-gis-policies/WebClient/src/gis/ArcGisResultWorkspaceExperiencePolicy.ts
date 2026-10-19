import {
  createArcGisResultExperienceModel,
  type ArcGisResultExperienceInput,
  type ArcGisResultExperienceModel,
  type ResultExperienceDensity,
  type ResultExperienceLayout,
} from './ArcGisResultExperiencePolicy';
import {
  normalizeResultInteractionSnapshot,
  reconcileResultInteraction,
  openResultDetail,
  closeResultDetail,
  moveResultFocus,
  toggleResultSelection,
  type ResultInteractionReason,
  type ResultInteractionSnapshot,
  type ResultInteractionTransition,
  type ResultInteractionViewport,
} from './ArcGisResultInteractionExperiencePolicy';

export type ResultWorkspacePanel = 'collection' | 'filters' | 'detail' | 'map';
export type ResultWorkspaceInputModality = 'keyboard' | 'pointer' | 'touch' | 'programmatic';
export type ResultWorkspaceIntent =
  | { readonly type: 'move-focus'; readonly delta: number }
  | { readonly type: 'open-detail'; readonly resultId: string }
  | { readonly type: 'close-detail' }
  | { readonly type: 'toggle-selection'; readonly resultId: string; readonly extend?: boolean }
  | { readonly type: 'toggle-filters' }
  | { readonly type: 'close-filters' }
  | { readonly type: 'show-map' }
  | { readonly type: 'show-results' }
  | { readonly type: 'set-layout'; readonly layout: ResultExperienceLayout }
  | { readonly type: 'set-density'; readonly density: ResultExperienceDensity }
  | { readonly type: 'refresh'; readonly resultIds: readonly string[]; readonly reason?: ResultInteractionReason };

export interface ResultWorkspaceEnvironment {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}

export interface ResultWorkspaceA11yContract {
  readonly collectionRole: 'region';
  readonly collectionLabel: string;
  readonly collectionBusy: boolean;
  readonly collectionLive: 'polite';
  readonly detailRole: 'region';
  readonly detailLabel: string;
  readonly filterRole: 'region';
  readonly filterLabel: string;
  readonly mapLabel: string;
  readonly focusVisible: boolean;
  readonly minimumTargetSize: 44 | 48;
  readonly motionDurationMs: number;
  readonly forcedColors: boolean;
}

export interface ResultWorkspacePresentation {
  readonly viewport: ResultInteractionViewport;
  readonly panel: ResultWorkspacePanel;
  readonly layout: ResultExperienceLayout;
  readonly density: ResultExperienceDensity;
  readonly filtersOverlay: boolean;
  readonly detailOverlay: boolean;
  readonly mapVisible: boolean;
  readonly collectionVisible: boolean;
  readonly splitView: boolean;
  readonly compactChrome: boolean;
}

export interface ResultWorkspaceSnapshot {
  readonly model: ArcGisResultExperienceModel;
  readonly interaction: ResultInteractionSnapshot;
  readonly presentation: ResultWorkspacePresentation;
  readonly accessibility: ResultWorkspaceA11yContract;
  readonly modality: ResultWorkspaceInputModality;
  readonly revision: number;
}

export interface ResultWorkspaceTransition {
  readonly next: ResultWorkspaceSnapshot;
  readonly focusTarget: string | null;
  readonly announcement: string;
  readonly scrollTop: number;
  readonly restoreMapFocus: boolean;
}

const MAX_RESULT_IDS = 20_000;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const PHONE_MAX = 639;
const TABLET_MAX = 1023;

const finite = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
const cleanId = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);

const resolveViewport = (width: number): ResultInteractionViewport => {
  const safeWidth = Math.max(0, finite(width, 1280));
  if (safeWidth <= PHONE_MAX) return 'phone';
  if (safeWidth <= TABLET_MAX) return 'tablet';
  return 'desktop';
};

const normalizeResultIds = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (result.length >= MAX_RESULT_IDS) break;
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return Object.freeze(result);
};

const nextRevision = (revision: number): number => {
  const safe = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  return safe >= MAX_REVISION ? 0 : safe + 1;
};

const derivePresentation = (
  viewport: ResultInteractionViewport,
  panel: ResultWorkspacePanel,
  model: ArcGisResultExperienceModel,
  interaction: ResultInteractionSnapshot,
): ResultWorkspacePresentation => {
  const desktop = viewport === 'desktop';
  const phone = viewport === 'phone';
  const detailOpen = interaction.detailOpen && Boolean(interaction.activeId);
  const filterOpen = interaction.filterOpen;
  return Object.freeze({
    viewport,
    panel,
    layout: phone ? 'list' : model.layout,
    density: phone ? 'comfortable' : model.density,
    filtersOverlay: !desktop && filterOpen,
    detailOverlay: !desktop && detailOpen,
    mapVisible: desktop || panel === 'map',
    collectionVisible: desktop || panel === 'collection',
    splitView: desktop,
    compactChrome: viewport !== 'desktop',
  });
};

const deriveAccessibility = (
  environment: ResultWorkspaceEnvironment,
  model: ArcGisResultExperienceModel,
  modality: ResultWorkspaceInputModality,
): ResultWorkspaceA11yContract => Object.freeze({
  collectionRole: 'region',
  collectionLabel: model.heading || 'Harita sonuçları',
  collectionBusy: model.status === 'loading',
  collectionLive: 'polite',
  detailRole: 'region',
  detailLabel: 'Sonuç ayrıntıları',
  filterRole: 'region',
  filterLabel: 'Sonuç filtreleri',
  mapLabel: 'Harita',
  focusVisible: modality === 'keyboard',
  minimumTargetSize: environment.coarsePointer ? 48 : 44,
  motionDurationMs: environment.reducedMotion ? 0 : 160,
  forcedColors: Boolean(environment.forcedColors),
});

const resultIdsFromModel = (model: ArcGisResultExperienceModel): readonly string[] => Object.freeze(
  model.rows.slice(0, MAX_RESULT_IDS).map((row) => cleanId(row.key)).filter(Boolean),
);

const initialPanel = (viewport: ResultInteractionViewport): ResultWorkspacePanel => viewport === 'desktop' ? 'collection' : 'map';

export function createArcGisResultWorkspaceExperience(
  input: ArcGisResultExperienceInput,
  environment: ResultWorkspaceEnvironment,
  modality: ResultWorkspaceInputModality = 'programmatic',
): ResultWorkspaceSnapshot {
  const model = createArcGisResultExperienceModel(input);
  const viewport = resolveViewport(environment.viewportWidth);
  const interaction = normalizeResultInteractionSnapshot({
    resultIds: resultIdsFromModel(model),
    selectedIds: model.selection ? [cleanId(`${typeof model.selection.objectId}:${String(model.selection.objectId)}`)] : [],
    focusedId: model.selection ? cleanId(`${typeof model.selection.objectId}:${String(model.selection.objectId)}`) : null,
    activeId: null,
    surface: 'collection',
    viewport,
    detailOpen: false,
    filterOpen: false,
    scrollTop: 0,
    rowHeight: model.density === 'compact' ? 44 : 56,
    viewportHeight: Math.max(0, finite(environment.viewportHeight, 0)),
  });
  const panel = initialPanel(viewport);
  return Object.freeze({
    model,
    interaction,
    presentation: derivePresentation(viewport, panel, model, interaction),
    accessibility: deriveAccessibility(environment, model, modality),
    modality,
    revision: 0,
  });
}

const withInteraction = (
  snapshot: ResultWorkspaceSnapshot,
  transition: ResultInteractionTransition,
  environment: ResultWorkspaceEnvironment,
  panel?: ResultWorkspacePanel,
  announcement?: string,
): ResultWorkspaceTransition => {
  const viewport = resolveViewport(environment.viewportWidth);
  const interaction = normalizeResultInteractionSnapshot({
    ...transition.next,
    viewport,
    viewportHeight: Math.max(0, finite(environment.viewportHeight, transition.next.viewportHeight)),
  });
  const nextPanel = panel ?? (interaction.detailOpen ? 'detail' : snapshot.presentation.panel);
  const next = Object.freeze({
    ...snapshot,
    interaction,
    presentation: derivePresentation(viewport, nextPanel, snapshot.model, interaction),
    accessibility: deriveAccessibility(environment, snapshot.model, snapshot.modality),
    revision: nextRevision(snapshot.revision),
  });
  return Object.freeze({
    next,
    focusTarget: transition.focusTarget,
    announcement: announcement ?? transition.announcement,
    scrollTop: transition.scrollTop,
    restoreMapFocus: transition.restoreMapFocus,
  });
};

const noInteractionTransition = (snapshot: ResultWorkspaceSnapshot): ResultInteractionTransition => ({
  next: snapshot.interaction,
  focusTarget: snapshot.interaction.focusedId,
  announcement: '',
  scrollTop: snapshot.interaction.scrollTop,
  restoreMapFocus: false,
});

export function applyArcGisResultWorkspaceIntent(
  snapshot: ResultWorkspaceSnapshot,
  intent: ResultWorkspaceIntent,
  environment: ResultWorkspaceEnvironment,
  modality: ResultWorkspaceInputModality = snapshot.modality,
): ResultWorkspaceTransition {
  const base = Object.freeze({ ...snapshot, modality });
  if (intent.type === 'move-focus') {
    return withInteraction(base, moveResultFocus(base.interaction, intent.delta), environment, 'collection');
  }
  if (intent.type === 'open-detail') {
    return withInteraction(base, openResultDetail(base.interaction, intent.resultId), environment, 'detail');
  }
  if (intent.type === 'close-detail') {
    return withInteraction(base, closeResultDetail(base.interaction), environment, 'collection');
  }
  if (intent.type === 'toggle-selection') {
    return withInteraction(base, toggleResultSelection(base.interaction, intent.resultId, Boolean(intent.extend)), environment, 'collection');
  }
  if (intent.type === 'toggle-filters') {
    const viewport = resolveViewport(environment.viewportWidth);
    if (viewport === 'desktop') {
      return withInteraction(base, noInteractionTransition(base), environment, 'filters', 'Filtreler gösteriliyor');
    }
    const interaction = normalizeResultInteractionSnapshot({ ...base.interaction, viewport, filterOpen: !base.interaction.filterOpen, surface: 'filters' });
    return withInteraction(base, { next: interaction, focusTarget: null, scrollTop: interaction.scrollTop, announcement: interaction.filterOpen ? 'Filtreler açıldı' : 'Filtreler kapatıldı', restoreMapFocus: false }, environment, interaction.filterOpen ? 'filters' : 'collection');
  }
  if (intent.type === 'close-filters') {
    const interaction = normalizeResultInteractionSnapshot({ ...base.interaction, filterOpen: false, surface: 'collection' });
    return withInteraction(base, { next: interaction, focusTarget: base.interaction.focusedId, scrollTop: interaction.scrollTop, announcement: base.interaction.filterOpen ? 'Filtreler kapatıldı' : '', restoreMapFocus: false }, environment, 'collection');
  }
  if (intent.type === 'show-map') {
    return withInteraction(base, noInteractionTransition(base), environment, 'map');
  }
  if (intent.type === 'show-results') {
    return withInteraction(base, noInteractionTransition(base), environment, 'collection');
  }
  if (intent.type === 'set-layout') {
    const model = Object.freeze({ ...base.model, layout: intent.layout });
    const viewport = resolveViewport(environment.viewportWidth);
    const next = Object.freeze({ ...base, model, presentation: derivePresentation(viewport, base.presentation.panel, model, base.interaction), accessibility: deriveAccessibility(environment, model, modality), revision: nextRevision(base.revision) });
    return Object.freeze({ next, focusTarget: base.interaction.focusedId, announcement: intent.layout === 'table' ? 'Tablo görünümü' : 'Liste görünümü', scrollTop: base.interaction.scrollTop, restoreMapFocus: false });
  }
  if (intent.type === 'set-density') {
    const model = Object.freeze({ ...base.model, density: intent.density });
    const rowHeight = intent.density === 'compact' ? 44 : 56;
    const interaction = normalizeResultInteractionSnapshot({ ...base.interaction, rowHeight });
    const viewport = resolveViewport(environment.viewportWidth);
    const next = Object.freeze({ ...base, model, interaction, presentation: derivePresentation(viewport, base.presentation.panel, model, interaction), accessibility: deriveAccessibility(environment, model, modality), revision: nextRevision(base.revision) });
    return Object.freeze({ next, focusTarget: interaction.focusedId, announcement: intent.density === 'compact' ? 'Sıkışık yoğunluk' : 'Rahat yoğunluk', scrollTop: interaction.scrollTop, restoreMapFocus: false });
  }
  const ids = normalizeResultIds(intent.resultIds);
  return withInteraction(base, reconcileResultInteraction(base.interaction, ids, intent.reason ?? 'result-refresh'), environment);
}

export function reconcileArcGisResultWorkspaceEnvironment(
  snapshot: ResultWorkspaceSnapshot,
  environment: ResultWorkspaceEnvironment,
): ResultWorkspaceTransition {
  const viewport = resolveViewport(environment.viewportWidth);
  const interaction = normalizeResultInteractionSnapshot({
    ...snapshot.interaction,
    viewport,
    viewportHeight: Math.max(0, finite(environment.viewportHeight, snapshot.interaction.viewportHeight)),
    filterOpen: viewport === 'desktop' ? false : snapshot.interaction.filterOpen,
  });
  let panel = snapshot.presentation.panel;
  if (viewport === 'desktop' && panel === 'map') panel = 'collection';
  if (viewport !== 'desktop' && interaction.detailOpen) panel = 'detail';
  if (viewport !== 'desktop' && interaction.filterOpen) panel = 'filters';
  const next = Object.freeze({
    ...snapshot,
    interaction,
    presentation: derivePresentation(viewport, panel, snapshot.model, interaction),
    accessibility: deriveAccessibility(environment, snapshot.model, snapshot.modality),
    revision: nextRevision(snapshot.revision),
  });
  return Object.freeze({ next, focusTarget: interaction.focusedId, announcement: '', scrollTop: interaction.scrollTop, restoreMapFocus: false });
}

export function resolveArcGisResultWorkspaceKeyboardIntent(
  key: string,
  shiftKey = false,
): ResultWorkspaceIntent | null {
  if (key === 'ArrowDown') return Object.freeze({ type: 'move-focus', delta: 1 });
  if (key === 'ArrowUp') return Object.freeze({ type: 'move-focus', delta: -1 });
  if (key === 'PageDown') return Object.freeze({ type: 'move-focus', delta: 10 });
  if (key === 'PageUp') return Object.freeze({ type: 'move-focus', delta: -10 });
  if (key === 'Escape') return Object.freeze({ type: 'close-detail' });
  if (key.toLowerCase() === 'f' && shiftKey) return Object.freeze({ type: 'toggle-filters' });
  if (key.toLowerCase() === 'm' && shiftKey) return Object.freeze({ type: 'show-map' });
  if (key.toLowerCase() === 'r' && shiftKey) return Object.freeze({ type: 'show-results' });
  return null;
}
