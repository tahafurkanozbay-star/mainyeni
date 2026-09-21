import { describe, expect, it } from 'vitest';
import { createSpatialQueryAdmissionController, normalizeSpatialQueryAdmissionPolicy } from './spatialQueryAdmissionController';

const query = (serviceId = 'parks', layerId = 2) => ({
  serviceId,
  layerId,
  estimatedFeatures: 100,
  estimatedBytes: 1_000,
  estimatedCpuMs: 10,
  estimatedGpuBytes: 2_000,
} as const);

describe('normalizeSpatialQueryAdmissionPolicy', () => {
  it('returns immutable bounded defaults', () => {
    const policy = normalizeSpatialQueryAdmissionPolicy();
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.maxConcurrent).toBeGreaterThan(0);
    expect(policy.interactiveReserve).toBeLessThan(policy.maxConcurrent);
  });

  it('rejects invalid concurrency and queue relationships', () => {
    expect(() => normalizeSpatialQueryAdmissionPolicy({ maxConcurrent: 0 })).toThrow();
    expect(() => normalizeSpatialQueryAdmissionPolicy({ maxConcurrent: 2, maxConcurrentPerService: 3 })).toThrow();
    expect(() => normalizeSpatialQueryAdmissionPolicy({ maxQueued: 2, maxQueuedPerService: 3 })).toThrow();
    expect(() => normalizeSpatialQueryAdmissionPolicy({ maxConcurrent: 2, interactiveReserve: 2 })).toThrow();
  });

  it('rejects single-request budgets larger than their in-flight budget', () => {
    expect(() => normalizeSpatialQueryAdmissionPolicy({
      maxEstimatedFeaturesInFlight: 100,
      maxSingleEstimatedFeatures: 101,
    })).toThrow();
  });
});

describe('createSpatialQueryAdmissionController', () => {
  it('admits work and returns a stable release ticket', () => {
    const controller = createSpatialQueryAdmissionController();
    const result = controller.request(query(), 100);
    expect(result.decision).toBe('admit');
    expect(result.reason).toBe('admitted');
    expect(result.ticket).toMatchObject({ serviceId: 'parks', layerId: 2, admittedAt: 100 });
    expect(controller.snapshot()).toMatchObject({ active: 1, admitted: 1 });
    expect(controller.release(result.ticket?.id ?? -1)).toBe(true);
    expect(controller.snapshot()).toMatchObject({ active: 0, released: 1 });
  });

  it('does not allocate an in-flight ticket for cache hits', () => {
    const controller = createSpatialQueryAdmissionController();
    const result = controller.request({ ...query(), cacheHit: true });
    expect(result).toMatchObject({ decision: 'admit', reason: 'cache-hit' });
    expect(result.ticket).toBeUndefined();
    expect(controller.snapshot()).toMatchObject({ active: 0, cacheHits: 1 });
  });

  it('rejects work that exceeds a single-request feature budget', () => {
    const controller = createSpatialQueryAdmissionController({ maxSingleEstimatedFeatures: 100 });
    const result = controller.request({ ...query(), estimatedFeatures: 101 });
    expect(result).toEqual({ decision: 'reject', reason: 'single-request-budget', retryable: false });
    expect(controller.snapshot().rejected).toBe(1);
  });

  it('rejects work that exceeds a single-request byte budget', () => {
    const controller = createSpatialQueryAdmissionController({ maxSingleEstimatedBytes: 100 });
    expect(controller.request({ ...query(), estimatedBytes: 101 })).toMatchObject({
      decision: 'reject',
      reason: 'single-request-budget',
    });
  });

  it('rejects work that exceeds a single-request CPU budget', () => {
    const controller = createSpatialQueryAdmissionController({ maxSingleEstimatedCpuMs: 5 });
    expect(controller.request({ ...query(), estimatedCpuMs: 6 })).toMatchObject({
      decision: 'reject',
      reason: 'single-request-budget',
    });
  });

  it('rejects work that exceeds a single-request GPU budget', () => {
    const controller = createSpatialQueryAdmissionController({ maxSingleEstimatedGpuBytes: 100 });
    expect(controller.request({ ...query(), estimatedGpuBytes: 101 })).toMatchObject({
      decision: 'reject',
      reason: 'single-request-budget',
    });
  });

  it('reserves configured concurrency for interactive work', () => {
    const controller = createSpatialQueryAdmissionController({
      maxConcurrent: 3,
      maxConcurrentPerService: 3,
      interactiveReserve: 1,
    });
    expect(controller.request(query('a')).decision).toBe('admit');
    expect(controller.request(query('b')).decision).toBe('admit');
    expect(controller.request(query('c')).toMatchObject({ decision: 'defer', reason: 'global-concurrency' });
    expect(controller.request({ ...query('c'), priority: 'interactive' }).decision).toBe('admit');
  });

  it('enforces per-service concurrency without blocking another service', () => {
    const controller = createSpatialQueryAdmissionController({
      maxConcurrent: 4,
      maxConcurrentPerService: 1,
      interactiveReserve: 0,
    });
    expect(controller.request(query('parks')).decision).toBe('admit');
    expect(controller.request(query('parks')).toMatchObject({ decision: 'defer', reason: 'service-concurrency' });
    expect(controller.request(query('roads')).decision).toBe('admit');
  });

  it('enforces aggregate feature pressure', () => {
    const controller = createSpatialQueryAdmissionController({
      maxEstimatedFeaturesInFlight: 150,
      maxSingleEstimatedFeatures: 150,
    });
    expect(controller.request({ ...query('a'), estimatedFeatures: 100 }).decision).toBe('admit');
    expect(controller.request({ ...query('b'), estimatedFeatures: 51 })).toMatchObject({
      decision: 'defer',
      reason: 'feature-budget',
    });
  });

  it('enforces aggregate byte pressure', () => {
    const controller = createSpatialQueryAdmissionController({
      maxEstimatedBytesInFlight: 1_500,
      maxSingleEstimatedBytes: 1_500,
    });
    expect(controller.request({ ...query('a'), estimatedBytes: 1_000 }).decision).toBe('admit');
    expect(controller.request({ ...query('b'), estimatedBytes: 501 })).toMatchObject({ decision: 'defer', reason: 'byte-budget' });
  });

  it('enforces aggregate CPU pressure', () => {
    const controller = createSpatialQueryAdmissionController({
      maxEstimatedCpuMsInFlight: 15,
      maxSingleEstimatedCpuMs: 15,
    });
    expect(controller.request({ ...query('a'), estimatedCpuMs: 10 }).decision).toBe('admit');
    expect(controller.request({ ...query('b'), estimatedCpuMs: 6 })).toMatchObject({ decision: 'defer', reason: 'cpu-budget' });
  });

  it('enforces aggregate GPU pressure', () => {
    const controller = createSpatialQueryAdmissionController({
      maxEstimatedGpuBytesInFlight: 3_000,
      maxSingleEstimatedGpuBytes: 3_000,
    });
    expect(controller.request({ ...query('a'), estimatedGpuBytes: 2_000 }).decision).toBe('admit');
    expect(controller.request({ ...query('b'), estimatedGpuBytes: 1_001 })).toMatchObject({ decision: 'defer', reason: 'gpu-budget' });
  });

  it('queues deferred work and drains it after release', () => {
    const controller = createSpatialQueryAdmissionController({
      maxConcurrent: 2,
      maxConcurrentPerService: 2,
      interactiveReserve: 1,
    });
    const active = controller.request(query('active'));
    expect(active.ticket).toBeDefined();
    expect(controller.enqueue(query('queued'))).toMatchObject({ decision: 'defer' });
    expect(controller.snapshot().queued).toBe(1);
    controller.release(active.ticket?.id ?? -1);
    const drained = controller.drain(200);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ serviceId: 'queued', admittedAt: 200 });
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 0 });
  });

  it('drains interactive work before normal and background work', () => {
    const controller = createSpatialQueryAdmissionController({
      maxConcurrent: 2,
      maxConcurrentPerService: 2,
      interactiveReserve: 1,
    });
    const blocker = controller.request(query('blocker'));
    controller.enqueue({ ...query('background'), priority: 'background' });
    controller.enqueue({ ...query('normal'), priority: 'normal' });
    controller.enqueue({ ...query('interactive'), priority: 'interactive' });
    controller.release(blocker.ticket?.id ?? -1);
    const firstDrain = controller.drain();
    expect(firstDrain[0]?.serviceId).toBe('interactive');
  });

  it('preserves FIFO order inside the same priority class', () => {
    const controller = createSpatialQueryAdmissionController({ maxConcurrent: 2, interactiveReserve: 1 });
    const blocker = controller.request(query('blocker'));
    controller.enqueue(query('first'), 10);
    controller.enqueue(query('second'), 11);
    controller.release(blocker.ticket?.id ?? -1);
    const drained = controller.drain();
    expect(drained[0]?.serviceId).toBe('first');
  });

  it('caps the global queue', () => {
    const controller = createSpatialQueryAdmissionController({ maxQueued: 1, maxQueuedPerService: 1 });
    expect(controller.enqueue(query('a')).decision).toBe('defer');
    expect(controller.enqueue(query('b'))).toMatchObject({ decision: 'reject', reason: 'queue-budget', retryable: true });
  });

  it('caps each service queue independently', () => {
    const controller = createSpatialQueryAdmissionController({ maxQueued: 3, maxQueuedPerService: 1 });
    controller.enqueue(query('parks'));
    expect(controller.enqueue(query('parks'))).toMatchObject({ decision: 'reject', reason: 'service-queue-budget' });
    expect(controller.enqueue(query('roads')).decision).toBe('defer');
  });

  it('cancels queued work by service', () => {
    const controller = createSpatialQueryAdmissionController();
    controller.enqueue(query('parks', 1));
    controller.enqueue(query('parks', 2));
    controller.enqueue(query('roads', 1));
    expect(controller.cancelQueued('parks')).toBe(2);
    expect(controller.snapshot().queued).toBe(1);
  });

  it('cancels queued work by service and layer', () => {
    const controller = createSpatialQueryAdmissionController();
    controller.enqueue(query('parks', 1));
    controller.enqueue(query('parks', 2));
    expect(controller.cancelQueued('parks', 2)).toBe(1);
    expect(controller.snapshot().queued).toBe(1);
  });

  it('clears the queue without affecting active tickets', () => {
    const controller = createSpatialQueryAdmissionController();
    const active = controller.request(query('active'));
    controller.enqueue(query('queued'));
    expect(controller.clearQueue()).toBe(1);
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 0 });
    expect(controller.release(active.ticket?.id ?? -1)).toBe(true);
  });

  it('tracks aggregate in-flight resource estimates', () => {
    const controller = createSpatialQueryAdmissionController();
    controller.request(query('a'));
    controller.request({ ...query('b'), estimatedFeatures: 200, estimatedBytes: 3_000, estimatedCpuMs: 20, estimatedGpuBytes: 4_000 });
    expect(controller.snapshot()).toMatchObject({
      estimatedFeaturesInFlight: 300,
      estimatedBytesInFlight: 4_000,
      estimatedCpuMsInFlight: 30,
      estimatedGpuBytesInFlight: 6_000,
    });
  });

  it('rejects malformed request identity and estimates', () => {
    const controller = createSpatialQueryAdmissionController();
    expect(() => controller.request({ ...query(), serviceId: ' ' })).toThrow();
    expect(() => controller.request({ ...query(), layerId: -1 })).toThrow();
    expect(() => controller.request({ ...query(), estimatedFeatures: Number.NaN })).toThrow();
    expect(() => controller.request({ ...query(), estimatedBytes: -1 })).toThrow();
  });

  it('rejects invalid timestamps', () => {
    const controller = createSpatialQueryAdmissionController();
    expect(() => controller.request(query(), -1)).toThrow();
    expect(() => controller.enqueue(query(), Number.NaN)).toThrow();
    expect(() => controller.drain(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('releases tickets idempotently', () => {
    const controller = createSpatialQueryAdmissionController();
    const result = controller.request(query());
    const id = result.ticket?.id ?? -1;
    expect(controller.release(id)).toBe(true);
    expect(controller.release(id)).toBe(false);
    expect(controller.snapshot().released).toBe(1);
  });
});
