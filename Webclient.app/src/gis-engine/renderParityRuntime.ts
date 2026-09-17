export type RenderViewMode = '2d' | '3d';
export type RenderVisibilityReason = 'desired' | 'scale' | 'blocked' | 'budget' | 'disposed';
export type RenderOperationKind =
  | 'set-visible'
  | 'set-opacity'
  | 'set-scale-range'
  | 'set-renderer'
  | 'set-filter'
  | 'set-popup'
  | 'set-selection'
  | 'set-order'
  | 'set-elevation'
  | 'noop';

export interface RenderScaleRange {
  minScale?: number;
  maxScale?: number;
}

export interface SharedRendererDescriptor {
  key: string;
  iconKey?: string;
  symbolKind?: 'point' | 'line' | 'fill' | 'mesh' | 'unknown';
  size?: number;
  width?: number;
  opacity?: number;
  labelField?: string;
}

export interface RenderLayerState {
  id: string;
  revision: number;
  visible: boolean;
  effectiveVisible: boolean;
  visibilityReason: RenderVisibilityReason;
  opacity: number;
  order: number;
  minScale: number;
  maxScale: number;
  rendererKey: string | null;
  iconKey: string | null;
  filter: string | null;
  popupEnabled: boolean;
  selectedIds: readonly (string | number)[];
  elevationMode: string | null;
  blocked: boolean;
  disposed: boolean;
}

export interface DesiredRenderLayerState {
  id: string;
  revision?: number;
  visible?: boolean;
  opacity?: number;
  order?: number;
  scale?: RenderScaleRange;
  renderer?: SharedRendererDescriptor | null;
  filter?: string | null;
  popupEnabled?: boolean;
  selectedIds?: readonly (string | number)[];
  elevationMode?: string | null;
  blocked?: boolean;
}

export interface RenderReconcileContext {
  viewMode: RenderViewMode;
  scale?: number;
  allow3dElevation?: boolean;
  maxSelections?: number;
  renderBudgetExceeded?: boolean;
}

export interface RenderOperation {
  kind: RenderOperationKind;
  layerId: string;
  revision: number;
  payload: Readonly<Record<string, unknown>>;
}

export interface RenderParityResult {
  state: RenderLayerState;
  operations: readonly RenderOperation[];
  changed: boolean;
  parityFingerprint: string;
}

export interface RenderParitySnapshot {
  layers: number;
  reconciliations: number;
  operations: number;
  staleUpdates: number;
  blockedLayers: number;
  disposedLayers: number;
}

const finite = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeId = (value: unknown): string => {
  const id = String(value ?? '').trim();
  if (!id) throw new Error('Render layer id is required.');
  return id;
};

const normalizeScale = (value: unknown): number => Math.max(0, finite(value, 0));

const normalizeSelection = (
  values: readonly (string | number)[] | undefined,
  maxSelections: number,
): readonly (string | number)[] => {
  const seen = new Set<string>();
  const output: (string | number)[] = [];
  for (const value of values ?? []) {
    const key = `${typeof value}:${String(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= maxSelections) break;
  }
  return Object.freeze(output);
};

const normalizeRenderer = (renderer: SharedRendererDescriptor | null | undefined): SharedRendererDescriptor | null => {
  if (!renderer) return null;
  const key = String(renderer.key ?? '').trim();
  if (!key) throw new Error('Renderer descriptor key is required.');
  const iconKey = typeof renderer.iconKey === 'string' && renderer.iconKey.trim() ? renderer.iconKey.trim() : undefined;
  const labelField = typeof renderer.labelField === 'string' && renderer.labelField.trim() ? renderer.labelField.trim() : undefined;
  return Object.freeze({
    key,
    ...(iconKey ? { iconKey } : {}),
    ...(renderer.symbolKind ? { symbolKind: renderer.symbolKind } : {}),
    ...(Number.isFinite(renderer.size) ? { size: Math.max(0, Number(renderer.size)) } : {}),
    ...(Number.isFinite(renderer.width) ? { width: Math.max(0, Number(renderer.width)) } : {}),
    ...(Number.isFinite(renderer.opacity) ? { opacity: clamp(Number(renderer.opacity), 0, 1) } : {}),
    ...(labelField ? { labelField } : {}),
  });
};

const sameSelection = (
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

const operation = (
  kind: RenderOperationKind,
  layerId: string,
  revision: number,
  payload: Readonly<Record<string, unknown>> = {},
): RenderOperation => Object.freeze({ kind, layerId, revision, payload: Object.freeze({ ...payload }) });

const fingerprint = (state: RenderLayerState): string => {
  const serialized = [
    state.id,
    state.revision,
    state.visible ? 1 : 0,
    state.effectiveVisible ? 1 : 0,
    state.visibilityReason,
    state.opacity,
    state.order,
    state.minScale,
    state.maxScale,
    state.rendererKey ?? '',
    state.iconKey ?? '',
    state.filter ?? '',
    state.popupEnabled ? 1 : 0,
    state.selectedIds.map((value) => `${typeof value}:${String(value)}`).join(','),
    state.elevationMode ?? '',
    state.blocked ? 1 : 0,
    state.disposed ? 1 : 0,
  ].join('|');
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const scaleVisible = (scale: number, minScale: number, maxScale: number): boolean => {
  if (scale <= 0) return true;
  if (minScale > 0 && scale > minScale) return false;
  if (maxScale > 0 && scale < maxScale) return false;
  return true;
};

const visibility = (
  desiredVisible: boolean,
  blocked: boolean,
  disposed: boolean,
  withinScale: boolean,
  budgetExceeded: boolean,
): { effectiveVisible: boolean; reason: RenderVisibilityReason } => {
  if (disposed) return { effectiveVisible: false, reason: 'disposed' };
  if (blocked) return { effectiveVisible: false, reason: 'blocked' };
  if (!desiredVisible) return { effectiveVisible: false, reason: 'desired' };
  if (!withinScale) return { effectiveVisible: false, reason: 'scale' };
  if (budgetExceeded) return { effectiveVisible: false, reason: 'budget' };
  return { effectiveVisible: true, reason: 'desired' };
};

const createInitialState = (id: string): RenderLayerState => Object.freeze({
  id,
  revision: 0,
  visible: true,
  effectiveVisible: true,
  visibilityReason: 'desired',
  opacity: 1,
  order: 0,
  minScale: 0,
  maxScale: 0,
  rendererKey: null,
  iconKey: null,
  filter: null,
  popupEnabled: true,
  selectedIds: Object.freeze([]),
  elevationMode: null,
  blocked: false,
  disposed: false,
});

export const reconcileRenderLayerState = (
  currentInput: RenderLayerState | null,
  desired: DesiredRenderLayerState,
  context: RenderReconcileContext,
): RenderParityResult => {
  const id = normalizeId(desired.id);
  const current = currentInput ?? createInitialState(id);
  if (current.id !== id) throw new Error(`Render state id mismatch: ${current.id} !== ${id}`);

  const requestedRevision = Math.max(current.revision + 1, Math.floor(finite(desired.revision, current.revision + 1)));
  const maxSelections = Math.max(1, Math.min(10_000, Math.floor(finite(context.maxSelections, 256))));
  const renderer = normalizeRenderer(desired.renderer);
  const visible = desired.visible ?? current.visible;
  const opacity = clamp(finite(desired.opacity, current.opacity), 0, 1);
  const order = Math.floor(finite(desired.order, current.order));
  const minScale = normalizeScale(desired.scale?.minScale ?? current.minScale);
  const maxScale = normalizeScale(desired.scale?.maxScale ?? current.maxScale);
  const blocked = desired.blocked ?? current.blocked;
  const selectedIds = normalizeSelection(desired.selectedIds ?? current.selectedIds, maxSelections);
  const filter = desired.filter === undefined ? current.filter : desired.filter;
  const popupEnabled = desired.popupEnabled ?? current.popupEnabled;
  const requestedElevation = desired.elevationMode === undefined ? current.elevationMode : desired.elevationMode;
  const elevationMode = context.viewMode === '3d' && context.allow3dElevation !== false ? requestedElevation : null;
  const rendererKey = desired.renderer === undefined ? current.rendererKey : renderer?.key ?? null;
  const iconKey = desired.renderer === undefined ? current.iconKey : renderer?.iconKey ?? null;
  const withinScale = scaleVisible(normalizeScale(context.scale), minScale, maxScale);
  const effective = visibility(visible, blocked, current.disposed, withinScale, context.renderBudgetExceeded === true);
  const operations: RenderOperation[] = [];

  if (current.effectiveVisible !== effective.effectiveVisible) {
    operations.push(operation('set-visible', id, requestedRevision, {
      visible: effective.effectiveVisible,
      reason: effective.reason,
    }));
  }
  if (current.opacity !== opacity) operations.push(operation('set-opacity', id, requestedRevision, { opacity }));
  if (current.minScale !== minScale || current.maxScale !== maxScale) {
    operations.push(operation('set-scale-range', id, requestedRevision, { minScale, maxScale }));
  }
  if (current.rendererKey !== rendererKey || current.iconKey !== iconKey) {
    operations.push(operation('set-renderer', id, requestedRevision, {
      rendererKey,
      iconKey,
      descriptor: renderer,
    }));
  }
  if (current.filter !== filter) operations.push(operation('set-filter', id, requestedRevision, { filter }));
  if (current.popupEnabled !== popupEnabled) operations.push(operation('set-popup', id, requestedRevision, { enabled: popupEnabled }));
  if (!sameSelection(current.selectedIds, selectedIds)) {
    operations.push(operation('set-selection', id, requestedRevision, { selectedIds }));
  }
  if (current.order !== order) operations.push(operation('set-order', id, requestedRevision, { order }));
  if (current.elevationMode !== elevationMode) {
    operations.push(operation('set-elevation', id, requestedRevision, { elevationMode, viewMode: context.viewMode }));
  }

  const state: RenderLayerState = Object.freeze({
    id,
    revision: requestedRevision,
    visible,
    effectiveVisible: effective.effectiveVisible,
    visibilityReason: effective.reason,
    opacity,
    order,
    minScale,
    maxScale,
    rendererKey,
    iconKey,
    filter,
    popupEnabled,
    selectedIds,
    elevationMode,
    blocked,
    disposed: current.disposed,
  });

  return Object.freeze({
    state,
    operations: Object.freeze(operations.length ? operations : [operation('noop', id, requestedRevision)]),
    changed: operations.length > 0,
    parityFingerprint: fingerprint(state),
  });
};

export class RenderParityRuntime {
  #states = new Map<string, RenderLayerState>();
  #reconciliations = 0;
  #operations = 0;
  #staleUpdates = 0;

  reconcile(desired: DesiredRenderLayerState, context: RenderReconcileContext): RenderParityResult {
    const id = normalizeId(desired.id);
    const current = this.#states.get(id) ?? null;
    if (current?.disposed) {
      const result = reconcileRenderLayerState(current, { ...desired, visible: false, blocked: true }, context);
      this.#reconciliations += 1;
      this.#operations += result.operations.filter((item) => item.kind !== 'noop').length;
      return result;
    }
    if (current && desired.revision !== undefined && desired.revision <= current.revision) {
      this.#staleUpdates += 1;
      return Object.freeze({
        state: current,
        operations: Object.freeze([operation('noop', id, current.revision, { stale: true })]),
        changed: false,
        parityFingerprint: fingerprint(current),
      });
    }

    const result = reconcileRenderLayerState(current, desired, context);
    this.#states.set(id, result.state);
    this.#reconciliations += 1;
    this.#operations += result.operations.filter((item) => item.kind !== 'noop').length;
    return result;
  }

  setBlocked(idInput: string, blocked: boolean, context: RenderReconcileContext): RenderParityResult {
    const id = normalizeId(idInput);
    const current = this.#states.get(id) ?? createInitialState(id);
    return this.reconcile({ id, revision: current.revision + 1, blocked }, context);
  }

  disposeLayer(idInput: string): RenderLayerState | null {
    const id = normalizeId(idInput);
    const current = this.#states.get(id);
    if (!current || current.disposed) return current ?? null;
    const disposed = Object.freeze({
      ...current,
      revision: current.revision + 1,
      effectiveVisible: false,
      visibilityReason: 'disposed' as const,
      selectedIds: Object.freeze([]),
      blocked: true,
      disposed: true,
    });
    this.#states.set(id, disposed);
    return disposed;
  }

  removeLayer(idInput: string): boolean {
    return this.#states.delete(normalizeId(idInput));
  }

  getState(idInput: string): RenderLayerState | null {
    return this.#states.get(normalizeId(idInput)) ?? null;
  }

  getStates(): readonly RenderLayerState[] {
    return Object.freeze(
      [...this.#states.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    );
  }

  snapshot(): RenderParitySnapshot {
    const states = [...this.#states.values()];
    return Object.freeze({
      layers: states.length,
      reconciliations: this.#reconciliations,
      operations: this.#operations,
      staleUpdates: this.#staleUpdates,
      blockedLayers: states.filter((state) => state.blocked).length,
      disposedLayers: states.filter((state) => state.disposed).length,
    });
  }

  reset(): void {
    this.#states.clear();
    this.#reconciliations = 0;
    this.#operations = 0;
    this.#staleUpdates = 0;
  }
}

export const createRenderParityRuntime = (): RenderParityRuntime => new RenderParityRuntime();
