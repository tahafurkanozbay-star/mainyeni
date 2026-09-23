export type GisViewMode = '2d' | '3d';
export type LayerViewPhase = 'idle' | 'loading' | 'ready' | 'suspended' | 'failed' | 'disposed';
export type LayerViewPriority = 'critical' | 'high' | 'normal' | 'low';

export interface LayerViewKey { readonly layerId: string; readonly mode: GisViewMode; }
export interface LayerViewLoadContext { readonly key: LayerViewKey; readonly signal: AbortSignal; readonly generation: number; }
export interface LayerViewResource { readonly dispose: () => void | Promise<void>; readonly suspend?: () => void | Promise<void>; readonly resume?: () => void | Promise<void>; }
export interface LayerViewRegistration { readonly key: LayerViewKey; readonly priority: LayerViewPriority; readonly load: (context: LayerViewLoadContext) => Promise<LayerViewResource>; }
export interface LayerViewSnapshot { readonly key: LayerViewKey; readonly priority: LayerViewPriority; readonly phase: LayerViewPhase; readonly generation: number; readonly lastTouchedAt: number; readonly error?: string; }
export interface LayerViewCoordinatorSnapshot { readonly entries: readonly LayerViewSnapshot[]; readonly activeLoads: number; readonly readyResources: number; readonly revision: number; readonly disposed: boolean; }
export interface LayerViewCoordinatorOptions { readonly maxEntries?: number; readonly maxConcurrentLoads?: number; readonly maxReadyResources?: number; readonly now?: () => number; }

type MutableEntry = { registration: LayerViewRegistration; phase: LayerViewPhase; generation: number; lastTouchedAt: number; controller?: AbortController; resource?: LayerViewResource; loadPromise?: Promise<LayerViewSnapshot>; error?: string; };
const PRIORITY: Readonly<Record<LayerViewPriority, number>> = Object.freeze({ critical: 4, high: 3, normal: 2, low: 1 });
const positiveInteger = (value: number, field: string): number => { if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`); return value; };
const normalizeKey = (key: LayerViewKey): LayerViewKey => { const layerId = key.layerId.trim(); if (!layerId) throw new Error('layerId must not be empty'); return Object.freeze({ layerId, mode: key.mode }); };
const identity = (key: LayerViewKey): string => `${key.mode}:${key.layerId}`;
const safeError = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isAbort = (error: unknown): boolean => error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError';

/**
 * Owns the asynchronous lifetime of ArcGIS layer-view resources without owning
 * network transport. It deliberately accepts injected load functions so callers
 * keep the repository's verified ArcGIS REST / SDK adapters authoritative.
 */
export class LayerViewLifecycleCoordinator {
  private readonly entries = new Map<string, MutableEntry>();
  private readonly maxEntries: number;
  private readonly maxConcurrentLoads: number;
  private readonly maxReadyResources: number;
  private readonly now: () => number;
  private activeLoads = 0;
  private revision = 0;
  private disposed = false;

  constructor(options: LayerViewCoordinatorOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 256, 'maxEntries');
    this.maxConcurrentLoads = positiveInteger(options.maxConcurrentLoads ?? 6, 'maxConcurrentLoads');
    this.maxReadyResources = positiveInteger(options.maxReadyResources ?? 64, 'maxReadyResources');
    this.now = options.now ?? Date.now;
  }

  register(input: LayerViewRegistration): LayerViewSnapshot {
    this.assertActive();
    const key = normalizeKey(input.key);
    const id = identity(key);
    const existing = this.entries.get(id);
    if (!existing && this.entries.size >= this.maxEntries) this.evictMetadata();
    if (existing) {
      existing.registration = Object.freeze({ ...input, key });
      existing.lastTouchedAt = this.now();
      this.revision += 1;
      return this.snapshotEntry(existing);
    }
    const entry: MutableEntry = { registration: Object.freeze({ ...input, key }), phase: 'idle', generation: 0, lastTouchedAt: this.now() };
    this.entries.set(id, entry);
    this.revision += 1;
    return this.snapshotEntry(entry);
  }

  async ensure(keyInput: LayerViewKey): Promise<LayerViewSnapshot> {
    this.assertActive();
    const key = normalizeKey(keyInput);
    const entry = this.entries.get(identity(key));
    if (!entry) throw new Error(`layer view is not registered: ${identity(key)}`);
    entry.lastTouchedAt = this.now();
    if (entry.phase === 'ready') { this.revision += 1; return this.snapshotEntry(entry); }
    if (entry.phase === 'suspended' && entry.resource) {
      await entry.resource.resume?.();
      this.assertGenerationEntry(entry);
      entry.phase = 'ready'; entry.error = undefined; this.revision += 1;
      await this.enforceReadyBudget(entry);
      return this.snapshotEntry(entry);
    }
    if (entry.loadPromise) return entry.loadPromise;
    if (this.activeLoads >= this.maxConcurrentLoads) throw new Error('layer view load concurrency exhausted');
    const controller = new AbortController();
    const generation = entry.generation + 1;
    entry.generation = generation; entry.controller = controller; entry.phase = 'loading'; entry.error = undefined; this.activeLoads += 1; this.revision += 1;
    const promise = this.loadEntry(entry, generation, controller);
    entry.loadPromise = promise;
    return promise;
  }

  async suspend(keyInput: LayerViewKey): Promise<boolean> {
    this.assertActive();
    const entry = this.entries.get(identity(normalizeKey(keyInput)));
    if (!entry || entry.phase === 'disposed') return false;
    entry.lastTouchedAt = this.now();
    if (entry.phase === 'loading') { this.cancelEntry(entry); entry.phase = 'suspended'; this.revision += 1; return true; }
    if (entry.phase !== 'ready' || !entry.resource) return false;
    await entry.resource.suspend?.();
    entry.phase = 'suspended'; this.revision += 1; return true;
  }

  async remove(keyInput: LayerViewKey): Promise<boolean> {
    this.assertActive();
    const key = normalizeKey(keyInput);
    const id = identity(key);
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.cancelEntry(entry);
    const resource = entry.resource;
    entry.resource = undefined; entry.phase = 'disposed'; entry.generation += 1; this.entries.delete(id); this.revision += 1;
    await resource?.dispose();
    return true;
  }

  touch(keyInput: LayerViewKey): boolean {
    this.assertActive();
    const entry = this.entries.get(identity(normalizeKey(keyInput)));
    if (!entry || entry.phase === 'disposed') return false;
    entry.lastTouchedAt = this.now(); this.revision += 1; return true;
  }

  snapshot(): LayerViewCoordinatorSnapshot {
    const entries = Array.from(this.entries.values()).sort((a,b) => identity(a.registration.key).localeCompare(identity(b.registration.key))).map((entry) => this.snapshotEntry(entry));
    const readyResources = entries.filter((entry) => entry.phase === 'ready').length;
    return Object.freeze({ entries: Object.freeze(entries), activeLoads: this.activeLoads, readyResources, revision: this.revision, disposed: this.disposed });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const resources: LayerViewResource[] = [];
    for (const entry of this.entries.values()) { this.cancelEntry(entry); if (entry.resource) resources.push(entry.resource); entry.resource = undefined; entry.phase = 'disposed'; entry.generation += 1; }
    this.entries.clear(); this.revision += 1;
    await Promise.allSettled(resources.map((resource) => Promise.resolve(resource.dispose())));
  }

  private async loadEntry(entry: MutableEntry, generation: number, controller: AbortController): Promise<LayerViewSnapshot> {
    try {
      const resource = await entry.registration.load(Object.freeze({ key: entry.registration.key, signal: controller.signal, generation }));
      if (this.disposed || controller.signal.aborted || entry.generation !== generation) { await resource.dispose(); return this.snapshotEntry(entry); }
      entry.resource = resource; entry.phase = 'ready'; entry.error = undefined; entry.lastTouchedAt = this.now(); this.revision += 1;
      await this.enforceReadyBudget(entry);
      return this.snapshotEntry(entry);
    } catch (error) {
      if (entry.generation === generation && !this.disposed) { entry.phase = controller.signal.aborted || isAbort(error) ? 'suspended' : 'failed'; entry.error = controller.signal.aborted || isAbort(error) ? undefined : safeError(error); this.revision += 1; }
      return this.snapshotEntry(entry);
    } finally {
      if (entry.generation === generation) { entry.controller = undefined; entry.loadPromise = undefined; }
      this.activeLoads = Math.max(0, this.activeLoads - 1);
    }
  }

  private async enforceReadyBudget(incoming: MutableEntry): Promise<void> {
    while (this.readyEntries().length > this.maxReadyResources) {
      const victim = this.readyEntries().filter((candidate) => candidate !== incoming && PRIORITY[candidate.registration.priority] <= PRIORITY[incoming.registration.priority]).sort((a,b) => PRIORITY[a.registration.priority] - PRIORITY[b.registration.priority] || a.lastTouchedAt - b.lastTouchedAt || identity(a.registration.key).localeCompare(identity(b.registration.key)))[0];
      if (!victim) { const resource = incoming.resource; incoming.resource = undefined; incoming.phase = 'suspended'; await resource?.dispose(); this.revision += 1; return; }
      const resource = victim.resource; victim.resource = undefined; victim.phase = 'suspended'; victim.lastTouchedAt = this.now(); await resource?.dispose(); this.revision += 1;
    }
  }

  private readyEntries(): MutableEntry[] { return Array.from(this.entries.values()).filter((entry) => entry.phase === 'ready' && entry.resource); }
  private cancelEntry(entry: MutableEntry): void { entry.controller?.abort(); entry.controller = undefined; entry.loadPromise = undefined; entry.generation += 1; }
  private evictMetadata(): void { const victim = Array.from(this.entries.values()).filter((entry) => entry.phase !== 'loading' && entry.phase !== 'ready').sort((a,b) => a.lastTouchedAt - b.lastTouchedAt || identity(a.registration.key).localeCompare(identity(b.registration.key)))[0]; if (!victim) throw new Error('layer view registry capacity exhausted by active resources'); this.entries.delete(identity(victim.registration.key)); this.revision += 1; }
  private snapshotEntry(entry: MutableEntry): LayerViewSnapshot { return Object.freeze({ key: Object.freeze({ ...entry.registration.key }), priority: entry.registration.priority, phase: entry.phase, generation: entry.generation, lastTouchedAt: entry.lastTouchedAt, ...(entry.error === undefined ? {} : { error: entry.error }) }); }
  private assertGenerationEntry(entry: MutableEntry): void { if (this.disposed || entry.phase === 'disposed') throw new Error('layer view coordinator is disposed'); }
  private assertActive(): void { if (this.disposed) throw new Error('layer view coordinator is disposed'); }
}
