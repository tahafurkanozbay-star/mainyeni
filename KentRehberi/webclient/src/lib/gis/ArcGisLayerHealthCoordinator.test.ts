import { describe, expect, it } from 'vitest';
import { ArcGisLayerHealthCoordinator } from './ArcGisLayerHealthCoordinator';

const policy = {
  maxLayers: 2,
  maxLayerKeyLength: 32,
  maxFailureCodeLength: 24,
  maxLatencyMs: 10_000,
  retentionMs: 1_000,
  maxClockSkewMs: 50,
  degradedLatencyMs: 500,
  unavailableAfterFailures: 3,
} as const;

const create = () => new ArcGisLayerHealthCoordinator(policy);

describe('ArcGisLayerHealthCoordinator', () => {
  it('records healthy and latency-degraded observations without retaining payloads', () => {
    const coordinator = create();
    expect(coordinator.recordSuccess('parcels', 40, 100).status).toBe('healthy');
    expect(coordinator.recordSuccess('parcels', 500, 110).status).toBe('degraded');
    expect(coordinator.get('parcels', 110)?.latencyMs).toBe(500);
  });

  it('promotes repeated failures to unavailable and resets on success', () => {
    const coordinator = create();
    expect(coordinator.recordFailure('roads', 'timeout', 10).status).toBe('degraded');
    expect(coordinator.recordFailure('roads', 'timeout', 20).consecutiveFailures).toBe(2);
    expect(coordinator.recordFailure('roads', 'timeout', 30).status).toBe('unavailable');
    const recovered = coordinator.recordSuccess('roads', 20, 40);
    expect(recovered.status).toBe('healthy');
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.failureCode).toBeNull();
  });

  it('rejects stale observations outside clock skew', () => {
    const coordinator = create();
    coordinator.recordSuccess('roads', 20, 100);
    expect(() => coordinator.recordFailure('roads', 'timeout', 49)).toThrow('stale');
    expect(() => coordinator.recordFailure('roads', 'timeout', 50)).not.toThrow();
  });

  it('bounds latency, identities and diagnostics', () => {
    const coordinator = create();
    expect(() => coordinator.recordSuccess('roads', 10_001, 1)).toThrow('latency');
    expect(() => coordinator.recordSuccess(' ', 1, 1)).toThrow('layer key');
    expect(() => coordinator.recordFailure('roads', 'x'.repeat(25), 1)).toThrow('failure code');
    expect(() => coordinator.recordFailure('roads\0evil', 'timeout', 1)).toThrow('layer key');
  });

  it('evicts oldest observations deterministically', () => {
    const coordinator = create();
    coordinator.recordSuccess('a', 1, 10);
    coordinator.recordSuccess('b', 1, 20);
    coordinator.recordSuccess('c', 1, 30);
    expect(coordinator.get('a', 30)).toBeNull();
    expect(coordinator.snapshot(30).observations.map(item => item.layerKey)).toEqual(['b', 'c']);
  });

  it('prunes expired observations and increments generation', () => {
    const coordinator = create();
    coordinator.recordSuccess('a', 1, 10);
    const before = coordinator.snapshot(10).generation;
    expect(coordinator.snapshot(1_011).observations).toEqual([]);
    expect(coordinator.snapshot(1_011).generation).toBeGreaterThan(before);
  });

  it('restores valid primitive state atomically', () => {
    const coordinator = create();
    coordinator.recordSuccess('existing', 1, 10);
    coordinator.restore({ observations: [{
      layerKey: 'roads', status: 'unavailable', latencyMs: null, failureCode: 'timeout', observedAtMs: 100,
      consecutiveFailures: 3, revision: 4,
    }] }, 100);
    expect(coordinator.get('existing', 100)).toBeNull();
    expect(coordinator.get('roads', 100)?.revision).toBe(4);
  });

  it('does not replace live state when restore validation fails', () => {
    const coordinator = create();
    coordinator.recordSuccess('existing', 1, 10);
    expect(() => coordinator.restore({ observations: [{
      layerKey: 'bad', status: 'healthy', latencyMs: null, failureCode: null, observedAtMs: 20,
      consecutiveFailures: 0, revision: 1,
    }] }, 20)).toThrow('inconsistent');
    expect(coordinator.get('existing', 20)?.status).toBe('healthy');
  });

  it('rejects duplicate and future restored observations', () => {
    const coordinator = create();
    const item = { layerKey: 'roads', status: 'degraded' as const, latencyMs: null, failureCode: 'timeout', observedAtMs: 100, consecutiveFailures: 1, revision: 1 };
    expect(() => coordinator.restore({ observations: [item, item] }, 100)).toThrow('duplicate');
    expect(() => coordinator.restore({ observations: [{ ...item, observedAtMs: 151 }] }, 100)).toThrow('future');
  });

  it('rejects inconsistent unavailable restore state', () => {
    const coordinator = create();
    expect(() => coordinator.restore({ observations: [{
      layerKey: 'roads', status: 'unavailable', latencyMs: null, failureCode: 'timeout', observedAtMs: 100,
      consecutiveFailures: 2, revision: 1,
    }] }, 100)).toThrow('threshold');
  });

  it('freezes observations and snapshots', () => {
    const coordinator = create();
    const observation = coordinator.recordSuccess('roads', 1, 1);
    const snapshot = coordinator.snapshot(1);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.observations)).toBe(true);
  });

  it('becomes unusable after disposal', () => {
    const coordinator = create();
    coordinator.recordSuccess('roads', 1, 1);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(2)).toThrow(/disposed/);
    expect(() => coordinator.recordSuccess('roads', 1, 2)).toThrow(/disposed/);
  });
});
