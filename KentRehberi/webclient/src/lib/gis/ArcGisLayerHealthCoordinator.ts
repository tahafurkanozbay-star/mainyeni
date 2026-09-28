export type ArcGisLayerHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unavailable';

export interface ArcGisLayerHealthObservation {
  readonly layerKey: string;
  readonly status: ArcGisLayerHealthStatus;
  readonly latencyMs: number | null;
  readonly failureCode: string | null;
  readonly observedAtMs: number;
  readonly consecutiveFailures: number;
  readonly revision: number;
}

export interface ArcGisLayerHealthPolicy {
  readonly maxLayers: number;
  readonly maxLayerKeyLength: number;
  readonly maxFailureCodeLength: number;
  readonly maxLatencyMs: number;
  readonly retentionMs: number;
  readonly maxClockSkewMs: number;
  readonly degradedLatencyMs: number;
  readonly unavailableAfterFailures: number;
}

export interface ArcGisLayerHealthSnapshot {
  readonly generation: number;
  readonly observations: readonly ArcGisLayerHealthObservation[];
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and >= 0`);
  return value;
}

function boundedText(value: string, maxLength: number, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) throw new Error(`${name} outside configured bounds`);
  return normalized;
}

function freezeObservation(value: ArcGisLayerHealthObservation): ArcGisLayerHealthObservation {
  return Object.freeze({ ...value });
}

/**
 * Primitive-only health authority for configured ArcGIS layers. The coordinator
 * deliberately owns no URL, request, timer, ArcGIS Layer, LayerView or response
 * payload; callers feed observations from already-governed service adapters.
 */
export class ArcGisLayerHealthCoordinator {
  private readonly policy: ArcGisLayerHealthPolicy;
  private readonly observations = new Map<string, ArcGisLayerHealthObservation>();
  private generation = 0;
  private disposed = false;

  constructor(policy: ArcGisLayerHealthPolicy) {
    this.policy = Object.freeze({
      maxLayers: positiveInteger(policy.maxLayers, 'maxLayers'),
      maxLayerKeyLength: positiveInteger(policy.maxLayerKeyLength, 'maxLayerKeyLength'),
      maxFailureCodeLength: positiveInteger(policy.maxFailureCodeLength, 'maxFailureCodeLength'),
      maxLatencyMs: positiveInteger(policy.maxLatencyMs, 'maxLatencyMs'),
      retentionMs: positiveInteger(policy.retentionMs, 'retentionMs'),
      maxClockSkewMs: positiveInteger(policy.maxClockSkewMs, 'maxClockSkewMs'),
      degradedLatencyMs: positiveInteger(policy.degradedLatencyMs, 'degradedLatencyMs'),
      unavailableAfterFailures: positiveInteger(policy.unavailableAfterFailures, 'unavailableAfterFailures'),
    });
    if (this.policy.degradedLatencyMs > this.policy.maxLatencyMs) throw new Error('degradedLatencyMs cannot exceed maxLatencyMs');
  }

  recordSuccess(layerKeyValue: string, latencyMsValue: number, timestampMs: number): ArcGisLayerHealthObservation {
    this.assertUsable();
    const layerKey = boundedText(layerKeyValue, this.policy.maxLayerKeyLength, 'layer key');
    const latencyMs = nonNegative(latencyMsValue, 'latencyMs');
    if (latencyMs > this.policy.maxLatencyMs) throw new Error('latency exceeds configured bound');
    const now = nonNegative(timestampMs, 'timestampMs');
    this.prune(now);
    const previous = this.observations.get(layerKey);
    this.assertFresh(previous, now);
    const status: ArcGisLayerHealthStatus = latencyMs >= this.policy.degradedLatencyMs ? 'degraded' : 'healthy';
    const next = freezeObservation({ layerKey, status, latencyMs, failureCode: null, observedAtMs: now, consecutiveFailures: 0, revision: (previous?.revision ?? 0) + 1 });
    this.observations.set(layerKey, next);
    this.enforceCapacity(layerKey);
    this.generation += 1;
    return next;
  }

  recordFailure(layerKeyValue: string, failureCodeValue: string, timestampMs: number): ArcGisLayerHealthObservation {
    this.assertUsable();
    const layerKey = boundedText(layerKeyValue, this.policy.maxLayerKeyLength, 'layer key');
    const failureCode = boundedText(failureCodeValue, this.policy.maxFailureCodeLength, 'failure code');
    const now = nonNegative(timestampMs, 'timestampMs');
    this.prune(now);
    const previous = this.observations.get(layerKey);
    this.assertFresh(previous, now);
    const consecutiveFailures = Math.min((previous?.consecutiveFailures ?? 0) + 1, this.policy.unavailableAfterFailures);
    const status: ArcGisLayerHealthStatus = consecutiveFailures >= this.policy.unavailableAfterFailures ? 'unavailable' : 'degraded';
    const next = freezeObservation({ layerKey, status, latencyMs: null, failureCode, observedAtMs: now, consecutiveFailures, revision: (previous?.revision ?? 0) + 1 });
    this.observations.set(layerKey, next);
    this.enforceCapacity(layerKey);
    this.generation += 1;
    return next;
  }

  get(layerKeyValue: string, timestampMs: number): ArcGisLayerHealthObservation | null {
    this.assertUsable();
    const now = nonNegative(timestampMs, 'timestampMs');
    this.prune(now);
    return this.observations.get(boundedText(layerKeyValue, this.policy.maxLayerKeyLength, 'layer key')) ?? null;
  }

  snapshot(timestampMs: number): ArcGisLayerHealthSnapshot {
    this.assertUsable();
    this.prune(nonNegative(timestampMs, 'timestampMs'));
    const observations = [...this.observations.values()]
      .sort((a, b) => a.observedAtMs - b.observedAtMs || a.layerKey.localeCompare(b.layerKey))
      .map(freezeObservation);
    return Object.freeze({ generation: this.generation, observations: Object.freeze(observations) });
  }

  restore(snapshot: Pick<ArcGisLayerHealthSnapshot, 'observations'>, timestampMs: number): void {
    this.assertUsable();
    const now = nonNegative(timestampMs, 'timestampMs');
    if (!Array.isArray(snapshot.observations) || snapshot.observations.length > this.policy.maxLayers) throw new Error('health snapshot exceeds capacity');
    const staged = new Map<string, ArcGisLayerHealthObservation>();
    for (const source of snapshot.observations) {
      const layerKey = boundedText(source.layerKey, this.policy.maxLayerKeyLength, 'layer key');
      if (staged.has(layerKey)) throw new Error('duplicate layer health key');
      const observedAtMs = nonNegative(source.observedAtMs, 'observedAtMs');
      if (observedAtMs > now + this.policy.maxClockSkewMs) throw new Error('future health snapshot rejected');
      if (now - observedAtMs > this.policy.retentionMs) continue;
      const revision = positiveInteger(source.revision, 'revision');
      if (!Number.isSafeInteger(source.consecutiveFailures) || source.consecutiveFailures < 0 || source.consecutiveFailures > this.policy.unavailableAfterFailures) throw new Error('consecutiveFailures outside configured bounds');
      if (!['healthy', 'degraded', 'unavailable', 'unknown'].includes(source.status)) throw new Error('invalid health status');
      let latencyMs: number | null = null;
      if (source.latencyMs !== null) {
        latencyMs = nonNegative(source.latencyMs, 'latencyMs');
        if (latencyMs > this.policy.maxLatencyMs) throw new Error('latency exceeds configured bound');
      }
      const failureCode = source.failureCode === null ? null : boundedText(source.failureCode, this.policy.maxFailureCodeLength, 'failure code');
      if (source.status === 'healthy' && (failureCode !== null || source.consecutiveFailures !== 0 || latencyMs === null)) throw new Error('healthy observation is inconsistent');
      if (source.status === 'unavailable' && source.consecutiveFailures < this.policy.unavailableAfterFailures) throw new Error('unavailable observation lacks failure threshold');
      staged.set(layerKey, freezeObservation({ layerKey, status: source.status, latencyMs, failureCode, observedAtMs, consecutiveFailures: source.consecutiveFailures, revision }));
    }
    this.observations.clear();
    for (const [key, value] of staged) this.observations.set(key, value);
    this.generation += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observations.clear();
  }

  private assertFresh(previous: ArcGisLayerHealthObservation | undefined, now: number): void {
    if (previous && now + this.policy.maxClockSkewMs < previous.observedAtMs) throw new Error('stale layer health observation rejected');
  }

  private prune(now: number): void {
    let changed = false;
    for (const [key, observation] of this.observations) {
      if (now - observation.observedAtMs <= this.policy.retentionMs) continue;
      this.observations.delete(key);
      changed = true;
    }
    if (changed) this.generation += 1;
  }

  private enforceCapacity(protectedKey: string): void {
    while (this.observations.size > this.policy.maxLayers) {
      const victim = [...this.observations.values()]
        .filter(item => item.layerKey !== protectedKey)
        .sort((a, b) => a.observedAtMs - b.observedAtMs || a.layerKey.localeCompare(b.layerKey))[0];
      if (!victim) throw new Error('health capacity cannot be satisfied');
      this.observations.delete(victim.layerKey);
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ArcGisLayerHealthCoordinator is disposed');
  }
}
