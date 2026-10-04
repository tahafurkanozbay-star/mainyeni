import type { ResultWorkspacePanel, ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

export type WorkspaceNavigationLandmark = 'map' | 'collection' | 'filters' | 'detail' | 'view-controls' | 'status';
export type WorkspaceNavigationDirection = 'next' | 'previous' | 'first' | 'last';
export type WorkspaceNavigationReason = 'keyboard-cycle' | 'panel-open' | 'panel-close' | 'viewport-change' | 'result-refresh' | 'programmatic';

export interface WorkspaceNavigationEnvironment {
  readonly documentVisible?: boolean;
  readonly activeElementId?: string | null;
  readonly inertElementIds?: readonly string[];
  readonly disabledElementIds?: readonly string[];
  readonly connectedElementIds?: readonly string[];
}

export interface WorkspaceNavigationTarget {
  readonly landmark: WorkspaceNavigationLandmark;
  readonly elementId: string;
  readonly label: string;
  readonly panel: ResultWorkspacePanel | null;
  readonly visible: boolean;
  readonly focusable: boolean;
}

export interface WorkspaceNavigationPlan {
  readonly targets: readonly WorkspaceNavigationTarget[];
  readonly activeIndex: number;
  readonly activeTarget: WorkspaceNavigationTarget | null;
  readonly fallbackTarget: WorkspaceNavigationTarget | null;
  readonly cycleEnabled: boolean;
  readonly revision: number;
}

export interface WorkspaceFocusRequest {
  readonly targetId: string | null;
  readonly preventScroll: boolean;
  readonly announce: string;
  readonly reason: WorkspaceNavigationReason;
}

const IDS: Readonly<Record<WorkspaceNavigationLandmark, string>> = Object.freeze({
  map: 'arcgis-result-workspace-map', collection: 'arcgis-result-workspace-collection', filters: 'arcgis-result-workspace-filters',
  detail: 'arcgis-result-workspace-detail', 'view-controls': 'arcgis-result-workspace-view-controls', status: 'arcgis-result-workspace-status',
});
const LABELS: Readonly<Record<WorkspaceNavigationLandmark, string>> = Object.freeze({
  map: 'Harita', collection: 'Harita sonuçları', filters: 'Sonuç filtreleri', detail: 'Sonuç ayrıntıları',
  'view-controls': 'Sonuç görünümü kontrolleri', status: 'Sonuç durumu',
});
const cleanId = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
const idSet = (values: readonly string[] | undefined): ReadonlySet<string> => {
  const result = new Set<string>();
  for (const raw of values ?? []) { if (result.size >= 128) break; const id = cleanId(raw); if (id) result.add(id); }
  return result;
};
const visible = (snapshot: ResultWorkspaceSnapshot, landmark: WorkspaceNavigationLandmark): boolean => {
  if (landmark === 'map') return snapshot.presentation.mapVisible;
  if (landmark === 'collection') return snapshot.presentation.collectionVisible;
  if (landmark === 'filters') return snapshot.presentation.viewport === 'desktop' || snapshot.presentation.filtersOverlay;
  if (landmark === 'detail') return snapshot.interaction.detailOpen && (snapshot.presentation.viewport === 'desktop' || snapshot.presentation.detailOverlay);
  return true;
};
const panel = (landmark: WorkspaceNavigationLandmark): ResultWorkspacePanel | null =>
  landmark === 'map' || landmark === 'collection' || landmark === 'filters' || landmark === 'detail' ? landmark : null;

export function createArcGisResultWorkspaceNavigationPlan(snapshot: ResultWorkspaceSnapshot, environment: WorkspaceNavigationEnvironment = {}): WorkspaceNavigationPlan {
  const disabled = idSet(environment.disabledElementIds); const inert = idSet(environment.inertElementIds); const connected = idSet(environment.connectedElementIds);
  const order: readonly WorkspaceNavigationLandmark[] = snapshot.presentation.viewport === 'desktop'
    ? ['view-controls', 'collection', 'map', 'filters', 'detail', 'status']
    : snapshot.presentation.panel === 'map'
      ? ['view-controls', 'map', 'collection', 'filters', 'detail', 'status']
      : ['view-controls', snapshot.presentation.panel, 'collection', 'map', 'filters', 'detail', 'status'];
  const seen = new Set<WorkspaceNavigationLandmark>(); const targets: WorkspaceNavigationTarget[] = [];
  for (const landmark of order) {
    if (seen.has(landmark)) continue; seen.add(landmark); if (!visible(snapshot, landmark)) continue;
    const elementId = IDS[landmark]; const connectedEnough = connected.size === 0 || connected.has(elementId);
    targets.push(Object.freeze({ landmark, elementId, label: landmark === 'collection' ? snapshot.accessibility.collectionLabel : LABELS[landmark], panel: panel(landmark), visible: true, focusable: connectedEnough && !disabled.has(elementId) && !inert.has(elementId) }));
  }
  const frozen = Object.freeze(targets); const activeId = cleanId(environment.activeElementId);
  const activeIndex = activeId ? frozen.findIndex((item) => item.elementId === activeId) : -1;
  const activeTarget = activeIndex >= 0 ? frozen[activeIndex] ?? null : null; const fallbackTarget = frozen.find((item) => item.focusable) ?? null;
  return Object.freeze({ targets: frozen, activeIndex, activeTarget, fallbackTarget, cycleEnabled: environment.documentVisible !== false && frozen.filter((item) => item.focusable).length > 1, revision: snapshot.revision });
}

export function resolveArcGisResultWorkspaceLandmarkFocus(plan: WorkspaceNavigationPlan, direction: WorkspaceNavigationDirection, reason: WorkspaceNavigationReason = 'keyboard-cycle'): WorkspaceFocusRequest {
  const targets = plan.targets.filter((item) => item.focusable); if (targets.length === 0) return Object.freeze({ targetId: null, preventScroll: true, announce: '', reason });
  if (direction === 'first' || direction === 'last') { const item = direction === 'first' ? targets[0]! : targets[targets.length - 1]!; return Object.freeze({ targetId: item.elementId, preventScroll: true, announce: item.label, reason }); }
  const currentIndex = targets.findIndex((item) => item.elementId === plan.activeTarget?.elementId); const delta = direction === 'next' ? 1 : -1;
  const base = currentIndex >= 0 ? currentIndex : direction === 'next' ? -1 : 0; const item = targets[(base + delta + targets.length) % targets.length]!;
  return Object.freeze({ targetId: item.elementId, preventScroll: true, announce: item.label, reason });
}

export function resolveArcGisResultWorkspacePanelFocus(plan: WorkspaceNavigationPlan, targetPanel: ResultWorkspacePanel, reason: WorkspaceNavigationReason): WorkspaceFocusRequest {
  const item = plan.targets.find((candidate) => candidate.panel === targetPanel && candidate.focusable) ?? plan.fallbackTarget;
  return Object.freeze({ targetId: item?.elementId ?? null, preventScroll: true, announce: item?.label ?? '', reason });
}

export function resolveArcGisResultWorkspaceF6Intent(key: string, shiftKey: boolean, altKey = false, ctrlKey = false, metaKey = false): WorkspaceNavigationDirection | null {
  if (key !== 'F6' || altKey || ctrlKey || metaKey) return null; return shiftKey ? 'previous' : 'next';
}

export function shouldSuppressWorkspaceNavigationShortcut(targetTagName: string | null | undefined, editable: boolean, composing: boolean): boolean {
  if (composing || editable) return true; const tag = String(targetTagName ?? '').toLowerCase(); return tag === 'input' || tag === 'textarea' || tag === 'select';
}
