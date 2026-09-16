export type GisViewMode = "2d" | "3d";
export type LayerRenderStatus = "hidden" | "loading" | "ready" | "error";

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

function normalizeId(value: string | number): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeIds(values: readonly (string | number)[] | undefined): readonly string[] {
  if (!values?.length) return [];
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeId(value);
    if (normalized !== null) unique.add(normalized);
  }
  return [...unique].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function normalizeOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function isScaleVisible(intent: LayerRenderIntent, scale: number): boolean {
  if (!Number.isFinite(scale) || scale <= 0) return false;
  if (intent.minScale !== undefined && Number.isFinite(intent.minScale) && intent.minScale > 0 && scale > intent.minScale) return false;
  if (intent.maxScale !== undefined && Number.isFinite(intent.maxScale) && intent.maxScale > 0 && scale < intent.maxScale) return false;
  return true;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameState(a: LayerRenderState, b: Omit<LayerRenderState, "revision">): boolean {
  return a.layerId === b.layerId && a.mode === b.mode && a.status === b.status && a.visible === b.visible &&
    a.opacity === b.opacity && a.error === b.error && sameIds(a.selectedObjectIds, b.selectedObjectIds) &&
    sameIds(a.highlightedObjectIds, b.highlightedObjectIds);
}

export function createRenderStateCoordinator(initialMode: GisViewMode = "2d"): RenderStateCoordinator {
  let mode = initialMode;
  let revision = 0;
  let disposed = false;
  const states = new Map<string, LayerRenderState>();

  const assertActive = () => {
    if (disposed) throw new Error("Render state coordinator is disposed");
  };

  const makeSnapshot = (): RenderStateSnapshot => ({
    mode,
    revision,
    layers: [...states.values()].sort((a, b) => a.layerId.localeCompare(b.layerId)),
  });

  const replace = (layerId: string, next: Omit<LayerRenderState, "revision">): void => {
    const current = states.get(layerId);
    if (current && sameState(current, next)) return;
    revision += 1;
    states.set(layerId, { ...next, revision });
  };

  const mutateStatus = (layerId: string, status: LayerRenderStatus, error?: string): RenderStateSnapshot => {
    assertActive();
    const current = states.get(layerId);
    if (!current) return makeSnapshot();
    replace(layerId, { ...current, status, error, revision: undefined as never });
    return makeSnapshot();
  };

  return {
    reconcile(frame, intents) {
      assertActive();
      if (frame.mode !== "2d" && frame.mode !== "3d") throw new Error("Unsupported GIS view mode");
      if (!Number.isFinite(frame.scale) || frame.scale <= 0) throw new Error("Frame scale must be a positive finite number");

      const seen = new Set<string>();
      const nextMode = frame.mode;
      if (mode !== nextMode) {
        mode = nextMode;
        revision += 1;
      }

      for (const intent of intents) {
        const layerId = intent.layerId.trim();
        if (!layerId) throw new Error("Layer id must not be blank");
        if (seen.has(layerId)) throw new Error(`Duplicate layer render intent: ${layerId}`);
        seen.add(layerId);

        const current = states.get(layerId);
        const visible = intent.visible && isScaleVisible(intent, frame.scale);
        const selectedObjectIds = normalizeIds(intent.selectedObjectIds);
        const highlightedObjectIds = normalizeIds(intent.highlightedObjectIds);
        const status: LayerRenderStatus = visible ? (current?.status === "error" ? "error" : current?.status ?? "loading") : "hidden";

        replace(layerId, {
          layerId,
          mode,
          status,
          visible,
          opacity: normalizeOpacity(intent.opacity),
          selectedObjectIds,
          highlightedObjectIds,
          error: status === "error" ? current?.error : undefined,
        });
      }

      for (const layerId of [...states.keys()]) {
        if (!seen.has(layerId)) {
          states.delete(layerId);
          revision += 1;
        }
      }
      return makeSnapshot();
    },

    markLoading(layerId) { return mutateStatus(layerId.trim(), "loading"); },
    markReady(layerId) { return mutateStatus(layerId.trim(), "ready"); },
    markError(layerId, message) {
      const normalized = message.trim() || "Layer render failed";
      return mutateStatus(layerId.trim(), "error", normalized);
    },
    releaseLayer(layerId) {
      assertActive();
      if (states.delete(layerId.trim())) revision += 1;
      return makeSnapshot();
    },
    clearTransientState() {
      assertActive();
      for (const [layerId, current] of states) {
        if (!current.selectedObjectIds.length && !current.highlightedObjectIds.length) continue;
        replace(layerId, { ...current, selectedObjectIds: [], highlightedObjectIds: [], revision: undefined as never });
      }
      return makeSnapshot();
    },
    snapshot() { assertActive(); return makeSnapshot(); },
    dispose() {
      if (disposed) return;
      states.clear();
      revision += 1;
      disposed = true;
    },
  };
}
