export type ArcGisRenderLane = 'interaction' | 'visible' | 'background';
export type ArcGisRenderViewMode = '2d' | '3d';

export interface ArcGisRenderFramePolicy {
  readonly targetFrameMs: number;
  readonly maxFrameMs: number;
  readonly maxLayers: number;
  readonly maxFeaturesPerFrame: number;
  readonly maxDrawCallsPerFrame: number;
  readonly maxGpuBytesPerFrame: number;
  readonly maxCpuMsPerFrame: number;
  readonly recoveryFrames: number;
  readonly historySize: number;
}

export interface ArcGisRenderLayerDemand {
  readonly layerId: string;
  readonly viewMode: ArcGisRenderViewMode;
  readonly lane: ArcGisRenderLane;
  readonly requestedFeatures: number;
  readonly requestedDrawCalls: number;
  readonly requestedGpuBytes: number;
  readonly estimatedCpuMs: number;
  readonly minimumFraction: number;
}

export interface ArcGisRenderLayerGrant extends ArcGisRenderLayerDemand {
  readonly grantedFeatures: number;
  readonly grantedDrawCalls: number;
  readonly grantedGpuBytes: number;
  readonly grantedCpuMs: number;
  readonly fraction: number;
  readonly generation: number;
}

export interface ArcGisRenderFrameObservation {
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly gpuMs: number;
  readonly dropped: boolean;
}

export interface ArcGisRenderFrameSnapshot {
  readonly sequence: number;
  readonly pressure: number;
  readonly qualityScale: number;
  readonly recoveryCounter: number;
  readonly grants: readonly ArcGisRenderLayerGrant[];
}

const LANE_RANK: Readonly<Record<ArcGisRenderLane, number>> = Object.freeze({ interaction: 3, visible: 2, background: 1 });

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and > 0`);
  return value;
}
function safePositive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function safeNonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}
function fraction(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be within [0, 1]`);
  return value;
}
function normalizedLayerId(value: string): string {
  const id = value.trim();
  if (!id || id.length > 256) throw new Error('layerId must contain 1..256 characters');
  return id;
}
function freezeGrant(grant: ArcGisRenderLayerGrant): ArcGisRenderLayerGrant { return Object.freeze({ ...grant }); }

/**
 * Runtime-only render admission policy. It does not own ArcGIS views or network
 * transports: callers submit already-verified layer demand and apply grants to
 * their renderer. All retained state is bounded by maxLayers/historySize.
 */
export class ArcGisRenderFrameGovernor {
  private readonly policy: ArcGisRenderFramePolicy;
  private readonly demands = new Map<string, ArcGisRenderLayerDemand>();
  private readonly generations = new Map<string, number>();
  private readonly history: ArcGisRenderFrameObservation[] = [];
  private sequence = 0;
  private nextGeneration = 1;
  private qualityScale = 1;
  private recoveryCounter = 0;
  private disposed = false;

  constructor(policy: ArcGisRenderFramePolicy) {
    const targetFrameMs = finitePositive(policy.targetFrameMs, 'targetFrameMs');
    const maxFrameMs = finitePositive(policy.maxFrameMs, 'maxFrameMs');
    if (maxFrameMs < targetFrameMs) throw new Error('maxFrameMs must be >= targetFrameMs');
    this.policy = Object.freeze({
      targetFrameMs,
      maxFrameMs,
      maxLayers: safePositive(policy.maxLayers, 'maxLayers'),
      maxFeaturesPerFrame: safePositive(policy.maxFeaturesPerFrame, 'maxFeaturesPerFrame'),
      maxDrawCallsPerFrame: safePositive(policy.maxDrawCallsPerFrame, 'maxDrawCallsPerFrame'),
      maxGpuBytesPerFrame: safePositive(policy.maxGpuBytesPerFrame, 'maxGpuBytesPerFrame'),
      maxCpuMsPerFrame: finitePositive(policy.maxCpuMsPerFrame, 'maxCpuMsPerFrame'),
      recoveryFrames: safePositive(policy.recoveryFrames, 'recoveryFrames'),
      historySize: safePositive(policy.historySize, 'historySize'),
    });
  }

  upsert(demand: ArcGisRenderLayerDemand): void {
    this.assertUsable();
    const normalized = this.normalizeDemand(demand);
    const existing = this.demands.get(normalized.layerId);
    if (existing && existing.viewMode !== normalized.viewMode) throw new Error('layer viewMode cannot change without removal');
    if (!existing && this.demands.size >= this.policy.maxLayers) throw new Error('render layer capacity exhausted');
    if (!existing) this.generations.set(normalized.layerId, this.nextGeneration++);
    this.demands.set(normalized.layerId, normalized);
  }

  remove(layerIdInput: string): boolean {
    this.assertUsable();
    const id = normalizedLayerId(layerIdInput);
    this.generations.delete(id);
    return this.demands.delete(id);
  }

  observe(observation: ArcGisRenderFrameObservation): void {
    this.assertUsable();
    const normalized = this.normalizeObservation(observation);
    this.history.push(normalized);
    while (this.history.length > this.policy.historySize) this.history.shift();
    const overloaded = normalized.dropped || normalized.frameMs > this.policy.maxFrameMs || normalized.cpuMs > this.policy.maxCpuMsPerFrame;
    if (overloaded) {
      this.recoveryCounter = 0;
      this.qualityScale = Math.max(0.25, this.qualityScale * 0.75);
      return;
    }
    if (normalized.frameMs <= this.policy.targetFrameMs && normalized.cpuMs <= this.policy.maxCpuMsPerFrame * 0.8) {
      this.recoveryCounter += 1;
      if (this.recoveryCounter >= this.policy.recoveryFrames) {
        this.recoveryCounter = 0;
        this.qualityScale = Math.min(1, this.qualityScale + 0.1);
      }
    } else {
      this.recoveryCounter = 0;
    }
  }

  plan(viewMode?: ArcGisRenderViewMode): ArcGisRenderFrameSnapshot {
    this.assertUsable();
    if (viewMode !== undefined && viewMode !== '2d' && viewMode !== '3d') throw new Error('invalid viewMode');
    const candidates = [...this.demands.values()]
      .filter(x => viewMode === undefined || x.viewMode === viewMode)
      .sort((a, b) => LANE_RANK[b.lane] - LANE_RANK[a.lane] || a.layerId.localeCompare(b.layerId));

    let featuresLeft = this.policy.maxFeaturesPerFrame;
    let drawsLeft = this.policy.maxDrawCallsPerFrame;
    let gpuLeft = this.policy.maxGpuBytesPerFrame;
    let cpuLeft = this.policy.maxCpuMsPerFrame;
    const grants: ArcGisRenderLayerGrant[] = [];

    for (const demand of candidates) {
      const qualityTarget = demand.minimumFraction + (1 - demand.minimumFraction) * this.qualityScale;
      const resourceFraction = Math.min(
        qualityTarget,
        demand.requestedFeatures === 0 ? 1 : featuresLeft / demand.requestedFeatures,
        demand.requestedDrawCalls === 0 ? 1 : drawsLeft / demand.requestedDrawCalls,
        demand.requestedGpuBytes === 0 ? 1 : gpuLeft / demand.requestedGpuBytes,
        demand.estimatedCpuMs === 0 ? 1 : cpuLeft / demand.estimatedCpuMs,
      );
      const grantedFraction = Math.max(0, Math.min(1, resourceFraction));
      if (grantedFraction + Number.EPSILON < demand.minimumFraction) continue;
      const grantedFeatures = Math.min(featuresLeft, Math.floor(demand.requestedFeatures * grantedFraction));
      const grantedDrawCalls = Math.min(drawsLeft, Math.floor(demand.requestedDrawCalls * grantedFraction));
      const grantedGpuBytes = Math.min(gpuLeft, Math.floor(demand.requestedGpuBytes * grantedFraction));
      const grantedCpuMs = Math.min(cpuLeft, demand.estimatedCpuMs * grantedFraction);
      featuresLeft -= grantedFeatures;
      drawsLeft -= grantedDrawCalls;
      gpuLeft -= grantedGpuBytes;
      cpuLeft = Math.max(0, cpuLeft - grantedCpuMs);
      grants.push(freezeGrant({
        ...demand,
        grantedFeatures,
        grantedDrawCalls,
        grantedGpuBytes,
        grantedCpuMs,
        fraction: grantedFraction,
        generation: this.generations.get(demand.layerId) ?? 0,
      }));
    }

    this.sequence += 1;
    const pressure = Math.max(
      (this.policy.maxFeaturesPerFrame - featuresLeft) / this.policy.maxFeaturesPerFrame,
      (this.policy.maxDrawCallsPerFrame - drawsLeft) / this.policy.maxDrawCallsPerFrame,
      (this.policy.maxGpuBytesPerFrame - gpuLeft) / this.policy.maxGpuBytesPerFrame,
      (this.policy.maxCpuMsPerFrame - cpuLeft) / this.policy.maxCpuMsPerFrame,
    );
    return Object.freeze({
      sequence: this.sequence,
      pressure,
      qualityScale: this.qualityScale,
      recoveryCounter: this.recoveryCounter,
      grants: Object.freeze(grants),
    });
  }

  observations(): readonly ArcGisRenderFrameObservation[] {
    this.assertUsable();
    return Object.freeze(this.history.map(x => Object.freeze({ ...x })));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.demands.clear();
    this.generations.clear();
    this.history.length = 0;
    this.recoveryCounter = 0;
  }

  private normalizeDemand(demand: ArcGisRenderLayerDemand): ArcGisRenderLayerDemand {
    const layerId = normalizedLayerId(demand.layerId);
    if (demand.viewMode !== '2d' && demand.viewMode !== '3d') throw new Error('invalid viewMode');
    if (!(demand.lane in LANE_RANK)) throw new Error('invalid render lane');
    const requestedFeatures = safeNonNegative(demand.requestedFeatures, 'requestedFeatures');
    const requestedDrawCalls = safeNonNegative(demand.requestedDrawCalls, 'requestedDrawCalls');
    const requestedGpuBytes = safeNonNegative(demand.requestedGpuBytes, 'requestedGpuBytes');
    const estimatedCpuMs = demand.estimatedCpuMs === 0 ? 0 : finitePositive(demand.estimatedCpuMs, 'estimatedCpuMs');
    const minimumFraction = fraction(demand.minimumFraction, 'minimumFraction');
    if (requestedFeatures > this.policy.maxFeaturesPerFrame * 16 || requestedDrawCalls > this.policy.maxDrawCallsPerFrame * 16 || requestedGpuBytes > this.policy.maxGpuBytesPerFrame * 16 || estimatedCpuMs > this.policy.maxCpuMsPerFrame * 16) {
      throw new Error('single layer render demand exceeds safety envelope');
    }
    return Object.freeze({ layerId, viewMode: demand.viewMode, lane: demand.lane, requestedFeatures, requestedDrawCalls, requestedGpuBytes, estimatedCpuMs, minimumFraction });
  }

  private normalizeObservation(observation: ArcGisRenderFrameObservation): ArcGisRenderFrameObservation {
    const frameMs = finitePositive(observation.frameMs, 'frameMs');
    const cpuMs = observation.cpuMs === 0 ? 0 : finitePositive(observation.cpuMs, 'cpuMs');
    const gpuMs = observation.gpuMs === 0 ? 0 : finitePositive(observation.gpuMs, 'gpuMs');
    if (typeof observation.dropped !== 'boolean') throw new Error('dropped must be boolean');
    return Object.freeze({ frameMs, cpuMs, gpuMs, dropped: observation.dropped });
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisRenderFrameGovernor is disposed');
  }
}
