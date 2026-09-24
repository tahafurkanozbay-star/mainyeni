import { describe, expect, it } from 'vitest';
import { RuntimeCapacityReservationPool } from './runtimeCapacityReservationPool';
import { RuntimeHealthEscalationMatrix } from './runtimeHealthEscalationMatrix';

describe('runtime capacity and health control integration', () => {
  it('keeps pressure evidence separate from capacity ownership', () => {
    const capacity = new RuntimeCapacityReservationPool({
      capacity: 8,
      maximumReservationUnits: 8,
      minimumCriticalReserve: 2,
      minimumInteractiveReserve: 2,
    });
    const health = new RuntimeHealthEscalationMatrix({
      windowSize: 4,
      minimumSamples: 2,
      recoverySamples: 2,
    });

    expect(capacity.request({ id: 'ui', lane: 'interactive', priority: 'urgent', units: 4, leaseDurationMs: 100, at: 1 }).disposition).toBe('reserved');
    health.record({ lane: 'interactive', kind: 'saturation', pressure: 0.9, at: 1 });
    health.record({ lane: 'interactive', kind: 'saturation', pressure: 0.9, at: 2 });

    expect(health.snapshot().lanes.interactive.severity).toBe('critical');
    expect(capacity.snapshot().lanes.interactive.activeUnits).toBe(4);
    expect(capacity.snapshot().lanes.critical.activeUnits).toBe(0);
  });

  it('preserves critical reserve while background health remains healthy', () => {
    const capacity = new RuntimeCapacityReservationPool({
      capacity: 10,
      maximumReservationUnits: 10,
      minimumCriticalReserve: 3,
      minimumInteractiveReserve: 2,
    });
    const health = new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 2 });

    expect(capacity.request({ id: 'background', lane: 'background', priority: 'standard', units: 6, leaseDurationMs: 50, at: 1 }).disposition).toBe('queued');
    health.record({ lane: 'background', kind: 'availability', pressure: 0, at: 1 });
    health.record({ lane: 'background', kind: 'availability', pressure: 0, at: 2 });

    expect(health.snapshot().lanes.background.severity).toBe('healthy');
    expect(capacity.snapshot()).toMatchObject({ activeUnits: 0, queuedReservations: 1 });
  });

  it('allows explicit capacity release while health evidence remains available for policy callers', () => {
    const capacity = new RuntimeCapacityReservationPool({ capacity: 4, maximumReservationUnits: 4, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    const health = new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 1 });

    capacity.request({ id: 'critical-work', lane: 'critical', priority: 'urgent', units: 4, leaseDurationMs: 100, at: 1 });
    health.record({ lane: 'critical', kind: 'integrity', pressure: 1, at: 1 });
    expect(health.snapshot().severity).toBe('critical');

    capacity.release('critical-work', 2);
    expect(capacity.snapshot().activeUnits).toBe(0);
    expect(health.snapshot().severity).toBe('critical');
  });

  it('uses the same caller clock value without hidden timers or polling', () => {
    const capacity = new RuntimeCapacityReservationPool({ capacity: 2, maximumReservationUnits: 2, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    const health = new RuntimeHealthEscalationMatrix({ windowSize: 2, minimumSamples: 1 });

    capacity.request({ id: 'a', lane: 'interactive', priority: 'standard', units: 2, leaseDurationMs: 10, at: 100 });
    health.record({ lane: 'interactive', kind: 'latency', pressure: 0.4, at: 100 });
    expect(capacity.snapshot().nextExpiryAt).toBe(110);
    expect(health.snapshot().lanes.interactive.severity).toBe('watch');

    capacity.sweep(110);
    health.record({ lane: 'interactive', kind: 'latency', pressure: 0, at: 110 });
    expect(capacity.snapshot().activeReservations).toBe(0);
    expect(health.snapshot().lanes.interactive.sampleCount).toBe(2);
  });

  it('maintains independent bounded histories for capacity and health transitions', () => {
    const capacity = new RuntimeCapacityReservationPool({ maximumHistory: 1, minimumCriticalReserve: 0, minimumInteractiveReserve: 0 });
    const health = new RuntimeHealthEscalationMatrix({ windowSize: 1, minimumSamples: 1, recoverySamples: 1, maximumHistory: 1 });

    capacity.request({ id: 'a', lane: 'interactive', priority: 'standard', units: 1, leaseDurationMs: 10, at: 1 });
    capacity.release('a', 2);
    health.record({ lane: 'interactive', kind: 'latency', pressure: 1, at: 1 });
    health.record({ lane: 'interactive', kind: 'latency', pressure: 0, at: 2 });

    expect(capacity.history()).toHaveLength(1);
    expect(health.history()).toHaveLength(1);
    expect(Object.isFrozen(capacity.history())).toBe(true);
    expect(Object.isFrozen(health.history())).toBe(true);
  });
});
