import { describe, expect, it } from 'vitest';

import {
  createSpatialQueryBudgetLedger,
  type SpatialQueryBudgetRequest,
} from './spatialQueryBudgetLedger';

const limits = {
  features: 100,
  responseBytes: 1_000,
  cpuMs: 100,
  gpuBytes: 2_000,
  maxLeases: 4,
  maxOwners: 2,
  maxHistory: 8,
} as const;

function request(
  owner: string,
  overrides: Partial<SpatialQueryBudgetRequest> = {},
): SpatialQueryBudgetRequest {
  return {
    owner,
    serviceId: 'planning',
    layerId: 'parcels',
    priority: 'normal',
    features: 10,
    responseBytes: 100,
    cpuMs: 10,
    gpuBytes: 100,
    ...overrides,
  };
}

describe('SpatialQueryBudgetLedger', () => {
  it('accounts for admitted work and releases resources exactly once', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    const decision = ledger.acquire(request('map'));
    expect(decision.kind).toBe('admit');
    if (decision.kind !== 'admit') throw new Error('expected admission');

    expect(ledger.snapshot()).toMatchObject({
      used: { features: 10, responseBytes: 100, cpuMs: 10, gpuBytes: 100 },
      leases: 1,
      owners: 1,
    });
    expect(ledger.release(decision.lease.id)).toBe(true);
    expect(ledger.release(decision.lease.id)).toBe(false);
    expect(ledger.snapshot().used).toEqual({ features: 0, responseBytes: 0, cpuMs: 0, gpuBytes: 0 });
  });

  it('rejects malformed requests without allocating resources', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits });
    expect(ledger.acquire(request(' ', { features: Number.NaN }))).toEqual({
      kind: 'reject',
      reason: 'invalid-request',
    });
    expect(ledger.snapshot().leases).toBe(0);
  });

  it('rejects requests that can never fit instead of queueing impossible work', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits });
    expect(ledger.acquire(request('map', { features: 101 }))).toEqual({
      kind: 'reject',
      reason: 'single-request-exceeds-budget',
    });
  });

  it('reserves capacity for interactive queries under normal pressure', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0.2 });
    const first = ledger.acquire(request('background-map', {
      features: 80,
      responseBytes: 800,
      cpuMs: 80,
      gpuBytes: 1_600,
      priority: 'normal',
    }));
    expect(first.kind).toBe('admit');

    expect(ledger.acquire(request('normal', { features: 1 }))).toEqual({
      kind: 'defer',
      reason: 'feature-pressure',
    });

    const interactive = ledger.acquire(request('interactive', {
      priority: 'interactive',
      features: 20,
      responseBytes: 200,
      cpuMs: 20,
      gpuBytes: 400,
    }));
    expect(interactive.kind).toBe('admit');
    expect(ledger.snapshot().pressure).toBe(1);
  });

  it('enforces owner cardinality without penalizing an existing owner', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    expect(ledger.acquire(request('owner-a')).kind).toBe('admit');
    expect(ledger.acquire(request('owner-b')).kind).toBe('admit');
    expect(ledger.acquire(request('owner-c'))).toEqual({ kind: 'defer', reason: 'owner-capacity' });
    expect(ledger.acquire(request('owner-a')).kind).toBe('admit');
  });

  it('releases owner capacity after the final owner lease is removed', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    const first = ledger.acquire(request('owner-a'));
    const second = ledger.acquire(request('owner-a'));
    expect(first.kind).toBe('admit');
    expect(second.kind).toBe('admit');
    expect(ledger.releaseOwner('owner-a')).toBe(2);
    expect(ledger.snapshot().owners).toBe(0);
  });

  it('releases only leases matching the requested service and layer', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    ledger.acquire(request('map', { serviceId: 'a', layerId: '1' }));
    ledger.acquire(request('map', { serviceId: 'a', layerId: '2' }));
    ledger.acquire(request('map', { serviceId: 'b', layerId: '1' }));
    expect(ledger.releaseLayer('a', '1')).toBe(1);
    expect(ledger.list()).toHaveLength(2);
    expect(ledger.list().some((lease) => lease.serviceId === 'a' && lease.layerId === '1')).toBe(false);
  });

  it('bounds lease count independently of resource pressure', () => {
    const ledger = createSpatialQueryBudgetLedger({
      limits: { ...limits, maxLeases: 1 },
      interactiveReserveRatio: 0,
    });
    expect(ledger.acquire(request('map')).kind).toBe('admit');
    expect(ledger.acquire(request('map'))).toEqual({ kind: 'defer', reason: 'lease-capacity' });
  });

  it.each([
    ['features', { features: 95 }, 'feature-pressure'],
    ['responseBytes', { responseBytes: 950 }, 'response-byte-pressure'],
    ['cpuMs', { cpuMs: 95 }, 'cpu-pressure'],
    ['gpuBytes', { gpuBytes: 1_950 }, 'gpu-pressure'],
  ] as const)('reports %s pressure deterministically', (_name, override, expectedReason) => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    expect(ledger.acquire(request('first', override)).kind).toBe('admit');
    expect(ledger.acquire(request('second'))).toEqual({ kind: 'defer', reason: expectedReason });
  });

  it('sorts leases by priority, acquisition time, then id', () => {
    let now = 10;
    let id = 0;
    const ledger = createSpatialQueryBudgetLedger({
      limits: { ...limits, maxOwners: 3 },
      interactiveReserveRatio: 0,
      now: () => now++,
      createId: () => `id-${++id}`,
    });
    ledger.acquire(request('normal', { priority: 'normal' }));
    ledger.acquire(request('background', { priority: 'background' }));
    ledger.acquire(request('interactive', { priority: 'interactive' }));
    expect(ledger.list().map((lease) => lease.priority)).toEqual(['interactive', 'normal', 'background']);
  });

  it('bounds diagnostic history to the configured tail', () => {
    let now = 0;
    const ledger = createSpatialQueryBudgetLedger({
      limits: { ...limits, maxHistory: 2 },
      interactiveReserveRatio: 0,
      now: () => ++now,
    });
    const first = ledger.acquire(request('map'));
    const second = ledger.acquire(request('map'));
    if (first.kind !== 'admit' || second.kind !== 'admit') throw new Error('expected admissions');
    ledger.release(first.lease.id);
    expect(ledger.snapshot().history).toHaveLength(2);
    expect(ledger.snapshot().history.map((event) => event.type)).toEqual(['acquire', 'release']);
  });

  it('can disable history without disabling accounting', () => {
    const ledger = createSpatialQueryBudgetLedger({
      limits: { ...limits, maxHistory: 0 },
      interactiveReserveRatio: 0,
    });
    expect(ledger.acquire(request('map')).kind).toBe('admit');
    expect(ledger.snapshot().history).toEqual([]);
  });

  it('normalizes owner/service/layer identities on admitted leases', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    const decision = ledger.acquire(request('  map  ', { serviceId: ' service ', layerId: ' layer ' }));
    expect(decision.kind).toBe('admit');
    if (decision.kind !== 'admit') throw new Error('expected admission');
    expect(decision.lease).toMatchObject({ owner: 'map', serviceId: 'service', layerId: 'layer' });
  });

  it('does not expose mutable internal accounting through snapshots', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    ledger.acquire(request('map'));
    const snapshot = ledger.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.used)).toBe(true);
    expect(Object.isFrozen(snapshot.available)).toBe(true);
    expect(Object.isFrozen(snapshot.history)).toBe(true);
  });

  it('disposes deterministically and rejects subsequent admissions', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    ledger.acquire(request('map'));
    ledger.dispose();
    ledger.dispose();
    expect(ledger.disposed).toBe(true);
    expect(ledger.snapshot()).toMatchObject({ leases: 0, owners: 0 });
    expect(ledger.acquire(request('map'))).toEqual({ kind: 'reject', reason: 'invalid-request' });
  });

  it('fails configuration with non-finite or non-positive resource limits', () => {
    expect(() => createSpatialQueryBudgetLedger({ limits: { ...limits, features: 0 } })).toThrow(RangeError);
    expect(() => createSpatialQueryBudgetLedger({ limits: { ...limits, gpuBytes: Number.POSITIVE_INFINITY } })).toThrow(RangeError);
  });

  it('fails configuration with unsafe cardinality limits', () => {
    expect(() => createSpatialQueryBudgetLedger({ limits: { ...limits, maxLeases: 0 } })).toThrow(RangeError);
    expect(() => createSpatialQueryBudgetLedger({ limits: { ...limits, maxOwners: 1.5 } })).toThrow(RangeError);
    expect(() => createSpatialQueryBudgetLedger({ limits: { ...limits, maxHistory: -1 } })).toThrow(RangeError);
  });

  it('fails invalid interactive reserve ratios', () => {
    expect(() => createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: -0.1 })).toThrow(RangeError);
    expect(() => createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 1 })).toThrow(RangeError);
  });

  it('retries colliding generated ids without replacing an existing lease', () => {
    const ids = ['same', 'same', 'different'];
    const ledger = createSpatialQueryBudgetLedger({
      limits,
      interactiveReserveRatio: 0,
      createId: () => ids.shift() ?? 'fallback',
    });
    const first = ledger.acquire(request('map'));
    const second = ledger.acquire(request('map'));
    expect(first.kind).toBe('admit');
    expect(second.kind).toBe('admit');
    if (first.kind !== 'admit' || second.kind !== 'admit') throw new Error('expected admissions');
    expect(first.lease.id).toBe('same');
    expect(second.lease.id).toBe('different');
  });

  it('reports available budget after mixed admissions and releases', () => {
    const ledger = createSpatialQueryBudgetLedger({ limits, interactiveReserveRatio: 0 });
    const first = ledger.acquire(request('map', { features: 30, responseBytes: 300, cpuMs: 20, gpuBytes: 500 }));
    ledger.acquire(request('map', { features: 20, responseBytes: 200, cpuMs: 10, gpuBytes: 300 }));
    if (first.kind !== 'admit') throw new Error('expected admission');
    expect(ledger.snapshot().available).toEqual({ features: 50, responseBytes: 500, cpuMs: 70, gpuBytes: 1_200 });
    ledger.release(first.lease.id);
    expect(ledger.snapshot().available).toEqual({ features: 80, responseBytes: 800, cpuMs: 90, gpuBytes: 1_700 });
  });
});
