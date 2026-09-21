import { describe, expect, it } from 'vitest';
import { LoadSheddingPolicy } from './loadSheddingPolicy';

const policy = () => new LoadSheddingPolicy({
  maxActive: 10,
  maxQueued: 20,
  maxLatencyMs: 500,
  maxErrorRate: 0.1,
});

describe('LoadSheddingPolicy', () => {
  it('admits healthy work', () => {
    expect(policy().evaluate({ active: 2, queued: 3, latencyMs: 100, errorRate: 0.01 }, 'background'))
      .toMatchObject({ admitted: true, reason: 'healthy' });
  });

  it.each([
    [{ active: 10, queued: 0, latencyMs: 10, errorRate: 0 }, 'capacity'],
    [{ active: 0, queued: 20, latencyMs: 10, errorRate: 0 }, 'queue'],
    [{ active: 0, queued: 0, latencyMs: 500, errorRate: 0 }, 'latency'],
    [{ active: 0, queued: 0, latencyMs: 10, errorRate: 0.1 }, 'errors'],
  ] as const)('rejects background work at the %s boundary', (sample, reason) => {
    expect(policy().evaluate(sample, 'background')).toMatchObject({ admitted: false, reason });
  });

  it('reserves bounded headroom for critical work', () => {
    expect(policy().evaluate({ active: 11, queued: 0, latencyMs: 10, errorRate: 0 }, 'critical'))
      .toMatchObject({ admitted: true, reason: 'priority' });
    expect(policy().evaluate({ active: 15, queued: 0, latencyMs: 10, errorRate: 0 }, 'critical'))
      .toMatchObject({ admitted: false, reason: 'capacity' });
  });

  it('rejects invalid thresholds', () => {
    expect(() => new LoadSheddingPolicy({ maxActive: 0, maxQueued: 1, maxLatencyMs: 1, maxErrorRate: 0.1 }))
      .toThrow(RangeError);
    expect(() => new LoadSheddingPolicy({ maxActive: 1, maxQueued: 1, maxLatencyMs: 1, maxErrorRate: 2 }))
      .toThrow(RangeError);
  });

  it('handles a zero queue budget deterministically', () => {
    const noQueue = new LoadSheddingPolicy({ maxActive: 2, maxQueued: 0, maxLatencyMs: 100, maxErrorRate: 0.1 });
    expect(noQueue.evaluate({ active: 0, queued: 0, latencyMs: 1, errorRate: 0 }, 'background').admitted).toBe(true);
    expect(noQueue.evaluate({ active: 0, queued: 1, latencyMs: 1, errorRate: 0 }, 'background'))
      .toMatchObject({ admitted: false, reason: 'queue' });
  });
});
