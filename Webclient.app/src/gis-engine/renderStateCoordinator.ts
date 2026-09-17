export type GisViewMode = '2d' | '3d';
export type LayerRenderStatus = 'hidden' | 'loading' | 'ready' | 'error';

export interface LayerRenderIntent {
  readonly layerId: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly selectedObjectIds?: readonly (string | number)[];
  readonly highlightedObjectIds?: readonly (string | number)[];
}

export interface RenderFrameFacts {
  readonly mode: GisViewMode;
  readonly scale: number;
}

export interface LayerRenderState {
  readonly layerId: string;
  readonly mode: GisViewMode;
  readonly status: LayerRenderStatus;
  readonly visible: boolean;
  readonly opacity: number;
  readonly selectedObjectIds: readonly string[];
  readonly highlightedObjectIds: readonly string[];
  readonly revision: number;
  readonly error?: string;
}

export interface RenderStateSnapshot {
  readonly mode: GisViewMode;
  readonly revision: number;
  readonly layers: readonly LayerRenderState[];
}

export interface RenderStateCoordinator {
  reconcile(frame: RenderFrameFacts, intents: readonly LayerRenderIntent[]): RenderStateSnapshot;
  markLoading(layerId: string): RenderStateSnapshot;
  markReady(layerId: string): RenderStateSnapshot;
  markError(layerId: string, message: string): RenderStateSnapshot;
  releaseLayer(layerId: string): RenderStateSnapshot;
  clearTransientState(): RenderStateSnapshot;
  snapshot(): RenderStateSnapshot;
  dispose(): void;
}

type StateInput = Omit<LayerRenderState, 'revision'>;
type StatePatch = Partial<Omit<StateInput, 'error'>> & { error?: string | undefined };

type PreparedIntent = Readonly<{
  layerId: string;
  intent: LayerRenderIntent;
}>;

const normalizeObjectIds = (
  values: readonly (string | number)[] | undefined,
): readonly string[] => {
  const unique = (values ?? []).reduce<Set<string>>((output, value) => {
    const normalized = typeof value === 'number'
      ? (Number.isFinite(value) ? String(value) : '')
      : value.trim();
    if (normalized) output.add(normalized);
    return output;
  }, new Set<string>());

  return Object.freeze(
    Array.from(unique).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
  );
};

const normalizeOpacity = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
};

const isVisibleAtScale = (intent: LayerRenderIntent, scale: number): boolean => {
  if (intent.minScale && scale > intent.minScale) return false;
  if (intent.maxScale && scale < intent.maxScale) return false;
  return true;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameState = (current: LayerRenderState, next: StateInput): boolean =>
  current.layerId === next.layerId
  && current.mode === next.mode
  && current.status === next.status
  && current.visible === next.visible
  && current.opacity === next.opacity
  && current.error === next.error
  && sameIds(current.selectedObjectIds, next.selectedObjectIds)
  && sameIds(current.highlightedObjectIds, next.highlightedObjectIds);

const applyPatch = (current: LayerRenderState, patch: StatePatch): StateInput => {
  const error = Object.prototype.hasOwnProperty.call(patch, 'error')
    ? patch.error
    : current.error;

  return {
    layerId: patch.layerId ?? current.layerId,
    mode: patch.mode ?? current.mode,
    status: patch.status ?? current.status,
    visible: patch.visible ?? current.visible,
    opacity: patch.opacity ?? current.opacity,
    selectedObjectIds: patch.selectedObjectIds ?? current.selectedObjectIds,
    highlightedObjectIds: patch.highlightedObjectIds ?? current.highlightedObjectIds,
    ...(error === undefined ? {} : { error }),
  };
};

const validateFrame = (frame: RenderFrameFacts): void => {
  if (
    (frame.mode !== '2d' && frame.mode !== '3d')
    || !Number.isFinite(frame.scale)
    || frame.scale <= 0
  ) {
    throw new Error('Invalid render frame');
  }
};

const prepareIntents = (intents: readonly LayerRenderIntent[]): readonly PreparedIntent[] => {
  const seen = new Set<string>();

  return Object.freeze(intents.map((intent) => {
    const layerId = intent.layerId.trim();
    if (!layerId) throw new Error('Layer id must not be blank');
    if (seen.has(layerId)) throw new Error(`Duplicate layer render intent: ${layerId}`);
    seen.add(layerId);
    return Object.freeze({ layerId, intent });
  }));
};

/**
 * Renderer-neutral state coordinator shared by 2D and 3D presentation layers.
 *
 * Reconciliation is deliberately split into validation/preparation and mutation.
 * This prevents malformed or duplicate layer intents from leaving a partially
 * mutated render state. The coordinator owns only logical state; concrete ArcGIS
 * views/renderers remain outside this boundary.
 */
export function createRenderStateCoordinator(
  initialMode: GisViewMode = '2d',
): RenderStateCoordinator {
  let mode = initialMode;
  let revision = 0;
  let disposed = false;
  const states = new Map<string, LayerRenderState>();

  const assertActive = (): void => {
    if (disposed) throw new Error('Render state coordinator is disposed');
  };

  const snapshot = (): RenderStateSnapshot => Object.freeze({
    mode,
    revision,
    layers: Object.freeze(
      Array.from(states.values()).sort((left, right) => left.layerId.localeCompare(right.layerId)),
    ),
  });

  const replace = (layerId: string, next: StateInput): void => {
    const current = states.get(layerId);
    if (current && sameState(current, next)) return;

    revision += 1;
    states.set(layerId, Object.freeze({ ...next, revision }));
  };

  const changeStatus = (
    rawLayerId: string,
    nextStatus: LayerRenderStatus,
    error?: string,
  ): RenderStateSnapshot => {
    assertActive();
    const current = states.get(rawLayerId.trim());
    if (!current) return snapshot();

    replace(
      current.layerId,
      applyPatch(
        current,
        nextStatus === 'error'
          ? { status: nextStatus, error }
          : { status: nextStatus, error: undefined },
      ),
    );
    return snapshot();
  };

  const reconcile = (
    frame: RenderFrameFacts,
    intents: readonly LayerRenderIntent[],
  ): RenderStateSnapshot => {
    assertActive();
    validateFrame(frame);

    // Prepare and validate every intent before mutating coordinator state.
    const prepared = prepareIntents(intents);
    const desiredLayerIds = new Set(prepared.map(({ layerId }) => layerId));

    if (mode !== frame.mode) {
      mode = frame.mode;
      revision += 1;
    }

    prepared.reduce((_, { layerId, intent }) => {
      const current = states.get(layerId);
      const visible = intent.visible && isVisibleAtScale(intent, frame.scale);
      const status: LayerRenderStatus = visible
        ? (current?.status === 'error' ? 'error' : current?.status ?? 'loading')
        : 'hidden';
      const error = status === 'error' ? current?.error : undefined;

      replace(layerId, {
        layerId,
        mode,
        status,
        visible,
        opacity: normalizeOpacity(intent.opacity),
        selectedObjectIds: normalizeObjectIds(intent.selectedObjectIds),
        highlightedObjectIds: normalizeObjectIds(intent.highlightedObjectIds),
        ...(error === undefined ? {} : { error }),
      });
      return undefined;
    }, undefined as undefined);

    Array.from(states.keys())
      .filter((layerId) => !desiredLayerIds.has(layerId))
      .reduce((_, layerId) => {
        if (states.delete(layerId)) revision += 1;
        return undefined;
      }, undefined as undefined);

    return snapshot();
  };

  const clearTransientState = (): RenderStateSnapshot => {
    assertActive();

    Array.from(states.entries())
      .filter(([, state]) => state.selectedObjectIds.length > 0 || state.highlightedObjectIds.length > 0)
      .reduce((_, [layerId, state]) => {
        replace(layerId, applyPatch(state, {
          selectedObjectIds: Object.freeze([]),
          highlightedObjectIds: Object.freeze([]),
        }));
        return undefined;
      }, undefined as undefined);

    return snapshot();
  };

  return Object.freeze({
    reconcile,
    markLoading(layerId: string) {
      return changeStatus(layerId, 'loading');
    },
    markReady(layerId: string) {
      return changeStatus(layerId, 'ready');
    },
    markError(layerId: string, message: string) {
      return changeStatus(layerId, 'error', message.trim() || 'Layer render failed');
    },
    releaseLayer(layerId: string) {
      assertActive();
      if (states.delete(layerId.trim())) revision += 1;
      return snapshot();
    },
    clearTransientState,
    snapshot() {
      assertActive();
      return snapshot();
    },
    dispose() {
      if (disposed) return;
      states.clear();
      revision += 1;
      disposed = true;
    },
  });
}
