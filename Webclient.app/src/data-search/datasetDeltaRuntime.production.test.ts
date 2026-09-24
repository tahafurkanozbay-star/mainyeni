import { describe, expect, it } from 'vitest';
import {
  compareNormalizedDatasets,
  createDatasetDeltaRuntime,
  createDatasetSchemaBaseline,
  datasetRecordKey,
} from './datasetDeltaRuntime';
import { normalizeRecordCollection } from './normalization';

const record = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Place ${id}`,
  category: 'service',
  type: 'municipal',
  address: `Address ${id}`,
  district: 'Çankaya',
  latitude: 39.92,
  longitude: 32.85,
  ...overrides,
});

describe('DatasetDeltaRuntime production contract', () => {
  it('normalizes initial records and exposes a stable revision snapshot', () => {
    const runtime = createDatasetDeltaRuntime([record('2'), record('1')], { datasetKey: 'Places' });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.datasetKey).toBe('places');
    expect(snapshot.revision).toBe(1);
    expect(snapshot.recordCount).toBe(2);
    expect(snapshot.fingerprint).toMatch(/^fnv1a-/);
    expect(runtime.getRecords().map(item => item.id)).toEqual(['1', '2']);
  });

  it('applies inserts atomically and increments revision once', () => {
    const runtime = createDatasetDeltaRuntime([record('1')]);
    const commit = runtime.apply({ expectedRevision: 1, upserts: [record('2'), record('3')] });
    expect(commit.accepted).toBe(true);
    expect(commit.changed).toBe(true);
    expect(commit.insertCount).toBe(2);
    expect(commit.nextRevision).toBe(2);
    expect(runtime.getSnapshot().revision).toBe(2);
    expect(runtime.getRecords()).toHaveLength(3);
  });

  it('updates existing stable IDs without duplicating records', () => {
    const runtime = createDatasetDeltaRuntime([record('1')]);
    const commit = runtime.apply({
      expectedRevision: 1,
      upserts: [record('1', { title: 'Updated title' })],
    });
    expect(commit.updateCount).toBe(1);
    expect(commit.insertCount).toBe(0);
    expect(runtime.getRecords()).toHaveLength(1);
    expect(runtime.getRecord('1')?.title).toBe('Updated title');
  });

  it('removes records by bare id and canonical id key', () => {
    const runtime = createDatasetDeltaRuntime([record('1'), record('2'), record('3')]);
    const first = runtime.apply({ removeKeys: ['1'] });
    expect(first.removeCount).toBe(1);
    const second = runtime.apply({ removeKeys: ['id:2'] });
    expect(second.removeCount).toBe(1);
    expect(runtime.getRecords().map(item => item.id)).toEqual(['3']);
  });

  it('reports no-op removes without changing revision', () => {
    const runtime = createDatasetDeltaRuntime([record('1')]);
    const commit = runtime.apply({ removeKeys: ['missing'] });
    expect(commit.changed).toBe(false);
    expect(commit.noopCount).toBe(1);
    expect(commit.currentRevision).toBe(1);
    expect(commit.nextRevision).toBe(1);
    expect(runtime.getSnapshot().revision).toBe(1);
  });

  it('fails closed on optimistic revision mismatch and leaves data untouched', () => {
    const runtime = createDatasetDeltaRuntime([record('1')]);
    const before = runtime.getSnapshot();
    const preview = runtime.preview({ expectedRevision: 999, upserts: [record('2')] });
    expect(preview.accepted).toBe(false);
    expect(preview.rejectionReasons.join(' ')).toContain('Revision mismatch');
    expect(() => runtime.apply({ expectedRevision: 999, upserts: [record('2')] })).toThrowError(/Revision mismatch/);
    expect(runtime.getSnapshot().fingerprint).toBe(before.fingerprint);
    expect(runtime.getRecords()).toHaveLength(1);
  });

  it('enforces bounded batch size before mutating state', () => {
    const runtime = createDatasetDeltaRuntime([record('1')], { maxBatchOperations: 2 });
    const mutation = { upserts: [record('2'), record('3')], removeKeys: ['1'] };
    expect(runtime.preview(mutation).accepted).toBe(false);
    expect(() => runtime.apply(mutation)).toThrowError(/Batch operation count/);
    expect(runtime.getRecords().map(item => item.id)).toEqual(['1']);
  });

  it('enforces bounded dataset capacity', () => {
    const runtime = createDatasetDeltaRuntime([record('1'), record('2')], { maxRecords: 2 });
    const preview = runtime.preview({ upserts: [record('3')] });
    expect(preview.accepted).toBe(false);
    expect(preview.rejectionReasons.join(' ')).toContain('bounded capacity');
    expect(() => runtime.apply({ upserts: [record('3')] })).toThrowError(/bounded capacity/);
    expect(runtime.getRecords()).toHaveLength(2);
  });

  it('rejects breaking schema drift by default', () => {
    const runtime = createDatasetDeltaRuntime([
      { id: '1', title: 'A', stableRequiredField: 'required' },
      { id: '2', title: 'B', stableRequiredField: 'required' },
    ]);
    const preview = runtime.preview({
      removeKeys: ['1', '2'],
      upserts: [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' },
      ],
    });
    expect(preview.schemaCompatibility).toBe('breaking');
    expect(preview.accepted).toBe(false);
    expect(preview.schemaReport.removedFields).toContain('stablerequiredfield');
  });

  it('can explicitly warn instead of rejecting schema drift', () => {
    const runtime = createDatasetDeltaRuntime([
      { id: '1', title: 'A', stableRequiredField: 'required' },
      { id: '2', title: 'B', stableRequiredField: 'required' },
    ], { schemaEnforcement: 'warn' });
    const commit = runtime.apply({
      removeKeys: ['1', '2'],
      upserts: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }],
    });
    expect(commit.accepted).toBe(true);
    expect(commit.schemaCompatibility).toBe('breaking');
    expect(runtime.getRecords()).toHaveLength(2);
  });

  it('supports stricter reject-warning enforcement', () => {
    const runtime = createDatasetDeltaRuntime([
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ], { schemaEnforcement: 'reject-warning' });
    const preview = runtime.preview({ upserts: [{ id: '3', title: 'C', optionalNew: 'x' }] });
    expect(['warning', 'compatible']).toContain(preview.schemaCompatibility);
    if (preview.schemaReport.warningCount > 0) expect(preview.accepted).toBe(false);
  });

  it('deduplicates repeated raw upserts by normalized record fingerprint', () => {
    const runtime = createDatasetDeltaRuntime([]);
    const preview = runtime.preview({ upserts: [record('1'), record('1')] });
    expect(preview.duplicateMutationCount).toBeGreaterThanOrEqual(1);
    expect(preview.afterCount).toBe(1);
  });

  it('uses fingerprint keys when source data has no stable id', () => {
    const runtime = createDatasetDeltaRuntime([
      { title: 'No id', category: 'park', latitude: 39.9, longitude: 32.8 },
    ]);
    const first = runtime.getRecords()[0];
    expect(first).toBeDefined();
    expect(datasetRecordKey(first!)).toMatch(/^fp:fnv1a-/);
    expect(runtime.getRecord(datasetRecordKey(first!))?.title).toBe('No id');
  });

  it('keeps preview side-effect free', () => {
    const runtime = createDatasetDeltaRuntime([record('1')]);
    const before = runtime.getSnapshot();
    const preview = runtime.preview({ upserts: [record('2')] });
    expect(preview.changed).toBe(true);
    expect(runtime.getSnapshot()).toEqual(before);
    expect(runtime.getRecords()).toHaveLength(1);
  });

  it('bounds commit history while preserving counters', () => {
    let now = 100;
    const runtime = createDatasetDeltaRuntime([], { historySize: 2, clock: () => ++now, schemaEnforcement: 'warn' });
    runtime.apply({ upserts: [record('1')] });
    runtime.apply({ upserts: [record('2')] });
    runtime.apply({ upserts: [record('3')] });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.commits).toBe(3);
    expect(snapshot.updatedAt).toBeGreaterThan(snapshot.createdAt);
  });

  it('returns the same commit for an immediately repeated identical mutation', () => {
    const runtime = createDatasetDeltaRuntime([], { schemaEnforcement: 'warn' });
    const mutation = { upserts: [record('1')], metadata: { requestId: 'abc' } } as const;
    const first = runtime.apply(mutation);
    const second = runtime.apply(mutation);
    expect(second).toBe(first);
    expect(runtime.getSnapshot().commits).toBe(1);
  });

  it('replaceAll removes stale records and installs the candidate atomically', () => {
    const runtime = createDatasetDeltaRuntime([record('1'), record('2')], { schemaEnforcement: 'warn' });
    const commit = runtime.replaceAll([record('3'), record('4')], 1, { reason: 'refresh' });
    expect(commit.removeCount).toBe(2);
    expect(commit.insertCount).toBe(2);
    expect(commit.metadata).toEqual({ reason: 'refresh' });
    expect(runtime.getRecords().map(item => item.id)).toEqual(['3', '4']);
  });

  it('compares normalized datasets deterministically', () => {
    const left = normalizeRecordCollection([record('1'), record('2')]).records;
    const right = normalizeRecordCollection([
      record('2', { title: 'Changed' }),
      record('3'),
    ]).records;
    const diff = compareNormalizedDatasets(left, right, 5, 6);
    expect(diff.leftRevision).toBe(5);
    expect(diff.rightRevision).toBe(6);
    expect(diff.insertedKeys).toEqual(['id:3']);
    expect(diff.removedKeys).toEqual(['id:1']);
    expect(diff.changedKeys).toEqual(['id:2']);
    expect(diff.unchangedKeys).toEqual([]);
    expect(diff.fingerprint).toMatch(/^fnv1a-/);
  });

  it('creates a reusable schema baseline from raw records', () => {
    const baseline = createDatasetSchemaBaseline([
      record('1'),
      record('2', { extra: 'value' }),
    ]);
    expect(baseline.sampledCount).toBe(2);
    expect(baseline.fieldCount).toBeGreaterThan(0);
    expect(baseline.fingerprint).toMatch(/^fnv1a-/);
  });

  it('records rejected mutations without incrementing committed count', () => {
    const runtime = createDatasetDeltaRuntime([record('1')]);
    expect(() => runtime.apply({ expectedRevision: 2, upserts: [record('2')] })).toThrow();
    const snapshot = runtime.getSnapshot();
    expect(snapshot.rejectedMutations).toBe(1);
    expect(snapshot.commits).toBe(0);
    expect(snapshot.revision).toBe(1);
  });
});
