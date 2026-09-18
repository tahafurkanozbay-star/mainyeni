import { describe, expect, it } from 'vitest';
import {
  AdmissionCancelledError,
  AdmissionRejectedError,
  createAdmissionController,
} from './admissionController';

const policy = {
  maxActive: 2,
  maxQueued: 4,
  maxCost: 4,
  maxQueueAgeMs: 1_000,
  laneMaxActive: { network: 1 },
  laneMaxQueued: { network: 2 },
} as const;

describe('createAdmissionController', () => {
  it('admits work immediately while global capacity is available', async () => {
    const controller = createAdmissionController(policy);
    const first = await controller.acquire({ key: 'first', lane: 'cpu' });
    const second = await controller.acquire({ key: 'second', lane: 'render' });
    expect(controller.snapshot()).toMatchObject({ active: 2, queued: 0, admitted: 2 });
    first.release();
    second.release();
    expect(controller.snapshot()).toMatchObject({ active: 0, completed: 2 });
  });

  it('makes lease release idempotent', async () => {
    const controller = createAdmissionController(policy);
    const lease = await controller.acquire({ key: 'idempotent' });
    lease.release();
    lease.release();
    expect(controller.snapshot()).toMatchObject({ active: 0, completed: 1 });
  });

  it('queues work when global active capacity is exhausted', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1 });
    const active = await controller.acquire({ key: 'active' });
    let admitted = false;
    const queued = controller.acquire({ key: 'queued' }).then((lease) => {
      admitted = true;
      return lease;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(controller.snapshot().queued).toBe(1);
    active.release();
    const next = await queued;
    expect(admitted).toBe(true);
    next.release();
  });

  it('enforces weighted cost capacity independently of active count', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 4, maxCost: 3 });
    const expensive = await controller.acquire({ key: 'expensive', cost: 3 });
    const pending = controller.acquire({ key: 'pending', cost: 2 });
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 1, activeCost: 3 });
    expensive.release();
    const admitted = await pending;
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 0, activeCost: 2 });
    admitted.release();
  });

  it('caps request cost to the configured maximum', async () => {
    const controller = createAdmissionController({ ...policy, maxCost: 3 });
    const lease = await controller.acquire({ key: 'large', cost: 999 });
    expect(lease.cost).toBe(3);
    expect(controller.snapshot().activeCost).toBe(3);
    lease.release();
  });

  it('normalizes missing lanes and priorities without changing the key', async () => {
    const controller = createAdmissionController(policy);
    const lease = await controller.acquire({ key: '  normalized  ' });
    expect(lease.key).toBe('normalized');
    expect(lease.lane).toBe('default');
    lease.release();
  });

  it('rejects empty admission keys', async () => {
    const controller = createAdmissionController(policy);
    await expect(controller.acquire({ key: '   ' })).rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, admitted: 0 });
  });

  it('enforces per-lane active limits', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 3 });
    const network = await controller.acquire({ key: 'n1', lane: 'network' });
    const queued = controller.acquire({ key: 'n2', lane: 'network' });
    const cpu = await controller.acquire({ key: 'cpu', lane: 'cpu' });
    expect(controller.snapshot().lanes.network).toMatchObject({ active: 1, queued: 1 });
    expect(controller.snapshot().lanes.cpu).toMatchObject({ active: 1, queued: 0 });
    network.release();
    const network2 = await queued;
    network2.release();
    cpu.release();
  });

  it('does not let a blocked lane prevent another lane from using capacity', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 2 });
    const network = await controller.acquire({ key: 'n1', lane: 'network' });
    const blocked = controller.acquire({ key: 'n2', lane: 'network', priority: 'critical' });
    const cpu = await controller.acquire({ key: 'cpu', lane: 'cpu', priority: 'normal' });
    expect(controller.snapshot()).toMatchObject({ active: 2, queued: 1 });
    cpu.release();
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 1 });
    network.release();
    const next = await blocked;
    next.release();
  });

  it('orders queued work by priority before FIFO sequence', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1 });
    const blocker = await controller.acquire({ key: 'blocker' });
    const order: string[] = [];
    const background = controller.acquire({ key: 'background', priority: 'background' }).then((lease) => {
      order.push(lease.key);
      lease.release();
    });
    const critical = controller.acquire({ key: 'critical', priority: 'critical' }).then((lease) => {
      order.push(lease.key);
      lease.release();
    });
    const high = controller.acquire({ key: 'high', priority: 'high' }).then((lease) => {
      order.push(lease.key);
      lease.release();
    });
    blocker.release();
    await Promise.all([background, critical, high]);
    expect(order).toEqual(['critical', 'high', 'background']);
  });

  it('preserves FIFO ordering within the same priority', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1 });
    const blocker = await controller.acquire({ key: 'blocker' });
    const order: string[] = [];
    const first = controller.acquire({ key: 'first', priority: 'normal' }).then((lease) => {
      order.push(lease.key);
      lease.release();
    });
    const second = controller.acquire({ key: 'second', priority: 'normal' }).then((lease) => {
      order.push(lease.key);
      lease.release();
    });
    blocker.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('sheds work when the global queue bound is reached', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1, maxQueued: 2, laneMaxQueued: {} });
    const blocker = await controller.acquire({ key: 'blocker' });
    const q1 = controller.acquire({ key: 'q1' });
    const q2 = controller.acquire({ key: 'q2' });
    await expect(controller.acquire({ key: 'shed' })).rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(controller.snapshot()).toMatchObject({ queued: 2, shed: 1 });
    controller.cancelQueued();
    await Promise.allSettled([q1, q2]);
    blocker.release();
  });

  it('sheds work when a lane queue bound is reached', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 2 });
    const blocker = await controller.acquire({ key: 'n0', lane: 'network' });
    const q1 = controller.acquire({ key: 'n1', lane: 'network' });
    const q2 = controller.acquire({ key: 'n2', lane: 'network' });
    await expect(controller.acquire({ key: 'n3', lane: 'network' })).rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(controller.snapshot().shed).toBe(1);
    controller.cancelQueued();
    await Promise.allSettled([q1, q2]);
    blocker.release();
  });

  it('rejects an already-aborted request without queueing it', async () => {
    const controller = createAdmissionController(policy);
    const abort = new AbortController();
    abort.abort();
    await expect(controller.acquire({ key: 'aborted', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, cancelled: 0 });
  });

  it('removes a queued request when its signal aborts', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1 });
    const blocker = await controller.acquire({ key: 'blocker' });
    const abort = new AbortController();
    const queued = controller.acquire({ key: 'queued', signal: abort.signal });
    abort.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.snapshot()).toMatchObject({ queued: 0, cancelled: 1 });
    blocker.release();
  });

  it('propagates an Error abort reason', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1 });
    const blocker = await controller.acquire({ key: 'blocker' });
    const abort = new AbortController();
    const reason = new Error('navigation changed');
    const queued = controller.acquire({ key: 'queued', signal: abort.signal });
    abort.abort(reason);
    await expect(queued).rejects.toBe(reason);
    blocker.release();
  });

  it('selectively cancels queued work by lane', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1, laneMaxQueued: {} });
    const blocker = await controller.acquire({ key: 'blocker' });
    const network = controller.acquire({ key: 'network', lane: 'network' });
    const render = controller.acquire({ key: 'render', lane: 'render' });
    expect(controller.cancelQueued((request) => request.lane === 'network')).toBe(1);
    await expect(network).rejects.toBeInstanceOf(AdmissionCancelledError);
    expect(controller.snapshot()).toMatchObject({ queued: 1, cancelled: 1 });
    blocker.release();
    const renderLease = await render;
    renderLease.release();
  });

  it('expires stale queued requests on the next observable controller action', async () => {
    let now = 100;
    const controller = createAdmissionController({ ...policy, maxActive: 1, maxQueueAgeMs: 50 }, () => now);
    const blocker = await controller.acquire({ key: 'blocker' });
    const stale = controller.acquire({ key: 'stale' });
    now = 151;
    expect(controller.snapshot()).toMatchObject({ queued: 0, expired: 1 });
    await expect(stale).rejects.toMatchObject({ code: 'PLATFORM_ADMISSION_SHED' });
    blocker.release();
  });

  it('does not expire work exactly at the queue age boundary', async () => {
    let now = 100;
    const controller = createAdmissionController({ ...policy, maxActive: 1, maxQueueAgeMs: 50 }, () => now);
    const blocker = await controller.acquire({ key: 'blocker' });
    const queued = controller.acquire({ key: 'queued' });
    now = 150;
    expect(controller.snapshot().queued).toBe(1);
    blocker.release();
    const lease = await queued;
    lease.release();
  });

  it('reports per-lane active cost and queue counts', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 2, maxCost: 4, laneMaxActive: { network: 1 } });
    const network = await controller.acquire({ key: 'n1', lane: 'network', cost: 2 });
    const cpu = await controller.acquire({ key: 'c1', lane: 'cpu', cost: 1 });
    const queued = controller.acquire({ key: 'n2', lane: 'network', cost: 1 });
    expect(controller.snapshot().lanes).toEqual({
      network: { active: 1, queued: 1, cost: 2 },
      cpu: { active: 1, queued: 0, cost: 1 },
    });
    controller.cancelQueued();
    await Promise.allSettled([queued]);
    network.release();
    cpu.release();
  });

  it('dispose rejects queued work and prevents future admission', async () => {
    const controller = createAdmissionController({ ...policy, maxActive: 1 });
    const active = await controller.acquire({ key: 'active' });
    const queued = controller.acquire({ key: 'queued' });
    controller.dispose();
    await expect(queued).rejects.toBeInstanceOf(AdmissionCancelledError);
    await expect(controller.acquire({ key: 'future' })).rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, cancelled: 1 });
    active.release();
  });

  it('dispose is idempotent', async () => {
    const controller = createAdmissionController(policy);
    const lease = await controller.acquire({ key: 'active' });
    controller.dispose();
    controller.dispose();
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0 });
    lease.release();
  });
  it('treats zero lane limits as a hard disabled-lane contract', async () => {
    const controller = createAdmissionController({
      ...policy,
      maxActive: 4,
      maxQueued: 8,
      laneMaxActive: { disabled: 0 },
      laneMaxQueued: { disabled: 0 },
    });
    await expect(controller.acquire({ key: 'disabled', lane: 'disabled' }))
      .rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(controller.snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      admitted: 0,
      shed: 1,
    });
  });


});
