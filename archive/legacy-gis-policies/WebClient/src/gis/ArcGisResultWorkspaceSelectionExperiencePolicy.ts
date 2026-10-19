export type WorkspaceSelectionModality = 'keyboard' | 'pointer' | 'touch';
export type WorkspaceSelectionAction = 'clear' | 'inspect' | 'zoom' | 'export';

export interface WorkspaceSelectionEnvironment {
  viewportWidth?: number;
  coarsePointer?: boolean;
  reducedMotion?: boolean;
  forcedColors?: boolean;
}

export interface WorkspaceSelectionInput {
  selectedIds: readonly string[];
  focusedId?: string;
  visibleIds?: readonly string[];
  exportAllowed?: boolean;
}

export interface WorkspaceSelectionActionContract {
  action: WorkspaceSelectionAction;
  id: string;
  label: string;
  disabled: boolean;
  touchTargetPx: number;
}

export interface WorkspaceSelectionSnapshot {
  selectedIds: readonly string[];
  selectedCount: number;
  focusedId?: string;
  visibleSelectedCount: number;
  hiddenSelectedCount: number;
  toolbarVisible: boolean;
  toolbarRole: 'toolbar';
  toolbarLabel: string;
  statusMessage: string;
  actions: readonly WorkspaceSelectionActionContract[];
  modality: WorkspaceSelectionModality;
  touchTargetPx: number;
  motionDurationMs: number;
  forcedColors: boolean;
}

const MAX_SELECTION = 1000;
const MAX_ID = 96;

const cleanId = (value: unknown): string =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ID);

function uniqueIds(input: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of input ?? []) {
    if (result.length >= MAX_SELECTION) break;
    const id = cleanId(source);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function target(environment: WorkspaceSelectionEnvironment): number {
  return environment.coarsePointer ? 48 : 44;
}

function actionContracts(count: number, environment: WorkspaceSelectionEnvironment, exportAllowed: boolean): readonly WorkspaceSelectionActionContract[] {
  const size = target(environment);
  const many = count > 1;
  return [
    { action: 'inspect', id: 'selection-inspect', label: 'Seçimi incele', disabled: count !== 1, touchTargetPx: size },
    { action: 'zoom', id: 'selection-zoom', label: many ? `${count} seçime yakınlaş` : 'Seçime yakınlaş', disabled: count === 0, touchTargetPx: size },
    { action: 'export', id: 'selection-export', label: 'Seçimi dışa aktar', disabled: count === 0 || !exportAllowed, touchTargetPx: size },
    { action: 'clear', id: 'selection-clear', label: many ? `${count} seçimi temizle` : 'Seçimi temizle', disabled: count === 0, touchTargetPx: size },
  ];
}

export function createArcGisResultWorkspaceSelectionExperience(
  input: WorkspaceSelectionInput,
  environment: WorkspaceSelectionEnvironment = {},
  modality: WorkspaceSelectionModality = 'keyboard',
): WorkspaceSelectionSnapshot {
  const selectedIds = uniqueIds(input.selectedIds);
  const selected = new Set(selectedIds);
  const visibleIds = uniqueIds(input.visibleIds);
  let visibleSelectedCount = 0;
  for (const id of visibleIds) if (selected.has(id)) visibleSelectedCount += 1;
  const hiddenSelectedCount = Math.max(0, selectedIds.length - visibleSelectedCount);
  const focused = cleanId(input.focusedId);
  const focusedId = focused && selected.has(focused) ? focused : undefined;
  const count = selectedIds.length;
  const hiddenSuffix = hiddenSelectedCount ? `, ${hiddenSelectedCount} görünür alan dışında` : '';
  return {
    selectedIds,
    selectedCount: count,
    ...(focusedId ? { focusedId } : {}),
    visibleSelectedCount,
    hiddenSelectedCount,
    toolbarVisible: count > 0,
    toolbarRole: 'toolbar',
    toolbarLabel: 'Sonuç seçim işlemleri',
    statusMessage: count ? `${count} sonuç seçili${hiddenSuffix}.` : 'Seçili sonuç yok.',
    actions: actionContracts(count, environment, Boolean(input.exportAllowed)),
    modality,
    touchTargetPx: target(environment),
    motionDurationMs: environment.reducedMotion ? 0 : 140,
    forcedColors: Boolean(environment.forcedColors),
  };
}

export function reconcileArcGisResultWorkspaceSelection(
  previous: WorkspaceSelectionSnapshot,
  input: WorkspaceSelectionInput,
  environment: WorkspaceSelectionEnvironment = {},
): { next: WorkspaceSelectionSnapshot; announcement: string; restoreFocusId?: string } {
  const next = createArcGisResultWorkspaceSelectionExperience(input, environment, previous.modality);
  let announcement = '';
  if (previous.selectedCount !== next.selectedCount) announcement = next.statusMessage;
  else if (previous.hiddenSelectedCount !== next.hiddenSelectedCount) announcement = next.statusMessage;
  const restoreFocusId = previous.focusedId && next.selectedIds.includes(previous.focusedId)
    ? previous.focusedId
    : next.selectedIds[0];
  return { next, announcement, ...(restoreFocusId ? { restoreFocusId } : {}) };
}

export function resolveWorkspaceSelectionAction(
  snapshot: WorkspaceSelectionSnapshot,
  action: WorkspaceSelectionAction,
): { accepted: boolean; ids: readonly string[]; focusId?: string } {
  const contract = snapshot.actions.find((candidate) => candidate.action === action);
  if (!contract || contract.disabled) return { accepted: false, ids: [] };
  if (action === 'inspect') return { accepted: true, ids: snapshot.selectedIds.slice(0, 1), ...(snapshot.selectedIds[0] ? { focusId: snapshot.selectedIds[0] } : {}) };
  if (action === 'clear') return { accepted: true, ids: [] };
  return { accepted: true, ids: snapshot.selectedIds };
}

export function shouldSuppressWorkspaceSelectionShortcut(
  modality: WorkspaceSelectionModality,
  context: { editable?: boolean; composing?: boolean; disabled?: boolean; defaultPrevented?: boolean } = {},
): boolean {
  return modality !== 'keyboard' || Boolean(context.editable || context.composing || context.disabled || context.defaultPrevented);
}
