import type { ArcGisLayerLike, RemovableHandle } from './contracts';

/**
 * Scoped ownership for operational ArcGIS layers, watches, async work and view
 * attachments. The manager prevents cross-tool "clear everything" behaviour and
 * makes cleanup idempotent across React mount/unmount and 2D/3D view switches.
 */

export type ViewKind = '2d' | '3d';
export type LifecycleState = 'active' | 'disposing' | 'disposed';

export interface LayerCollectionLike {
  add?: (layer: ArcGisLayerLike, index?: number) => unknown;
  remove?: (layer: ArcGisLayerLike) => unknown;
  includes?: (layer: ArcGisLayerLike) => boolean;
  toArray?: () => ArcGisLayerLike[];
}

export interface MapLike {
  layers?: LayerCollectionLike;
  add?: (layer: ArcGisLayerLike, index?: number) => unknown;
  remove?: (layer: ArcGisLayerLike) => unknown;
}

export interface ViewLike {
  readonly type?: string;
  readonly map?: MapLike | null;
  when?: () => Promise<unknown>;
}

export interface LayerOwnershipOptions {
  readonly ownerId: string;
  readonly layer: ArcGisLayerLike;
  readonly role?: string;
  readonly removeLayerOnDispose?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface LayerLifecycleSnapshot {
  readonly state: LifecycleState;
  readonly owners: number;
  readonly layers: number;
  readonly handles: number;
  readonly abortControllers: number;
  readonly disposers: number;
  readonly views2d: number;
  readonly views3d: number;
  readonly generations: Readonly<Record<string, number>>;
}

export interface OwnerSnapshot {
  readonly ownerId: string;
  readonly state: LifecycleState;
  readonly layerIds: readonly string[];
  readonly handleCount: number;
  readonly abortControllerCount: number;
  readonly disposerCount: number;
  readonly generation: number;
}

export class LayerLifecycleError extends Error {
  readonly code: string;
  readonly ownerId?: string;

  constructor(message: string, code = 'LAYER_LIFECYCLE_ERROR', ownerId?: string) {
    super(message);
    this.name = 'LayerLifecycleError';
    this.code = code;
    if (ownerId) this.ownerId = ownerId;
  }
}

interface OwnedLayer {
  readonly layer: ArcGisLayerLike;
  readonly role: string;
  readonly removeLayerOnDispose: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  attachedMaps: Set<MapLike>;
}

interface OwnerRecord {
  readonly id: string;
  state: LifecycleState;
  generation: number;
  readonly layers: Map<ArcGisLayerLike, OwnedLayer>;
  readonly handles: Set<RemovableHandle>;
  readonly controllers: Set<AbortController>;
  readonly disposers: Set<() => void | Promise<void>>;
}

interface ViewRecord {
  readonly view: ViewLike;
  readonly kind: ViewKind;
  readonly map: MapLike | null;
}

const ownerId = (value: unknown): string => {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new LayerLifecycleError('Owner id must not be empty.', 'INVALID_OWNER_ID');
  if (normalized.length > 256) throw new LayerLifecycleError('Owner id is too long.', 'INVALID_OWNER_ID');
  return normalized;
};

const normalizeRole = (value: unknown): string => {
  const normalized = String(value ?? 'operational').trim();
  return normalized || 'operational';
};

const layerIdentity = (layer: ArcGisLayerLike, fallback: number): string => {
  const candidate = String(layer.id ?? layer.title ?? '').trim();
  return candidate || `anonymous-layer-${fallback}`;
};

const safeRemoveHandle = (handle: RemovableHandle): void => {
  try {
    handle.remove?.();
  } catch {
    // Disposal must remain best-effort and continue releasing sibling resources.
  }
};

const collectionContains = (collection: LayerCollectionLike, layer: ArcGisLayerLike): boolean => {
  try {
    if (typeof collection.includes === 'function') return collection.includes(layer);
    if (typeof collection.toArray === 'function') return collection.toArray().includes(layer);
  } catch {
    return false;
  }
  return false;
};

const addLayer = (map: MapLike, layer: ArcGisLayerLike, index?: number): void => {
  const layers = map.layers;
  if (layers && collectionContains(layers, layer)) return;
  if (layers?.add) {
    layers.add(layer, index);
    return;
  }
  map.add?.(layer, index);
};

const removeLayer = (map: MapLike, layer: ArcGisLayerLike): void => {
  try {
    const layers = map.layers;
    if (layers?.remove) {
      if (!layers.includes || collectionContains(layers, layer)) layers.remove(layer);
      return;
    }
    map.remove?.(layer);
  } catch {
    // A destroyed ArcGIS view/map can throw during cleanup; ownership still ends.
  }
};

const inferViewKind = (view: ViewLike, explicit?: ViewKind): ViewKind => {
  if (explicit) return explicit;
  const value = String(view.type ?? '').toLowerCase();
  return value.includes('scene') || value.includes('3d') ? '3d' : '2d';
};

export class LayerLifecycleManager {
  private readonly owners = new Map<string, OwnerRecord>();
  private readonly views = new Map<ViewLike, ViewRecord>();
  private state: LifecycleState = 'active';
  private anonymousLayerSequence = 0;

  getState(): LifecycleState {
    return this.state;
  }

  registerView(view: ViewLike, kind?: ViewKind): () => void {
    this.assertActive();
    if (!view || typeof view !== 'object') {
      throw new LayerLifecycleError('View registration requires a view object.', 'INVALID_VIEW');
    }
    const record: ViewRecord = {
      view,
      kind: inferViewKind(view, kind),
      map: view.map ?? null,
    };
    this.views.set(view, record);
    return () => this.unregisterView(view);
  }

  unregisterView(view: ViewLike): boolean {
    const record = this.views.get(view);
    if (!record) return false;
    for (const owner of this.owners.values()) {
      for (const owned of owner.layers.values()) {
        if (record.map && owned.attachedMaps.has(record.map)) {
          if (owned.removeLayerOnDispose) removeLayer(record.map, owned.layer);
          owned.attachedMaps.delete(record.map);
        }
      }
    }
    return this.views.delete(view);
  }

  ownLayer(options: LayerOwnershipOptions): ArcGisLayerLike {
    this.assertActive();
    const owner = this.ensureOwner(options.ownerId);
    this.assertOwnerActive(owner);
    const existing = owner.layers.get(options.layer);
    if (existing) return existing.layer;
    owner.layers.set(options.layer, {
      layer: options.layer,
      role: normalizeRole(options.role),
      removeLayerOnDispose: options.removeLayerOnDispose !== false,
      metadata: Object.freeze({ ...(options.metadata ?? {}) }),
      attachedMaps: new Set<MapLike>(),
    });
    return options.layer;
  }

  releaseLayer(rawOwnerId: string, layer: ArcGisLayerLike): boolean {
    const owner = this.owners.get(ownerId(rawOwnerId));
    if (!owner) return false;
    const owned = owner.layers.get(layer);
    if (!owned) return false;
    if (owned.removeLayerOnDispose) {
      for (const map of owned.attachedMaps) removeLayer(map, owned.layer);
    }
    owned.attachedMaps.clear();
    return owner.layers.delete(layer);
  }

  attachOwnerLayers(rawOwnerId: string, target?: ViewLike, index?: number): number {
    this.assertActive();
    const owner = this.requireOwner(rawOwnerId);
    this.assertOwnerActive(owner);
    const targets = target ? [this.requireView(target)] : Array.from(this.views.values());
    let attached = 0;
    for (const view of targets) {
      if (!view.map) continue;
      for (const owned of owner.layers.values()) {
        if (owned.attachedMaps.has(view.map)) continue;
        addLayer(view.map, owned.layer, index);
        owned.attachedMaps.add(view.map);
        attached += 1;
      }
    }
    return attached;
  }

  detachOwnerLayers(rawOwnerId: string, target?: ViewLike): number {
    const owner = this.owners.get(ownerId(rawOwnerId));
    if (!owner) return 0;
    const targetMaps = target
      ? new Set([this.views.get(target)?.map].filter((value): value is MapLike => Boolean(value)))
      : null;
    let detached = 0;
    for (const owned of owner.layers.values()) {
      for (const map of Array.from(owned.attachedMaps)) {
        if (targetMaps && !targetMaps.has(map)) continue;
        if (owned.removeLayerOnDispose) removeLayer(map, owned.layer);
        owned.attachedMaps.delete(map);
        detached += 1;
      }
    }
    return detached;
  }

  trackHandle(rawOwnerId: string, handle: RemovableHandle): RemovableHandle {
    this.assertActive();
    const owner = this.ensureOwner(rawOwnerId);
    this.assertOwnerActive(owner);
    if (!handle || typeof handle !== 'object') {
      throw new LayerLifecycleError('Tracked handle must be an object.', 'INVALID_HANDLE', owner.id);
    }
    owner.handles.add(handle);
    return handle;
  }

  untrackHandle(rawOwnerId: string, handle: RemovableHandle, remove = false): boolean {
    const owner = this.owners.get(ownerId(rawOwnerId));
    if (!owner || !owner.handles.delete(handle)) return false;
    if (remove) safeRemoveHandle(handle);
    return true;
  }

  createAbortController(rawOwnerId: string): AbortController {
    this.assertActive();
    const owner = this.ensureOwner(rawOwnerId);
    this.assertOwnerActive(owner);
    const controller = new AbortController();
    owner.controllers.add(controller);
    return controller;
  }

  trackAbortController(rawOwnerId: string, controller: AbortController): AbortController {
    this.assertActive();
    const owner = this.ensureOwner(rawOwnerId);
    this.assertOwnerActive(owner);
    owner.controllers.add(controller);
    return controller;
  }

  releaseAbortController(rawOwnerId: string, controller: AbortController, abort = false): boolean {
    const owner = this.owners.get(ownerId(rawOwnerId));
    if (!owner || !owner.controllers.delete(controller)) return false;
    if (abort && !controller.signal.aborted) controller.abort();
    return true;
  }

  trackDisposer(rawOwnerId: string, disposer: () => void | Promise<void>): () => void | Promise<void> {
    this.assertActive();
    if (typeof disposer !== 'function') {
      throw new LayerLifecycleError('Disposer must be a function.', 'INVALID_DISPOSER', rawOwnerId);
    }
    const owner = this.ensureOwner(rawOwnerId);
    this.assertOwnerActive(owner);
    owner.disposers.add(disposer);
    return disposer;
  }

  beginGeneration(rawOwnerId: string, reason?: unknown): number {
    this.assertActive();
    const owner = this.ensureOwner(rawOwnerId);
    this.assertOwnerActive(owner);
    owner.generation += 1;
    for (const controller of owner.controllers) {
      if (!controller.signal.aborted) controller.abort(reason ?? new LayerLifecycleError(
        'Owner generation superseded.',
        'GENERATION_SUPERSEDED',
        owner.id,
      ));
    }
    owner.controllers.clear();
    return owner.generation;
  }

  currentGeneration(rawOwnerId: string): number {
    const owner = this.owners.get(ownerId(rawOwnerId));
    return owner?.generation ?? 0;
  }

  isCurrentGeneration(rawOwnerId: string, generation: number): boolean {
    const owner = this.owners.get(ownerId(rawOwnerId));
    return Boolean(owner && owner.state === 'active' && owner.generation === generation);
  }

  assertCurrentGeneration(rawOwnerId: string, generation: number): void {
    if (!this.isCurrentGeneration(rawOwnerId, generation)) {
      throw new LayerLifecycleError(
        'Async result belongs to a stale owner generation.',
        'STALE_OWNER_GENERATION',
        rawOwnerId,
      );
    }
  }

  ownerSnapshot(rawOwnerId: string): OwnerSnapshot | null {
    const owner = this.owners.get(ownerId(rawOwnerId));
    if (!owner) return null;
    return Object.freeze({
      ownerId: owner.id,
      state: owner.state,
      layerIds: Object.freeze(Array.from(owner.layers.values()).map((owned) => (
        layerIdentity(owned.layer, ++this.anonymousLayerSequence)
      ))),
      handleCount: owner.handles.size,
      abortControllerCount: owner.controllers.size,
      disposerCount: owner.disposers.size,
      generation: owner.generation,
    });
  }

  snapshot(): LayerLifecycleSnapshot {
    let layers = 0;
    let handles = 0;
    let controllers = 0;
    let disposers = 0;
    const generations: Record<string, number> = {};
    for (const owner of this.owners.values()) {
      layers += owner.layers.size;
      handles += owner.handles.size;
      controllers += owner.controllers.size;
      disposers += owner.disposers.size;
      generations[owner.id] = owner.generation;
    }
    let views2d = 0;
    let views3d = 0;
    for (const view of this.views.values()) {
      if (view.kind === '3d') views3d += 1;
      else views2d += 1;
    }
    return Object.freeze({
      state: this.state,
      owners: this.owners.size,
      layers,
      handles,
      abortControllers: controllers,
      disposers,
      views2d,
      views3d,
      generations: Object.freeze(generations),
    });
  }

  async disposeOwner(rawOwnerId: string, reason?: unknown): Promise<boolean> {
    const id = ownerId(rawOwnerId);
    const owner = this.owners.get(id);
    if (!owner || owner.state === 'disposed') return false;
    owner.state = 'disposing';
    for (const controller of owner.controllers) {
      if (!controller.signal.aborted) controller.abort(reason ?? new LayerLifecycleError(
        'Layer owner disposed.',
        'OWNER_DISPOSED',
        id,
      ));
    }
    owner.controllers.clear();
    for (const handle of owner.handles) safeRemoveHandle(handle);
    owner.handles.clear();
    this.detachOwnerLayers(id);
    owner.layers.clear();

    const disposers = Array.from(owner.disposers);
    owner.disposers.clear();
    for (const disposer of disposers) {
      try {
        await disposer();
      } catch {
        // Continue deterministic teardown even if one third-party disposer fails.
      }
    }
    owner.state = 'disposed';
    this.owners.delete(id);
    return true;
  }

  async dispose(reason?: unknown): Promise<void> {
    if (this.state === 'disposed' || this.state === 'disposing') return;
    this.state = 'disposing';
    const owners = Array.from(this.owners.keys());
    for (const id of owners) await this.disposeOwner(id, reason);
    this.views.clear();
    this.state = 'disposed';
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new LayerLifecycleError('Layer lifecycle manager is not active.', 'MANAGER_NOT_ACTIVE');
    }
  }

  private ensureOwner(rawOwnerId: string): OwnerRecord {
    const id = ownerId(rawOwnerId);
    const existing = this.owners.get(id);
    if (existing) return existing;
    const owner: OwnerRecord = {
      id,
      state: 'active',
      generation: 0,
      layers: new Map(),
      handles: new Set(),
      controllers: new Set(),
      disposers: new Set(),
    };
    this.owners.set(id, owner);
    return owner;
  }

  private requireOwner(rawOwnerId: string): OwnerRecord {
    const id = ownerId(rawOwnerId);
    const owner = this.owners.get(id);
    if (!owner) throw new LayerLifecycleError(`Unknown layer owner: ${id}`, 'UNKNOWN_OWNER', id);
    return owner;
  }

  private requireView(view: ViewLike): ViewRecord {
    const record = this.views.get(view);
    if (!record) throw new LayerLifecycleError('Target view is not registered.', 'UNKNOWN_VIEW');
    return record;
  }

  private assertOwnerActive(owner: OwnerRecord): void {
    if (owner.state !== 'active') {
      throw new LayerLifecycleError(`Layer owner ${owner.id} is not active.`, 'OWNER_NOT_ACTIVE', owner.id);
    }
  }
}

export const createLayerLifecycleManager = (): LayerLifecycleManager => new LayerLifecycleManager();
