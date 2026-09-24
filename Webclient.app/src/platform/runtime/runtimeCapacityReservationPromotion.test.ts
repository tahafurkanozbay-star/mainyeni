import { describe, expect, it } from 'vitest';
import { RuntimeCapacityReservationPool, type RuntimeCapacityReservationRequest } from './runtimeCapacityReservationPool';

const makeRequest = (
  id: string,
  at: number,
  lane: RuntimeCapacityReservationRequest['lane'],
  units = 1,
  priority: RuntimeCapacityReservationRequest['priority'] = 'standard',
): RuntimeCapacityReservationRequest => ({ id, at, lane, units, priority, leaseDurationMs: 100 });

describe('RuntimeCapacityReservationPool bounded promotion', () => {
  it('stops after a complete miss cycle when every lane head is too large', () => {
    const pool = new RuntimeCapacityReservationPool({
      capacity: 4,
      maximumReservationUnits: 4,
      minimumCriticalReserve: 0,
      minimumInteractiveReserve: 0,
    });
    pool.request(makeRequest('owner', 1, 'critical', 3));
    pool.request(makeRequest('critical-large', 2, 'critical', 2));
    pool.request(makeRequest('interactive-large', 3, 'interactive', 2));
    pool.request(makeRequest('background-large', 4, 'background', 2));

    expect(pool.release('owner', 5).map(({ id }) => id)).toEqual(['critical-large', 'interactive-large']);
    expect(pool.snapshot().lanes.background.queuedReservations).toBe(1);
  });

  it('restarts the miss budget after each successful reservation', () => {
    const pool = new RuntimeCapacityReservationPool({
      capacity: 3,
      maximumReservationUnits: 3,
      minimumCriticalReserve: 0,
      minimumInteractiveReserve: 0,
    });
    pool.request(makeRequest('owner', 1, 'critical', 3));
    pool.request(makeRequest('critical', 2, 'critical'));
    pool.request(makeRequest('interactive', 3, 'interactive'));
    pool.request(makeRequest('background', 4, 'background'));

    expect(pool.release('owner', 5).map(({ id }) => id)).toEqual(['critical', 'interactive', 'background']);
    expect(pool.snapshot().queuedReservations).toBe(0);
  });

  it('does not skip a lane when the preceding lane cannot currently fit', () => {
    const pool = new RuntimeCapacityReservationPool({
      capacity: 4,
      maximumReservationUnits: 4,
      minimumCriticalReserve: 0,
      minimumInteractiveReserve: 0,
    });
    pool.request(makeRequest('owner', 1, 'critical', 4));
    pool.request(makeRequest('critical-large', 2, 'critical', 4));
    pool.request(makeRequest('interactive-small', 3, 'interactive', 1));
    pool.request(makeRequest('background-small', 4, 'background', 1));

    const promoted = pool.release('owner', 5).map(({ id }) => id);
    expect(promoted).toEqual(['critical-large']);
    expect(pool.snapshot().queuedReservations).toBe(2);
  });

  it('preserves urgent-before-standard ordering across repeated promotions', () => {
    const pool = new RuntimeCapacityReservationPool({
      capacity: 1,
      maximumReservationUnits: 1,
      minimumCriticalReserve: 0,
      minimumInteractiveReserve: 0,
    });
    pool.request(makeRequest('owner', 1, 'interactive'));
    pool.request(makeRequest('standard', 2, 'interactive'));
    pool.request(makeRequest('urgent', 3, 'interactive', 1, 'urgent'));

    expect(pool.release('owner', 4).map(({ id }) => id)).toEqual(['urgent']);
    expect(pool.release('urgent', 5).map(({ id }) => id)).toEqual(['standard']);
  });

  it('keeps queue ownership stable when no queued head can be admitted', () => {
    const pool = new RuntimeCapacityReservationPool({
      capacity: 2,
      maximumReservationUnits: 2,
      minimumCriticalReserve: 1,
      minimumInteractiveReserve: 1,
    });
    pool.request(makeRequest('critical-owner', 1, 'critical', 1));
    pool.request(makeRequest('interactive-owner', 2, 'interactive', 1));
    pool.request(makeRequest('background', 3, 'background', 1));

    expect(pool.release('critical-owner', 4)).toEqual([]);
    expect(pool.snapshot().lanes.background.queuedReservations).toBe(1);
    expect(pool.cancel('background', 5)).toBe(true);
  });
});
