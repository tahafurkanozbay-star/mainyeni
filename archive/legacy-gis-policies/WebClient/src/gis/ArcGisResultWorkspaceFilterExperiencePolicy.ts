import {
  createResultFilterState,
  describeResultFilterChange,
  reduceResultFilterState,
  type ResultFilterAction,
  type ResultFilterClause,
  type ResultFilterDefinition,
  type ResultFilterOperator,
  type ResultFilterState,
  type ResultFilterViewport,
} from './ArcGisResultFilterExperiencePolicy';

export type WorkspaceFilterModality = 'keyboard' | 'pointer' | 'touch';
export type WorkspaceFilterFocusTarget = 'trigger' | 'panel' | 'first-invalid' | 'apply' | 'clear' | 'none';
export type WorkspaceFilterDismissReason = 'escape' | 'apply' | 'cancel' | 'outside' | 'viewport-change';

export interface WorkspaceFilterEnvironment {
  viewportWidth?: number;
  viewportHeight?: number;
  coarsePointer?: boolean;
  reducedMotion?: boolean;
  forcedColors?: boolean;
}

export interface WorkspaceFilterInput {
  definitions: readonly ResultFilterDefinition[];
  clauses?: readonly ResultFilterClause[];
  draftClauses?: readonly ResultFilterClause[];
  panelOpen?: boolean;
}

export interface WorkspaceFilterFieldContract {
  id: string;
  clauseId: string;
  filterId: string;
  label: string;
  kind: ResultFilterDefinition['kind'];
  operator: ResultFilterOperator;
  value: string;
  secondaryValue?: string;
  invalid: boolean;
  errorId?: string;
  describedBy?: string;
  inputMode: 'text' | 'decimal' | 'none';
  touchTargetPx: number;
}

export interface WorkspaceFilterPanelContract {
  id: string;
  role: 'region' | 'dialog';
  modal: boolean;
  hidden: boolean;
  label: string;
  tabIndex: 0 | -1;
  trapFocus: boolean;
  restoreFocusOnClose: boolean;
  dismissOnOutsidePointer: boolean;
}

export interface WorkspaceFilterTriggerContract {
  id: string;
  controls: string;
  expanded: boolean;
  hasPopup: 'dialog' | false;
  label: string;
  touchTargetPx: number;
}

export interface WorkspaceFilterLiveContract {
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  message: string;
}

export interface WorkspaceFilterSnapshot {
  state: ResultFilterState;
  environment: Required<WorkspaceFilterEnvironment>;
  modality: WorkspaceFilterModality;
  trigger: WorkspaceFilterTriggerContract;
  panel: WorkspaceFilterPanelContract;
  fields: readonly WorkspaceFilterFieldContract[];
  live: WorkspaceFilterLiveContract;
  focusTarget: WorkspaceFilterFocusTarget;
  focusTargetId?: string;
  dirty: boolean;
  canApply: boolean;
  canClear: boolean;
  motionDurationMs: number;
  forcedColors: boolean;
}

export interface WorkspaceFilterTransition {
  next: WorkspaceFilterSnapshot;
  changed: boolean;
  announcement: string;
  focusTarget: WorkspaceFilterFocusTarget;
  focusTargetId?: string;
  dismissReason?: WorkspaceFilterDismissReason;
}

export interface WorkspaceFilterShortcutContext {
  editable?: boolean;
  composing?: boolean;
  disabled?: boolean;
  defaultPrevented?: boolean;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MAX_ID = 72;

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const cleanId = (value: unknown): string => {
  const source = String(value ?? '').normalize('NFKC').toLocaleLowerCase('tr-TR');
  const cleaned = source
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-z0-9çğıöşü_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID);
  return cleaned || 'results';
};

const cleanText = (value: unknown, max = 180): string =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function normalizeEnvironment(input: WorkspaceFilterEnvironment = {}): Required<WorkspaceFilterEnvironment> {
  return {
    viewportWidth: Math.max(0, finite(input.viewportWidth, DEFAULT_WIDTH)),
    viewportHeight: Math.max(0, finite(input.viewportHeight, DEFAULT_HEIGHT)),
    coarsePointer: Boolean(input.coarsePointer),
    reducedMotion: Boolean(input.reducedMotion),
    forcedColors: Boolean(input.forcedColors),
  };
}

function viewportWidth(viewport: ResultFilterViewport): number {
  if (viewport === 'phone') return 390;
  if (viewport === 'tablet') return 800;
  return 1280;
}

function touchTarget(environment: Required<WorkspaceFilterEnvironment>): number {
  return environment.coarsePointer ? 48 : 44;
}

function definitionMap(definitions: readonly ResultFilterDefinition[]): ReadonlyMap<string, ResultFilterDefinition> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function fieldInputMode(kind: ResultFilterDefinition['kind']): WorkspaceFilterFieldContract['inputMode'] {
  if (kind === 'number') return 'decimal';
  if (kind === 'choice') return 'none';
  return 'text';
}

function createFields(state: ResultFilterState, scope: string, environment: Required<WorkspaceFilterEnvironment>): readonly WorkspaceFilterFieldContract[] {
  const definitions = definitionMap(state.definitions);
  const invalid = new Set(state.invalidClauseIds);
  return state.draftClauses.map((clause) => {
    const definition = definitions.get(clause.filterId);
    const fieldId = `${scope}-filter-${cleanId(clause.id)}`;
    const isInvalid = invalid.has(clause.id);
    const errorId = isInvalid ? `${fieldId}-error` : undefined;
    return {
      id: fieldId,
      clauseId: clause.id,
      filterId: clause.filterId,
      label: definition?.label ?? clause.filterId,
      kind: definition?.kind ?? 'text',
      operator: clause.operator,
      value: clause.value,
      ...(clause.secondaryValue === undefined ? {} : { secondaryValue: clause.secondaryValue }),
      invalid: isInvalid,
      ...(errorId ? { errorId, describedBy: errorId } : {}),
      inputMode: fieldInputMode(definition?.kind ?? 'text'),
      touchTargetPx: touchTarget(environment),
    };
  });
}

function panelContract(state: ResultFilterState, scope: string): WorkspaceFilterPanelContract {
  const overlay = state.viewport !== 'desktop';
  const visible = overlay ? state.panelOpen : true;
  return {
    id: `${scope}-filter-panel`,
    role: overlay ? 'dialog' : 'region',
    modal: overlay && state.panelOpen,
    hidden: !visible,
    label: state.panelLabel,
    tabIndex: visible ? 0 : -1,
    trapFocus: overlay && state.panelOpen,
    restoreFocusOnClose: overlay,
    dismissOnOutsidePointer: overlay && state.panelOpen,
  };
}

function triggerContract(state: ResultFilterState, scope: string, environment: Required<WorkspaceFilterEnvironment>): WorkspaceFilterTriggerContract {
  const overlay = state.viewport !== 'desktop';
  return {
    id: `${scope}-filter-trigger`,
    controls: `${scope}-filter-panel`,
    expanded: overlay ? state.panelOpen : true,
    hasPopup: overlay ? 'dialog' : false,
    label: state.panelLabel,
    touchTargetPx: touchTarget(environment),
  };
}

function liveContract(state: ResultFilterState, message = ''): WorkspaceFilterLiveContract {
  const invalid = state.invalidClauseIds.length > 0;
  return {
    role: invalid && message ? 'alert' : 'status',
    ariaLive: invalid && message ? 'assertive' : 'polite',
    message: cleanText(message),
  };
}

function focusForState(state: ResultFilterState, scope: string): { target: WorkspaceFilterFocusTarget; id?: string } {
  if (state.viewport !== 'desktop' && !state.panelOpen) return { target: 'trigger', id: `${scope}-filter-trigger` };
  if (state.invalidClauseIds.length) {
    const invalidId = cleanId(state.invalidClauseIds[0]);
    return { target: 'first-invalid', id: `${scope}-filter-${invalidId}` };
  }
  return { target: 'panel', id: `${scope}-filter-panel` };
}

function snapshotFromState(
  state: ResultFilterState,
  environment: Required<WorkspaceFilterEnvironment>,
  modality: WorkspaceFilterModality,
  scope: string,
  message = '',
  explicitFocus?: { target: WorkspaceFilterFocusTarget; id?: string },
): WorkspaceFilterSnapshot {
  const focus = explicitFocus ?? focusForState(state, scope);
  return {
    state,
    environment,
    modality,
    trigger: triggerContract(state, scope, environment),
    panel: panelContract(state, scope),
    fields: createFields(state, scope, environment),
    live: liveContract(state, message),
    focusTarget: focus.target,
    ...(focus.id ? { focusTargetId: focus.id } : {}),
    dirty: state.dirty,
    canApply: state.dirty && state.invalidClauseIds.length === 0,
    canClear: state.clauses.length > 0 || state.draftClauses.length > 0,
    motionDurationMs: environment.reducedMotion ? 0 : 160,
    forcedColors: environment.forcedColors,
  };
}

export function createArcGisResultWorkspaceFilterExperience(
  input: WorkspaceFilterInput,
  environmentInput: WorkspaceFilterEnvironment = {},
  modality: WorkspaceFilterModality = 'keyboard',
  scopeInput = 'results',
): WorkspaceFilterSnapshot {
  const environment = normalizeEnvironment(environmentInput);
  const scope = cleanId(scopeInput);
  const state = createResultFilterState({
    definitions: input.definitions,
    clauses: input.clauses,
    draftClauses: input.draftClauses,
    panelOpen: input.panelOpen,
    viewportWidth: environment.viewportWidth,
  });
  return snapshotFromState(state, environment, modality, scope);
}

function stateScope(snapshot: WorkspaceFilterSnapshot): string {
  return snapshot.panel.id.replace(/-filter-panel$/, '') || 'results';
}

function applyStateAction(snapshot: WorkspaceFilterSnapshot, action: ResultFilterAction): ResultFilterState {
  return reduceResultFilterState(snapshot.state, action);
}

export function applyArcGisResultWorkspaceFilterAction(
  snapshot: WorkspaceFilterSnapshot,
  action: ResultFilterAction,
  modality: WorkspaceFilterModality = snapshot.modality,
): WorkspaceFilterTransition {
  const scope = stateScope(snapshot);
  const previous = snapshot.state;
  const nextState = applyStateAction(snapshot, action);
  const announcement = describeResultFilterChange(previous, nextState);
  let focus: { target: WorkspaceFilterFocusTarget; id?: string } | undefined;
  let dismissReason: WorkspaceFilterDismissReason | undefined;

  if (action.type === 'apply' && previous.invalidClauseIds.length) {
    const invalidId = cleanId(previous.invalidClauseIds[0]);
    focus = { target: 'first-invalid', id: `${scope}-filter-${invalidId}` };
  } else if (action.type === 'apply') {
    dismissReason = 'apply';
    focus = nextState.viewport === 'desktop'
      ? { target: 'panel', id: `${scope}-filter-panel` }
      : { target: 'trigger', id: `${scope}-filter-trigger` };
  } else if (action.type === 'cancel') {
    dismissReason = 'cancel';
    focus = nextState.viewport === 'desktop'
      ? { target: 'panel', id: `${scope}-filter-panel` }
      : { target: 'trigger', id: `${scope}-filter-trigger` };
  } else if (action.type === 'open') {
    focus = { target: 'panel', id: `${scope}-filter-panel` };
  } else if (action.type === 'close') {
    focus = { target: 'trigger', id: `${scope}-filter-trigger` };
  }

  const next = snapshotFromState(nextState, snapshot.environment, modality, scope, announcement, focus);
  return {
    next,
    changed: JSON.stringify(previous) !== JSON.stringify(nextState),
    announcement,
    focusTarget: next.focusTarget,
    ...(next.focusTargetId ? { focusTargetId: next.focusTargetId } : {}),
    ...(dismissReason ? { dismissReason } : {}),
  };
}

export function reconcileArcGisResultWorkspaceFilterEnvironment(
  snapshot: WorkspaceFilterSnapshot,
  environmentInput: WorkspaceFilterEnvironment,
): WorkspaceFilterTransition {
  const environment = normalizeEnvironment(environmentInput);
  const scope = stateScope(snapshot);
  const nextState = createResultFilterState({
    definitions: snapshot.state.definitions,
    clauses: snapshot.state.clauses,
    draftClauses: snapshot.state.draftClauses,
    panelOpen: snapshot.state.panelOpen,
    viewportWidth: environment.viewportWidth,
  });
  const viewportChanged = nextState.viewport !== snapshot.state.viewport;
  const closedByViewport = viewportChanged && snapshot.state.panelOpen && !nextState.panelOpen;
  const focus = closedByViewport
    ? { target: 'trigger' as const, id: `${scope}-filter-trigger` }
    : undefined;
  const next = snapshotFromState(nextState, environment, snapshot.modality, scope, '', focus);
  return {
    next,
    changed: viewportChanged || JSON.stringify(snapshot.environment) !== JSON.stringify(environment),
    announcement: '',
    focusTarget: next.focusTarget,
    ...(next.focusTargetId ? { focusTargetId: next.focusTargetId } : {}),
    ...(closedByViewport ? { dismissReason: 'viewport-change' as const } : {}),
  };
}

export function dismissArcGisResultWorkspaceFilter(
  snapshot: WorkspaceFilterSnapshot,
  reason: 'escape' | 'outside',
): WorkspaceFilterTransition {
  if (snapshot.state.viewport === 'desktop' || !snapshot.state.panelOpen) {
    return {
      next: snapshot,
      changed: false,
      announcement: '',
      focusTarget: snapshot.focusTarget,
      ...(snapshot.focusTargetId ? { focusTargetId: snapshot.focusTargetId } : {}),
    };
  }
  const scope = stateScope(snapshot);
  const nextState = reason === 'escape'
    ? reduceResultFilterState(snapshot.state, { type: 'cancel' })
    : reduceResultFilterState(snapshot.state, { type: 'close' });
  const focus = { target: 'trigger' as const, id: `${scope}-filter-trigger` };
  const message = reason === 'escape' && snapshot.state.dirty ? 'Filtre değişiklikleri iptal edildi' : '';
  const next = snapshotFromState(nextState, snapshot.environment, snapshot.modality, scope, message, focus);
  return {
    next,
    changed: true,
    announcement: message,
    focusTarget: 'trigger',
    focusTargetId: focus.id,
    dismissReason: reason,
  };
}

export function shouldSuppressWorkspaceFilterShortcut(
  modality: WorkspaceFilterModality,
  context: WorkspaceFilterShortcutContext = {},
): boolean {
  if (context.disabled || context.defaultPrevented || context.composing) return true;
  if (context.editable) return true;
  return modality !== 'keyboard';
}

export function resolveWorkspaceFilterEscape(
  snapshot: WorkspaceFilterSnapshot,
  context: WorkspaceFilterShortcutContext = {},
): WorkspaceFilterTransition {
  if (shouldSuppressWorkspaceFilterShortcut(snapshot.modality, context)) {
    return {
      next: snapshot,
      changed: false,
      announcement: '',
      focusTarget: snapshot.focusTarget,
      ...(snapshot.focusTargetId ? { focusTargetId: snapshot.focusTargetId } : {}),
    };
  }
  return dismissArcGisResultWorkspaceFilter(snapshot, 'escape');
}

export function resolveWorkspaceFilterFieldError(snapshot: WorkspaceFilterSnapshot, clauseId: string): string {
  const field = snapshot.fields.find((candidate) => candidate.clauseId === cleanText(clauseId, 80));
  if (!field?.invalid) return '';
  const definition = snapshot.state.definitions.find((candidate) => candidate.id === field.filterId);
  if (!definition) return 'Filtre değerini kontrol edin.';
  if (definition.kind === 'number') return 'Geçerli bir sayı girin.';
  if (definition.kind === 'date') return 'Geçerli bir tarih girin.';
  if (definition.kind === 'choice') return 'Listeden geçerli bir seçenek belirleyin.';
  return 'Filtre değerini kontrol edin.';
}

export function resolveWorkspaceFilterActionOrder(snapshot: WorkspaceFilterSnapshot): readonly WorkspaceFilterFocusTarget[] {
  const result: WorkspaceFilterFocusTarget[] = ['panel'];
  if (snapshot.state.invalidClauseIds.length) result.push('first-invalid');
  if (snapshot.canClear) result.push('clear');
  if (snapshot.canApply) result.push('apply');
  if (snapshot.state.viewport !== 'desktop') result.push('trigger');
  return result;
}
