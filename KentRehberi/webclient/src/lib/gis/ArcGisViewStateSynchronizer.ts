export type ArcGisViewMode = '2d' | '3d';
export type ArcGisViewChangeOrigin = 'user' | 'programmatic' | 'restore';

export interface ArcGisViewState {
  readonly centerX: number;
  readonly centerY: number;
  readonly wkid: number;
  readonly scale: number;
  readonly rotation: number;
  readonly tilt: number;
  readonly altitude: number;
}

export interface ArcGisViewStateSynchronizerPolicy {
  readonly maxHistory: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly maxAltitude: number;
  readonly maxClockSkewMs: number;
}

export interface ArcGisViewStateRevision {
  readonly mode: ArcGisViewMode;
  readonly origin: ArcGisViewChangeOrigin;
  readonly state: ArcGisViewState;
  readonly revision: number;
  readonly timestampMs: number;
}

export interface ArcGisViewStateSnapshot {
  readonly activeMode: ArcGisViewMode;
  readonly revision: number;
  readonly twoD: ArcGisViewStateRevision | null;
  readonly threeD: ArcGisViewStateRevision | null;
  readonly history: readonly ArcGisViewStateRevision[];
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and > 0`);
  return value;
}
function safePositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function mode(value: ArcGisViewMode): ArcGisViewMode {
  if (value !== '2d' && value !== '3d') throw new Error('invalid view mode');
  return value;
}
function origin(value: ArcGisViewChangeOrigin): ArcGisViewChangeOrigin {
  if (value !== 'user' && value !== 'programmatic' && value !== 'restore') throw new Error('invalid view change origin');
  return value;
}
function freezeState(state: ArcGisViewState): ArcGisViewState { return Object.freeze({ ...state }); }
function freezeRevision(value: ArcGisViewStateRevision): ArcGisViewStateRevision {
  return Object.freeze({ ...value, state: freezeState(value.state) });
}

/**
 * Keeps 2D and 3D camera state coherent without owning ArcGIS View instances.
 * Callers feed verified view observations and apply returned projections. State,
 * history and clocks are bounded so a noisy view cannot grow retained memory.
 */
export class ArcGisViewStateSynchronizer {
  private readonly policy: ArcGisViewStateSynchronizerPolicy;
  private readonly history: ArcGisViewStateRevision[] = [];
  private twoD: ArcGisViewStateRevision | null = null;
  private threeD: ArcGisViewStateRevision | null = null;
  private activeMode: ArcGisViewMode = '2d';
  private revision = 0;
  private disposed = false;

  constructor(policy: ArcGisViewStateSynchronizerPolicy) {
    const minScale = positive(policy.minScale, 'minScale');
    const maxScale = positive(policy.maxScale, 'maxScale');
    if (maxScale < minScale) throw new Error('maxScale must be >= minScale');
    this.policy = Object.freeze({
      maxHistory: safePositive(policy.maxHistory, 'maxHistory'),
      minScale,
      maxScale,
      maxAltitude: positive(policy.maxAltitude, 'maxAltitude'),
      maxClockSkewMs: positive(policy.maxClockSkewMs, 'maxClockSkewMs'),
    });
  }

  setActiveMode(next: ArcGisViewMode): void {
    this.assertUsable();
    this.activeMode = mode(next);
  }

  observe(nextMode: ArcGisViewMode, state: ArcGisViewState, changeOrigin: ArcGisViewChangeOrigin, timestampMs: number): ArcGisViewStateRevision {
    this.assertUsable();
    const normalizedMode = mode(nextMode);
    const normalizedOrigin = origin(changeOrigin);
    const normalizedTimestamp = finite(timestampMs, 'timestampMs');
    if (normalizedTimestamp < 0) throw new Error('timestampMs must be non-negative');
    const current = normalizedMode === '2d' ? this.twoD : this.threeD;
    if (current && normalizedTimestamp + this.policy.maxClockSkewMs < current.timestampMs) throw new Error('stale view observation rejected');
    const normalized = this.normalizeState(state, normalizedMode);
    this.revision += 1;
    const entry = freezeRevision({ mode: normalizedMode, origin: normalizedOrigin, state: normalized, revision: this.revision, timestampMs: normalizedTimestamp });
    if (normalizedMode === '2d') this.twoD = entry; else this.threeD = entry;
    this.history.push(entry);
    while (this.history.length > this.policy.maxHistory) this.history.shift();
    return entry;
  }

  project(sourceMode: ArcGisViewMode, targetMode: ArcGisViewMode): ArcGisViewState | null {
    this.assertUsable();
    const source = mode(sourceMode) === '2d' ? this.twoD : this.threeD;
    const target = mode(targetMode);
    if (!source) return null;
    if (source.state.wkid <= 0) throw new Error('source spatial reference is invalid');
    const projected: ArcGisViewState = target === '2d'
      ? { ...source.state, tilt: 0, altitude: 0 }
      : { ...source.state, altitude: Math.min(this.policy.maxAltitude, this.scaleToAltitude(source.state.scale)) };
    return freezeState(this.normalizeState(projected, target));
  }

  snapshot(): ArcGisViewStateSnapshot {
    this.assertUsable();
    return Object.freeze({
      activeMode: this.activeMode,
      revision: this.revision,
      twoD: this.twoD,
      threeD: this.threeD,
      history: Object.freeze(this.history.map(freezeRevision)),
    });
  }

  restore(snapshot: Pick<ArcGisViewStateSnapshot, 'activeMode' | 'twoD' | 'threeD'>, timestampMs: number): void {
    this.assertUsable();
    const nextMode = mode(snapshot.activeMode);
    if (snapshot.twoD) this.observe('2d', snapshot.twoD.state, 'restore', timestampMs);
    if (snapshot.threeD) this.observe('3d', snapshot.threeD.state, 'restore', timestampMs);
    this.activeMode = nextMode;
  }

  clear(): void {
    this.assertUsable();
    this.twoD = null;
    this.threeD = null;
    this.history.length = 0;
    this.revision += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.twoD = null;
    this.threeD = null;
    this.history.length = 0;
  }

  private normalizeState(state: ArcGisViewState, stateMode: ArcGisViewMode): ArcGisViewState {
    const centerX = finite(state.centerX, 'centerX');
    const centerY = finite(state.centerY, 'centerY');
    if (centerY < -90 || centerY > 90) throw new Error('centerY must be within [-90, 90]');
    if (!Number.isSafeInteger(state.wkid) || state.wkid <= 0) throw new Error('wkid must be a positive safe integer');
    const scale = positive(state.scale, 'scale');
    if (scale < this.policy.minScale || scale > this.policy.maxScale) throw new Error('scale outside configured bounds');
    const rotation = finite(state.rotation, 'rotation');
    if (rotation < -360 || rotation > 360) throw new Error('rotation outside [-360, 360]');
    const tilt = finite(state.tilt, 'tilt');
    const altitude = finite(state.altitude, 'altitude');
    if (stateMode === '2d' && (tilt !== 0 || altitude !== 0)) throw new Error('2d state cannot carry tilt or altitude');
    if (stateMode === '3d' && (tilt < 0 || tilt > 90 || altitude < 0 || altitude > this.policy.maxAltitude)) throw new Error('3d camera outside configured bounds');
    return freezeState({ centerX, centerY, wkid: state.wkid, scale, rotation, tilt, altitude });
  }

  private scaleToAltitude(scale: number): number {
    return Math.max(1, Math.sqrt(scale) * 32);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisViewStateSynchronizer is disposed');
  }
}
