import { describe, expect, test, vi } from 'vitest';
import { AdmissionRejectedError, createAdmissionController } from './admissionController';

describe('adaptive runtime admission controller', () => {
  test('admits within global active and cost budgets', async () => {
    const controller = createAdmissionController({ maxActive: 2, maxQueued: 4, maxCost: 3, maxQueueAgeMs: 1000 });
    const first = await controller.acquire({ key: 'a', cost: 2 });
    const secondPromise = controller.acquire({ key: 'b', cost: 2 });
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 1, activeCost: 2 });
    first.release();
    const second = await secondPromise;
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 0, completed: 1 });
    second.release();
    expect(controller.snapshot().completed).toBe(2);
  });

  test('prioritizes critical queued work without preempting active leases', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 8, maxCost: 2, maxQueueAgeMs: 1000 });
    const running = await controller.acquire({ key: 'running' });
    const background = controller.acquire({ key: 'background', priority: 'background' });
    const critical = controller.acquire({ key: 'critical', priority: 'critical' });
    running.release();
    const criticalLease = await critical;
    expect(criticalLease.key).toBe('critical');
    expect(controller.snapshot().queued).toBe(1);
    criticalLease.release();
    const backgroundLease = await background;
    backgroundLease.release();
  });

  test('enforces per-lane active capacity', async () => {
    const controller = createAdmissionController({
      maxActive: 3, maxQueued: 8, maxCost: 8, maxQueueAgeMs: 1000,
      laneMaxActive: { gis: 1, api: 2 },
    });
    const gis = await controller.acquire({ key: 'gis-1', lane: 'gis' });
    const queuedGis = controller.acquire({ key: 'gis-2', lane: 'gis' });
    const api = await controller.acquire({ key: 'api-1', lane: 'api' });
    expect(controller.snapshot().lanes.gis).toMatchObject({ active: 1, queued: 1 });
    api.release();
    expect(controller.snapshot().queued).toBe(1);
    gis.release();
    const next = await queuedGis;
    next.release();
  });

  test('sheds when global queue budget is exhausted', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 1, maxCost: 1, maxQueueAgeMs: 1000 });
    const running = await controller.acquire({ key: 'running' });
    const queued = controller.acquire({ key: 'queued' });
    await expect(controller.acquire({ key: 'shed' })).rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(controller.snapshot().shed).toBe(1);
    running.release();
    (await queued).release();
  });

  test('sheds when lane queue budget is exhausted', async () => {
    const controller = createAdmissionController({
      maxActive: 1, maxQueued: 8, maxCost: 4, maxQueueAgeMs: 1000,
      laneMaxQueued: { search: 1 },
    });
    const running = await controller.acquire({ key: 'running', lane: 'search' });
    const queued = controller.acquire({ key: 'queued', lane: 'search' });
    await expect(controller.acquire({ key: 'shed', lane: 'search' })).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_SHED' });
    running.release();
    (await queued).release();
  });

  test('cancels a queued request through AbortSignal', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 4, maxCost: 2, maxQueueAgeMs: 1000 });
    const running = await controller.acquire({ key: 'running' });
    const abort = new AbortController();
    const queued = controller.acquire({ key: 'queued', signal: abort.signal });
    abort.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.snapshot()).toMatchObject({ queued: 0, cancelled: 1 });
    running.release();
  });

  test('preserves caller abort reason', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 4, maxCost: 2, maxQueueAgeMs: 1000 });
    const running = await controller.acquire({ key: 'running' });
    const abort = new AbortController();
    const reason = new Error('caller stopped');
    const queued = controller.acquire({ key: 'queued', signal: abort.signal });
    abort.abort(reason);
    await expect(queued).rejects.toBe(reason);
    running.release();
  });

  test('rejects an already aborted request without queueing it', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 4, maxCost: 2, maxQueueAgeMs: 1000 });
    const abort = new AbortController();
    abort.abort();
    await expect(controller.acquire({ key: 'cancelled', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test('expires stale queued work before admitting newer work', async () => {
    let time = 0;
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 4, maxCost: 2, maxQueueAgeMs: 50 }, () => time);
    const running = await controller.acquire({ key: 'running' });
    const stale = controller.acquire({ key: 'stale' });
    time = 51;
    const fresh = controller.acquire({ key: 'fresh' });
    await expect(stale).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_SHED' });
    expect(controller.snapshot().expired).toBe(1);
    running.release();
    (await fresh).release();
  });

  test('release is idempotent', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 1, maxCost: 1, maxQueueAgeMs: 1000 });
    const lease = await controller.acquire({ key: 'a' });
    lease.release();
    lease.release();
    expect(controller.snapshot()).toMatchObject({ active: 0, completed: 1 });
  });

  test('cancelQueued selectively rejects queued lanes', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 8, maxCost: 2, maxQueueAgeMs: 1000 });
    const running = await controller.acquire({ key: 'running' });
    const gis = controller.acquire({ key: 'gis', lane: 'gis' });
    const search = controller.acquire({ key: 'search', lane: 'search' });
    expect(controller.cancelQueued((request) => request.lane === 'gis')).toBe(1);
    await expect(gis).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_CANCELLED' });
    expect(controller.snapshot().queued).toBe(1);
    running.release();
    (await search).release();
  });

  test('dispose rejects queued work and future acquisition', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 4, maxCost: 2, maxQueueAgeMs: 1000 });
    await controller.acquire({ key: 'running' });
    const queued = controller.acquire({ key: 'queued' });
    controller.dispose();
    await expect(queued).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_CANCELLED' });
    await expect(controller.acquire({ key: 'future' })).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_SHED' });
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  test('normalizes invalid costs and caps oversized costs', async () => {
    const controller = createAdmissionController({ maxActive: 2, maxQueued: 2, maxCost: 3, maxQueueAgeMs: 1000 });
    const first = await controller.acquire({ key: 'a', cost: Number.NaN });
    expect(first.cost).toBe(1);
    first.release();
    const second = await controller.acquire({ key: 'b', cost: 999 });
    expect(second.cost).toBe(3);
    second.release();
  });

  test('exposes immutable top-level snapshots', async () => {
    const controller = createAdmissionController({ maxActive: 1, maxQueued: 1, maxCost: 1, maxQueueAgeMs: 1000 });
    const lease = await controller.acquire({ key: 'a', lane: 'api' });
    const snapshot = controller.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.lanes)).toBe(true);
    expect(snapshot.lanes.api).toMatchObject({ active: 1, queued: 0, cost: 1 });
    lease.release();
  });

  test('does not execute timers or polling in idle state', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    createAdmissionController({ maxActive: 1, maxQueued: 1, maxCost: 1, maxQueueAgeMs: 1000 });
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });
});
