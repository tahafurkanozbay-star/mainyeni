export type RenderMode = "2d" | "3d";
export type RenderPressure = "normal" | "warm" | "hot" | "critical";
export type RenderResourceKind = "feature" | "label" | "mesh" | "texture" | "elevation" | "effect";
export type RenderPriority = "background" | "normal" | "important" | "critical";

export interface RenderBudgetPolicy {
  readonly maxResources: number;
  readonly maxCpuBytes: number;
  readonly maxGpuBytes: number;
  readonly maxDrawCalls2d: number;
  readonly maxDrawCalls3d: number;
  readonly maxVisibleFeatures2d: number;
  readonly maxVisibleFeatures3d: number;
  readonly maxPendingAdmissions: number;
  readonly maxObservers: number;
  readonly maxEvents: number;
  readonly targetFrameMs: number;
  readonly warmFrameMs: number;
  readonly hotFrameMs: number;
  readonly criticalFrameMs: number;
  readonly pressureWindow: number;
  readonly recoverySamples: number;
  readonly idleTtlMs: number;
}

export interface RenderResourceRequest {
  readonly id: string;
  readonly kind: RenderResourceKind;
  readonly mode: RenderMode | "shared";
  readonly priority?: RenderPriority;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly drawCalls: number;
  readonly visibleFeatures: number;
  readonly pinned?: boolean;
}

export interface RenderResourceSnapshot extends RenderResourceRequest {
  readonly priority: RenderPriority;
  readonly pinned: boolean;
  readonly admittedAt: number;
  readonly lastUsedAt: number;
  readonly sequence: number;
}

export interface RenderBudgetUsage {
  readonly resources: number;
  readonly cpuBytes: number;
  readonly gpuBytes: number;
  readonly drawCalls2d: number;
  readonly drawCalls3d: number;
  readonly visibleFeatures2d: number;
  readonly visibleFeatures3d: number;
}

export interface RenderBudgetSnapshot {
  readonly mode: RenderMode;
  readonly pressure: RenderPressure;
  readonly qualityScale: number;
  readonly usage: RenderBudgetUsage;
  readonly resources: readonly RenderResourceSnapshot[];
  readonly pendingAdmissions: number;
  readonly disposed: boolean;
}

export interface RenderBudgetEvent {
  readonly type: "admitted" | "released" | "evicted" | "rejected" | "pressure" | "mode" | "disposed";
  readonly at: number;
  readonly resourceId?: string;
  readonly detail?: string;
}

export interface RenderBudgetMetrics {
  readonly admissions: number;
  readonly releases: number;
  readonly evictions: number;
  readonly rejections: number;
  readonly pressureTransitions: number;
  readonly modeTransitions: number;
  readonly observerErrors: number;
  readonly frameSamples: number;
}

export interface RenderAdmissionResult {
  readonly admitted: boolean;
  readonly reason?: "invalid" | "disposed" | "duplicate" | "budget" | "queue";
  readonly resource?: RenderResourceSnapshot;
  readonly evicted: readonly string[];
}

export interface RenderBudgetRuntime {
  snapshot(): RenderBudgetSnapshot;
  metrics(): RenderBudgetMetrics;
  events(): readonly RenderBudgetEvent[];
  admit(request: RenderResourceRequest, now?: number): RenderAdmissionResult;
  release(id: string, now?: number): boolean;
  touch(id: string, now?: number): boolean;
  setMode(mode: RenderMode, now?: number): void;
  sampleFrame(frameMs: number, now?: number): RenderPressure;
  sweepIdle(now?: number): readonly string[];
  subscribe(observer: (snapshot: RenderBudgetSnapshot, event: RenderBudgetEvent) => void): () => void;
  dispose(now?: number): void;
}

export const DEFAULT_RENDER_BUDGET_POLICY: RenderBudgetPolicy = Object.freeze({
  maxResources: 384,
  maxCpuBytes: 256 * 1024 * 1024,
  maxGpuBytes: 384 * 1024 * 1024,
  maxDrawCalls2d: 900,
  maxDrawCalls3d: 1400,
  maxVisibleFeatures2d: 120_000,
  maxVisibleFeatures3d: 80_000,
  maxPendingAdmissions: 64,
  maxObservers: 24,
  maxEvents: 128,
  targetFrameMs: 16.7,
  warmFrameMs: 22,
  hotFrameMs: 33,
  criticalFrameMs: 50,
  pressureWindow: 12,
  recoverySamples: 8,
  idleTtlMs: 90_000,
});

const PRIORITY_WEIGHT: Readonly<Record<RenderPriority, number>> = Object.freeze({
  background: 0,
  normal: 1,
  important: 2,
  critical: 3,
});

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value > 0;
}

function validPolicy(policy: RenderBudgetPolicy): boolean {
  return positiveInteger(policy.maxResources)
    && positiveInteger(policy.maxCpuBytes)
    && positiveInteger(policy.maxGpuBytes)
    && positiveInteger(policy.maxDrawCalls2d)
    && positiveInteger(policy.maxDrawCalls3d)
    && positiveInteger(policy.maxVisibleFeatures2d)
    && positiveInteger(policy.maxVisibleFeatures3d)
    && positiveInteger(policy.maxPendingAdmissions)
    && positiveInteger(policy.maxObservers)
    && positiveInteger(policy.maxEvents)
    && finite(policy.targetFrameMs) && policy.targetFrameMs > 0
    && finite(policy.warmFrameMs) && policy.warmFrameMs >= policy.targetFrameMs
    && finite(policy.hotFrameMs) && policy.hotFrameMs >= policy.warmFrameMs
    && finite(policy.criticalFrameMs) && policy.criticalFrameMs >= policy.hotFrameMs
    && positiveInteger(policy.pressureWindow)
    && positiveInteger(policy.recoverySamples)
    && finite(policy.idleTtlMs) && policy.idleTtlMs >= 0;
}

function requirePolicy(policy: RenderBudgetPolicy): void {
  if (!validPolicy(policy)) throw new Error("Invalid GIS render-budget policy");
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 160 && value.trim() === value;
}

function normalizeRequest(request: RenderResourceRequest): Omit<RenderResourceSnapshot, "admittedAt" | "lastUsedAt" | "sequence"> | null {
  if (!validId(request.id)) return null;
  if (!nonNegativeInteger(request.cpuBytes) || !nonNegativeInteger(request.gpuBytes)) return null;
  if (!nonNegativeInteger(request.drawCalls) || !nonNegativeInteger(request.visibleFeatures)) return null;
  const priority = request.priority ?? "normal";
  if (!(priority in PRIORITY_WEIGHT)) return null;
  return {
    id: request.id,
    kind: request.kind,
    mode: request.mode,
    priority,
    cpuBytes: request.cpuBytes,
    gpuBytes: request.gpuBytes,
    drawCalls: request.drawCalls,
    visibleFeatures: request.visibleFeatures,
    pinned: request.pinned === true,
  };
}

function emptyUsage(): RenderBudgetUsage {
  return {
    resources: 0,
    cpuBytes: 0,
    gpuBytes: 0,
    drawCalls2d: 0,
    drawCalls3d: 0,
    visibleFeatures2d: 0,
    visibleFeatures3d: 0,
  };
}

function addResource(usage: RenderBudgetUsage, resource: RenderResourceSnapshot): RenderBudgetUsage {
  const contributes2d = resource.mode === "2d" || resource.mode === "shared";
  const contributes3d = resource.mode === "3d" || resource.mode === "shared";
  return {
    resources: usage.resources + 1,
    cpuBytes: usage.cpuBytes + resource.cpuBytes,
    gpuBytes: usage.gpuBytes + resource.gpuBytes,
    drawCalls2d: usage.drawCalls2d + (contributes2d ? resource.drawCalls : 0),
    drawCalls3d: usage.drawCalls3d + (contributes3d ? resource.drawCalls : 0),
    visibleFeatures2d: usage.visibleFeatures2d + (contributes2d ? resource.visibleFeatures : 0),
    visibleFeatures3d: usage.visibleFeatures3d + (contributes3d ? resource.visibleFeatures : 0),
  };
}

function removeResource(usage: RenderBudgetUsage, resource: RenderResourceSnapshot): RenderBudgetUsage {
  const contributes2d = resource.mode === "2d" || resource.mode === "shared";
  const contributes3d = resource.mode === "3d" || resource.mode === "shared";
  return {
    resources: Math.max(0, usage.resources - 1),
    cpuBytes: Math.max(0, usage.cpuBytes - resource.cpuBytes),
    gpuBytes: Math.max(0, usage.gpuBytes - resource.gpuBytes),
    drawCalls2d: Math.max(0, usage.drawCalls2d - (contributes2d ? resource.drawCalls : 0)),
    drawCalls3d: Math.max(0, usage.drawCalls3d - (contributes3d ? resource.drawCalls : 0)),
    visibleFeatures2d: Math.max(0, usage.visibleFeatures2d - (contributes2d ? resource.visibleFeatures : 0)),
    visibleFeatures3d: Math.max(0, usage.visibleFeatures3d - (contributes3d ? resource.visibleFeatures : 0)),
  };
}

function withinBudget(usage: RenderBudgetUsage, policy: RenderBudgetPolicy): boolean {
  return usage.resources <= policy.maxResources
    && usage.cpuBytes <= policy.maxCpuBytes
    && usage.gpuBytes <= policy.maxGpuBytes
    && usage.drawCalls2d <= policy.maxDrawCalls2d
    && usage.drawCalls3d <= policy.maxDrawCalls3d
    && usage.visibleFeatures2d <= policy.maxVisibleFeatures2d
    && usage.visibleFeatures3d <= policy.maxVisibleFeatures3d;
}

function pressureForFrame(frameMs: number, policy: RenderBudgetPolicy): RenderPressure {
  if (frameMs >= policy.criticalFrameMs) return "critical";
  if (frameMs >= policy.hotFrameMs) return "hot";
  if (frameMs >= policy.warmFrameMs) return "warm";
  return "normal";
}

function pressureWeight(pressure: RenderPressure): number {
  switch (pressure) {
    case "critical": return 3;
    case "hot": return 2;
    case "warm": return 1;
    default: return 0;
  }
}

function qualityScale(pressure: RenderPressure): number {
  switch (pressure) {
    case "critical": return 0.5;
    case "hot": return 0.65;
    case "warm": return 0.82;
    default: return 1;
  }
}

export function createRenderBudgetRuntime(
  policy: RenderBudgetPolicy = DEFAULT_RENDER_BUDGET_POLICY,
  initialMode: RenderMode = "2d",
): RenderBudgetRuntime {
  requirePolicy(policy);
  let mode = initialMode;
  let pressure: RenderPressure = "normal";
  let usage = emptyUsage();
  let disposed = false;
  let sequence = 0;
  let pendingAdmissions = 0;
  let recoveryCount = 0;
  const resources = new Map<string, RenderResourceSnapshot>();
  const observers = new Set<(snapshot: RenderBudgetSnapshot, event: RenderBudgetEvent) => void>();
  const eventLog: RenderBudgetEvent[] = [];
  const frameWindow: number[] = [];
  const counters = {
    admissions: 0,
    releases: 0,
    evictions: 0,
    rejections: 0,
    pressureTransitions: 0,
    modeTransitions: 0,
    observerErrors: 0,
    frameSamples: 0,
  };

  const currentSnapshot = (): RenderBudgetSnapshot => ({
    mode,
    pressure,
    qualityScale: qualityScale(pressure),
    usage: { ...usage },
    resources: [...resources.values()].sort((a, b) => a.sequence - b.sequence),
    pendingAdmissions,
    disposed,
  });

  const emit = (event: RenderBudgetEvent): void => {
    eventLog.push(event);
    if (eventLog.length > policy.maxEvents) eventLog.splice(0, eventLog.length - policy.maxEvents);
    const snapshot = currentSnapshot();
    for (const observer of [...observers]) {
      try { observer(snapshot, event); } catch { counters.observerErrors += 1; }
    }
  };

  const evictable = (incoming: Omit<RenderResourceSnapshot, "admittedAt" | "lastUsedAt" | "sequence">): RenderResourceSnapshot[] => {
    const incomingWeight = PRIORITY_WEIGHT[incoming.priority];
    return [...resources.values()]
      .filter((resource) => !resource.pinned && PRIORITY_WEIGHT[resource.priority] <= incomingWeight)
      .sort((a, b) => {
        const priorityDelta = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
        if (priorityDelta !== 0) return priorityDelta;
        const activePenaltyA = a.mode === mode || a.mode === "shared" ? 1 : 0;
        const activePenaltyB = b.mode === mode || b.mode === "shared" ? 1 : 0;
        if (activePenaltyA !== activePenaltyB) return activePenaltyA - activePenaltyB;
        if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
        return a.sequence - b.sequence;
      });
  };

  const remove = (resource: RenderResourceSnapshot, type: "released" | "evicted", now: number): void => {
    if (!resources.delete(resource.id)) return;
    usage = removeResource(usage, resource);
    if (type === "released") counters.releases += 1;
    else counters.evictions += 1;
    emit({ type, at: now, resourceId: resource.id });
  };

  const admit = (request: RenderResourceRequest, now = Date.now()): RenderAdmissionResult => {
    if (disposed) return { admitted: false, reason: "disposed", evicted: [] };
    if (!finite(now)) return { admitted: false, reason: "invalid", evicted: [] };
    const normalized = normalizeRequest(request);
    if (!normalized) { counters.rejections += 1; return { admitted: false, reason: "invalid", evicted: [] }; }
    if (resources.has(normalized.id)) { counters.rejections += 1; return { admitted: false, reason: "duplicate", evicted: [] }; }
    if (pendingAdmissions >= policy.maxPendingAdmissions) { counters.rejections += 1; return { admitted: false, reason: "queue", evicted: [] }; }
    pendingAdmissions += 1;
    try {
      const candidate: RenderResourceSnapshot = { ...normalized, admittedAt: now, lastUsedAt: now, sequence: ++sequence };
      let projected = addResource(usage, candidate);
      const victims: RenderResourceSnapshot[] = [];
      if (!withinBudget(projected, policy)) {
        for (const victim of evictable(normalized)) {
          victims.push(victim);
          projected = removeResource(projected, victim);
          if (withinBudget(projected, policy)) break;
        }
      }
      if (!withinBudget(projected, policy)) {
        counters.rejections += 1;
        emit({ type: "rejected", at: now, resourceId: normalized.id, detail: "budget" });
        return { admitted: false, reason: "budget", evicted: [] };
      }
      for (const victim of victims) remove(victim, "evicted", now);
      resources.set(candidate.id, candidate);
      usage = addResource(usage, candidate);
      counters.admissions += 1;
      emit({ type: "admitted", at: now, resourceId: candidate.id });
      return { admitted: true, resource: candidate, evicted: victims.map((victim) => victim.id) };
    } finally {
      pendingAdmissions -= 1;
    }
  };

  const release = (id: string, now = Date.now()): boolean => {
    if (disposed || !finite(now)) return false;
    const resource = resources.get(id);
    if (!resource) return false;
    remove(resource, "released", now);
    return true;
  };

  const touch = (id: string, now = Date.now()): boolean => {
    if (disposed || !finite(now)) return false;
    const resource = resources.get(id);
    if (!resource) return false;
    resources.set(id, { ...resource, lastUsedAt: Math.max(resource.lastUsedAt, now) });
    return true;
  };

  const setMode = (nextMode: RenderMode, now = Date.now()): void => {
    if (disposed || nextMode === mode || !finite(now)) return;
    mode = nextMode;
    counters.modeTransitions += 1;
    emit({ type: "mode", at: now, detail: nextMode });
  };

  const sampleFrame = (frameMs: number, now = Date.now()): RenderPressure => {
    if (disposed || !finite(frameMs) || frameMs < 0 || !finite(now)) return pressure;
    counters.frameSamples += 1;
    frameWindow.push(frameMs);
    if (frameWindow.length > policy.pressureWindow) frameWindow.shift();
    const sorted = [...frameWindow].sort((a, b) => a - b);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const observed = pressureForFrame(sorted[p95Index] ?? frameMs, policy);
    const previous = pressure;
    if (pressureWeight(observed) > pressureWeight(pressure)) {
      pressure = observed;
      recoveryCount = 0;
    } else if (pressureWeight(observed) < pressureWeight(pressure)) {
      recoveryCount += 1;
      if (recoveryCount >= policy.recoverySamples) {
        pressure = observed;
        recoveryCount = 0;
      }
    } else {
      recoveryCount = 0;
    }
    if (previous !== pressure) {
      counters.pressureTransitions += 1;
      emit({ type: "pressure", at: now, detail: pressure });
    }
    return pressure;
  };

  const sweepIdle = (now = Date.now()): readonly string[] => {
    if (disposed || !finite(now)) return [];
    const removed: string[] = [];
    for (const resource of [...resources.values()]) {
      if (resource.pinned) continue;
      if (now - resource.lastUsedAt < policy.idleTtlMs) continue;
      removed.push(resource.id);
      remove(resource, "evicted", now);
    }
    return removed;
  };

  const subscribe = (observer: (snapshot: RenderBudgetSnapshot, event: RenderBudgetEvent) => void): (() => void) => {
    if (disposed || observers.size >= policy.maxObservers) return () => undefined;
    observers.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      observers.delete(observer);
    };
  };

  const dispose = (now = Date.now()): void => {
    if (disposed) return;
    disposed = true;
    resources.clear();
    usage = emptyUsage();
    frameWindow.length = 0;
    pendingAdmissions = 0;
    const event: RenderBudgetEvent = { type: "disposed", at: finite(now) ? now : Date.now() };
    eventLog.push(event);
    if (eventLog.length > policy.maxEvents) eventLog.splice(0, eventLog.length - policy.maxEvents);
    const snapshot = currentSnapshot();
    for (const observer of [...observers]) {
      try { observer(snapshot, event); } catch { counters.observerErrors += 1; }
    }
    observers.clear();
  };

  return {
    snapshot: currentSnapshot,
    metrics: () => ({ ...counters }),
    events: () => eventLog.map((event) => ({ ...event })),
    admit,
    release,
    touch,
    setMode,
    sampleFrame,
    sweepIdle,
    subscribe,
    dispose,
  };
}
