import { describe, expect, it } from 'vitest';
import { ArcGisExportJobCoordinator, type ArcGisExportPolicy } from './ArcGisExportJobCoordinator';

const policy: ArcGisExportPolicy = {
  maxJobs: 2,
  maxIdLength: 32,
  maxTitleLength: 64,
  maxResultTokenLength: 80,
  maxFailureCodeLength: 40,
  maxWidthPx: 4096,
  maxHeightPx: 4096,
  maxPixelCount: 8_000_000,
  minDpi: 72,
  maxDpi: 300,
  retentionMs: 1_000,
  maxClockSkewMs: 10,
};

const extent = { xmin: 0, ymin: 0, xmax: 100, ymax: 100, wkid: 3857 } as const;

function create(coordinator: ArcGisExportJobCoordinator, id: string, now: number) {
  return coordinator.create({ id, title: `Export ${id}`, format: 'pdf', viewMode: '2d', extent, widthPx: 1000, heightPx: 800, dpi: 96 }, now);
}

describe('ArcGisExportJobCoordinator', () => {
  it('tracks a bounded export lifecycle without retaining runtime objects', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    expect(create(coordinator, 'a', 100).status).toBe('queued');
    expect(coordinator.transition('a', 'running', 110).revision).toBe(2);
    const completed = coordinator.transition('a', 'completed', 120, { resultToken: 'same-origin-result-1' });
    expect(completed.status).toBe('completed');
    expect(completed.resultToken).toBe('same-origin-result-1');
    expect(completed.failureCode).toBeNull();
    expect(coordinator.snapshot(120).activeId).toBe('a');
  });

  it('supports failure and cancellation terminal states', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'failed', 1);
    coordinator.transition('failed', 'running', 2);
    expect(coordinator.transition('failed', 'failed', 3, { failureCode: 'PRINT_TIMEOUT' }).failureCode).toBe('PRINT_TIMEOUT');
    create(coordinator, 'cancelled', 4);
    expect(coordinator.transition('cancelled', 'cancelled', 5).status).toBe('cancelled');
  });

  it('rejects invalid lifecycle transitions and terminal payload mixing', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'a', 1);
    expect(() => coordinator.transition('a', 'completed', 2, { resultToken: 'x' })).toThrow(/invalid export transition/);
    coordinator.transition('a', 'running', 2);
    expect(() => coordinator.transition('a', 'completed', 3, { resultToken: 'x', failureCode: 'bad' })).toThrow(/failure code/);
  });

  it('rejects missing result and failure terminal payloads', () => {
    const first = new ArcGisExportJobCoordinator(policy);
    create(first, 'a', 1);
    first.transition('a', 'running', 2);
    expect(() => first.transition('a', 'completed', 3)).toThrow(/resultToken/);
    const second = new ArcGisExportJobCoordinator(policy);
    create(second, 'b', 1);
    second.transition('b', 'running', 2);
    expect(() => second.transition('b', 'failed', 3)).toThrow(/failureCode/);
  });

  it('enforces dimensions, pixel budget and dpi', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    const base = { id: 'a', title: 'A', format: 'png' as const, viewMode: '2d' as const, extent };
    expect(() => coordinator.create({ ...base, widthPx: 5000, heightPx: 10, dpi: 96 }, 1)).toThrow(/widthPx/);
    expect(() => coordinator.create({ ...base, widthPx: 3000, heightPx: 3000, dpi: 96 }, 1)).toThrow(/pixel budget/);
    expect(() => coordinator.create({ ...base, widthPx: 100, heightPx: 100, dpi: 600 }, 1)).toThrow(/dpi/);
  });

  it('rejects malformed extents and wkids', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    const base = { id: 'a', title: 'A', format: 'png' as const, viewMode: '2d' as const, widthPx: 100, heightPx: 100, dpi: 96 };
    expect(() => coordinator.create({ ...base, extent: { xmin: 1, ymin: 0, xmax: 1, ymax: 2, wkid: 3857 } }, 1)).toThrow(/extent/);
    expect(() => coordinator.create({ ...base, extent: { xmin: 0, ymin: 0, xmax: 1, ymax: 2, wkid: 0 } }, 1)).toThrow(/wkid/);
  });

  it('rejects unsafe text identities and duplicate ids', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'a', 1);
    expect(() => create(coordinator, 'a', 2)).toThrow(/already exists/);
    expect(() => create(coordinator, 'bad\0id', 2)).toThrow(/bounds/);
  });

  it('evicts terminal jobs before active work when capacity is exceeded', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'old-terminal', 1);
    coordinator.transition('old-terminal', 'running', 2);
    coordinator.transition('old-terminal', 'completed', 3, { resultToken: 'r' });
    create(coordinator, 'active', 4);
    coordinator.transition('active', 'running', 5);
    create(coordinator, 'new', 6);
    const ids = coordinator.snapshot(6).jobs.map(job => job.id);
    expect(ids).toEqual(['active', 'new']);
  });

  it('prunes terminal jobs after retention while preserving running jobs', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'done', 1);
    coordinator.transition('done', 'running', 2);
    coordinator.transition('done', 'completed', 3, { resultToken: 'r' });
    create(coordinator, 'running', 4);
    coordinator.transition('running', 'running', 5);
    expect(coordinator.snapshot(1_004).jobs.map(job => job.id)).toEqual(['running']);
  });

  it('allows retention boundary exactly at configured duration', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'done', 1);
    coordinator.transition('done', 'running', 2);
    coordinator.transition('done', 'completed', 3, { resultToken: 'r' });
    expect(coordinator.snapshot(1_003).jobs).toHaveLength(1);
  });

  it('rejects stale lifecycle mutations beyond clock skew', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'a', 100);
    coordinator.transition('a', 'running', 200);
    expect(() => coordinator.transition('a', 'cancelled', 180)).toThrow(/stale/);
  });

  it('returns deeply immutable snapshots', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'a', 1);
    const snapshot = coordinator.snapshot(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.jobs)).toBe(true);
    expect(Object.isFrozen(snapshot.jobs[0])).toBe(true);
    expect(Object.isFrozen(snapshot.jobs[0]?.extent)).toBe(true);
  });

  it('restores valid completed state atomically', () => {
    const source = new ArcGisExportJobCoordinator(policy);
    create(source, 'a', 1);
    source.transition('a', 'running', 2);
    source.transition('a', 'completed', 3, { resultToken: 'r' });
    const target = new ArcGisExportJobCoordinator(policy);
    target.restore(source.snapshot(3), 3);
    expect(target.snapshot(3).jobs[0]?.status).toBe('completed');
  });

  it('rejects duplicate restore ids without mutating current state', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'stable', 1);
    const job = coordinator.snapshot(1).jobs[0]!;
    expect(() => coordinator.restore({ activeId: null, jobs: [job, job] }, 2)).toThrow(/duplicate/);
    expect(coordinator.snapshot(2).jobs.map(value => value.id)).toEqual(['stable']);
  });

  it('rejects future and inverted restore timestamps atomically', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'stable', 1);
    const job = coordinator.snapshot(1).jobs[0]!;
    expect(() => coordinator.restore({ activeId: null, jobs: [{ ...job, updatedAtMs: 100 }] }, 2)).toThrow(/future/);
    expect(() => coordinator.restore({ activeId: null, jobs: [{ ...job, createdAtMs: 10, updatedAtMs: 5 }] }, 10)).toThrow(/precedes/);
    expect(coordinator.snapshot(10).jobs[0]?.id).toBe('stable');
  });

  it('rejects dangling active ids during restore', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    expect(() => coordinator.restore({ activeId: 'missing', jobs: [] }, 1)).toThrow(/active export is missing/);
  });

  it('removes and activates known jobs deterministically', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'a', 1);
    create(coordinator, 'b', 2);
    expect(coordinator.activate('a', 3).id).toBe('a');
    expect(coordinator.snapshot(3).activeId).toBe('a');
    expect(coordinator.remove('a')).toBe(true);
    expect(coordinator.snapshot(3).activeId).toBeNull();
    expect(coordinator.remove('a')).toBe(false);
  });

  it('fails closed after disposal', () => {
    const coordinator = new ArcGisExportJobCoordinator(policy);
    create(coordinator, 'a', 1);
    coordinator.dispose();
    coordinator.dispose();
    expect(() => coordinator.snapshot(2)).toThrow(/disposed/);
    expect(() => create(coordinator, 'b', 2)).toThrow(/disposed/);
  });
});
