import { describe, expect, it } from 'vitest';
import {
  createSpatialWorkloadGovernor,
  deriveSpatialPressure,
  SpatialWorkloadGovernor,
} from './spatialWorkloadGovernor';

const request = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  lane: 'query' as const,
  priority: 'normal' as const,
  estimatedBytes: 1_024,
  estimatedCpuMs: 4,
  cancellable: true,
  createdAt: 1_000,
  ...overrides,
});

describe('spatialWorkloadGovernor', () => {
  it('derives pressure from frame, gpu, heap, memory and backlog samples', () => {
    expect(deriveSpatialPressure({ frameMs: 16, memoryGb: 8 })).toBe('normal');
    expect(deriveSpatialPressure({ frameMs: 30, memoryGb: 8 })).toBe('elevated');
    expect(deriveSpatialPressure({ gpuPressure: 0.75, memoryGb: 8 })).toBe('elevated');
    expect(deriveSpatialPressure({ heapPressure: 0.95, memoryGb: 8 })).toBe('critical');
    expect(deriveSpatialPressure({ memoryGb: 1 })).toBe('critical');
    expect(deriveSpatialPressure({ networkBacklog: 70, memoryGb: 8 })).toBe('critical');
  });

  it('starts requests immediately while lane capacity is available', () => {
    const governor = createSpatialWorkloadGovernor({ budgets: { query: { maxActive: 2 } } });
    const first = governor.admit(request('a'));
    const second = governor.admit(request('b'));

    expect(first.decision).toBe('start');
    expect(second.decision).toBe('start');
    expect(governor.snapshot().totalActive).toBe(2);
  });

  it('queues deterministic overflow and promotes highest priority work first', () => {
    const governor = createSpatialWorkloadGovernor({
      budgets: { query: { maxActive: 1, maxQueued: 5 } },
    });
    governor.admit(request('active'));
    governor.admit(request('background', { priority: 'background', createdAt: 1_001 }));
    governor.admit(request('interactive', { priority: 'interactive', createdAt: 1_002 }));

    expect(governor.snapshot().totalQueued).toBe(2);
    governor.complete('active', { completedAt: 2_000 });

    const lane = governor.snapshot().lanes.find((item) => item.lane === 'query');
    expect(lane).toMatchObject({ active: 1, queued: 1 });
    expect(governor.cancel('interactive')).toBe(true);
  });

  it('preempts cancellable lower-priority work only for critical requests', () => {
    const governor = createSpatialWorkloadGovernor({ budgets: { query: { maxActive: 1 } } });
    governor.admit(request('normal'));
    const interactive = governor.admit(request('interactive', { priority: 'interactive' }));
    expect(interactive.decision).toBe('queue');

    const critical = governor.admit(request('critical', { priority: 'critical' }));
    expect(critical.decision).toBe('preempt');
    expect(critical.preemptRequestId).toBe('normal');
    expect(governor.snapshot().preemptions).toBe(1);
  });

  it('does not preempt non-cancellable work', () => {
    const governor = createSpatialWorkloadGovernor({ budgets: { query: { maxActive: 1, maxQueued: 2 } } });
    governor.admit(request('protected', { cancellable: false }));
    const critical = governor.admit(request('critical', { priority: 'critical' }));

    expect(critical.decision).toBe('queue');
    expect(critical.preemptRequestId).toBeNull();
  });

  it('rejects duplicate request ids', () => {
    const governor = createSpatialWorkloadGovernor();
    governor.admit(request('same'));
    const duplicate = governor.admit(request('same'));

    expect(duplicate.decision).toBe('reject');
    expect(duplicate.reason).toBe('duplicate-request-id');
    expect(governor.snapshot().rejected).toBe(1);
  });

  it('rejects a single request exceeding its lane byte budget', () => {
    const governor = createSpatialWorkloadGovernor({
      budgets: { identify: { maxEstimatedBytes: 2_048 } },
    });
    const result = governor.admit(request('huge', {
      lane: 'identify',
      estimatedBytes: 10_000,
    }));

    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('request-byte-budget-exceeded');
  });

  it('bounds queued work by both count and aggregate bytes', () => {
    const governor = createSpatialWorkloadGovernor({
      budgets: { query: { maxActive: 1, maxQueued: 1, maxEstimatedBytes: 3_000 } },
    });
    governor.admit(request('active', { estimatedBytes: 1_000 }));
    expect(governor.admit(request('queued', { estimatedBytes: 2_000 })).decision).toBe('queue');
    const rejected = governor.admit(request('overflow', { estimatedBytes: 1_000 }));

    expect(rejected.decision).toBe('reject');
    expect(rejected.reason).toBe('queue-capacity-exceeded');
  });

  it('raises pressure immediately and relaxes only after hysteresis samples', () => {
    const governor = createSpatialWorkloadGovernor({ pressureHysteresisSamples: 3 });
    expect(governor.samplePerformance({ frameMs: 60, memoryGb: 8 })).toBe('critical');
    expect(governor.samplePerformance({ frameMs: 16, memoryGb: 8 })).toBe('critical');
    expect(governor.samplePerformance({ frameMs: 16, memoryGb: 8 })).toBe('critical');
    expect(governor.samplePerformance({ frameMs: 16, memoryGb: 8 })).toBe('normal');
  });

  it('reduces effective concurrency under critical pressure', () => {
    const governor = createSpatialWorkloadGovernor({
      budgets: { tile: { maxActive: 5, maxQueued: 10 } },
    });
    governor.samplePerformance({ frameMs: 70, memoryGb: 8 });

    const decisions = Array.from({ length: 5 }, (_, index) => governor.admit(request(`tile-${index}`, {
      lane: 'tile',
    })).decision);

    expect(decisions.filter((decision) => decision === 'start')).toHaveLength(2);
    expect(decisions.filter((decision) => decision === 'queue')).toHaveLength(3);
  });

  it('promotes queued work after completion', () => {
    const governor = createSpatialWorkloadGovernor({ budgets: { query: { maxActive: 1 } } });
    governor.admit(request('first', { createdAt: 1_000 }));
    governor.admit(request('second', { createdAt: 1_001 }));

    const completion = governor.complete('first', { completedAt: 1_250 });
    expect(completion).toEqual({
      id: 'first',
      lane: 'query',
      durationMs: 250,
      success: true,
      bytes: 1_024,
    });
    expect(governor.snapshot()).toMatchObject({ totalActive: 1, totalQueued: 0, completed: 1 });
  });

  it('tracks failed completions separately', () => {
    const governor = createSpatialWorkloadGovernor();
    governor.admit(request('failed'));
    governor.complete('failed', { success: false, completedAt: 1_100 });

    expect(governor.snapshot()).toMatchObject({ failed: 1, completed: 0 });
  });

  it('expires only cancellable active requests past their lane timeout', () => {
    const governor = new SpatialWorkloadGovernor({
      budgets: { query: { maxActive: 2, timeoutMs: 500 } },
    });
    governor.admit(request('cancellable', { createdAt: 1_000, cancellable: true }));
    governor.admit(request('protected', { createdAt: 1_000, cancellable: false }));

    const expired = governor.drainExpired(1_600);

    expect(expired).toEqual(['cancellable']);
    expect(governor.snapshot().totalActive).toBe(1);
  });

  it('allows queued work to be cancelled without disturbing active work', () => {
    const governor = createSpatialWorkloadGovernor({ budgets: { query: { maxActive: 1 } } });
    governor.admit(request('active'));
    governor.admit(request('queued'));

    expect(governor.cancel('queued')).toBe(true);
    expect(governor.snapshot()).toMatchObject({ totalActive: 1, totalQueued: 0, cancelled: 1 });
  });

  it('provides per-lane resource accounting', () => {
    const governor = createSpatialWorkloadGovernor();
    governor.admit(request('q', { estimatedBytes: 2_000 }));
    governor.admit(request('tile', { lane: 'tile', estimatedBytes: 4_000 }));

    const snapshot = governor.snapshot();
    expect(snapshot.totalActive).toBe(2);
    expect(snapshot.lanes.find((item) => item.lane === 'query')?.activeBytes).toBe(2_000);
    expect(snapshot.lanes.find((item) => item.lane === 'tile')?.activeBytes).toBe(4_000);
  });

  it('disposes by cancelling all tracked work and rejects future admissions', () => {
    const governor = createSpatialWorkloadGovernor({ budgets: { query: { maxActive: 1 } } });
    governor.admit(request('active'));
    governor.admit(request('queued'));
    governor.dispose();

    expect(governor.snapshot()).toMatchObject({
      disposed: true,
      totalActive: 0,
      totalQueued: 0,
      cancelled: 2,
    });
    expect(() => governor.admit(request('later'))).toThrow(/disposed/);
  });
});
