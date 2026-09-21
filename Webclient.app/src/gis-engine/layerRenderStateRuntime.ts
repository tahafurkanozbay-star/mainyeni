export type LayerViewMode = "2d" | "3d";
export type LayerPriority = "background" | "normal" | "important" | "critical";
export type LayerHealth = "idle" | "loading" | "ready" | "degraded" | "failed";

export interface LayerRenderPolicy {
  readonly maxLayers: number;
  readonly maxVisible2d: number;
  readonly maxVisible3d: number;
  readonly maxLoading: number;
  readonly maxListeners: number;
  readonly maxEvents: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly failureBackoffMs: number;
  readonly maxConsecutiveFailures: number;
}

export interface LayerRegistration {
  readonly id: string;
  readonly title: string;
  readonly priority?: LayerPriority;
  readonly modes: readonly LayerViewMode[];
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly defaultVisible?: boolean;
  readonly opacity?: number;
}

export interface LayerRenderState {
  readonly id: string;
  readonly title: string;
  readonly priority: LayerPriority;
  readonly modes: readonly LayerViewMode[];
  readonly minScale: number;
  readonly maxScale: number;
  readonly requestedVisible: boolean;
  readonly effectiveVisible: boolean;
  readonly opacity: number;
  readonly health: LayerHealth;
  readonly consecutiveFailures: number;
  readonly retryAfter: number;
  readonly revision: number;
  readonly registeredAt: number;
  readonly updatedAt: number;
}

export interface LayerRenderSnapshot {
  readonly mode: LayerViewMode;
  readonly scale: number;
  readonly layers: readonly LayerRenderState[];
  readonly visibleIds: readonly string[];
  readonly loadingCount: number;
  readonly disposed: boolean;
}

export interface LayerRenderEvent {
  readonly type: "registered" | "removed" | "visibility" | "opacity" | "health" | "mode" | "scale" | "disposed";
  readonly at: number;
  readonly layerId?: string;
  readonly detail?: string;
}

export interface LayerRenderMetrics {
  readonly registrations: number;
  readonly removals: number;
  readonly visibilityChanges: number;
  readonly opacityChanges: number;
  readonly healthChanges: number;
  readonly modeChanges: number;
  readonly scaleChanges: number;
  readonly rejectedMutations: number;
  readonly listenerErrors: number;
}

export interface LayerRenderRuntime {
  snapshot(): LayerRenderSnapshot;
  metrics(): LayerRenderMetrics;
  events(): readonly LayerRenderEvent[];
  register(input: LayerRegistration, now?: number): boolean;
  remove(id: string, now?: number): boolean;
  setRequestedVisible(id: string, visible: boolean, now?: number): boolean;
  setOpacity(id: string, opacity: number, now?: number): boolean;
  setHealth(id: string, health: LayerHealth, now?: number): boolean;
  setMode(mode: LayerViewMode, now?: number): void;
  setScale(scale: number, now?: number): boolean;
  canRetry(id: string, now?: number): boolean;
  subscribe(listener: (snapshot: LayerRenderSnapshot, event: LayerRenderEvent) => void): () => void;
  dispose(now?: number): void;
}

export const DEFAULT_LAYER_RENDER_POLICY: LayerRenderPolicy = Object.freeze({
  maxLayers: 256,
  maxVisible2d: 96,
  maxVisible3d: 64,
  maxLoading: 12,
  maxListeners: 24,
  maxEvents: 128,
  minScale: 50,
  maxScale: 150_000_000,
  failureBackoffMs: 5_000,
  maxConsecutiveFailures: 5,
});

const PRIORITY_WEIGHT: Readonly<Record<LayerPriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  important: 2,
  critical: 3,
});

function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function positiveInteger(value: unknown): value is number { return finite(value) && Number.isInteger(value) && value > 0; }
function validId(value: string): boolean { return value.length > 0 && value.length <= 160 && value.trim() === value; }
function validTitle(value: string): boolean { return value.trim().length > 0 && value.length <= 240; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function validatePolicy(policy: LayerRenderPolicy): void {
  if (!positiveInteger(policy.maxLayers)
    || !positiveInteger(policy.maxVisible2d)
    || !positiveInteger(policy.maxVisible3d)
    || !positiveInteger(policy.maxLoading)
    || !positiveInteger(policy.maxListeners)
    || !positiveInteger(policy.maxEvents)
    || !finite(policy.minScale) || policy.minScale <= 0
    || !finite(policy.maxScale) || policy.maxScale < policy.minScale
    || !finite(policy.failureBackoffMs) || policy.failureBackoffMs < 0
    || !positiveInteger(policy.maxConsecutiveFailures)) {
    throw new Error("Invalid GIS layer-render policy");
  }
}

function normalizeModes(modes: readonly LayerViewMode[]): readonly LayerViewMode[] | null {
  if (modes.length === 0) return null;
  const unique = [...new Set(modes)];
  if (unique.some((mode) => mode !== "2d" && mode !== "3d")) return null;
  return unique.sort();
}

function normalizeRegistration(input: LayerRegistration, policy: LayerRenderPolicy, now: number): LayerRenderState | null {
  if (!validId(input.id) || !validTitle(input.title)) return null;
  const modes = normalizeModes(input.modes);
  if (!modes) return null;
  const priority = input.priority ?? "normal";
  if (!(priority in PRIORITY_WEIGHT)) return null;
  const minScale = input.minScale ?? policy.minScale;
  const maxScale = input.maxScale ?? policy.maxScale;
  if (!finite(minScale) || !finite(maxScale) || minScale <= 0 || maxScale < minScale) return null;
  const opacity = input.opacity ?? 1;
  if (!finite(opacity) || opacity < 0 || opacity > 1) return null;
  return {
    id: input.id,
    title: input.title.trim(),
    priority,
    modes,
    minScale,
    maxScale,
    requestedVisible: input.defaultVisible !== false,
    effectiveVisible: false,
    opacity,
    health: "idle",
    consecutiveFailures: 0,
    retryAfter: 0,
    revision: 1,
    registeredAt: now,
    updatedAt: now,
  };
}

export function createLayerRenderStateRuntime(
  policy: LayerRenderPolicy = DEFAULT_LAYER_RENDER_POLICY,
  initialMode: LayerViewMode = "2d",
  initialScale = 10_000,
): LayerRenderRuntime {
  validatePolicy(policy);
  if (!finite(initialScale) || initialScale <= 0) throw new Error("Invalid initial GIS scale");
  let mode = initialMode;
  let scale = clamp(initialScale, policy.minScale, policy.maxScale);
  let disposed = false;
  const layers = new Map<string, LayerRenderState>();
  const listeners = new Set<(snapshot: LayerRenderSnapshot, event: LayerRenderEvent) => void>();
  const eventLog: LayerRenderEvent[] = [];
  const counters = {
    registrations: 0,
    removals: 0,
    visibilityChanges: 0,
    opacityChanges: 0,
    healthChanges: 0,
    modeChanges: 0,
    scaleChanges: 0,
    rejectedMutations: 0,
    listenerErrors: 0,
  };

  const loadingCount = (): number => [...layers.values()].filter((layer) => layer.health === "loading").length;

  const candidateVisible = (layer: LayerRenderState): boolean => layer.requestedVisible
    && layer.opacity > 0
    && layer.modes.includes(mode)
    && scale >= layer.minScale
    && scale <= layer.maxScale
    && layer.health !== "failed";

  const recomputeVisibility = (): void => {
    const limit = mode === "2d" ? policy.maxVisible2d : policy.maxVisible3d;
    const candidates = [...layers.values()]
      .filter(candidateVisible)
      .sort((a, b) => {
        const priority = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
        if (priority !== 0) return priority;
        if (a.registeredAt !== b.registeredAt) return a.registeredAt - b.registeredAt;
        return a.id.localeCompare(b.id);
      });
    const allowed = new Set(candidates.slice(0, limit).map((layer) => layer.id));
    for (const [id, layer] of layers) {
      const effectiveVisible = allowed.has(id);
      if (layer.effectiveVisible !== effectiveVisible) layers.set(id, { ...layer, effectiveVisible });
    }
  };

  const currentSnapshot = (): LayerRenderSnapshot => {
    const ordered = [...layers.values()].sort((a, b) => a.registeredAt - b.registeredAt || a.id.localeCompare(b.id));
    return {
      mode,
      scale,
      layers: ordered.map((layer) => ({ ...layer, modes: [...layer.modes] })),
      visibleIds: ordered.filter((layer) => layer.effectiveVisible).map((layer) => layer.id),
      loadingCount: loadingCount(),
      disposed,
    };
  };

  const emit = (event: LayerRenderEvent): void => {
    eventLog.push(event);
    if (eventLog.length > policy.maxEvents) eventLog.splice(0, eventLog.length - policy.maxEvents);
    const snapshot = currentSnapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot, event); } catch { counters.listenerErrors += 1; }
    }
  };

  const reject = (): false => { counters.rejectedMutations += 1; return false; };

  const register = (input: LayerRegistration, now = Date.now()): boolean => {
    if (disposed || !finite(now) || layers.size >= policy.maxLayers || layers.has(input.id)) return reject();
    const layer = normalizeRegistration(input, policy, now);
    if (!layer) return reject();
    layers.set(layer.id, layer);
    recomputeVisibility();
    counters.registrations += 1;
    emit({ type: "registered", at: now, layerId: layer.id });
    return true;
  };

  const remove = (id: string, now = Date.now()): boolean => {
    if (disposed || !finite(now)) return false;
    if (!layers.delete(id)) return false;
    recomputeVisibility();
    counters.removals += 1;
    emit({ type: "removed", at: now, layerId: id });
    return true;
  };

  const mutate = (
    id: string,
    now: number,
    type: LayerRenderEvent["type"],
    updater: (layer: LayerRenderState) => LayerRenderState | null,
  ): boolean => {
    if (disposed || !finite(now)) return reject();
    const current = layers.get(id);
    if (!current) return reject();
    const next = updater(current);
    if (!next) return reject();
    if (next === current) return true;
    layers.set(id, { ...next, revision: current.revision + 1, updatedAt: Math.max(current.updatedAt, now) });
    recomputeVisibility();
    emit({ type, at: now, layerId: id });
    return true;
  };

  const setRequestedVisible = (id: string, visible: boolean, now = Date.now()): boolean => {
    const result = mutate(id, now, "visibility", (layer) => layer.requestedVisible === visible ? layer : { ...layer, requestedVisible: visible });
    if (result) counters.visibilityChanges += 1;
    return result;
  };

  const setOpacity = (id: string, opacity: number, now = Date.now()): boolean => {
    if (!finite(opacity) || opacity < 0 || opacity > 1) return reject();
    const result = mutate(id, now, "opacity", (layer) => layer.opacity === opacity ? layer : { ...layer, opacity });
    if (result) counters.opacityChanges += 1;
    return result;
  };

  const setHealth = (id: string, health: LayerHealth, now = Date.now()): boolean => {
    const result = mutate(id, now, "health", (layer) => {
      if (layer.health === health) return layer;
      if (health === "loading" && layer.health !== "loading" && loadingCount() >= policy.maxLoading) return null;
      if (health === "failed") {
        const failures = Math.min(policy.maxConsecutiveFailures, layer.consecutiveFailures + 1);
        const multiplier = Math.max(1, 2 ** Math.max(0, failures - 1));
        return { ...layer, health, consecutiveFailures: failures, retryAfter: now + policy.failureBackoffMs * multiplier };
      }
      if (health === "ready") return { ...layer, health, consecutiveFailures: 0, retryAfter: 0 };
      return { ...layer, health };
    });
    if (result) counters.healthChanges += 1;
    return result;
  };

  const setMode = (nextMode: LayerViewMode, now = Date.now()): void => {
    if (disposed || !finite(now) || nextMode === mode) return;
    mode = nextMode;
    recomputeVisibility();
    counters.modeChanges += 1;
    emit({ type: "mode", at: now, detail: nextMode });
  };

  const setScale = (nextScale: number, now = Date.now()): boolean => {
    if (disposed || !finite(now) || !finite(nextScale) || nextScale <= 0) return reject();
    const normalized = clamp(nextScale, policy.minScale, policy.maxScale);
    if (normalized === scale) return true;
    scale = normalized;
    recomputeVisibility();
    counters.scaleChanges += 1;
    emit({ type: "scale", at: now, detail: String(normalized) });
    return true;
  };

  const canRetry = (id: string, now = Date.now()): boolean => {
    if (disposed || !finite(now)) return false;
    const layer = layers.get(id);
    if (!layer || layer.health !== "failed") return false;
    return layer.consecutiveFailures < policy.maxConsecutiveFailures && now >= layer.retryAfter;
  };

  const subscribe = (listener: (snapshot: LayerRenderSnapshot, event: LayerRenderEvent) => void): (() => void) => {
    if (disposed || listeners.size >= policy.maxListeners) return () => undefined;
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  };

  const dispose = (now = Date.now()): void => {
    if (disposed) return;
    disposed = true;
    layers.clear();
    const event: LayerRenderEvent = { type: "disposed", at: finite(now) ? now : Date.now() };
    eventLog.push(event);
    if (eventLog.length > policy.maxEvents) eventLog.splice(0, eventLog.length - policy.maxEvents);
    const snapshot = currentSnapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot, event); } catch { counters.listenerErrors += 1; }
    }
    listeners.clear();
  };

  return {
    snapshot: currentSnapshot,
    metrics: () => ({ ...counters }),
    events: () => eventLog.map((event) => ({ ...event })),
    register,
    remove,
    setRequestedVisible,
    setOpacity,
    setHealth,
    setMode,
    setScale,
    canRetry,
    subscribe,
    dispose,
  };
}
