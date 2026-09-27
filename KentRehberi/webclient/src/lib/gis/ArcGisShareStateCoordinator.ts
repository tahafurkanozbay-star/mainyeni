export type ArcGisShareViewMode = '2d' | '3d';

export interface ArcGisShareCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number | null;
  readonly heading: number | null;
  readonly tilt: number | null;
  readonly wkid: number;
}

export interface ArcGisShareLayerState {
  readonly key: string;
  readonly visible: boolean;
  readonly opacity: number;
}

export interface ArcGisShareState {
  readonly id: string;
  readonly viewMode: ArcGisShareViewMode;
  readonly camera: ArcGisShareCamera;
  readonly layers: readonly ArcGisShareLayerState[];
  readonly selectedLayerKey: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly revision: number;
}

export interface ArcGisSharePolicy {
  readonly maxStates: number;
  readonly maxLayersPerState: number;
  readonly maxIdLength: number;
  readonly maxLayerKeyLength: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisShareSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly states: readonly ArcGisShareState[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeTime(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}

function boundedText(value: string, maxLength: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
}

function normalizeViewMode(value: ArcGisShareViewMode): ArcGisShareViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid share view mode');
  return value;
}

function normalizeCamera(value: ArcGisShareCamera, mode: ArcGisShareViewMode): ArcGisShareCamera {
  if (!value || typeof value !== 'object') throw new Error('camera is required');
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('camera coordinates must be finite');
  if (!Number.isSafeInteger(value.wkid) || value.wkid <= 0) throw new Error('camera wkid must be a positive safe integer');
  if (mode === '2d' && (value.z !== null || value.heading !== null || value.tilt !== null)) throw new Error('2d camera cannot contain 3d orientation');
  if (mode === '3d') {
    if (value.z === null || !Number.isFinite(value.z)) throw new Error('3d camera z must be finite');
    if (value.heading === null || !Number.isFinite(value.heading) || value.heading < 0 || value.heading >= 360) throw new Error('heading outside configured bounds');
    if (value.tilt === null || !Number.isFinite(value.tilt) || value.tilt < 0 || value.tilt > 180) throw new Error('tilt outside configured bounds');
  }
  return Object.freeze({ ...value });
}

function freezeLayer(value: ArcGisShareLayerState): ArcGisShareLayerState {
  return Object.freeze({ ...value });
}

function freezeState(value: ArcGisShareState): ArcGisShareState {
  return Object.freeze({ ...value, camera: Object.freeze({ ...value.camera }), layers: Object.freeze(value.layers.map(freezeLayer)) });
}

/**
 * Bounded primitive authority for URL/shareable map state. Serialization and URL
 * transport remain outside this class so untrusted URL input must pass restore()
 * validation before becoming application state. No ArcGIS runtime object is retained.
 */
export class ArcGisShareStateCoordinator {
  private readonly policy: ArcGisSharePolicy;
  private readonly states = new Map<string, ArcGisShareState>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisSharePolicy) {
    this.policy = Object.freeze({
      maxStates: positiveInteger(policy.maxStates, 'maxStates'),
      maxLayersPerState: positiveInteger(policy.maxLayersPerState, 'maxLayersPerState'),
      maxIdLength: positiveInteger(policy.maxIdLength, 'maxIdLength'),
      maxLayerKeyLength: positiveInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  create(input: {
    readonly id: string;
    readonly viewMode: ArcGisShareViewMode;
    readonly camera: ArcGisShareCamera;
    readonly layers: readonly ArcGisShareLayerState[];
    readonly selectedLayerKey?: string | null;
  }, timestampMs: number): ArcGisShareState {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedText(input.id, this.policy.maxIdLength, 'share id');
    if (this.states.has(id)) throw new Error('share id already exists');
    const viewMode = normalizeViewMode(input.viewMode);
    const layers = this.normalizeLayers(input.layers);
    const selectedLayerKey = this.normalizeSelection(input.selectedLayerKey ?? null, layers);
    const state = freezeState({ id, viewMode, camera: normalizeCamera(input.camera, viewMode), layers, selectedLayerKey, createdAtMs: now, updatedAtMs: now, revision: 1 });
    this.states.set(id, state);
    this.enforceCapacity(id);
    this.activeId = id;
    this.generation += 1;
    return state;
  }

  update(idValue: string, patch: {
    readonly viewMode: ArcGisShareViewMode;
    readonly camera: ArcGisShareCamera;
    readonly layers: readonly ArcGisShareLayerState[];
    readonly selectedLayerKey?: string | null;
  }, timestampMs: number): ArcGisShareState {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedText(idValue, this.policy.maxIdLength, 'share id');
    const current = this.states.get(id);
    if (!current) throw new Error('share state does not exist');
    if (now + this.policy.maxClockSkewMs < current.updatedAtMs) throw new Error('stale share update rejected');
    const viewMode = normalizeViewMode(patch.viewMode);
    const layers = this.normalizeLayers(patch.layers);
    const selectedLayerKey = this.normalizeSelection(patch.selectedLayerKey ?? null, layers);
    const next = freezeState({ ...current, viewMode, camera: normalizeCamera(patch.camera, viewMode), layers, selectedLayerKey, updatedAtMs: now, revision: current.revision + 1 });
    this.states.set(id, next);
    this.activeId = id;
    this.generation += 1;
    return next;
  }

  activate(idValue: string, timestampMs: number): ArcGisShareState {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const id = boundedText(idValue, this.policy.maxIdLength, 'share id');
    const state = this.states.get(id);
    if (!state) throw new Error('share state does not exist');
    if (this.activeId !== id) {
      this.activeId = id;
      this.generation += 1;
    }
    return state;
  }

  remove(idValue: string): boolean {
    this.assertUsable();
    const id = boundedText(idValue, this.policy.maxIdLength, 'share id');
    if (!this.states.delete(id)) return false;
    if (this.activeId === id) this.activeId = null;
    this.generation += 1;
    return true;
  }

  snapshot(timestampMs: number): ArcGisShareSnapshot {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const states = [...this.states.values()].sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id)).map(freezeState);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, states: Object.freeze(states) });
  }

  restore(snapshot: Pick<ArcGisShareSnapshot, 'activeId' | 'states'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.states) || snapshot.states.length > this.policy.maxStates) throw new Error('share snapshot exceeds capacity');
    const staged = new Map<string, ArcGisShareState>();
    for (const source of snapshot.states) {
      const id = boundedText(source.id, this.policy.maxIdLength, 'share id');
      if (staged.has(id)) throw new Error('duplicate share id');
      const createdAtMs = nonNegativeTime(source.createdAtMs, 'createdAtMs');
      const updatedAtMs = nonNegativeTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < createdAtMs) throw new Error('share update precedes creation');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future share snapshot rejected');
      if (now - updatedAtMs > this.policy.retentionMs) continue;
      const viewMode = normalizeViewMode(source.viewMode);
      const layers = this.normalizeLayers(source.layers);
      staged.set(id, freezeState({
        id,
        viewMode,
        camera: normalizeCamera(source.camera, viewMode),
        layers,
        selectedLayerKey: this.normalizeSelection(source.selectedLayerKey, layers),
        createdAtMs,
        updatedAtMs,
        revision: positiveInteger(source.revision, 'revision'),
      }));
    }
    let activeId: string | null = null;
    if (snapshot.activeId !== null) {
      activeId = boundedText(snapshot.activeId, this.policy.maxIdLength, 'active share id');
      if (!staged.has(activeId)) throw new Error('active share state is missing');
    }
    this.states.clear();
    for (const [id, state] of staged) this.states.set(id, state);
    this.activeId = activeId;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.states.clear();
    this.activeId = null;
  }

  private normalizeLayers(values: readonly ArcGisShareLayerState[]): readonly ArcGisShareLayerState[] {
    if (!Array.isArray(values) || values.length > this.policy.maxLayersPerState) throw new Error('share layers exceed capacity');
    const seen = new Set<string>();
    const normalized = values.map(value => {
      if (!value || typeof value !== 'object') throw new Error('share layer is required');
      const key = boundedText(value.key, this.policy.maxLayerKeyLength, 'layer key');
      if (seen.has(key)) throw new Error('duplicate share layer key');
      seen.add(key);
      if (typeof value.visible !== 'boolean') throw new Error('layer visibility must be boolean');
      if (!Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1) throw new Error('layer opacity outside configured bounds');
      return freezeLayer({ key, visible: value.visible, opacity: value.opacity });
    });
    return Object.freeze(normalized);
  }

  private normalizeSelection(value: string | null, layers: readonly ArcGisShareLayerState[]): string | null {
    if (value === null) return null;
    const key = boundedText(value, this.policy.maxLayerKeyLength, 'selected layer key');
    if (!layers.some(layer => layer.key === key)) throw new Error('selected layer is missing from share state');
    return key;
  }

  private prune(now: number): void {
    let changed = false;
    for (const [id, state] of this.states) {
      if (now - state.updatedAtMs <= this.policy.retentionMs) continue;
      this.states.delete(id);
      if (this.activeId === id) this.activeId = null;
      changed = true;
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedId: string): void {
    while (this.states.size > this.policy.maxStates) {
      const victim = [...this.states.values()].filter(state => state.id !== protectedId).sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))[0];
      if (!victim) throw new Error('share capacity cannot be satisfied');
      this.states.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisShareStateCoordinator is disposed');
  }
}
