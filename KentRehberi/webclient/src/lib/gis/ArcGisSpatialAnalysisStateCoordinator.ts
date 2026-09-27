export type ArcGisSpatialAnalysisKind = 'buffer' | 'nearest' | 'proximity' | 'spatial-filter';
export type ArcGisSpatialAnalysisStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ArcGisSpatialObjectId = string | number;

export interface ArcGisSpatialAnalysisTarget {
  readonly layerKey: string;
  readonly objectId: ArcGisSpatialObjectId;
}

export interface ArcGisSpatialAnalysisResult {
  readonly target: ArcGisSpatialAnalysisTarget;
  readonly distanceMeters: number | null;
}

export interface ArcGisSpatialAnalysisState {
  readonly id: string;
  readonly kind: ArcGisSpatialAnalysisKind;
  readonly wkid: number;
  readonly status: ArcGisSpatialAnalysisStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly revision: number;
  readonly results: readonly ArcGisSpatialAnalysisResult[];
  readonly failureCode: string | null;
}

export interface ArcGisSpatialAnalysisPolicy {
  readonly maxAnalyses: number;
  readonly maxResultsPerAnalysis: number;
  readonly maxIdLength: number;
  readonly maxLayerKeyLength: number;
  readonly maxFailureCodeLength: number;
  readonly maxDistanceMeters: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisSpatialAnalysisSnapshot {
  readonly generation: number;
  readonly activeId: string | null;
  readonly analyses: readonly ArcGisSpatialAnalysisState[];
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
function normalizeObjectId(value: ArcGisSpatialObjectId): ArcGisSpatialObjectId {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('numeric objectId must be a safe integer');
    return value;
  }
  if (typeof value !== 'string') throw new Error('objectId must be a string or safe integer');
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0')) throw new Error('string objectId outside configured bounds');
  return normalized;
}
function normalizeKind(value: ArcGisSpatialAnalysisKind): ArcGisSpatialAnalysisKind {
  if (value !== 'buffer' && value !== 'nearest' && value !== 'proximity' && value !== 'spatial-filter') throw new Error('invalid spatial analysis kind');
  return value;
}
function normalizeStatus(value: ArcGisSpatialAnalysisStatus): ArcGisSpatialAnalysisStatus {
  if (value !== 'queued' && value !== 'running' && value !== 'completed' && value !== 'failed' && value !== 'cancelled') throw new Error('invalid spatial analysis status');
  return value;
}
function normalizeWkid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('wkid must be a positive safe integer');
  return value;
}
function freezeTarget(value: ArcGisSpatialAnalysisTarget): ArcGisSpatialAnalysisTarget {
  return Object.freeze({ ...value });
}
function freezeResult(value: ArcGisSpatialAnalysisResult): ArcGisSpatialAnalysisResult {
  return Object.freeze({ ...value, target: freezeTarget(value.target) });
}
function freezeState(value: ArcGisSpatialAnalysisState): ArcGisSpatialAnalysisState {
  return Object.freeze({ ...value, results: Object.freeze(value.results.map(freezeResult)) });
}
function isTerminal(status: ArcGisSpatialAnalysisStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
function canTransition(from: ArcGisSpatialAnalysisStatus, to: ArcGisSpatialAnalysisStatus): boolean {
  if (from === 'queued') return to === 'running' || to === 'cancelled';
  if (from === 'running') return to === 'completed' || to === 'failed' || to === 'cancelled';
  return false;
}

/**
 * Primitive-only authority for client-visible spatial-analysis lifecycle state.
 * Geometry execution remains owned by injected ArcGIS adapters; this class never
 * retains Graphic, Geometry, FeatureSet, LayerView or request/AbortController objects.
 */
export class ArcGisSpatialAnalysisStateCoordinator {
  private readonly policy: ArcGisSpatialAnalysisPolicy;
  private readonly analyses = new Map<string, ArcGisSpatialAnalysisState>();
  private activeId: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisSpatialAnalysisPolicy) {
    this.policy = Object.freeze({
      maxAnalyses: positiveInteger(policy.maxAnalyses, 'maxAnalyses'),
      maxResultsPerAnalysis: positiveInteger(policy.maxResultsPerAnalysis, 'maxResultsPerAnalysis'),
      maxIdLength: positiveInteger(policy.maxIdLength, 'maxIdLength'),
      maxLayerKeyLength: positiveInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxFailureCodeLength: positiveInteger(policy.maxFailureCodeLength, 'maxFailureCodeLength'),
      maxDistanceMeters: positiveInteger(policy.maxDistanceMeters, 'maxDistanceMeters'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  create(input: { readonly id: string; readonly kind: ArcGisSpatialAnalysisKind; readonly wkid: number }, timestampMs: number): ArcGisSpatialAnalysisState {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedText(input.id, this.policy.maxIdLength, 'analysis id');
    if (this.analyses.has(id)) throw new Error('analysis id already exists');
    const next = freezeState({
      id,
      kind: normalizeKind(input.kind),
      wkid: normalizeWkid(input.wkid),
      status: 'queued',
      createdAtMs: now,
      updatedAtMs: now,
      revision: 1,
      results: [],
      failureCode: null,
    });
    this.analyses.set(id, next);
    this.enforceCapacity(id);
    this.activeId = id;
    this.generation += 1;
    return next;
  }

  transition(idValue: string, statusValue: ArcGisSpatialAnalysisStatus, timestampMs: number, options?: {
    readonly results?: readonly ArcGisSpatialAnalysisResult[];
    readonly failureCode?: string;
  }): ArcGisSpatialAnalysisState {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    this.prune(now);
    const id = boundedText(idValue, this.policy.maxIdLength, 'analysis id');
    const current = this.analyses.get(id);
    if (!current) throw new Error('analysis does not exist');
    if (now + this.policy.maxClockSkewMs < current.updatedAtMs) throw new Error('stale analysis transition rejected');
    const nextStatus = normalizeStatus(statusValue);
    if (!canTransition(current.status, nextStatus)) throw new Error(`invalid analysis transition ${current.status} -> ${nextStatus}`);
    if (nextStatus === 'completed' && options?.failureCode !== undefined) throw new Error('completed analysis cannot contain failure code');
    if (nextStatus === 'failed' && options?.results !== undefined) throw new Error('failed analysis cannot contain results');
    if ((nextStatus === 'queued' || nextStatus === 'running' || nextStatus === 'cancelled') && (options?.results !== undefined || options?.failureCode !== undefined)) {
      throw new Error('non-result transition cannot contain result payload');
    }
    const results = nextStatus === 'completed' ? this.normalizeResults(options?.results ?? []) : [];
    const failureCode = nextStatus === 'failed'
      ? boundedText(options?.failureCode ?? '', this.policy.maxFailureCodeLength, 'failureCode')
      : null;
    const next = freezeState({ ...current, status: nextStatus, updatedAtMs: now, revision: current.revision + 1, results, failureCode });
    this.analyses.set(id, next);
    this.activeId = id;
    this.generation += 1;
    return next;
  }

  activate(idValue: string, timestampMs: number): ArcGisSpatialAnalysisState {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const id = boundedText(idValue, this.policy.maxIdLength, 'analysis id');
    const current = this.analyses.get(id);
    if (!current) throw new Error('analysis does not exist');
    if (this.activeId !== id) { this.activeId = id; this.generation += 1; }
    return current;
  }

  remove(idValue: string): boolean {
    this.assertUsable();
    const id = boundedText(idValue, this.policy.maxIdLength, 'analysis id');
    if (!this.analyses.delete(id)) return false;
    if (this.activeId === id) this.activeId = null;
    this.generation += 1;
    return true;
  }

  snapshot(timestampMs: number): ArcGisSpatialAnalysisSnapshot {
    this.assertUsable();
    this.prune(nonNegativeTime(timestampMs, 'timestampMs'));
    const analyses = [...this.analyses.values()]
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id))
      .map(freezeState);
    return Object.freeze({ generation: this.generation, activeId: this.activeId, analyses: Object.freeze(analyses) });
  }

  restore(snapshot: Pick<ArcGisSpatialAnalysisSnapshot, 'activeId' | 'analyses'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegativeTime(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.analyses) || snapshot.analyses.length > this.policy.maxAnalyses) throw new Error('analysis snapshot exceeds capacity');
    const staged = new Map<string, ArcGisSpatialAnalysisState>();
    for (const source of snapshot.analyses) {
      const id = boundedText(source.id, this.policy.maxIdLength, 'analysis id');
      if (staged.has(id)) throw new Error('duplicate analysis id');
      const createdAtMs = nonNegativeTime(source.createdAtMs, 'createdAtMs');
      const updatedAtMs = nonNegativeTime(source.updatedAtMs, 'updatedAtMs');
      if (updatedAtMs < createdAtMs) throw new Error('analysis update precedes creation');
      if (updatedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future analysis snapshot rejected');
      if (now - updatedAtMs > this.policy.retentionMs) continue;
      const status = normalizeStatus(source.status);
      const results = this.normalizeResults(source.results);
      const failureCode = source.failureCode === null ? null : boundedText(source.failureCode, this.policy.maxFailureCodeLength, 'failureCode');
      if (status === 'completed' && failureCode !== null) throw new Error('completed analysis cannot contain failure code');
      if (status === 'failed' && (results.length !== 0 || failureCode === null)) throw new Error('failed analysis has invalid payload');
      if (!isTerminal(status) && (results.length !== 0 || failureCode !== null)) throw new Error('active analysis has terminal payload');
      if (status === 'cancelled' && (results.length !== 0 || failureCode !== null)) throw new Error('cancelled analysis has terminal payload');
      staged.set(id, freezeState({
        id,
        kind: normalizeKind(source.kind),
        wkid: normalizeWkid(source.wkid),
        status,
        createdAtMs,
        updatedAtMs,
        revision: positiveInteger(source.revision, 'revision'),
        results,
        failureCode,
      }));
    }
    let activeId: string | null = null;
    if (snapshot.activeId !== null) {
      activeId = boundedText(snapshot.activeId, this.policy.maxIdLength, 'active analysis id');
      if (!staged.has(activeId)) throw new Error('active analysis is missing');
    }
    this.analyses.clear();
    for (const [id, value] of staged) this.analyses.set(id, value);
    this.activeId = activeId;
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.analyses.clear();
    this.activeId = null;
  }

  private normalizeResults(values: readonly ArcGisSpatialAnalysisResult[]): readonly ArcGisSpatialAnalysisResult[] {
    if (!Array.isArray(values) || values.length > this.policy.maxResultsPerAnalysis) throw new Error('analysis results exceed capacity');
    const seen = new Set<string>();
    const normalized = values.map((value) => {
      if (!value || typeof value !== 'object') throw new Error('analysis result is required');
      const layerKey = boundedText(value.target?.layerKey, this.policy.maxLayerKeyLength, 'layerKey');
      const objectId = normalizeObjectId(value.target?.objectId);
      const identity = `${layerKey}\u0001${typeof objectId}\u0001${String(objectId)}`;
      if (seen.has(identity)) throw new Error('duplicate analysis result target');
      seen.add(identity);
      let distanceMeters: number | null = null;
      if (value.distanceMeters !== null) {
        if (!Number.isFinite(value.distanceMeters) || value.distanceMeters < 0 || value.distanceMeters > this.policy.maxDistanceMeters) throw new Error('distanceMeters outside configured bounds');
        distanceMeters = value.distanceMeters;
      }
      return freezeResult({ target: { layerKey, objectId }, distanceMeters });
    });
    return Object.freeze(normalized);
  }

  private prune(now: number): void {
    let changed = false;
    for (const [id, state] of this.analyses) {
      if (!isTerminal(state.status) || now - state.updatedAtMs <= this.policy.retentionMs) continue;
      this.analyses.delete(id);
      if (this.activeId === id) this.activeId = null;
      changed = true;
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedId: string): void {
    while (this.analyses.size > this.policy.maxAnalyses) {
      const candidates = [...this.analyses.values()]
        .filter(item => item.id !== protectedId)
        .sort((a, b) => Number(isTerminal(b.status)) - Number(isTerminal(a.status)) || a.updatedAtMs - b.updatedAtMs || a.id.localeCompare(b.id));
      const victim = candidates[0];
      if (!victim) throw new Error('analysis capacity cannot be satisfied');
      this.analyses.delete(victim.id);
      if (this.activeId === victim.id) this.activeId = null;
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisSpatialAnalysisStateCoordinator is disposed');
  }
}
