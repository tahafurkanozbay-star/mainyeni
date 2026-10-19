import type {
  WorkspaceSelectionAction,
  WorkspaceSelectionActionContract,
  WorkspaceSelectionEnvironment,
  WorkspaceSelectionSnapshot,
} from './ArcGisResultWorkspaceSelectionExperiencePolicy';

export type WorkspaceSelectionAccessibilityModality = 'keyboard' | 'pointer' | 'touch';
export type WorkspaceSelectionAccessibilityIntent =
  | 'focus-toolbar'
  | 'focus-selection'
  | 'invoke-action'
  | 'dismiss-toolbar';

export interface WorkspaceSelectionAccessibilityInput {
  snapshot: WorkspaceSelectionSnapshot;
  resultIds?: readonly string[];
  activeElementId?: string;
  triggerElementId?: string;
  preferredAction?: WorkspaceSelectionAction;
  environment?: WorkspaceSelectionEnvironment;
  modality?: WorkspaceSelectionAccessibilityModality;
}

export interface WorkspaceSelectionAccessibilityAction {
  action: WorkspaceSelectionAction;
  elementId: string;
  label: string;
  disabled: boolean;
  ariaDisabled: 'true' | 'false';
  tabIndex: 0 | -1;
  touchTargetPx: number;
}

export interface WorkspaceSelectionAccessibilitySnapshot {
  toolbarId: string;
  toolbarRole: 'toolbar';
  toolbarLabel: string;
  toolbarHidden: boolean;
  toolbarTabIndex: 0 | -1;
  actionOrientation: 'horizontal';
  actions: readonly WorkspaceSelectionAccessibilityAction[];
  activeAction?: WorkspaceSelectionAction;
  selectedResultIds: readonly string[];
  selectedResultCount: number;
  focusedResultId?: string;
  setSize: number;
  statusId: string;
  statusRole: 'status';
  statusLive: 'polite';
  statusAtomic: true;
  statusMessage: string;
  instructionsId: string;
  instructions: string;
  restoreFocusId?: string;
  modality: WorkspaceSelectionAccessibilityModality;
  focusVisible: boolean;
  touchTargetPx: number;
  motionDurationMs: number;
  forcedColors: boolean;
}

export interface WorkspaceSelectionAccessibilityKeyContext {
  key: string;
  editable?: boolean;
  composing?: boolean;
  defaultPrevented?: boolean;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface WorkspaceSelectionAccessibilityKeyDecision {
  accepted: boolean;
  preventDefault: boolean;
  intent?: WorkspaceSelectionAccessibilityIntent;
  action?: WorkspaceSelectionAction;
  focusElementId?: string;
}

const MAX_RESULTS = 1000;
const MAX_ID = 96;
const TOOLBAR_ID = 'result-selection-toolbar';
const STATUS_ID = 'result-selection-status';
const INSTRUCTIONS_ID = 'result-selection-instructions';

const cleanId = (value: unknown): string =>
  String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ID);

function uniqueIds(values: readonly string[] | undefined): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    if (result.length >= MAX_RESULTS) break;
    const id = cleanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

const actionElementId = (action: WorkspaceSelectionAction): string => `result-selection-action-${action}`;

function enabledActions(actions: readonly WorkspaceSelectionActionContract[]): readonly WorkspaceSelectionAction[] {
  return actions.filter((action) => !action.disabled).map((action) => action.action);
}

function chooseActiveAction(
  snapshot: WorkspaceSelectionSnapshot,
  preferred: WorkspaceSelectionAction | undefined,
): WorkspaceSelectionAction | undefined {
  const enabled = enabledActions(snapshot.actions);
  if (!enabled.length) return undefined;
  if (preferred && enabled.includes(preferred)) return preferred;
  return enabled[0];
}

function deriveActions(
  snapshot: WorkspaceSelectionSnapshot,
  activeAction: WorkspaceSelectionAction | undefined,
): readonly WorkspaceSelectionAccessibilityAction[] {
  return snapshot.actions.map((contract) => ({
    action: contract.action,
    elementId: actionElementId(contract.action),
    label: contract.label,
    disabled: contract.disabled,
    ariaDisabled: contract.disabled ? 'true' : 'false',
    tabIndex: !contract.disabled && contract.action === activeAction ? 0 : -1,
    touchTargetPx: contract.touchTargetPx,
  }));
}

function selectionInstructions(count: number): string {
  if (!count) return 'Sonuç seçildiğinde seçim araçları kullanılabilir.';
  return 'Seçim araçlarında Sol ve Sağ Ok tuşlarıyla ilerleyin. Enter veya Boşluk ile işlemi çalıştırın. Escape ile sonuçlara dönün.';
}

export function createArcGisResultWorkspaceSelectionAccessibilityExperience(
  input: WorkspaceSelectionAccessibilityInput,
): WorkspaceSelectionAccessibilitySnapshot {
  const { snapshot } = input;
  const resultIds = new Set(uniqueIds(input.resultIds));
  const selectedResultIds = snapshot.selectedIds.filter((id) => !resultIds.size || resultIds.has(id)).slice(0, MAX_RESULTS);
  const focusedResultId = snapshot.focusedId && selectedResultIds.includes(snapshot.focusedId)
    ? snapshot.focusedId
    : selectedResultIds[0];
  const activeAction = chooseActiveAction(snapshot, input.preferredAction);
  const modality = input.modality ?? 'keyboard';
  const trigger = cleanId(input.triggerElementId);
  const active = cleanId(input.activeElementId);
  const restoreFocusId = focusedResultId || trigger || (active && !active.startsWith(`${TOOLBAR_ID}-`) ? active : undefined);
  const environment = input.environment ?? {};
  return {
    toolbarId: TOOLBAR_ID,
    toolbarRole: 'toolbar',
    toolbarLabel: snapshot.toolbarLabel,
    toolbarHidden: !snapshot.toolbarVisible,
    toolbarTabIndex: snapshot.toolbarVisible && activeAction ? 0 : -1,
    actionOrientation: 'horizontal',
    actions: deriveActions(snapshot, activeAction),
    ...(activeAction ? { activeAction } : {}),
    selectedResultIds,
    selectedResultCount: selectedResultIds.length,
    ...(focusedResultId ? { focusedResultId } : {}),
    setSize: selectedResultIds.length,
    statusId: STATUS_ID,
    statusRole: 'status',
    statusLive: 'polite',
    statusAtomic: true,
    statusMessage: snapshot.statusMessage,
    instructionsId: INSTRUCTIONS_ID,
    instructions: selectionInstructions(selectedResultIds.length),
    ...(restoreFocusId ? { restoreFocusId } : {}),
    modality,
    focusVisible: modality === 'keyboard',
    touchTargetPx: environment.coarsePointer ? Math.max(48, snapshot.touchTargetPx) : Math.max(44, snapshot.touchTargetPx),
    motionDurationMs: environment.reducedMotion ? 0 : snapshot.motionDurationMs,
    forcedColors: Boolean(environment.forcedColors || snapshot.forcedColors),
  };
}

function rotateAction(
  actions: readonly WorkspaceSelectionAccessibilityAction[],
  current: WorkspaceSelectionAction | undefined,
  direction: 1 | -1,
): WorkspaceSelectionAccessibilityAction | undefined {
  const enabled = actions.filter((action) => !action.disabled);
  if (!enabled.length) return undefined;
  const currentIndex = enabled.findIndex((action) => action.action === current);
  const origin = currentIndex >= 0 ? currentIndex : 0;
  return enabled[(origin + direction + enabled.length) % enabled.length];
}

function edgeAction(
  actions: readonly WorkspaceSelectionAccessibilityAction[],
  edge: 'first' | 'last',
): WorkspaceSelectionAccessibilityAction | undefined {
  const enabled = actions.filter((action) => !action.disabled);
  return edge === 'first' ? enabled[0] : enabled[enabled.length - 1];
}

function suppressed(context: WorkspaceSelectionAccessibilityKeyContext): boolean {
  return Boolean(
    context.editable || context.composing || context.defaultPrevented || context.repeat ||
    context.altKey || context.ctrlKey || context.metaKey,
  );
}

export function resolveWorkspaceSelectionAccessibilityKey(
  snapshot: WorkspaceSelectionAccessibilitySnapshot,
  context: WorkspaceSelectionAccessibilityKeyContext,
): WorkspaceSelectionAccessibilityKeyDecision {
  if (snapshot.toolbarHidden || snapshot.modality !== 'keyboard' || suppressed(context)) {
    return { accepted: false, preventDefault: false };
  }
  if (context.key === 'Escape') {
    return {
      accepted: true,
      preventDefault: true,
      intent: 'dismiss-toolbar',
      ...(snapshot.restoreFocusId ? { focusElementId: snapshot.restoreFocusId } : {}),
    };
  }
  const direction = context.key === 'ArrowRight' || context.key === 'ArrowDown'
    ? 1
    : context.key === 'ArrowLeft' || context.key === 'ArrowUp'
      ? -1
      : undefined;
  if (direction) {
    const next = rotateAction(snapshot.actions, snapshot.activeAction, direction);
    return next
      ? { accepted: true, preventDefault: true, intent: 'focus-toolbar', action: next.action, focusElementId: next.elementId }
      : { accepted: false, preventDefault: false };
  }
  if (context.key === 'Home' || context.key === 'End') {
    const next = edgeAction(snapshot.actions, context.key === 'Home' ? 'first' : 'last');
    return next
      ? { accepted: true, preventDefault: true, intent: 'focus-toolbar', action: next.action, focusElementId: next.elementId }
      : { accepted: false, preventDefault: false };
  }
  if (context.key === 'Enter' || context.key === ' ') {
    const current = snapshot.actions.find((action) => action.action === snapshot.activeAction && !action.disabled);
    return current
      ? { accepted: true, preventDefault: true, intent: 'invoke-action', action: current.action, focusElementId: current.elementId }
      : { accepted: false, preventDefault: false };
  }
  return { accepted: false, preventDefault: false };
}

export function reconcileWorkspaceSelectionAccessibilityExperience(
  previous: WorkspaceSelectionAccessibilitySnapshot,
  input: WorkspaceSelectionAccessibilityInput,
): { next: WorkspaceSelectionAccessibilitySnapshot; announcement: string; focusElementId?: string } {
  const preferredAction = previous.activeAction ?? input.preferredAction;
  const next = createArcGisResultWorkspaceSelectionAccessibilityExperience({ ...input, preferredAction });
  const announcement = previous.statusMessage === next.statusMessage ? '' : next.statusMessage;
  if (previous.toolbarHidden && !next.toolbarHidden && next.activeAction) {
    return { next, announcement, focusElementId: actionElementId(next.activeAction) };
  }
  if (!previous.toolbarHidden && next.toolbarHidden) {
    return { next, announcement, ...(next.restoreFocusId ? { focusElementId: next.restoreFocusId } : {}) };
  }
  if (previous.activeAction && previous.activeAction !== next.activeAction && next.activeAction) {
    return { next, announcement, focusElementId: actionElementId(next.activeAction) };
  }
  return { next, announcement };
}