import { LAYER_STATUS, isScaleVisible, layerReducer, visibleLayersAtScale } from './layerRuntime';
import type { ArcGisLayerLike, LayerAction, LayerDescriptor, LayerTree } from './contracts';

export const LAYER_LOAD_PRIORITY = Object.freeze({ BACKGROUND: 10, PREFETCH: 25, VISIBLE: 100, USER_REQUESTED: 250, SELECTED: 500 });
export interface LayerSchedulerErrorDetails { code?: string; layerId?: string | null; cause?: unknown; }
export class LayerSchedulerError extends Error {
  code: string; layerId: string | null; cause?: unknown;
  constructor(message: string, details: LayerSchedulerErrorDetails = {}) { super(message); this.name = 'LayerSchedulerError'; this.code = details.code || 'LAYER_SCHEDULER_ERROR'; this.layerId = details.layerId || null; this.cause = details.cause; }
}
const finite = (value: unknown, fallback: number | null = null): number | null => { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; };
const positiveInteger = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number => { const numeric = Number(value); if (!Number.isFinite(numeric) || numeric <= 0) return fallback; return Math.min(max, Math.max(1, Math.floor(numeric))); };
const now = (): number => Date.now();
const cancelledError = (layerId: string): LayerSchedulerError => new LayerSchedulerError('Layer request cancelled.', { code: 'CANCELLED', layerId });
const normalizeLayerId = (layerOrId: unknown): string => { const raw = typeof layerOrId === 'object' && layerOrId ? (layerOrId as { id?: unknown }).id : layerOrId; const id = String(raw ?? '').trim(); if (!id) throw new LayerSchedulerError('A layer id is required.', { code: 'INVALID_LAYER_ID' }); return id; };
const normalizePriority = (value: unknown, fallback = LAYER_LOAD_PRIORITY.VISIBLE): number => { const numeric = Number(value); return Number.isFinite(numeric) ? numeric : fallback; };
const safeAbort = (controller: AbortController | null): boolean => { if (!controller || controller.signal?.aborted) return false; try { controller.abort(); return true; } catch (_) { return false; } };
const createController = (): AbortController | null => typeof AbortController === 'undefined' ? null : new AbortController();

export interface LayerPriorityContext { selectedLayerId?: unknown; userRequestedIds?: unknown[]; visibleIds?: unknown[]; prefetchIds?: unknown[]; [key: string]: unknown; }
export interface LayerLoadPlanEntry { layer: LayerDescriptor; priority: number; visibleAtScale: boolean; selected: boolean; userRequested: boolean; prefetch: boolean; }
export interface LayerLoadPlan { scale: number | null; visibleIds: string[]; desiredIds: string[]; load: LayerLoadPlanEntry[]; unload: LayerDescriptor[]; }
export const computeLayerPriority = (layer: LayerDescriptor | { id?: unknown }, context: LayerPriorityContext = {}): number => {
  const id = normalizeLayerId(layer);
  if (id === String(context.selectedLayerId ?? '')) return LAYER_LOAD_PRIORITY.SELECTED;
  if ((context.userRequestedIds || []).map(String).includes(id)) return LAYER_LOAD_PRIORITY.USER_REQUESTED;
  if ((context.visibleIds || []).map(String).includes(id)) return LAYER_LOAD_PRIORITY.VISIBLE;
  if ((context.prefetchIds || []).map(String).includes(id)) return LAYER_LOAD_PRIORITY.PREFETCH;
  return LAYER_LOAD_PRIORITY.BACKGROUND;
};
export const createLayerLoadPlan = (tree: LayerTree, scale: unknown, context: LayerPriorityContext = {}): LayerLoadPlan => {
  const visible = visibleLayersAtScale(tree, scale); const visibleIds = visible.map((layer) => layer.id);
  const selectedLayerId = context.selectedLayerId == null ? null : String(context.selectedLayerId);
  const userRequestedIds = Array.from(new Set((context.userRequestedIds || []).map(String)));
  const prefetchIds = Array.from(new Set((context.prefetchIds || []).map(String)));
  const byId = tree?.byId || new Map<string, LayerDescriptor>(); const desiredIds = new Set<string>([...visibleIds, ...userRequestedIds, ...prefetchIds]);
  if (selectedLayerId && byId.has(selectedLayerId)) desiredIds.add(selectedLayerId);
  const load: LayerLoadPlanEntry[] = [];
  desiredIds.forEach((id) => { const layer = byId.get(id); if (!layer || layer.runtime?.status === LAYER_STATUS.DISABLED) return; const visibleAtScale = isScaleVisible(scale, layer); const requested = userRequestedIds.includes(id) || id === selectedLayerId; if (!visibleAtScale && !requested) return; load.push({ layer, priority: computeLayerPriority(layer, { ...context, visibleIds, userRequestedIds, prefetchIds, selectedLayerId }), visibleAtScale, selected: id === selectedLayerId, userRequested: userRequestedIds.includes(id), prefetch: prefetchIds.includes(id) }); });
  load.sort((left, right) => right.priority - left.priority || left.layer.id.localeCompare(right.layer.id));
  const unload: LayerDescriptor[] = []; byId.forEach((layer, id) => { if (layer?.sdkLayer && !desiredIds.has(id)) unload.push(layer); });
  return { scale: finite(scale), visibleIds, desiredIds: [...desiredIds], load, unload };
};
export const applyRuntimeToSdkLayer = (descriptor: LayerDescriptor, sdkLayer: ArcGisLayerLike | null = descriptor?.sdkLayer): boolean => {
  if (!descriptor || !sdkLayer) return false; const runtime = descriptor.runtime || {} as any;
  if (typeof runtime.visible === 'boolean') sdkLayer.visible = runtime.visible;
  if (Number.isFinite(Number(runtime.opacity))) sdkLayer.opacity = Math.min(1, Math.max(0, Number(runtime.opacity)));
  if (Number.isFinite(Number(runtime.minScale)) && Number(runtime.minScale) >= 0) sdkLayer.minScale = Number(runtime.minScale);
  if (Number.isFinite(Number(runtime.maxScale)) && Number(runtime.maxScale) >= 0) sdkLayer.maxScale = Number(runtime.maxScale);
  return true;
};

export interface ResidencyRecord { layerId: string; lastUsedAt: number; pinned: boolean; [key: string]: any; }
export interface ResidencyTracker { touch: (layerId: unknown, metadata?: Record<string, any>) => ResidencyRecord; pin: (layerId: unknown, pinned?: boolean) => ResidencyRecord; forget: (layerId: unknown) => boolean; get: (layerId: unknown) => ResidencyRecord | null; idleCandidates: (activeIds?: unknown[]) => ResidencyRecord[]; clear: () => void; size: () => number; settings: () => { idleMs: number }; }
export const createLayerResidencyTracker = (options: { now?: () => number; idleMs?: unknown } = {}): ResidencyTracker => {
  const clock = typeof options.now === 'function' ? options.now : now; const idleMs = positiveInteger(options.idleMs, 120000, 24 * 60 * 60 * 1000); const records = new Map<string, ResidencyRecord>();
  const touch = (layerId: unknown, metadata: Record<string, any> = {}): ResidencyRecord => { const id = normalizeLayerId(layerId); const previous = records.get(id) || {} as ResidencyRecord; const record = { ...previous, ...metadata, layerId: id, lastUsedAt: clock(), pinned: metadata.pinned ?? previous.pinned ?? false } as ResidencyRecord; records.set(id, record); return { ...record }; };
  const pin = (layerId: unknown, pinned = true) => touch(layerId, { pinned: Boolean(pinned) });
  const forget = (layerId: unknown) => records.delete(normalizeLayerId(layerId));
  const get = (layerId: unknown) => { const record = records.get(normalizeLayerId(layerId)); return record ? { ...record } : null; };
  const idleCandidates = (activeIds: unknown[] = []) => { const activeIdsSet = new Set(activeIds.map(String)); const current = clock(); return [...records.values()].filter((record) => !record.pinned && !activeIdsSet.has(record.layerId) && current - record.lastUsedAt >= idleMs).sort((a, b) => a.lastUsedAt - b.lastUsedAt).map((record) => ({ ...record })); };
  return { touch, pin, forget, get, idleCandidates, clear: () => records.clear(), size: () => records.size, settings: () => ({ idleMs }) };
};

export interface SchedulerLoaderContext<TLayer> { layer: TLayer; layerId: string; signal?: AbortSignal; priority: number; metadata: Record<string, any>; }
export type SchedulerLoader<TLayer, TValue> = (context: SchedulerLoaderContext<TLayer>) => TValue | Promise<TValue>;
export interface ScheduleOptions { signal?: AbortSignal; priority?: unknown; metadata?: Record<string, any>; [key: string]: any; }
type EntryState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
interface Subscriber<T> { signal?: AbortSignal; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: any) => void; done: boolean; abortHandler: (() => void) | null; }
interface SchedulerEntry<TLayer = any, TValue = any> { layerId: string; layer: TLayer; loader: SchedulerLoader<TLayer, TValue>; priority: number; metadata: Record<string, any>; sequence: number; state: EntryState; enqueuedAt: number; startedAt: number | null; completedAt: number | null; controller: AbortController | null; subscribers: Set<Subscriber<TValue>>; settled: boolean; error: any; value: TValue | undefined; }
export interface LayerSchedulerSnapshot { [key: string]: any; }
export interface LayerLoadScheduler { schedule: <TLayer, TValue>(layer: TLayer, loader: SchedulerLoader<TLayer, TValue>, options?: ScheduleOptions) => Promise<TValue>; cancel: (layerId: unknown, reason?: string) => boolean; cancelExcept: (desiredIds?: unknown[]) => number; reprioritize: (layerId: unknown, priority: unknown) => boolean; setMaxConcurrent: (value: unknown) => number; snapshot: () => LayerSchedulerSnapshot; destroy: () => void; has: (layerId: unknown) => boolean; getState: (layerId: unknown) => EntryState | null; }
const eventSnapshot = (entry: SchedulerEntry) => ({ layerId: entry.layerId, priority: entry.priority, state: entry.state, subscribers: entry.subscribers.size, enqueuedAt: entry.enqueuedAt, startedAt: entry.startedAt, completedAt: entry.completedAt });
export const createLayerLoadScheduler = (configuration: { maxConcurrent?: unknown; now?: () => number; onEvent?: (event: any) => void } = {}): LayerLoadScheduler => {
  const settings = { maxConcurrent: positiveInteger(configuration.maxConcurrent, 4, 16) }; const clock = typeof configuration.now === 'function' ? configuration.now : now; const onEvent = typeof configuration.onEvent === 'function' ? configuration.onEvent : () => {};
  const queue: SchedulerEntry[] = []; const entries = new Map<string, SchedulerEntry>(); let sequence = 0; let active = 0; let destroyed = false; let draining = false;
  const metrics = { enqueued: 0, deduped: 0, started: 0, completed: 0, failed: 0, cancelled: 0, underlyingAborts: 0, reprioritized: 0, peakConcurrent: 0, totalLoadMs: 0, lastLoadMs: null as number | null };
  const emit = (type: string, entry: SchedulerEntry, extra: Record<string, any> = {}): void => { try { onEvent({ type, ...eventSnapshot(entry), ...extra }); } catch (_) { /* observer isolation */ } };
  const sortQueue = (): void => { queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence); };
  const removeFromQueue = (entry: SchedulerEntry): void => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); };
  const finishSubscriber = <T>(entry: SchedulerEntry<any, T>, subscriber: Subscriber<T>, callback: (value: any) => void, value: any, reason: 'cancelled' | null = null): void => {
    if (subscriber.done) return; subscriber.done = true; if (subscriber.abortHandler && subscriber.signal) subscriber.signal.removeEventListener('abort', subscriber.abortHandler); entry.subscribers.delete(subscriber); if (reason === 'cancelled') metrics.cancelled += 1; callback(value);
    if (entry.subscribers.size === 0 && !entry.settled) { if (entry.state === 'queued') { removeFromQueue(entry as SchedulerEntry); entries.delete(entry.layerId); entry.state = 'cancelled'; entry.settled = true; emit('cancelled', entry as SchedulerEntry, { phase: 'queued' }); } else if (entry.state === 'running' && safeAbort(entry.controller)) { metrics.underlyingAborts += 1; emit('abort', entry as SchedulerEntry, { phase: 'running' }); } }
  };
  const subscribe = <T>(entry: SchedulerEntry<any, T>, signal?: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    const subscriber: Subscriber<T> = { signal, resolve, reject, done: false, abortHandler: null }; entry.subscribers.add(subscriber);
    const cancelSubscriber = () => finishSubscriber(entry, subscriber, reject, cancelledError(entry.layerId), 'cancelled');
    if (signal) { subscriber.abortHandler = cancelSubscriber; if (signal.aborted) { cancelSubscriber(); return; } signal.addEventListener('abort', cancelSubscriber, { once: true }); }
    if (entry.settled) { if (entry.error) finishSubscriber(entry, subscriber, reject, entry.error); else finishSubscriber(entry, subscriber, resolve, entry.value); }
  });
  const settleEntry = (entry: SchedulerEntry, error: any, value: any): boolean => {
    if (entry.settled) return false; entry.settled = true; entry.error = error || null; entry.value = value; entry.completedAt = clock(); const duration = Math.max(0, entry.completedAt - (entry.startedAt ?? entry.enqueuedAt)); metrics.totalLoadMs += duration; metrics.lastLoadMs = duration;
    if (error) { entry.state = error?.code === 'CANCELLED' || error?.name === 'AbortError' ? 'cancelled' : 'failed'; if (entry.state === 'failed') metrics.failed += 1; } else { entry.state = 'completed'; metrics.completed += 1; }
    [...entry.subscribers].forEach((subscriber) => { if (error) finishSubscriber(entry, subscriber, subscriber.reject, error); else finishSubscriber(entry, subscriber, subscriber.resolve, value); });
    if (entries.get(entry.layerId) === entry) entries.delete(entry.layerId); emit(entry.state, entry, error ? { error } : { value }); return true;
  };
  const startEntry = (entry: SchedulerEntry): void => {
    if (destroyed || entry.settled || entry.subscribers.size === 0) return; entry.state = 'running'; entry.startedAt = clock(); entry.controller = createController(); active += 1; metrics.started += 1; metrics.peakConcurrent = Math.max(metrics.peakConcurrent, active); emit('started', entry);
    Promise.resolve().then(() => entry.loader({ layer: entry.layer, layerId: entry.layerId, signal: entry.controller?.signal, priority: entry.priority, metadata: { ...entry.metadata } })).then((value) => settleEntry(entry, null, value), (error) => settleEntry(entry, error, undefined)).finally(() => { active = Math.max(0, active - 1); drain(); });
  };
  const drain = (): void => { if (destroyed || draining) return; draining = true; try { sortQueue(); while (active < settings.maxConcurrent && queue.length) { const entry = queue.shift(); if (!entry || entry.settled || entry.subscribers.size === 0) continue; startEntry(entry); } } finally { draining = false; } };
  const schedule = <TLayer, TValue>(layer: TLayer, loader: SchedulerLoader<TLayer, TValue>, options: ScheduleOptions = {}): Promise<TValue> => {
    if (destroyed) return Promise.reject(new LayerSchedulerError('Layer scheduler has been destroyed.', { code: 'SCHEDULER_DESTROYED', layerId: typeof layer === 'object' && layer ? String((layer as any).id ?? '') : String(layer ?? '') }));
    let layerId: string; try { layerId = normalizeLayerId(layer); } catch (error) { return Promise.reject(error); }
    if (typeof loader !== 'function') return Promise.reject(new LayerSchedulerError('A layer loader function is required.', { code: 'INVALID_LAYER_LOADER', layerId }));
    if (options.signal?.aborted) return Promise.reject(cancelledError(layerId));
    const requestedPriority = normalizePriority(options.priority); let entry = entries.get(layerId) as SchedulerEntry<TLayer, TValue> | undefined;
    if (entry && !entry.settled) { metrics.deduped += 1; if (requestedPriority > entry.priority && entry.state === 'queued') { entry.priority = requestedPriority; metrics.reprioritized += 1; sortQueue(); emit('reprioritized', entry as SchedulerEntry); } return subscribe(entry, options.signal); }
    entry = { layerId, layer: typeof layer === 'object' ? layer : ({ id: layerId } as unknown as TLayer), loader, priority: requestedPriority, metadata: { ...options.metadata }, sequence: sequence++, state: 'queued', enqueuedAt: clock(), startedAt: null, completedAt: null, controller: null, subscribers: new Set<Subscriber<TValue>>(), settled: false, error: null, value: undefined };
    entries.set(layerId, entry as SchedulerEntry); queue.push(entry as SchedulerEntry); metrics.enqueued += 1; emit('enqueued', entry as SchedulerEntry); const promise = subscribe(entry, options.signal); drain(); return promise;
  };
  const cancel = (layerId: unknown, reason = 'cancelled'): boolean => { const id = normalizeLayerId(layerId); const entry = entries.get(id); if (!entry || entry.settled) return false; const error = new LayerSchedulerError(`Layer request ${reason}.`, { code: 'CANCELLED', layerId: id }); if (entry.state === 'queued') removeFromQueue(entry); if (entry.state === 'running' && safeAbort(entry.controller)) metrics.underlyingAborts += 1; return settleEntry(entry, error, undefined); };
  const cancelExcept = (desiredIds: unknown[] = []): number => { const desired = new Set(desiredIds.map(String)); let count = 0; [...entries.keys()].forEach((id) => { if (!desired.has(id) && cancel(id, 'no longer needed')) count += 1; }); return count; };
  const reprioritize = (layerId: unknown, priority: unknown): boolean => { const id = normalizeLayerId(layerId); const entry = entries.get(id); if (!entry || entry.settled || entry.state !== 'queued') return false; const next = normalizePriority(priority, entry.priority); if (next === entry.priority) return false; entry.priority = next; metrics.reprioritized += 1; sortQueue(); emit('reprioritized', entry); drain(); return true; };
  const setMaxConcurrent = (value: unknown): number => { settings.maxConcurrent = positiveInteger(value, settings.maxConcurrent, 16); drain(); return settings.maxConcurrent; };
  const snapshot = (): LayerSchedulerSnapshot => ({ ...metrics, queued: queue.filter((entry) => !entry.settled).length, active, tracked: entries.size, maxConcurrent: settings.maxConcurrent, queue: queue.filter((entry) => !entry.settled).map(eventSnapshot), running: [...entries.values()].filter((entry) => entry.state === 'running').map(eventSnapshot) });
  const destroy = (): void => { if (destroyed) return; [...entries.keys()].forEach((id) => cancel(id, 'scheduler destroyed')); destroyed = true; queue.length = 0; entries.clear(); };
  return { schedule, cancel, cancelExcept, reprioritize, setMaxConcurrent, snapshot, destroy, has: (layerId) => entries.has(String(layerId)), getState: (layerId) => entries.get(String(layerId))?.state || null };
};

export interface RuntimeLoaderOptions {
  scheduler: LayerLoadScheduler;
  getTree: () => LayerTree;
  setTree: (tree: LayerTree) => void;
  loadLayer: (layer: LayerDescriptor, context: SchedulerLoaderContext<LayerDescriptor>) => Promise<ArcGisLayerLike> | ArcGisLayerLike;
  unloadLayer?: (sdkLayer: ArcGisLayerLike, descriptor: LayerDescriptor, reason: string) => Promise<unknown> | unknown;
  residency?: ResidencyTracker;
  now?: () => number;
}
export const createLayerRuntimeLoader = ({ scheduler, getTree, setTree, loadLayer, unloadLayer, residency, now: clock = now }: RuntimeLoaderOptions) => {
  if (!scheduler?.schedule) throw new Error('A layer scheduler is required.'); if (typeof getTree !== 'function' || typeof setTree !== 'function') throw new Error('Layer tree getter/setter functions are required.'); if (typeof loadLayer !== 'function') throw new Error('A layer loader is required.');
  let requestSequence = 0; const activeLoads = new Map<string, Promise<ArcGisLayerLike>>();
  const update = (action: LayerAction): LayerTree => { const current = getTree(); const next = layerReducer(current, action); if (next !== current) setTree(next); return next; };
  const load = (layer: LayerDescriptor, options: ScheduleOptions & { featureCount?: number } = {}): Promise<ArcGisLayerLike> => {
    const layerId = normalizeLayerId(layer); const existing = activeLoads.get(layerId); if (existing) return existing; const requestId = `${layerId}:${++requestSequence}`; update({ type: 'LOAD_START', layerId, requestId });
    const promise = scheduler.schedule<LayerDescriptor, ArcGisLayerLike>(layer, async ({ signal, priority, metadata }) => { const sdkLayer = await loadLayer(layer, { layer, layerId, signal, priority, metadata }); if (signal?.aborted) throw cancelledError(layerId); applyRuntimeToSdkLayer(layer, sdkLayer); residency?.touch?.(layerId, { loadedAt: clock() }); return sdkLayer; }, options)
      .then((sdkLayer) => { update({ type: 'SET_SDK_LAYER', layerId, requestId, sdkLayer }); update({ type: 'LOAD_SUCCESS', layerId, requestId, featureCount: Number.isFinite(options.featureCount) ? options.featureCount : undefined, loadedAt: new Date(clock()).toISOString() }); return sdkLayer; })
      .catch((error) => { if (error?.code === 'CANCELLED' || error?.name === 'AbortError') { update({ type: 'LOAD_CANCEL', layerId, requestId }); throw error; } update({ type: 'LOAD_ERROR', layerId, requestId, error }); throw error; })
      .finally(() => { if (activeLoads.get(layerId) === promise) activeLoads.delete(layerId); });
    activeLoads.set(layerId, promise); return promise;
  };
  const unload = async (layerId: unknown, reason = 'idle'): Promise<boolean> => { const id = normalizeLayerId(layerId); const tree = getTree(); const descriptor = tree?.byId?.get(id); scheduler.cancel(id, reason); try { await activeLoads.get(id); } catch (_) { /* state already reflected */ } if (descriptor?.sdkLayer && typeof unloadLayer === 'function') await unloadLayer(descriptor.sdkLayer, descriptor, reason); residency?.forget?.(id); update({ type: 'SET_SDK_LAYER', layerId: id, sdkLayer: null }); return true; };
  const reconcile = async (scale: unknown, context: LayerPriorityContext = {}) => { const tree = getTree(); const plan = createLayerLoadPlan(tree, scale, context); scheduler.cancelExcept(plan.desiredIds); const loadPromises = plan.load.map(({ layer, priority }) => { residency?.touch?.(layer.id, { desired: true, scale }); if (layer.sdkLayer) { applyRuntimeToSdkLayer(layer); return Promise.resolve(layer.sdkLayer); } return load(layer, { priority, metadata: { scale } }); }); const unloadIds = new Set(plan.unload.map((layer) => layer.id)); residency?.idleCandidates?.(plan.desiredIds).forEach((record) => unloadIds.add(record.layerId)); const unloadPromises = [...unloadIds].map((id) => unload(id)); const [loaded, unloaded] = await Promise.all([Promise.allSettled(loadPromises), Promise.allSettled(unloadPromises)]); return { plan, loaded, unloaded }; };
  return { load, unload, reconcile, hasActiveLoad: (layerId: unknown) => activeLoads.has(String(layerId)) };
};
