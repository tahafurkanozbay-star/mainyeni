export type SceneLayerPhase = 'idle' | 'queued' | 'loading' | 'ready' | 'suspended' | 'failed' | 'disposed';
export type SceneLayerPriority = 'critical' | 'high' | 'normal' | 'low';

export interface SceneLayerResourceEstimate { cpuBytes: number; gpuBytes: number; featureCount: number; drawCalls: number }
export interface SceneLayerDescriptor {
  id: string; priority?: SceneLayerPriority; minScale?: number; maxScale?: number; minZoom?: number; maxZoom?: number;
  visible?: boolean; required?: boolean; resourceEstimate?: Partial<SceneLayerResourceEstimate>; metadata?: Readonly<Record<string, unknown>>;
}
export interface SceneLayerLoadContext { signal: AbortSignal; generation: number; descriptor: SceneLayerDescriptor }
export interface SceneLayerAdapter<TResource = unknown> {
  load: (context: SceneLayerLoadContext) => Promise<TResource>;
  activate?: (resource: TResource, context: SceneLayerLoadContext) => Promise<void> | void;
  suspend?: (resource: TResource, reason: string) => Promise<void> | void;
  dispose?: (resource: TResource, reason: string) => Promise<void> | void;
}
export interface SceneLayerRuntimeOptions {
  maxConcurrentLoads?: number; maxLoadedLayers?: number; maxCpuBytes?: number; maxGpuBytes?: number; maxFeatures?: number; maxDrawCalls?: number;
  retryLimit?: number; retryBaseDelayMs?: number; now?: () => number; sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: SceneLayerEvent) => void; onObserverError?: (error: unknown) => void;
}
export interface SceneLayerSnapshot {
  id: string; phase: SceneLayerPhase; priority: SceneLayerPriority; generation: number; visible: boolean; requested: boolean; retries: number;
  lastError: unknown; loadedAt: number | null; lastUsedAt: number | null; estimate: SceneLayerResourceEstimate;
}
export interface SceneLayerRuntimeSnapshot {
  layers: readonly SceneLayerSnapshot[]; activeLoads: number; queuedLoads: number; loadedLayers: number;
  totalCpuBytes: number; totalGpuBytes: number; totalFeatures: number; totalDrawCalls: number;
}
export interface SceneLayerEvent {
  type: 'registered' | 'requested' | 'load-start' | 'load-ready' | 'load-failed' | 'suspended' | 'resumed' | 'evicted' | 'disposed' | 'visibility';
  layerId: string; timestamp: number; reason?: string | undefined; generation: number;
}
export interface SceneLayerLifecycleRuntime<TResource = unknown> {
  register: (descriptor: SceneLayerDescriptor, adapter: SceneLayerAdapter<TResource>) => SceneLayerSnapshot;
  unregister: (layerId: string, reason?: string) => Promise<boolean>;
  request: (layerId: string, reason?: string) => Promise<SceneLayerSnapshot>;
  suspend: (layerId: string, reason?: string) => Promise<boolean>;
  resume: (layerId: string, reason?: string) => Promise<SceneLayerSnapshot>;
  setVisibility: (layerId: string, visible: boolean) => SceneLayerSnapshot;
  setViewport: (input: { scale?: number; zoom?: number }) => Promise<SceneLayerRuntimeSnapshot>;
  reconcile: () => Promise<SceneLayerRuntimeSnapshot>;
  getLayerSnapshot: (layerId: string) => SceneLayerSnapshot | null;
  getSnapshot: () => SceneLayerRuntimeSnapshot;
  dispose: (reason?: string) => Promise<void>;
}

export class SceneLayerResourceBudgetError extends Error {
  public readonly code = 'SCENE_LAYER_RESOURCE_BUDGET';
  public constructor(public readonly layerId: string) { super(`Scene layer ${layerId} exceeds the configured resource budget`); this.name = 'SceneLayerResourceBudgetError'; }
}

interface MutableLayerState<TResource> {
  descriptor: SceneLayerDescriptor; adapter: SceneLayerAdapter<TResource>; phase: SceneLayerPhase; priority: SceneLayerPriority; generation: number;
  requested: boolean; manualRequested: boolean; visible: boolean; retries: number; lastError: unknown; loadedAt: number | null; lastUsedAt: number | null;
  resource: TResource | null; controller: AbortController | null; inFlight: Promise<void> | null; estimate: SceneLayerResourceEstimate;
}

const PRIORITY_WEIGHT: Readonly<Record<SceneLayerPriority, number>> = Object.freeze({ critical: 4, high: 3, normal: 2, low: 1 });
const DEFAULT_ESTIMATE: SceneLayerResourceEstimate = Object.freeze({ cpuBytes: 0, gpuBytes: 0, featureCount: 0, drawCalls: 0 });
const finiteNonNegative = (value: unknown, fallback: number): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const normalizeEstimate = (input?: Partial<SceneLayerResourceEstimate>): SceneLayerResourceEstimate => Object.freeze({
  cpuBytes: Math.floor(finiteNonNegative(input?.cpuBytes, 0)), gpuBytes: Math.floor(finiteNonNegative(input?.gpuBytes, 0)),
  featureCount: Math.floor(finiteNonNegative(input?.featureCount, 0)), drawCalls: Math.floor(finiteNonNegative(input?.drawCalls, 0)),
});
const defaultSleep = (delayMs: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
  const onAbort = (): void => { clearTimeout(handle); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  const handle = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
  signal.addEventListener('abort', onAbort, { once: true });
});
const inRange = (descriptor: SceneLayerDescriptor, scale: number | null, zoom: number | null): boolean => {
  if (scale !== null) { if (descriptor.minScale !== undefined && descriptor.minScale > 0 && scale > descriptor.minScale) return false; if (descriptor.maxScale !== undefined && descriptor.maxScale > 0 && scale < descriptor.maxScale) return false; }
  if (zoom !== null) { if (descriptor.minZoom !== undefined && zoom < descriptor.minZoom) return false; if (descriptor.maxZoom !== undefined && zoom > descriptor.maxZoom) return false; }
  return true;
};
const snapshotLayer = <TResource>(state: MutableLayerState<TResource>): SceneLayerSnapshot => Object.freeze({
  id: state.descriptor.id, phase: state.phase, priority: state.priority, generation: state.generation, visible: state.visible, requested: state.requested,
  retries: state.retries, lastError: state.lastError, loadedAt: state.loadedAt, lastUsedAt: state.lastUsedAt, estimate: state.estimate,
});

export const createSceneLayerLifecycleRuntime = <TResource = unknown>(options: SceneLayerRuntimeOptions = {}): SceneLayerLifecycleRuntime<TResource> => {
  const maxConcurrentLoads = Math.max(1, Math.floor(finiteNonNegative(options.maxConcurrentLoads, 4)));
  const maxLoadedLayers = Math.max(1, Math.floor(finiteNonNegative(options.maxLoadedLayers, 32)));
  const maxCpuBytes = Math.max(1, Math.floor(finiteNonNegative(options.maxCpuBytes, 1024 ** 3)));
  const maxGpuBytes = Math.max(1, Math.floor(finiteNonNegative(options.maxGpuBytes, 1024 ** 3)));
  const maxFeatures = Math.max(1, Math.floor(finiteNonNegative(options.maxFeatures, 2_000_000)));
  const maxDrawCalls = Math.max(1, Math.floor(finiteNonNegative(options.maxDrawCalls, 10_000)));
  const retryLimit = Math.max(0, Math.floor(finiteNonNegative(options.retryLimit, 2)));
  const retryBaseDelayMs = Math.max(10, Math.floor(finiteNonNegative(options.retryBaseDelayMs, 250)));
  const now = options.now ?? Date.now; const sleep = options.sleep ?? defaultSleep;
  const layers = new Map<string, MutableLayerState<TResource>>();
  let disposed = false; let activeLoads = 0; let viewportScale: number | null = null; let viewportZoom: number | null = null; let viewportInitialized = false;
  let reconcileScheduled: Promise<void> | null = null; let reconcileDirty = false;

  const observerError = (error: unknown): void => { try { options.onObserverError?.(error); } catch (secondary) { const report = (globalThis as typeof globalThis & { reportError?: (e: unknown) => void }).reportError; if (typeof report === 'function') report(secondary); else throw secondary; } };
  const emit = (state: MutableLayerState<TResource>, type: SceneLayerEvent['type'], reason?: string): void => { try { options.onEvent?.(Object.freeze({ type, layerId: state.descriptor.id, timestamp: now(), reason, generation: state.generation })); } catch (error) { observerError(error); } };
  const getState = (id: string): MutableLayerState<TResource> => { const state = layers.get(id); if (!state) throw new Error(`Unknown scene layer: ${id}`); return state; };
  const viewportRequests = (state: MutableLayerState<TResource>): boolean => viewportInitialized && state.visible && state.descriptor.visible !== false && inRange(state.descriptor, viewportScale, viewportZoom);
  const shouldBeRequested = (state: MutableLayerState<TResource>): boolean => state.manualRequested || viewportRequests(state);
  const loadedStates = (): MutableLayerState<TResource>[] => [...layers.values()].filter((s) => s.resource !== null && s.phase !== 'disposed');
  const budgetSatisfied = (loaded = loadedStates()): boolean => loaded.length <= maxLoadedLayers
    && loaded.reduce((n, s) => n + s.estimate.cpuBytes, 0) <= maxCpuBytes && loaded.reduce((n, s) => n + s.estimate.gpuBytes, 0) <= maxGpuBytes
    && loaded.reduce((n, s) => n + s.estimate.featureCount, 0) <= maxFeatures && loaded.reduce((n, s) => n + s.estimate.drawCalls, 0) <= maxDrawCalls;
  const buildSnapshot = (): SceneLayerRuntimeSnapshot => { const loaded = loadedStates(); return Object.freeze({ layers: Object.freeze([...layers.values()].map(snapshotLayer)), activeLoads, queuedLoads: [...layers.values()].filter((s) => s.phase === 'queued').length, loadedLayers: loaded.length, totalCpuBytes: loaded.reduce((n,s)=>n+s.estimate.cpuBytes,0), totalGpuBytes: loaded.reduce((n,s)=>n+s.estimate.gpuBytes,0), totalFeatures: loaded.reduce((n,s)=>n+s.estimate.featureCount,0), totalDrawCalls: loaded.reduce((n,s)=>n+s.estimate.drawCalls,0) }); };
  const disposeResource = async (state: MutableLayerState<TResource>, reason: string): Promise<void> => { state.controller?.abort(reason); state.controller = null; const resource = state.resource; state.resource = null; if (resource !== null) await state.adapter.dispose?.(resource, reason); };
  const evictIfNeeded = async (protectedId?: string): Promise<boolean> => { const loaded = loadedStates(); if (budgetSatisfied(loaded)) return true; const candidates = loaded.filter((s) => s.descriptor.id !== protectedId && !s.descriptor.required && !s.requested).sort((a,b) => PRIORITY_WEIGHT[a.priority]-PRIORITY_WEIGHT[b.priority] || (a.lastUsedAt??0)-(b.lastUsedAt??0) || a.descriptor.id.localeCompare(b.descriptor.id)); while (!budgetSatisfied(loaded) && candidates.length) { const candidate = candidates.shift(); if (!candidate?.resource) continue; await disposeResource(candidate, 'capacity'); candidate.phase='idle'; candidate.loadedAt=null; emit(candidate,'evicted','capacity'); loaded.splice(loaded.indexOf(candidate),1); } return budgetSatisfied(loaded); };
  const activate = async (state: MutableLayerState<TResource>): Promise<void> => { if (state.resource === null || state.phase === 'ready') return; await state.adapter.activate?.(state.resource, { signal: state.controller?.signal ?? new AbortController().signal, generation: state.generation, descriptor: state.descriptor }); state.phase='ready'; state.lastUsedAt=now(); emit(state,'resumed'); };

  const executeLoad = async (state: MutableLayerState<TResource>): Promise<void> => {
    if (disposed || state.phase === 'disposed' || !state.requested) return;
    if (state.resource !== null) { await activate(state); return; }
    activeLoads += 1; state.phase='loading'; state.generation += 1; const generation=state.generation; const controller=new AbortController(); state.controller?.abort('superseded'); state.controller=controller; emit(state,'load-start');
    try {
      while (!disposed && state.requested && state.generation === generation) {
        try {
          const resource = await state.adapter.load({ signal: controller.signal, generation, descriptor: state.descriptor });
          if (disposed || controller.signal.aborted || state.generation !== generation) { await state.adapter.dispose?.(resource,'stale-generation'); return; }
          state.resource=resource; state.phase='ready'; state.loadedAt=now(); state.lastUsedAt=state.loadedAt; state.lastError=null;
          if (!(await evictIfNeeded(state.descriptor.id))) { const error=new SceneLayerResourceBudgetError(state.descriptor.id); state.lastError=error; await disposeResource(state,'resource-budget'); state.phase='failed'; state.loadedAt=null; emit(state,'load-failed','resource-budget'); return; }
          try { await state.adapter.activate?.(resource,{ signal: controller.signal, generation, descriptor: state.descriptor }); } catch (error) { state.lastError=error; await disposeResource(state,'activation-failed'); state.phase='failed'; state.loadedAt=null; emit(state,'load-failed','activation-failed'); return; }
          state.retries=0; emit(state,'load-ready'); return;
        } catch (error) { if (controller.signal.aborted || disposed || state.generation !== generation) return; state.lastError=error; if (state.retries >= retryLimit) { state.phase='failed'; emit(state,'load-failed'); return; } state.retries += 1; await sleep(retryBaseDelayMs * (2 ** (state.retries - 1)), controller.signal); }
      }
    } finally { activeLoads=Math.max(0,activeLoads-1); state.inFlight=null; }
  };
  const chooseQueued = (): MutableLayerState<TResource>[] => [...layers.values()].filter((s)=>s.phase==='queued'&&s.requested).sort((a,b)=>PRIORITY_WEIGHT[b.priority]-PRIORITY_WEIGHT[a.priority] || Number(b.descriptor.required===true)-Number(a.descriptor.required===true) || (a.lastUsedAt??0)-(b.lastUsedAt??0));
  const pump = async (): Promise<void> => { while (!disposed && activeLoads < maxConcurrentLoads) { const next=chooseQueued()[0]; if (!next) break; next.inFlight=executeLoad(next); void next.inFlight.finally(()=>{ void scheduleReconcile(); }); await Promise.resolve(); } };
  const reconcileInternal = async (): Promise<void> => {
    for (const state of layers.values()) {
      const requested=shouldBeRequested(state); state.requested=requested;
      if (requested) { if (state.phase==='idle'||state.phase==='failed'||state.phase==='suspended') { if (state.resource!==null) await activate(state); else { state.phase='queued'; emit(state,'requested'); } } }
      else if (state.phase==='ready'&&state.resource!==null) { await state.adapter.suspend?.(state.resource,'viewport'); state.phase='suspended'; emit(state,'suspended','viewport'); }
      else if (state.phase==='queued') state.phase='idle';
      else if (state.phase==='loading') { state.controller?.abort('viewport'); state.phase='idle'; }
    }
    await pump(); await evictIfNeeded();
  };
  const scheduleReconcile = (): Promise<void> => {
    reconcileDirty = true;
    if (!reconcileScheduled) reconcileScheduled = (async () => { while (reconcileDirty && !disposed) { reconcileDirty=false; await reconcileInternal(); } })().finally(()=>{ reconcileScheduled=null; if (reconcileDirty && !disposed) void scheduleReconcile(); });
    return reconcileScheduled;
  };

  const register = (descriptor: SceneLayerDescriptor, adapter: SceneLayerAdapter<TResource>): SceneLayerSnapshot => { if (disposed) throw new Error('Scene layer runtime is disposed'); const id=descriptor.id.trim(); if (!id) throw new Error('Scene layer id is required'); if (layers.has(id)) throw new Error(`Scene layer already registered: ${id}`); const normalized=Object.freeze({...descriptor,id}); const state: MutableLayerState<TResource>={ descriptor:normalized, adapter, phase:'idle', priority:descriptor.priority??'normal', generation:0, requested:false, manualRequested:false, visible:descriptor.visible!==false, retries:0, lastError:null, loadedAt:null, lastUsedAt:null, resource:null, controller:null, inFlight:null, estimate:normalizeEstimate(descriptor.resourceEstimate) }; layers.set(id,state); emit(state,'registered'); return snapshotLayer(state); };
  const unregister = async (layerId: string, reason='unregister'): Promise<boolean> => { const state=layers.get(layerId); if (!state) return false; state.generation+=1; state.controller?.abort(reason); await disposeResource(state,reason); state.phase='disposed'; emit(state,'disposed',reason); layers.delete(layerId); return true; };
  const request = async (layerId: string, reason='manual'): Promise<SceneLayerSnapshot> => { const state=getState(layerId); state.visible=true; state.manualRequested=true; state.requested=true; if (state.resource!==null) { if (state.phase!=='ready') await activate(state); } else if (state.phase!=='loading'&&state.phase!=='queued') { state.phase='queued'; emit(state,'requested',reason); } await scheduleReconcile(); if (state.inFlight) await state.inFlight; return snapshotLayer(state); };
  const suspend = async (layerId: string, reason='manual'): Promise<boolean> => { const state=layers.get(layerId); if (!state||state.phase==='disposed') return false; state.manualRequested=false; state.requested=viewportRequests(state); if (state.requested) return true; state.controller?.abort(reason); const resource=state.resource; state.phase=resource!==null?'suspended':'idle'; emit(state,'suspended',reason); if (resource!==null) await state.adapter.suspend?.(resource,reason); return true; };
  const resume = async (layerId: string, reason='manual'): Promise<SceneLayerSnapshot> => request(layerId,reason);
  const setVisibility = (layerId: string, visible: boolean): SceneLayerSnapshot => { const state=getState(layerId); state.visible=visible; if (!visible) state.manualRequested=false; emit(state,'visibility',visible?'visible':'hidden'); void scheduleReconcile(); return snapshotLayer(state); };
  const setViewport = async (input: { scale?: number; zoom?: number }): Promise<SceneLayerRuntimeSnapshot> => { viewportInitialized=true; viewportScale=Number.isFinite(input.scale)?Number(input.scale):null; viewportZoom=Number.isFinite(input.zoom)?Number(input.zoom):null; for (const state of layers.values()) { if (!viewportRequests(state) && !state.manualRequested && state.phase==='loading') state.controller?.abort('viewport'); } await scheduleReconcile(); return buildSnapshot(); };
  const reconcile = async (): Promise<SceneLayerRuntimeSnapshot> => { await scheduleReconcile(); return buildSnapshot(); };
  const getLayerSnapshot = (layerId: string): SceneLayerSnapshot | null => { const state=layers.get(layerId); return state?snapshotLayer(state):null; };
  const dispose = async (reason='runtime-dispose'): Promise<void> => { if (disposed) return; disposed=true; reconcileDirty=false; await Promise.allSettled([...layers.values()].map(async(state)=>{ state.generation+=1; state.controller?.abort(reason); await disposeResource(state,reason); state.phase='disposed'; emit(state,'disposed',reason); })); layers.clear(); activeLoads=0; };
  return Object.freeze({ register, unregister, request, suspend, resume, setVisibility, setViewport, reconcile, getLayerSnapshot, getSnapshot: buildSnapshot, dispose });
};
