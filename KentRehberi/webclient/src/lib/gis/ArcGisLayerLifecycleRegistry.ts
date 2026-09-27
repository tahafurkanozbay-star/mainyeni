export type ArcGisLayerLifecyclePhase = 'idle' | 'loading' | 'ready' | 'failed' | 'unloading';

export interface ArcGisLayerLifecyclePolicy {
  readonly maxEntries: number;
  readonly maxFailuresBeforeCooldown: number;
  readonly failureCooldownMs: number;
  readonly staleEntryTtlMs: number;
  readonly maxDiagnosticLength: number;
}

export interface ArcGisLayerLifecycleSnapshot {
  readonly layerId: string;
  readonly phase: ArcGisLayerLifecyclePhase;
  readonly generation: number;
  readonly failureCount: number;
  readonly retryAfter: number | null;
  readonly lastTouchedAt: number;
  readonly diagnostic: string | null;
}

export interface ArcGisLayerLifecycleToken {
  readonly layerId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

interface MutableEntry {
  readonly layerId: string;
  phase: ArcGisLayerLifecyclePhase;
  generation: number;
  failureCount: number;
  retryAfter: number | null;
  lastTouchedAt: number;
  diagnostic: string | null;
  controller: AbortController | null;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function normalizeLayerId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) throw new Error('layerId must contain 1..256 characters');
  return normalized;
}

function assertNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a non-negative safe integer');
  return now;
}

export class ArcGisLayerLifecycleRegistry {
  private readonly policy: ArcGisLayerLifecyclePolicy;
  private readonly entries = new Map<string, MutableEntry>();
  private disposed = false;

  constructor(policy: ArcGisLayerLifecyclePolicy) {
    this.policy = Object.freeze({
      maxEntries: positiveInteger(policy.maxEntries, 'maxEntries'),
      maxFailuresBeforeCooldown: positiveInteger(policy.maxFailuresBeforeCooldown, 'maxFailuresBeforeCooldown'),
      failureCooldownMs: positiveInteger(policy.failureCooldownMs, 'failureCooldownMs'),
      staleEntryTtlMs: positiveInteger(policy.staleEntryTtlMs, 'staleEntryTtlMs'),
      maxDiagnosticLength: positiveInteger(policy.maxDiagnosticLength, 'maxDiagnosticLength'),
    });
  }

  beginLoad(layerIdInput: string, nowInput: number): ArcGisLayerLifecycleToken {
    this.assertUsable();
    const layerId = normalizeLayerId(layerIdInput);
    const now = assertNow(nowInput);
    this.prune(now);
    let entry = this.entries.get(layerId);
    if (!entry) {
      this.ensureCapacity(now);
      entry = this.createEntry(layerId, now);
      this.entries.set(layerId, entry);
    }
    if (entry.phase === 'loading' || entry.phase === 'unloading') throw new Error(`layer ${layerId} is transitioning`);
    if (entry.phase === 'ready') throw new Error(`layer ${layerId} is already ready`);
    if (entry.retryAfter !== null && now < entry.retryAfter) throw new Error(`layer ${layerId} is cooling down`);
    entry.controller?.abort('superseded');
    entry.controller = new AbortController();
    entry.phase = 'loading';
    entry.generation += 1;
    entry.retryAfter = null;
    entry.diagnostic = null;
    entry.lastTouchedAt = now;
    return Object.freeze({ layerId, generation: entry.generation, signal: entry.controller.signal });
  }

  markReady(token: ArcGisLayerLifecycleToken, nowInput: number): ArcGisLayerLifecycleSnapshot {
    const now = assertNow(nowInput);
    const entry = this.requireCurrent(token, 'loading');
    entry.phase = 'ready';
    entry.failureCount = 0;
    entry.retryAfter = null;
    entry.diagnostic = null;
    entry.controller = null;
    entry.lastTouchedAt = now;
    return this.toSnapshot(entry);
  }

  markFailed(token: ArcGisLayerLifecycleToken, diagnosticInput: string, nowInput: number): ArcGisLayerLifecycleSnapshot {
    const now = assertNow(nowInput);
    const entry = this.requireCurrent(token, 'loading');
    const diagnostic = diagnosticInput.trim();
    if (diagnostic.length === 0) throw new Error('diagnostic cannot be blank');
    entry.phase = 'failed';
    entry.failureCount = Math.min(Number.MAX_SAFE_INTEGER, entry.failureCount + 1);
    entry.retryAfter = entry.failureCount >= this.policy.maxFailuresBeforeCooldown ? now + this.policy.failureCooldownMs : null;
    entry.diagnostic = diagnostic.slice(0, this.policy.maxDiagnosticLength);
    entry.controller = null;
    entry.lastTouchedAt = now;
    return this.toSnapshot(entry);
  }

  cancelLoad(token: ArcGisLayerLifecycleToken, nowInput: number): ArcGisLayerLifecycleSnapshot {
    const now = assertNow(nowInput);
    const entry = this.requireCurrent(token, 'loading');
    entry.controller?.abort('cancelled');
    entry.controller = null;
    entry.phase = 'idle';
    entry.retryAfter = null;
    entry.diagnostic = null;
    entry.lastTouchedAt = now;
    return this.toSnapshot(entry);
  }

  beginUnload(layerIdInput: string, nowInput: number): ArcGisLayerLifecycleToken {
    this.assertUsable();
    const layerId = normalizeLayerId(layerIdInput);
    const now = assertNow(nowInput);
    const entry = this.entries.get(layerId);
    if (!entry) throw new Error(`layer ${layerId} is not registered`);
    if (entry.phase !== 'ready' && entry.phase !== 'failed' && entry.phase !== 'idle') throw new Error(`layer ${layerId} is transitioning`);
    entry.controller?.abort('unloading');
    entry.controller = new AbortController();
    entry.phase = 'unloading';
    entry.generation += 1;
    entry.retryAfter = null;
    entry.lastTouchedAt = now;
    return Object.freeze({ layerId, generation: entry.generation, signal: entry.controller.signal });
  }

  finishUnload(token: ArcGisLayerLifecycleToken): void {
    const entry = this.requireCurrent(token, 'unloading');
    entry.controller?.abort('unloaded');
    this.entries.delete(entry.layerId);
  }

  touch(layerIdInput: string, nowInput: number): ArcGisLayerLifecycleSnapshot | null {
    this.assertUsable();
    const layerId = normalizeLayerId(layerIdInput);
    const now = assertNow(nowInput);
    const entry = this.entries.get(layerId);
    if (!entry) return null;
    entry.lastTouchedAt = now;
    return this.toSnapshot(entry);
  }

  get(layerIdInput: string): ArcGisLayerLifecycleSnapshot | null {
    this.assertUsable();
    const entry = this.entries.get(normalizeLayerId(layerIdInput));
    return entry ? this.toSnapshot(entry) : null;
  }

  snapshot(): readonly ArcGisLayerLifecycleSnapshot[] {
    this.assertUsable();
    return Object.freeze([...this.entries.values()].map((entry) => this.toSnapshot(entry)).sort((a, b) => a.layerId.localeCompare(b.layerId)));
  }

  prune(nowInput: number): number {
    this.assertUsable();
    const now = assertNow(nowInput);
    let removed = 0;
    for (const [layerId, entry] of this.entries) {
      if (entry.phase === 'loading' || entry.phase === 'unloading' || entry.phase === 'ready') continue;
      if (now - entry.lastTouchedAt < this.policy.staleEntryTtlMs) continue;
      entry.controller?.abort('pruned');
      this.entries.delete(layerId);
      removed += 1;
    }
    return removed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.controller?.abort('disposed');
    this.entries.clear();
  }

  private createEntry(layerId: string, now: number): MutableEntry {
    return { layerId, phase: 'idle', generation: 0, failureCount: 0, retryAfter: null, lastTouchedAt: now, diagnostic: null, controller: null };
  }

  private ensureCapacity(now: number): void {
    if (this.entries.size < this.policy.maxEntries) return;
    this.prune(now);
    if (this.entries.size < this.policy.maxEntries) return;
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.phase === 'idle' || entry.phase === 'failed')
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt || a.layerId.localeCompare(b.layerId));
    const victim = candidates[0];
    if (!victim) throw new Error('layer lifecycle registry capacity exhausted');
    victim.controller?.abort('evicted');
    this.entries.delete(victim.layerId);
  }

  private requireCurrent(token: ArcGisLayerLifecycleToken, phase: ArcGisLayerLifecyclePhase): MutableEntry {
    this.assertUsable();
    const layerId = normalizeLayerId(token.layerId);
    const entry = this.entries.get(layerId);
    if (!entry || entry.generation !== token.generation) throw new Error(`stale lifecycle token for ${layerId}`);
    if (entry.phase !== phase) throw new Error(`layer ${layerId} expected ${phase} but is ${entry.phase}`);
    return entry;
  }

  private toSnapshot(entry: MutableEntry): ArcGisLayerLifecycleSnapshot {
    return Object.freeze({ layerId: entry.layerId, phase: entry.phase, generation: entry.generation, failureCount: entry.failureCount, retryAfter: entry.retryAfter, lastTouchedAt: entry.lastTouchedAt, diagnostic: entry.diagnostic });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisLayerLifecycleRegistry is disposed');
  }
}
