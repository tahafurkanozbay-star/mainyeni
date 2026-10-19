import {
  createResultAccessibilityAnnouncement,
  createResultAccessibilityHints,
  createResultCollectionAriaFacts,
  normalizeResultAccessibilitySnapshot,
  type ResultAccessibilityAnnouncement,
  type ResultAccessibilityReason,
  type ResultAccessibilitySnapshot,
  type ResultAccessibilityStatus,
} from './ArcGisResultAccessibilityExperiencePolicy';
import type {
  ResultWorkspaceInputModality,
  ResultWorkspacePanel,
  ResultWorkspaceSnapshot,
} from './ArcGisResultWorkspaceExperiencePolicy';

export type ResultWorkspaceAccessibilityAction =
  | 'announce'
  | 'focus-collection'
  | 'focus-detail'
  | 'focus-filters'
  | 'focus-map'
  | 'restore-result-focus'
  | 'none';

export interface ResultWorkspaceAccessibilityInput {
  readonly totalCount?: number;
  readonly visibleCount?: number;
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly query?: string;
  readonly sortLabel?: string;
  readonly errorMessage?: string | null;
  readonly status?: ResultAccessibilityStatus;
  readonly multiSelectable?: boolean;
}

export interface ResultWorkspaceAccessibilityIds {
  readonly collection: string;
  readonly collectionStatus: string;
  readonly collectionHint: string;
  readonly detail: string;
  readonly detailHeading: string;
  readonly filters: string;
  readonly filtersHeading: string;
  readonly map: string;
  readonly workspace: string;
}

export interface ResultWorkspaceAccessibilityContract {
  readonly ids: ResultWorkspaceAccessibilityIds;
  readonly snapshot: ResultAccessibilitySnapshot;
  readonly announcement: ResultAccessibilityAnnouncement;
  readonly activePanel: ResultWorkspacePanel;
  readonly activeDescendant: string | null;
  readonly focusTarget: string | null;
  readonly focusVisible: boolean;
  readonly collection: Readonly<{
    role: 'listbox';
    ariaLabel: string;
    ariaBusy: boolean;
    ariaMultiSelectable: boolean;
    ariaRowCount: number;
    ariaDescribedBy: string;
    tabIndex: 0 | -1;
  }>;
  readonly detail: Readonly<{
    role: 'region';
    ariaLabelledBy: string;
    hidden: boolean;
    tabIndex: -1;
  }>;
  readonly filters: Readonly<{
    role: 'region';
    ariaLabelledBy: string;
    hidden: boolean;
    modal: boolean;
    tabIndex: -1;
  }>;
  readonly map: Readonly<{
    role: 'region';
    ariaLabel: string;
    hidden: boolean;
    tabIndex: 0 | -1;
  }>;
  readonly liveRegion: Readonly<{
    role: 'status' | 'alert';
    ariaLive: 'off' | 'polite' | 'assertive';
    ariaAtomic: boolean;
    message: string;
  }>;
  readonly hints: Readonly<{
    keyboard: string;
    pagination: string;
    selection: string;
  }>;
  readonly action: ResultWorkspaceAccessibilityAction;
  readonly revision: number;
}

const MAX_ID_LENGTH = 96;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

const cleanToken = (value: unknown, fallback: string): string => {
  const source = typeof value === 'string' ? value : '';
  let output = '';
  for (const character of source) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 32 || code === 127) continue;
    if (/^[A-Za-z0-9_-]$/u.test(character)) output += character;
    else if (output && output.at(-1) !== '-') output += '-';
    if (output.length >= MAX_ID_LENGTH) break;
  }
  return output.replace(/-+/gu, '-').replace(/^-|-$/gu, '') || fallback;
};

const nextRevision = (value: number): number => {
  const safe = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return safe >= MAX_REVISION ? 0 : safe + 1;
};

const selectedCount = (workspace: ResultWorkspaceSnapshot): number => workspace.interaction.selectedIds.length;

const focusedIndex = (workspace: ResultWorkspaceSnapshot): number | null => {
  const focusedId = workspace.interaction.focusedId;
  if (!focusedId) return null;
  const index = workspace.interaction.resultIds.indexOf(focusedId);
  return index < 0 ? null : index;
};

const createIds = (scopeId: string): ResultWorkspaceAccessibilityIds => {
  const scope = cleanToken(scopeId, 'arcgis-results');
  return Object.freeze({
    collection: `${scope}-collection`,
    collectionStatus: `${scope}-status`,
    collectionHint: `${scope}-hint`,
    detail: `${scope}-detail`,
    detailHeading: `${scope}-detail-heading`,
    filters: `${scope}-filters`,
    filtersHeading: `${scope}-filters-heading`,
    map: `${scope}-map`,
    workspace: `${scope}-workspace`,
  });
};

const activeDescendant = (workspace: ResultWorkspaceSnapshot): string | null => {
  const focused = workspace.interaction.focusedId;
  if (!focused || !workspace.presentation.collectionVisible) return null;
  return `result-option-${cleanToken(focused, 'result')}`;
};

const focusTargetForPanel = (
  workspace: ResultWorkspaceSnapshot,
  ids: ResultWorkspaceAccessibilityIds,
): string | null => {
  if (workspace.presentation.panel === 'detail' && workspace.interaction.detailOpen) return ids.detail;
  if (workspace.presentation.panel === 'filters' && (workspace.interaction.filterOpen || workspace.presentation.splitView)) return ids.filters;
  if (workspace.presentation.panel === 'map') return ids.map;
  if (workspace.interaction.focusedId) return activeDescendant(workspace);
  return ids.collection;
};

const actionFor = (
  previous: ResultWorkspaceAccessibilityContract | null,
  workspace: ResultWorkspaceSnapshot,
  announcement: ResultAccessibilityAnnouncement,
): ResultWorkspaceAccessibilityAction => {
  if (!previous) return announcement.message ? 'announce' : 'none';
  if (previous.activePanel !== workspace.presentation.panel) {
    if (workspace.presentation.panel === 'detail') return 'focus-detail';
    if (workspace.presentation.panel === 'filters') return 'focus-filters';
    if (workspace.presentation.panel === 'map') return 'focus-map';
    return workspace.interaction.focusedId ? 'restore-result-focus' : 'focus-collection';
  }
  if (previous.activeDescendant !== activeDescendant(workspace) && workspace.modality === 'keyboard') {
    return 'restore-result-focus';
  }
  return announcement.message ? 'announce' : 'none';
};

const inferReason = (
  previous: ResultWorkspaceAccessibilityContract | null,
  workspace: ResultWorkspaceSnapshot,
  requested?: ResultAccessibilityReason,
): ResultAccessibilityReason => {
  if (requested) return requested;
  if (!previous) return 'initial-load';
  if (workspace.model.status === 'error') return 'error';
  if (previous.snapshot.selectedCount !== selectedCount(workspace)) return 'selection-change';
  if (previous.snapshot.focusedIndex !== focusedIndex(workspace)) return 'focus-change';
  return 'refresh';
};

export function createArcGisResultWorkspaceAccessibilityContract(
  workspace: ResultWorkspaceSnapshot,
  input: ResultWorkspaceAccessibilityInput = {},
  scopeId = 'arcgis-results',
  reason: ResultAccessibilityReason = 'initial-load',
): ResultWorkspaceAccessibilityContract {
  return reconcileArcGisResultWorkspaceAccessibilityContract(null, workspace, input, scopeId, reason);
}

export function reconcileArcGisResultWorkspaceAccessibilityContract(
  previous: ResultWorkspaceAccessibilityContract | null,
  workspace: ResultWorkspaceSnapshot,
  input: ResultWorkspaceAccessibilityInput = {},
  scopeId = 'arcgis-results',
  reason?: ResultAccessibilityReason,
): ResultWorkspaceAccessibilityContract {
  const ids = createIds(scopeId);
  const totalCount = input.totalCount ?? workspace.interaction.resultIds.length;
  const visibleCount = input.visibleCount ?? workspace.interaction.resultIds.length;
  const accessibility = normalizeResultAccessibilitySnapshot({
    totalCount,
    visibleCount,
    pageIndex: input.pageIndex,
    pageSize: input.pageSize,
    selectedCount: selectedCount(workspace),
    focusedIndex: focusedIndex(workspace),
    query: input.query,
    sortLabel: input.sortLabel,
    errorMessage: input.errorMessage,
    status: input.status ?? workspace.model.status,
    multiSelectable: input.multiSelectable,
  });
  const resolvedReason = inferReason(previous, workspace, reason);
  const announcement = createResultAccessibilityAnnouncement(accessibility, resolvedReason);
  const ariaFacts = createResultCollectionAriaFacts(accessibility);
  const hints = createResultAccessibilityHints(accessibility);
  const descendant = activeDescendant(workspace);
  const panel = workspace.presentation.panel;
  const keyboard = workspace.modality === 'keyboard';
  const detailVisible = workspace.interaction.detailOpen && Boolean(workspace.interaction.activeId);
  const filtersVisible = workspace.interaction.filterOpen || (workspace.presentation.splitView && panel === 'filters');
  const mapVisible = workspace.presentation.mapVisible;

  const contract: ResultWorkspaceAccessibilityContract = {
    ids,
    snapshot: accessibility,
    announcement,
    activePanel: panel,
    activeDescendant: descendant,
    focusTarget: focusTargetForPanel(workspace, ids),
    focusVisible: keyboard,
    collection: Object.freeze({
      role: ariaFacts.role,
      ariaLabel: ariaFacts.ariaLabel,
      ariaBusy: ariaFacts.ariaBusy,
      ariaMultiSelectable: ariaFacts.ariaMultiSelectable,
      ariaRowCount: ariaFacts.ariaRowCount,
      ariaDescribedBy: `${ids.collectionStatus} ${ids.collectionHint}`,
      tabIndex: workspace.presentation.collectionVisible && !descendant ? 0 : -1,
    }),
    detail: Object.freeze({
      role: 'region',
      ariaLabelledBy: ids.detailHeading,
      hidden: !detailVisible,
      tabIndex: -1,
    }),
    filters: Object.freeze({
      role: 'region',
      ariaLabelledBy: ids.filtersHeading,
      hidden: !filtersVisible,
      modal: workspace.presentation.filtersOverlay && filtersVisible,
      tabIndex: -1,
    }),
    map: Object.freeze({
      role: 'region',
      ariaLabel: workspace.accessibility.mapLabel,
      hidden: !mapVisible,
      tabIndex: mapVisible && panel === 'map' ? 0 : -1,
    }),
    liveRegion: Object.freeze({
      role: announcement.mode === 'assertive' ? 'alert' : 'status',
      ariaLive: announcement.mode,
      ariaAtomic: announcement.atomic,
      message: announcement.message,
    }),
    hints,
    action: actionFor(previous, workspace, announcement),
    revision: previous ? nextRevision(previous.revision) : 0,
  };
  return Object.freeze(contract);
}

export function shouldSuppressWorkspaceAccessibilityShortcut(
  modality: ResultWorkspaceInputModality,
  options: Readonly<{
    editable?: boolean;
    composing?: boolean;
    modalOpen?: boolean;
    disabled?: boolean;
  }> = {},
): boolean {
  if (options.disabled || options.composing || options.editable) return true;
  if (options.modalOpen && modality !== 'keyboard') return true;
  return false;
}

export function resolveWorkspaceAccessibilityEscapeTarget(
  contract: ResultWorkspaceAccessibilityContract,
): string | null {
  if (!contract.detail.hidden) return contract.ids.collection;
  if (!contract.filters.hidden) return contract.ids.collection;
  if (contract.activePanel === 'map') return contract.ids.map;
  return contract.activeDescendant ?? contract.ids.collection;
}
