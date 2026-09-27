export type ArcGisViewMode = '2d' | '3d';
export type ArcGisLayerResidencyClass = 'critical' | 'visible' | 'prefetch';

export interface ArcGisLayerResidencyPolicy {
  readonly maxResidentLayers: number;
  readonly maxResidentBytes: number;
  readonly maxGpuBytes: number;
  readonly maxPinnedLayers: number;
  readonly staleAfterMs: number;
}

export interface ArcGisLayerResidencyRequest {
  readonly layerId: string;
  readonly viewMode: ArcGisViewMode;
  readonly residencyClass: ArcGisLayerResidencyClass;
  readonly estimatedBytes: number;
  readonly estimatedGpuBytes: number;
  readonly pinned?: boolean;
}

export interface ArcGisLayerResidencySnapshot {
  readonly layerId: string;
  readonly viewMode: ArcGisViewMode;
  readonly residencyClass: ArcGisLayerResidencyClass;
  readonly estimatedBytes: number;
  readonly estimatedGpuBytes: number;
  readonly pinned: boolean;
  readonly generation: number;
  readonly admittedAt: number;
  readonly lastTouchedAt: number;
}

export interface ArcGisLayerResidencyAdmission {
  readonly resident: ArcGisLayerResidencySnapshot;
  readonly evicted: readonly ArcGisLayerResidencySnapshot[];
}

interface MutableResident {
  layerId: string;
  viewMode: ArcGisViewMode;
  residencyClass: ArcGisLayerResidencyClass;
  estimatedBytes: number;
  estimatedGpuBytes: number;
  pinned: boolean;
  generation: number;
  admittedAt: number;
  lastTouchedAt: number;
}

const CLASS_RANK: Readonly<Record<ArcGisLayerResidencyClass, number>> = Object.freeze({
  critical: 3,
  visible: 2,
  prefetch: 1,
});

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function normalizeLayerId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) throw new Error('layerId must contain 1..256 characters');
  return normalized;
}

function assertViewMode(value: string): asserts value is ArcGisViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('viewMode must be 2d or 3d');
}

function assertResidencyClass(value: string): asserts value is ArcGisLayerResidencyClass {
  if (value !== 'critical' && value !== 'visible' && value !== 'prefetch') throw new Error('invalid residencyClass');
}

function snapshot(entry: MutableResident): ArcGisLayerResidencySnapshot {
  return Object.freeze({ ...entry });
}

export class ArcGisLayerResidencyCoordinator {
  private readonly policy: ArcGisLayerResidencyPolicy;
  private readonly residents = new Map<string, MutableResident>();
  private residentBytes = 0;
  private gpuBytes = 0;
  private pinnedCount = 0;
  private nextGeneration = 1;
  private disposed = false;

  constructor(policy: ArcGisLayerResidencyPolicy) {
    this.policy = Object.freeze({
      maxResidentLayers: positiveSafeInteger(policy.maxResidentLayers, 'maxResidentLayers'),
      maxResidentBytes: positiveSafeInteger(policy.maxResidentBytes, 'maxResidentBytes'),
      maxGpuBytes: positiveSafeInteger(policy.maxGpuBytes, 'maxGpuBytes'),
      maxPinnedLayers: positiveSafeInteger(policy.maxPinnedLayers, 'maxPinnedLayers'),
      staleAfterMs: positiveSafeInteger(policy.staleAfterMs, 'staleAfterMs'),
    });
    if (this.policy.maxPinnedLayers > this.policy.maxResidentLayers) throw new Error('maxPinnedLayers cannot exceed maxResidentLayers');
  }

  admit(request: ArcGisLayerResidencyRequest, nowInput: number): ArcGisLayerResidencyAdmission {
    this.assertUsable();
    const now = nonNegativeSafeInteger(nowInput, 'now');
    const normalized = this.normalizeRequest(request);
    if (normalized.estimatedBytes > this.policy.maxResidentBytes) throw new Error('layer exceeds resident byte budget');
    if (normalized.estimatedGpuBytes > this.policy.maxGpuBytes) throw new Error('layer exceeds GPU byte budget');

    const existing = this.residents.get(normalized.layerId);
    if (existing) {
      if (existing.viewMode !== normalized.viewMode) throw new Error(`layer ${normalized.layerId} already belongs to ${existing.viewMode}`);
      const promoted = CLASS_RANK[normalized.residencyClass] >= CLASS_RANK[existing.residencyClass];
      if (!promoted) throw new Error('residency class demotion requires release');
      const pinDelta = Number(normalized.pinned) - Number(existing.pinned);
      if (pinDelta > 0 && this.pinnedCount >= this.policy.maxPinnedLayers) throw new Error('pinned layer budget exhausted');
      this.removeAccounting(existing);
      existing.residencyClass = normalized.residencyClass;
      existing.estimatedBytes = normalized.estimatedBytes;
      existing.estimatedGpuBytes = normalized.estimatedGpuBytes;
      existing.pinned = normalized.pinned;
      existing.lastTouchedAt = now;
      this.addAccounting(existing);
      const evicted = this.evictUntilWithinBudget(existing.layerId, normalized.residencyClass);
      if (!this.withinBudget()) {
        this.removeAccounting(existing);
        this.residents.delete(existing.layerId);
        throw new Error('resident budget cannot satisfy updated layer');
      }
      return Object.freeze({ resident: snapshot(existing), evicted: Object.freeze(evicted) });
    }

    if (normalized.pinned && this.pinnedCount >= this.policy.maxPinnedLayers) throw new Error('pinned layer budget exhausted');
    const entry: MutableResident = {
      ...normalized,
      generation: this.nextGeneration++,
      admittedAt: now,
      lastTouchedAt: now,
    };
    this.residents.set(entry.layerId, entry);
    this.addAccounting(entry);
    const evicted = this.evictUntilWithinBudget(entry.layerId, entry.residencyClass);
    if (!this.withinBudget()) {
      this.removeAccounting(entry);
      this.residents.delete(entry.layerId);
      throw new Error('resident budget cannot satisfy layer without evicting equal-or-higher priority residency');
    }
    return Object.freeze({ resident: snapshot(entry), evicted: Object.freeze(evicted) });
  }

  touch(layerIdInput: string, nowInput: number): ArcGisLayerResidencySnapshot | null {
    this.assertUsable();
    const layerId = normalizeLayerId(layerIdInput);
    const now = nonNegativeSafeInteger(nowInput, 'now');
    const entry = this.residents.get(layerId);
    if (!entry) return null;
    if (now < entry.lastTouchedAt) throw new Error('now cannot move backwards for a resident layer');
    entry.lastTouchedAt = now;
    return snapshot(entry);
  }

  release(layerIdInput: string): ArcGisLayerResidencySnapshot | null {
    this.assertUsable();
    const layerId = normalizeLayerId(layerIdInput);
    const entry = this.residents.get(layerId);
    if (!entry) return null;
    this.removeAccounting(entry);
    this.residents.delete(layerId);
    return snapshot(entry);
  }

  pruneStale(nowInput: number): readonly ArcGisLayerResidencySnapshot[] {
    this.assertUsable();
    const now = nonNegativeSafeInteger(nowInput, 'now');
    const evicted: ArcGisLayerResidencySnapshot[] = [];
    for (const entry of this.evictionOrder()) {
      if (entry.pinned || entry.residencyClass === 'critical') continue;
      if (now < entry.lastTouchedAt || now - entry.lastTouchedAt < this.policy.staleAfterMs) continue;
      this.removeAccounting(entry);
      this.residents.delete(entry.layerId);
      evicted.push(snapshot(entry));
    }
    return Object.freeze(evicted);
  }

  get(layerIdInput: string): ArcGisLayerResidencySnapshot | null {
    this.assertUsable();
    const entry = this.residents.get(normalizeLayerId(layerIdInput));
    return entry ? snapshot(entry) : null;
  }

  list(viewMode?: ArcGisViewMode): readonly ArcGisLayerResidencySnapshot[] {
    this.assertUsable();
    if (viewMode !== undefined) assertViewMode(viewMode);
    return Object.freeze([...this.residents.values()]
      .filter((entry) => viewMode === undefined || entry.viewMode === viewMode)
      .sort((a, b) => a.layerId.localeCompare(b.layerId))
      .map(snapshot));
  }

  budgetSnapshot(): Readonly<{ residentLayers: number; residentBytes: number; gpuBytes: number; pinnedLayers: number }> {
    this.assertUsable();
    return Object.freeze({ residentLayers: this.residents.size, residentBytes: this.residentBytes, gpuBytes: this.gpuBytes, pinnedLayers: this.pinnedCount });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.residents.clear();
    this.residentBytes = 0;
    this.gpuBytes = 0;
    this.pinnedCount = 0;
  }

  private normalizeRequest(request: ArcGisLayerResidencyRequest): Omit<MutableResident, 'generation' | 'admittedAt' | 'lastTouchedAt'> {
    const layerId = normalizeLayerId(request.layerId);
    assertViewMode(request.viewMode);
    assertResidencyClass(request.residencyClass);
    const estimatedBytes = positiveSafeInteger(request.estimatedBytes, 'estimatedBytes');
    const estimatedGpuBytes = nonNegativeSafeInteger(request.estimatedGpuBytes, 'estimatedGpuBytes');
    if (estimatedGpuBytes > estimatedBytes) throw new Error('estimatedGpuBytes cannot exceed estimatedBytes');
    return { layerId, viewMode: request.viewMode, residencyClass: request.residencyClass, estimatedBytes, estimatedGpuBytes, pinned: request.pinned === true };
  }

  private evictionOrder(): MutableResident[] {
    return [...this.residents.values()].sort((a, b) =>
      Number(a.pinned) - Number(b.pinned)
      || CLASS_RANK[a.residencyClass] - CLASS_RANK[b.residencyClass]
      || a.lastTouchedAt - b.lastTouchedAt
      || a.admittedAt - b.admittedAt
      || a.layerId.localeCompare(b.layerId));
  }

  private evictUntilWithinBudget(protectedLayerId: string, incomingClass: ArcGisLayerResidencyClass): ArcGisLayerResidencySnapshot[] {
    const evicted: ArcGisLayerResidencySnapshot[] = [];
    if (this.withinBudget()) return evicted;
    for (const candidate of this.evictionOrder()) {
      if (this.withinBudget()) break;
      if (candidate.layerId === protectedLayerId || candidate.pinned) continue;
      if (CLASS_RANK[candidate.residencyClass] >= CLASS_RANK[incomingClass]) continue;
      this.removeAccounting(candidate);
      this.residents.delete(candidate.layerId);
      evicted.push(snapshot(candidate));
    }
    return evicted;
  }

  private withinBudget(): boolean {
    return this.residents.size <= this.policy.maxResidentLayers
      && this.residentBytes <= this.policy.maxResidentBytes
      && this.gpuBytes <= this.policy.maxGpuBytes
      && this.pinnedCount <= this.policy.maxPinnedLayers;
  }

  private addAccounting(entry: MutableResident): void {
    this.residentBytes += entry.estimatedBytes;
    this.gpuBytes += entry.estimatedGpuBytes;
    if (entry.pinned) this.pinnedCount += 1;
    if (!Number.isSafeInteger(this.residentBytes) || !Number.isSafeInteger(this.gpuBytes)) throw new Error('residency accounting overflow');
  }

  private removeAccounting(entry: MutableResident): void {
    this.residentBytes -= entry.estimatedBytes;
    this.gpuBytes -= entry.estimatedGpuBytes;
    if (entry.pinned) this.pinnedCount -= 1;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisLayerResidencyCoordinator is disposed');
  }
}
