import { describe, expect, it } from 'vitest';
import { planArcGisGeometryWorkload } from './ArcGisGeometryWorkloadPolicy';
import type { ArcGisGeometryJob } from './ArcGisGeometryWorkloadPolicy';

const input = (id: string, vertices = 10, bytes = 1000, wkid = 4326, revision = 7) => ({ id, kind: 'polygon' as const, vertexCount: vertices, estimatedBytes: bytes, wkid, revision });
const job = (overrides: Partial<ArcGisGeometryJob> = {}): ArcGisGeometryJob => ({ id: 'job-a', operation: 'simplify', inputs: [input('a')], priority: 1, revision: 7, ...overrides });

describe('planArcGisGeometryWorkload', () => {
  it('admits a bounded valid workload', () => {
    const plan = planArcGisGeometryWorkload([job()], 7);
    expect(plan.admitted).toHaveLength(1);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.totalVertices).toBe(10);
  });

  it('orders jobs deterministically by priority then id', () => {
    const plan = planArcGisGeometryWorkload([job({ id: 'z', priority: 1 }), job({ id: 'a', priority: 2 }), job({ id: 'b', priority: 2 })], 7);
    expect(plan.admitted.map((entry) => entry.jobId)).toEqual(['a', 'b', 'z']);
  });

  it('rejects duplicate job identities', () => {
    const plan = planArcGisGeometryWorkload([job(), job()], 7);
    expect(plan.rejected.map((entry) => entry.reason)).toContain('duplicate-job-id');
  });

  it('rejects stale job revisions', () => {
    expect(planArcGisGeometryWorkload([job({ revision: 6 })], 7).rejected[0]?.reason).toBe('stale-revision');
  });

  it('rejects stale input revisions', () => {
    expect(planArcGisGeometryWorkload([job({ inputs: [input('a', 10, 1000, 4326, 6)] })], 7).rejected[0]?.reason).toBe('stale-input-revision');
  });

  it('rejects duplicate input identities', () => {
    expect(planArcGisGeometryWorkload([job({ inputs: [input('a'), input('a')] })], 7).rejected[0]?.reason).toBe('duplicate-input-id');
  });

  it('rejects mixed spatial references outside projection', () => {
    expect(planArcGisGeometryWorkload([job({ inputs: [input('a', 10, 1000, 4326), input('b', 10, 1000, 3857)] })], 7).rejected[0]?.reason).toBe('mixed-spatial-reference');
  });

  it('allows projection across source spatial references with a target', () => {
    const plan = planArcGisGeometryWorkload([job({ operation: 'project', inputs: [input('a', 10, 1000, 4326), input('b', 10, 1000, 3857)], targetWkid: 32636 })], 7);
    expect(plan.admitted[0]?.targetWkid).toBe(32636);
  });

  it('rejects projection without a valid target', () => {
    expect(planArcGisGeometryWorkload([job({ operation: 'project' })], 7).rejected[0]?.reason).toBe('invalid-target-wkid');
  });

  it('rejects unexpected projection targets', () => {
    expect(planArcGisGeometryWorkload([job({ targetWkid: 3857 })], 7).rejected[0]?.reason).toBe('unexpected-target-wkid');
  });

  it('requires bounded buffer distance only for buffer jobs', () => {
    expect(planArcGisGeometryWorkload([job({ operation: 'buffer' })], 7).rejected[0]?.reason).toBe('invalid-buffer-distance');
    expect(planArcGisGeometryWorkload([job({ bufferDistance: 10 })], 7).rejected[0]?.reason).toBe('unexpected-buffer-distance');
  });

  it('requires bounded densification only for densify jobs', () => {
    expect(planArcGisGeometryWorkload([job({ operation: 'densify' })], 7).rejected[0]?.reason).toBe('invalid-densify-segments');
    expect(planArcGisGeometryWorkload([job({ densifySegments: 10 })], 7).rejected[0]?.reason).toBe('unexpected-densify-segments');
  });

  it('enforces per-geometry vertex budget', () => {
    const limits = { maxJobs: 5, maxInputGeometries: 5, maxVerticesPerGeometry: 9, maxTotalVertices: 100, maxEstimatedBytes: 10000, maxOutputVertices: 100, maxDensifySegments: 100, maxBufferDistance: 100 };
    expect(planArcGisGeometryWorkload([job()], 7, limits).rejected[0]?.reason).toBe('geometry-vertex-budget');
  });

  it('enforces aggregate vertex budget in deterministic order', () => {
    const limits = { maxJobs: 5, maxInputGeometries: 5, maxVerticesPerGeometry: 100, maxTotalVertices: 15, maxEstimatedBytes: 10000, maxOutputVertices: 100, maxDensifySegments: 100, maxBufferDistance: 100 };
    const plan = planArcGisGeometryWorkload([job({ id: 'low', priority: 1 }), job({ id: 'high', priority: 2 })], 7, limits);
    expect(plan.admitted[0]?.jobId).toBe('high');
    expect(plan.rejected[0]?.reason).toBe('aggregate-vertex-budget');
  });

  it('enforces aggregate byte budget', () => {
    const limits = { maxJobs: 5, maxInputGeometries: 5, maxVerticesPerGeometry: 100, maxTotalVertices: 100, maxEstimatedBytes: 1500, maxOutputVertices: 100, maxDensifySegments: 100, maxBufferDistance: 100 };
    const plan = planArcGisGeometryWorkload([job({ id: 'a' }), job({ id: 'b' })], 7, limits);
    expect(plan.rejected[0]?.reason).toBe('aggregate-byte-budget');
  });

  it('rejects output estimates over budget', () => {
    const limits = { maxJobs: 5, maxInputGeometries: 5, maxVerticesPerGeometry: 100, maxTotalVertices: 100, maxEstimatedBytes: 10000, maxOutputVertices: 20, maxDensifySegments: 100, maxBufferDistance: 100 };
    expect(planArcGisGeometryWorkload([job({ operation: 'buffer', bufferDistance: 1 })], 7, limits).rejected[0]?.reason).toBe('output-vertex-budget');
  });

  it('produces stable fingerprints for equivalent input orderings', () => {
    const first = planArcGisGeometryWorkload([job({ id: 'b' }), job({ id: 'a' })], 7);
    const second = planArcGisGeometryWorkload([job({ id: 'a' }), job({ id: 'b' })], 7);
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('returns immutable plan collections', () => {
    const plan = planArcGisGeometryWorkload([job()], 7);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.admitted)).toBe(true);
    expect(Object.isFrozen(plan.admitted[0]?.sourceWkids)).toBe(true);
  });

  it('fails closed for invalid limits', () => {
    expect(() => planArcGisGeometryWorkload([], 7, { maxJobs: 0, maxInputGeometries: 1, maxVerticesPerGeometry: 1, maxTotalVertices: 1, maxEstimatedBytes: 1, maxOutputVertices: 1, maxDensifySegments: 1, maxBufferDistance: 1 })).toThrow(/limits/);
  });

  it('fails closed for invalid expected revision', () => {
    expect(() => planArcGisGeometryWorkload([], -1)).toThrow(/revision/);
  });
});
