import { describe, expect, it } from 'vitest';
import { normalizeRecord } from './normalization';
import {
  reconcileSearchReplicas,
  selectQuorumRecords,
  summarizeReplicaConflicts,
} from './searchReplicaReconciler';

const normalized = (id: string, overrides: Record<string, unknown> = {}) => {
  const value = normalizeRecord({
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
  if (!value) throw new Error('failed to normalize test record');
  return value;
};

describe('searchReplicaReconciler production contract', () => {
  it('selects the highest-priority source as canonical', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'fallback', priority: 100, records: [normalized('1', { title: 'Fallback' })] },
      { key: 'primary', priority: 1, records: [normalized('1', { title: 'Primary' })] },
    ], { quorum: 1 });

    expect(reconciliation.records).toHaveLength(1);
    expect(reconciliation.records[0]?.canonicalSourceKey).toBe('primary');
    expect(reconciliation.records[0]?.record.title).toBe('Primary');
  });

  it('marks identical replicas as quorum-consistent', () => {
    const shared = normalized('1');
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [shared] },
      { key: 'b', records: [shared] },
      { key: 'c', records: [shared] },
    ], { quorum: 2 });

    expect(reconciliation.quorumMetCount).toBe(1);
    expect(reconciliation.conflictCount).toBe(0);
    expect(reconciliation.records[0]?.agreeingSources).toEqual(['a', 'b', 'c']);
    expect(selectQuorumRecords(reconciliation)).toEqual([shared]);
  });

  it('detects fingerprint and title conflicts', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', priority: 1, records: [normalized('1', { title: 'Alpha' })] },
      { key: 'b', priority: 2, records: [normalized('1', { title: 'Beta' })] },
    ], { quorum: 2 });

    const summary = summarizeReplicaConflicts(reconciliation);
    expect(summary['fingerprint-mismatch']).toBe(1);
    expect(summary['title-mismatch']).toBe(1);
    expect(reconciliation.records[0]?.quorumMet).toBe(false);
  });

  it('detects category and type drift independently', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { category: 'Park', type: 'Green' })] },
      { key: 'b', records: [normalized('1', { category: 'School', type: 'Education' })] },
    ], { quorum: 1 });
    const summary = summarizeReplicaConflicts(reconciliation);
    expect(summary['category-mismatch']).toBe(1);
    expect(summary['type-mismatch']).toBe(1);
  });

  it('detects address drift without treating it as a hard coordinate conflict', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { address: 'A Street 1' })] },
      { key: 'b', records: [normalized('1', { address: 'B Street 1' })] },
    ], { quorum: 1 });
    const summary = summarizeReplicaConflicts(reconciliation);
    expect(summary['address-mismatch']).toBe(1);
    expect(summary['coordinate-divergence']).toBe(0);
  });

  it('accepts coordinates inside the configured tolerance', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { latitude: 39.92000, longitude: 32.85000 })] },
      { key: 'b', records: [normalized('1', { latitude: 39.92001, longitude: 32.85001 })] },
    ], { quorum: 1, coordinateToleranceMeters: 10 });
    expect(summarizeReplicaConflicts(reconciliation)['coordinate-divergence']).toBe(0);
  });

  it('flags coordinates that exceed tolerance as an error conflict', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { latitude: 39.92, longitude: 32.85 })] },
      { key: 'b', records: [normalized('1', { latitude: 40.00, longitude: 33.00 })] },
    ], { quorum: 1, coordinateToleranceMeters: 50 });
    const conflict = reconciliation.conflicts.find(item => item.kind === 'coordinate-divergence');
    expect(conflict?.severity).toBe('error');
    expect(reconciliation.records[0]?.quorumMet).toBe(false);
  });

  it('optionally reports records missing from some replicas', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1'), normalized('2')] },
      { key: 'b', records: [normalized('1')] },
      { key: 'c', records: [normalized('1')] },
    ], { includeMissingSourceConflicts: true, quorum: 1 });

    const missing = reconciliation.conflicts.find(item => item.kind === 'missing-from-source' && item.recordKey === 'id:2');
    expect(missing).toBeDefined();
    expect(missing?.detail).toContain('b');
    expect(missing?.detail).toContain('c');
  });

  it('does not create missing-source diagnostics unless requested', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1'), normalized('2')] },
      { key: 'b', records: [normalized('1')] },
    ]);
    expect(summarizeReplicaConflicts(reconciliation)['missing-from-source']).toBe(0);
  });

  it('deduplicates duplicate stable keys inside one source', () => {
    const first = normalized('1', { title: 'First' });
    const second = normalized('1', { title: 'Second' });
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [first, second] },
    ], { quorum: 1 });

    expect(reconciliation.recordCount).toBe(1);
    expect(reconciliation.records[0]?.record.title).toBe('First');
  });

  it('normalizes source identities and rejects duplicates after normalization', () => {
    expect(() => reconcileSearchReplicas([
      { key: 'Primary Source', records: [] },
      { key: 'primary-source', records: [] },
    ])).toThrowError(/Duplicate replica source key/);
  });

  it('enforces the record cardinality budget', () => {
    expect(() => reconcileSearchReplicas([
      { key: 'a', records: [normalized('1'), normalized('2')] },
    ], { maxRecords: 1 })).toThrowError(/record budget/);
  });

  it('bounds the global conflict materialization list', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { title: 'A', category: 'A', type: 'A' })] },
      { key: 'b', records: [normalized('1', { title: 'B', category: 'B', type: 'B' })] },
    ], { maxConflicts: 2, quorum: 1 });

    expect(reconciliation.conflicts).toHaveLength(2);
    expect(reconciliation.conflictTruncated).toBe(true);
    expect(reconciliation.records[0]?.conflicts.length).toBeGreaterThan(2);
  });

  it('preserves per-record conflicts even when global conflict history is truncated', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { title: 'A', address: 'A' })] },
      { key: 'b', records: [normalized('1', { title: 'B', address: 'B' })] },
    ], { maxConflicts: 1, quorum: 1 });

    expect(reconciliation.conflicts).toHaveLength(1);
    expect(reconciliation.records[0]?.conflicts.length).toBeGreaterThan(1);
  });

  it('returns only quorum-safe records from selectQuorumRecords', () => {
    const shared = normalized('1');
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [shared, normalized('2', { title: 'A' })] },
      { key: 'b', records: [shared, normalized('2', { title: 'B' })] },
    ], { quorum: 2 });

    expect(selectQuorumRecords(reconciliation).map(item => item.id)).toEqual(['1']);
  });

  it('is deterministic regardless of source input order', () => {
    const a = { key: 'a', priority: 1, records: [normalized('1')] };
    const b = { key: 'b', priority: 2, records: [normalized('1')] };
    const first = reconcileSearchReplicas([a, b], { quorum: 2 });
    const second = reconcileSearchReplicas([b, a], { quorum: 2 });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.records.map(item => item.canonicalSourceKey)).toEqual(second.records.map(item => item.canonicalSourceKey));
  });

  it('does not include raw source payloads in reconciliation diagnostics', () => {
    const reconciliation = reconcileSearchReplicas([
      { key: 'a', records: [normalized('1', { secret: 'never-log-this' })] },
    ], { quorum: 1 });
    const diagnostics = {
      conflicts: reconciliation.conflicts,
      conflictCount: reconciliation.conflictCount,
      conflictRecordCount: reconciliation.conflictRecordCount,
      fingerprint: reconciliation.fingerprint,
    };
    expect(JSON.stringify(diagnostics)).not.toContain('never-log-this');
  });

  it('produces an immutable conflict summary with every known conflict kind', () => {
    const reconciliation = reconcileSearchReplicas([{ key: 'a', records: [] }]);
    expect(summarizeReplicaConflicts(reconciliation)).toEqual({
      'fingerprint-mismatch': 0,
      'title-mismatch': 0,
      'category-mismatch': 0,
      'type-mismatch': 0,
      'address-mismatch': 0,
      'coordinate-divergence': 0,
      'missing-from-source': 0,
    });
  });
});