export type InteractionMode = "identify" | "select" | "measure" | "edit-preview";
export type InteractionView = "2d" | "3d";
export type InteractionPriority = "background" | "normal" | "important" | "critical";
export type InteractionState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface InteractionPoint {
  x: number;
  y: number;
  z?: number;
  wkid: number;
}

export interface InteractionRequest {
  id: string;
  mode: InteractionMode;
  view: InteractionView;
  point: InteractionPoint;
  layerIds: readonly string[];
  priority?: InteractionPriority;
  tolerancePx?: number;
  createdAt?: number;
}

export interface InteractionPolicy {
  maxQueued: number;
  maxRunning: number;
  maxLayersPerRequest: number;
  maxListeners: number;
  maxEvents: number;
  maxResultsPerRequest: number;
  timeoutMs: number;
  staleRequestMs: number;
  minTolerancePx: number;
  maxTolerancePx: number;
}

export interface InteractionResultItem {
  layerId: string;
  objectId: string | number;
  distance?: number;
}

export interface InteractionSnapshot {
  id: string;
  mode: InteractionMode;
  view: InteractionView;
  priority: InteractionPriority;
  state: InteractionState;
  point: InteractionPoint;
  layerIds: readonly string[];
  tolerancePx: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  resultCount: number;
  failure: string | null;
}

export interface InteractionEvent {
  type: "queued" | "started" | "completed" | "cancelled" | "failed" | "evicted" | "timed-out" | "disposed";
  requestId?: string;
  at: number;
  detail?: string;
}

export interface InteractionMetrics {
  accepted: number;
  rejected: number;
  started: number;
  completed: number;
  cancelled: number;
  failed: number;
  timedOut: number;
  evicted: number;
  deduplicated: number;
  listenerErrors: number;
}

export interface SpatialInteractionTransactionRuntime {
  enqueue(request: InteractionRequest, now?: number): boolean;
  startNext(now?: number): InteractionSnapshot | null;
  complete(id: string, results: readonly InteractionResultItem[], now?: number): boolean;
  fail(id: string, reason: string, now?: number): boolean;
  cancel(id: string, reason?: string, now?: number): boolean;
  sweep(now?: number): readonly string[];
  get(id: string): InteractionSnapshot | null;
  snapshot(): readonly InteractionSnapshot[];
  events(): readonly InteractionEvent[];
  metrics(): InteractionMetrics;
  subscribe(listener: (event: InteractionEvent, request: InteractionSnapshot | null) => void): () => void;
  dispose(now?: number): void;
}

export const DEFAULT_INTERACTION_POLICY: InteractionPolicy = Object.freeze({
  maxQueued: 48,
  maxRunning: 4,
  maxLayersPerRequest: 32,
  maxListeners: 16,
  maxEvents: 128,
  maxResultsPerRequest: 500,
  timeoutMs: 15_000,
  staleRequestMs: 10_000,
  minTolerancePx: 1,
  maxTolerancePx: 64,
});

const PRIORITY_WEIGHT: Readonly<Record<InteractionPriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  important: 2,
  critical: 3,
});

interface MutableInteraction {
  request: InteractionSnapshot;
  sequence: number;
  results: readonly InteractionResultItem[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

function validatePolicy(policy: InteractionPolicy): void {
  if (!positiveInteger(policy.maxQueued)) throw new Error("maxQueued must be a positive integer");
  if (!positiveInteger(policy.maxRunning)) throw new Error("maxRunning must be a positive integer");
  if (!positiveInteger(policy.maxLayersPerRequest)) throw new Error("maxLayersPerRequest must be a positive integer");
  if (!positiveInteger(policy.maxListeners)) throw new Error("maxListeners must be a positive integer");
  if (!positiveInteger(policy.maxEvents)) throw new Error("maxEvents must be a positive integer");
  if (!positiveInteger(policy.maxResultsPerRequest)) throw new Error("maxResultsPerRequest must be a positive integer");
  if (!finite(policy.timeoutMs) || policy.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  if (!finite(policy.staleRequestMs) || policy.staleRequestMs < 0) throw new Error("staleRequestMs must be non-negative");
  if (!finite(policy.minTolerancePx) || policy.minTolerancePx < 0) throw new Error("minTolerancePx must be non-negative");
  if (!finite(policy.maxTolerancePx) || policy.maxTolerancePx < policy.minTolerancePx) throw new Error("maxTolerancePx must be >= minTolerancePx");
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 && id.length <= 160 ? id : null;
}

function normalizeLayerIds(values: readonly string[], limit: number): readonly string[] | null {
  if (!Array.isArray(values) || values.length === 0 || values.length > limit) return null;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") return null;
    const id = value.trim();
    if (id.length === 0 || id.length > 256) return null;
    if (!seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output.length > 0 ? Object.freeze(output) : null;
}

function normalizePoint(point: InteractionPoint): InteractionPoint | null {
  if (!point || !finite(point.x) || !finite(point.y)) return null;
  if (point.z !== undefined && !finite(point.z)) return null;
  if (!Number.isInteger(point.wkid) || point.wkid <= 0) return null;
  const wkid = point.wkid === 102100 || point.wkid === 102113 ? 3857 : point.wkid;
  return Object.freeze({ x: point.x, y: point.y, ...(point.z === undefined ? {} : { z: point.z }), wkid });
}

function normalizeResults(results: readonly InteractionResultItem[], max: number): readonly InteractionResultItem[] | null {
  if (!Array.isArray(results) || results.length > max) return null;
  const output: InteractionResultItem[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const layerId = normalizeId(result.layerId);
    const objectId = typeof result.objectId === "number"
      ? (Number.isSafeInteger(result.objectId) ? result.objectId : null)
      : normalizeId(result.objectId);
    if (layerId === null || objectId === null) return null;
    if (result.distance !== undefined && (!finite(result.distance) || result.distance < 0)) return null;
    const key = `${layerId}\u0000${typeof objectId}:${String(objectId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze({ layerId, objectId, ...(result.distance === undefined ? {} : { distance: result.distance }) }));
  }
  return Object.freeze(output);
}

function cloneSnapshot(snapshot: InteractionSnapshot): InteractionSnapshot {
  return {
    ...snapshot,
    point: { ...snapshot.point },
    layerIds: [...snapshot.layerIds],
  };
}

export function createSpatialInteractionTransactionRuntime(
  policyInput: Partial<InteractionPolicy> = {},
): SpatialInteractionTransactionRuntime {
  const policy: InteractionPolicy = { ...DEFAULT_INTERACTION_POLICY, ...policyInput };
  validatePolicy(policy);
  const requests = new Map<string, MutableInteraction>();
  const listeners = new Set<(event: InteractionEvent, request: InteractionSnapshot | null) => void>();
  const eventLog: InteractionEvent[] = [];
  let sequence = 0;
  let disposed = false;
  const counters: InteractionMetrics = {
    accepted: 0,
    rejected: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    timedOut: 0,
    evicted: 0,
    deduplicated: 0,
    listenerErrors: 0,
  };

  const emit = (event: InteractionEvent, entry: MutableInteraction | null): void => {
    eventLog.push(event);
    if (eventLog.length > policy.maxEvents) eventLog.splice(0, eventLog.length - policy.maxEvents);
    const snapshot = entry ? cloneSnapshot(entry.request) : null;
    for (const listener of listeners) {
      try {
        listener({ ...event }, snapshot);
      } catch {
        counters.listenerErrors += 1;
      }
    }
  };

  const runningCount = (): number => {
    let count = 0;
    for (const entry of requests.values()) if (entry.request.state === "running") count += 1;
    return count;
  };

  const queued = (): MutableInteraction[] => {
    const output: MutableInteraction[] = [];
    for (const entry of requests.values()) if (entry.request.state === "queued") output.push(entry);
    return output;
  };

  const queueOrder = (a: MutableInteraction, b: MutableInteraction): number => {
    const priority = PRIORITY_WEIGHT[b.request.priority] - PRIORITY_WEIGHT[a.request.priority];
    if (priority !== 0) return priority;
    if (a.request.createdAt !== b.request.createdAt) return a.request.createdAt - b.request.createdAt;
    return a.sequence - b.sequence;
  };

  const evictionOrder = (a: MutableInteraction, b: MutableInteraction): number => {
    const priority = PRIORITY_WEIGHT[a.request.priority] - PRIORITY_WEIGHT[b.request.priority];
    if (priority !== 0) return priority;
    if (a.request.createdAt !== b.request.createdAt) return a.request.createdAt - b.request.createdAt;
    return a.sequence - b.sequence;
  };

  const terminal = (entry: MutableInteraction, state: InteractionState, now: number, failure: string | null): void => {
    entry.request = {
      ...entry.request,
      state,
      completedAt: now,
      failure,
    };
  };

  const enqueue = (request: InteractionRequest, now = Date.now()): boolean => {
    if (disposed || !finite(now) || now < 0) {
      counters.rejected += 1;
      return false;
    }
    const id = normalizeId(request.id);
    if (id === null || requests.has(id)) {
      if (id !== null && requests.has(id)) counters.deduplicated += 1;
      else counters.rejected += 1;
      return false;
    }
    const point = normalizePoint(request.point);
    const layerIds = normalizeLayerIds(request.layerIds, policy.maxLayersPerRequest);
    const createdAt = request.createdAt ?? now;
    const priority = request.priority ?? "normal";
    const tolerancePx = request.tolerancePx ?? 8;
    if (point === null || layerIds === null || !(priority in PRIORITY_WEIGHT)) {
      counters.rejected += 1;
      return false;
    }
    if (!finite(createdAt) || createdAt < 0 || createdAt > now || now - createdAt > policy.staleRequestMs) {
      counters.rejected += 1;
      return false;
    }
    if (!finite(tolerancePx) || tolerancePx < policy.minTolerancePx || tolerancePx > policy.maxTolerancePx) {
      counters.rejected += 1;
      return false;
    }
    if (queued().length >= policy.maxQueued) {
      const victim = queued().sort(evictionOrder)[0];
      if (!victim || PRIORITY_WEIGHT[victim.request.priority] >= PRIORITY_WEIGHT[priority]) {
        counters.rejected += 1;
        return false;
      }
      requests.delete(victim.request.id);
      counters.evicted += 1;
      emit({ type: "evicted", requestId: victim.request.id, at: now, detail: "queue-budget" }, victim);
    }
    const snapshot: InteractionSnapshot = {
      id,
      mode: request.mode,
      view: request.view,
      priority,
      state: "queued",
      point,
      layerIds,
      tolerancePx,
      createdAt,
      startedAt: null,
      completedAt: null,
      resultCount: 0,
      failure: null,
    };
    const entry: MutableInteraction = { request: snapshot, sequence: ++sequence, results: Object.freeze([]) };
    requests.set(id, entry);
    counters.accepted += 1;
    emit({ type: "queued", requestId: id, at: now }, entry);
    return true;
  };

  const startNext = (now = Date.now()): InteractionSnapshot | null => {
    if (disposed || !finite(now) || now < 0 || runningCount() >= policy.maxRunning) return null;
    const entry = queued().sort(queueOrder)[0];
    if (!entry) return null;
    if (now - entry.request.createdAt > policy.staleRequestMs) {
      terminal(entry, "cancelled", now, "stale-before-start");
      counters.cancelled += 1;
      emit({ type: "cancelled", requestId: entry.request.id, at: now, detail: "stale-before-start" }, entry);
      return startNext(now);
    }
    entry.request = { ...entry.request, state: "running", startedAt: now };
    counters.started += 1;
    emit({ type: "started", requestId: entry.request.id, at: now }, entry);
    return cloneSnapshot(entry.request);
  };

  const complete = (id: string, results: readonly InteractionResultItem[], now = Date.now()): boolean => {
    if (disposed || !finite(now) || now < 0) return false;
    const entry = requests.get(id);
    if (!entry || entry.request.state !== "running") return false;
    const normalized = normalizeResults(results, policy.maxResultsPerRequest);
    if (normalized === null) {
      counters.rejected += 1;
      return false;
    }
    entry.results = normalized;
    entry.request = { ...entry.request, state: "completed", completedAt: now, resultCount: normalized.length, failure: null };
    counters.completed += 1;
    emit({ type: "completed", requestId: id, at: now }, entry);
    return true;
  };

  const fail = (id: string, reason: string, now = Date.now()): boolean => {
    if (disposed || !finite(now) || now < 0) return false;
    const entry = requests.get(id);
    const normalizedReason = reason.trim().slice(0, 256);
    if (!entry || entry.request.state !== "running" || normalizedReason.length === 0) return false;
    terminal(entry, "failed", now, normalizedReason);
    counters.failed += 1;
    emit({ type: "failed", requestId: id, at: now, detail: normalizedReason }, entry);
    return true;
  };

  const cancel = (id: string, reason = "cancelled", now = Date.now()): boolean => {
    if (disposed || !finite(now) || now < 0) return false;
    const entry = requests.get(id);
    if (!entry || (entry.request.state !== "queued" && entry.request.state !== "running")) return false;
    const detail = reason.trim().slice(0, 256) || "cancelled";
    terminal(entry, "cancelled", now, detail);
    counters.cancelled += 1;
    emit({ type: "cancelled", requestId: id, at: now, detail }, entry);
    return true;
  };

  const sweep = (now = Date.now()): readonly string[] => {
    if (disposed || !finite(now) || now < 0) return [];
    const timedOut: string[] = [];
    for (const entry of requests.values()) {
      if (entry.request.state !== "running" || entry.request.startedAt === null) continue;
      if (now - entry.request.startedAt < policy.timeoutMs) continue;
      terminal(entry, "failed", now, "timeout");
      counters.failed += 1;
      counters.timedOut += 1;
      timedOut.push(entry.request.id);
      emit({ type: "timed-out", requestId: entry.request.id, at: now, detail: "timeout" }, entry);
    }
    return Object.freeze(timedOut);
  };

  return {
    enqueue,
    startNext,
    complete,
    fail,
    cancel,
    sweep,
    get: (id) => {
      const entry = requests.get(id);
      return entry ? cloneSnapshot(entry.request) : null;
    },
    snapshot: () => Object.freeze([...requests.values()].sort((a, b) => a.sequence - b.sequence).map((entry) => cloneSnapshot(entry.request))),
    events: () => Object.freeze(eventLog.map((event) => ({ ...event }))),
    metrics: () => ({ ...counters }),
    subscribe: (listener) => {
      if (disposed || listeners.size >= policy.maxListeners) return () => undefined;
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    dispose: (now = Date.now()) => {
      if (disposed) return;
      disposed = true;
      for (const entry of requests.values()) {
        if (entry.request.state === "queued" || entry.request.state === "running") terminal(entry, "cancelled", now, "disposed");
      }
      listeners.clear();
      emit({ type: "disposed", at: finite(now) && now >= 0 ? now : 0 }, null);
    },
  };
}
