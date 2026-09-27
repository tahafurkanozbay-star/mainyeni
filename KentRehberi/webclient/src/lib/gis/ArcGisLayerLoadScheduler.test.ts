import { describe, expect, it, vi } from 'vitest';
import { ArcGisLayerLoadScheduler } from './ArcGisLayerLoadScheduler';

const options = {
  maxConcurrent: 2,
  maxInFlightBytes: 100,
  maxQueueDepth: 4,
  queueTimeoutMs: 1000,
  maxEstimatedBytesPerLayer: 80,
} as const;

describe('ArcGisLayerLoadScheduler', () => {
  it('bounds concurrent loads and bytes', async () => {
    const scheduler = new ArcGisLayerLoadScheduler(options);
    const a = await scheduler.acquire({ layerId: 'a', priority: 'visible', estimatedBytes: 60 });
    const pending = scheduler.acquire({ layerId: 'b', priority: 'visible', estimatedBytes: 60 });
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 1, inFlightBytes: 60 });
    a.release();
    const b = await pending;
    expect(b.layerId).toBe('b');
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0, inFlightBytes: 60 });
    b.release();
  });

  it('orders queued work by priority then FIFO', async () => {
    const scheduler = new ArcGisLayerLoadScheduler({ ...options, maxConcurrent: 1 });
    const first = await scheduler.acquire({ layerId: 'first', priority: 'visible', estimatedBytes: 10 });
    const prefetch = scheduler.acquire({ layerId: 'prefetch', priority: 'prefetch', estimatedBytes: 10 });
    const critical = scheduler.acquire({ layerId: 'critical', priority: 'critical', estimatedBytes: 10 });
    first.release();
    const criticalLease = await critical;
    expect(criticalLease.layerId).toBe('critical');
    criticalLease.release();
    expect((await prefetch).layerId).toBe('prefetch');
  });

  it('rejects duplicate active or queued layer identities', async () => {
    const scheduler = new ArcGisLayerLoadScheduler(options);
    const lease = await scheduler.acquire({ layerId: 'roads', priority: 'visible', estimatedBytes: 10 });
    await expect(scheduler.acquire({ layerId: ' roads ', priority: 'critical', estimatedBytes: 10 })).rejects.toThrow(/already/);
    lease.release();
  });

  it('cancels queued callers independently', async () => {
    const scheduler = new ArcGisLayerLoadScheduler({ ...options, maxConcurrent: 1 });
    const first = await scheduler.acquire({ layerId: 'a', priority: 'visible', estimatedBytes: 10 });
    const controller = new AbortController();
    const queued = scheduler.acquire({ layerId: 'b', priority: 'visible', estimatedBytes: 10, signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.snapshot().queuedCount).toBe(0);
    first.release();
  });

  it('times out queued work without corrupting active accounting', async () => {
    vi.useFakeTimers();
    const scheduler = new ArcGisLayerLoadScheduler({ ...options, maxConcurrent: 1, queueTimeoutMs: 50 });
    const first = await scheduler.acquire({ layerId: 'a', priority: 'visible', estimatedBytes: 10 });
    const queued = scheduler.acquire({ layerId: 'b', priority: 'visible', estimatedBytes: 10 });
    await vi.advanceTimersByTimeAsync(51);
    await expect(queued).rejects.toThrow(/timeout/);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, queuedCount: 0, inFlightBytes: 10 });
    first.release();
    vi.useRealTimers();
  });

  it('rejects impossible budgets and oversized requests', async () => {
    expect(() => new ArcGisLayerLoadScheduler({ ...options, maxEstimatedBytesPerLayer: 101 })).toThrow();
    const scheduler = new ArcGisLayerLoadScheduler(options);
    await expect(scheduler.acquire({ layerId: 'huge', priority: 'visible', estimatedBytes: 81 })).rejects.toThrow(/budget/);
    await expect(scheduler.acquire({ layerId: 'x'.repeat(257), priority: 'visible', estimatedBytes: 1 })).rejects.toThrow(/layerId/);
  });

  it('dispose rejects queued work and prevents new admission', async () => {
    const scheduler = new ArcGisLayerLoadScheduler({ ...options, maxConcurrent: 1 });
    const first = await scheduler.acquire({ layerId: 'a', priority: 'visible', estimatedBytes: 10 });
    const queued = scheduler.acquire({ layerId: 'b', priority: 'visible', estimatedBytes: 10 });
    scheduler.dispose();
    await expect(queued).rejects.toThrow(/disposed/);
    await expect(scheduler.acquire({ layerId: 'c', priority: 'visible', estimatedBytes: 10 })).rejects.toThrow(/disposed/);
    first.release();
  });
});
