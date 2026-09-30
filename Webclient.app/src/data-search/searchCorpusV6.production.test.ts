import { describe, expect, it } from 'vitest';
import type { NormalizedRecord } from './contracts';
import { normalizeRecordCollection } from './normalization';
import { SearchCorpusRuntimeV6 } from './searchCorpusRuntimeV6';

const baseRecords = (): readonly NormalizedRecord[] => normalizeRecordCollection([
  { id: '1', name: 'Çankaya Atatürk Parkı', category: 'Park', type: 'Kent Parkı', district: 'Çankaya', neighborhood: 'Kızılay' },
  { id: '2', name: 'Ulus Kültür Merkezi', category: 'Kültür', type: 'Kültür Merkezi', district: 'Altındağ', neighborhood: 'Ulus' },
  { id: '3', name: 'Etlik Şehir Hastanesi', category: 'Sağlık', type: 'Hastane', district: 'Keçiören', neighborhood: 'Etlik' },
]).records;

const normalized = (value: unknown): NormalizedRecord => {
  const result = normalizeRecordCollection([value]).records[0];
  if (!result) throw new Error('fixture normalization failed');
  return result;
};

describe('SearchCorpusRuntimeV6 production lifecycle', () => {
  it('builds an immutable initial snapshot', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const snapshot = runtime.snapshot();
    expect(snapshot.version).toBe(6);
    expect(snapshot.revision).toBe('rev-1');
    expect(snapshot.recordCount).toBe(3);
    expect(snapshot.fingerprint).toBeTruthy();
    expect(snapshot.engine.datasetRevision).toBe('rev-1');
  });

  it('serves queries through the active atomic engine', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const result = runtime.search({ query: 'hastane' });
    expect(result.hits[0]?.record.title).toBe('Etlik Şehir Hastanesi');
    expect(result.diagnostics.datasetRevision).toBe('rev-1');
  });

  it('serves suggestions through the active engine', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    expect(runtime.suggest('ulus').suggestions.some((suggestion) => suggestion.value.includes('Ulus'))).toBe(true);
  });

  it('commits an optimistic upsert atomically', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({
      expectedRevision: 'rev-1',
      nextRevision: 'rev-2',
      upserts: [normalized({ id: '4', name: 'Mamak Kültür Merkezi', category: 'Kültür', district: 'Mamak' })],
    });
    expect(decision.committed).toBe(true);
    expect(decision.reason).toBe('committed');
    expect(decision.previousRevision).toBe('rev-1');
    expect(decision.revision).toBe('rev-2');
    expect(decision.recordCount).toBe(4);
    expect(decision.upserted).toBe(1);
    expect(runtime.search({ query: 'mamak' }).hits[0]?.record.title).toBe('Mamak Kültür Merkezi');
  });

  it('replaces an existing identity through upsert', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({
      expectedRevision: 'rev-1',
      nextRevision: 'rev-2',
      upserts: [normalized({ id: '1', name: 'Çankaya Büyük Park', category: 'Park', district: 'Çankaya' })],
    });
    expect(decision.committed).toBe(true);
    expect(decision.recordCount).toBe(3);
    expect(runtime.search({ query: 'büyük park' }).hits[0]?.record.title).toBe('Çankaya Büyük Park');
    expect(runtime.search({ query: 'ataturk' }).hits).toHaveLength(0);
  });

  it('removes records by canonical corpus key', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({
      expectedRevision: 'rev-1',
      nextRevision: 'rev-2',
      removeKeys: ['id:2'],
    });
    expect(decision.committed).toBe(true);
    expect(decision.removed).toBe(1);
    expect(decision.recordCount).toBe(2);
    expect(runtime.search({ query: 'ulus' }).hits).toHaveLength(0);
  });

  it('can remove and upsert in one atomic revision', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({
      expectedRevision: 'rev-1',
      nextRevision: 'rev-2',
      removeKeys: ['id:2'],
      upserts: [normalized({ id: '4', name: 'Yeni Kültür Merkezi', category: 'Kültür', district: 'Çankaya' })],
    });
    expect(decision.committed).toBe(true);
    expect(decision.removed).toBe(1);
    expect(decision.upserted).toBe(1);
    expect(decision.recordCount).toBe(3);
    expect(runtime.search({ query: 'yeni kültür' }).hits).toHaveLength(1);
  });

  it('rejects stale expected revisions before mutation', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const before = runtime.snapshot().fingerprint;
    const decision = runtime.commit({
      expectedRevision: 'stale',
      nextRevision: 'rev-2',
      upserts: [normalized({ id: '4', name: 'Should Not Commit' })],
    });
    expect(decision.committed).toBe(false);
    expect(decision.reason).toBe('revision-conflict');
    expect(runtime.snapshot().fingerprint).toBe(before);
    expect(runtime.snapshot().revision).toBe('rev-1');
  });

  it('requires expected revision by default', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({
      nextRevision: 'rev-2',
      upserts: [normalized({ id: '4', name: 'No Expected Revision' })],
    });
    expect(decision.committed).toBe(false);
    expect(decision.reason).toBe('expected-revision-required');
  });

  it('can explicitly disable expected-revision requirement', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1', { requireExpectedRevision: false });
    const decision = runtime.commit({
      nextRevision: 'rev-2',
      upserts: [normalized({ id: '4', name: 'Accepted Record' })],
    });
    expect(decision.committed).toBe(true);
  });

  it('rejects blank next revisions', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({ expectedRevision: 'rev-1', nextRevision: '   ', removeKeys: ['id:1'] });
    expect(decision.reason).toBe('invalid-next-revision');
    expect(runtime.snapshot().recordCount).toBe(3);
  });

  it('rejects non-advancing revision identifiers', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-1', removeKeys: ['id:1'] });
    expect(decision.reason).toBe('revision-not-advanced');
  });

  it('rejects empty mutations', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2' });
    expect(decision.reason).toBe('empty-mutation');
  });

  it('rejects mutation batches above the hard policy budget', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1', { maximumMutationsPerCommit: 1 });
    const decision = runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2', removeKeys: ['id:1', 'id:2'] });
    expect(decision.reason).toBe('mutation-budget-exceeded');
    expect(runtime.snapshot().recordCount).toBe(3);
  });

  it('rejects duplicate identities within one upsert batch', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const decision = runtime.commit({
      expectedRevision: 'rev-1',
      nextRevision: 'rev-2',
      upserts: [
        normalized({ id: '4', name: 'First' }),
        normalized({ id: '4', name: 'Second' }),
      ],
    });
    expect(decision.reason).toBe('duplicate-upsert-key');
    expect(runtime.snapshot().recordCount).toBe(3);
  });

  it('rejects unknown remove keys without partial deletions', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const before = runtime.records().map((record) => record.id);
    const decision = runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2', removeKeys: ['id:1', 'id:missing'] });
    expect(decision.reason).toBe('unknown-remove-key');
    expect(runtime.records().map((record) => record.id)).toEqual(before);
  });

  it('rejects post-mutation corpus capacity overflow atomically', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1', { maximumRecords: 3 });
    const decision = runtime.commit({
      expectedRevision: 'rev-1',
      nextRevision: 'rev-2',
      upserts: [normalized({ id: '4', name: 'Overflow' })],
    });
    expect(decision.reason).toBe('record-capacity-exceeded');
    expect(runtime.snapshot().recordCount).toBe(3);
  });

  it('updates dataset revision seen by all subsequent query diagnostics', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2', removeKeys: ['id:2'] });
    const result = runtime.search({ query: 'park' });
    expect(result.diagnostics.datasetRevision).toBe('rev-2');
    expect(runtime.snapshot().engine.datasetRevision).toBe('rev-2');
  });

  it('changes corpus fingerprint after a successful commit', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    const before = runtime.snapshot().fingerprint;
    runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2', removeKeys: ['id:2'] });
    expect(runtime.snapshot().fingerprint).not.toBe(before);
  });

  it('retains bounded history', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1', { maximumHistory: 2 });
    runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2', removeKeys: ['id:1'] });
    runtime.commit({ expectedRevision: 'rev-2', nextRevision: 'rev-3', removeKeys: ['id:2'] });
    runtime.commit({ expectedRevision: 'rev-3', nextRevision: 'rev-4', removeKeys: ['id:3'] });
    expect(runtime.history()).toHaveLength(2);
    expect(runtime.history()[0]?.revision).toBe('rev-3');
    expect(runtime.history()[1]?.revision).toBe('rev-4');
  });

  it('can disable retained mutation history', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1', { maximumHistory: 0 });
    runtime.commit({ expectedRevision: 'rev-1', nextRevision: 'rev-2', removeKeys: ['id:1'] });
    expect(runtime.history()).toHaveLength(0);
    expect(runtime.snapshot().sequence).toBe(1);
  });

  it('records rejected decisions without changing active revision', () => {
    const runtime = new SearchCorpusRuntimeV6(baseRecords(), 'rev-1');
    runtime.commit({ expectedRevision: 'wrong', nextRevision: 'rev-2', removeKeys: ['id:1'] });
    expect(runtime.history()[0]?.reason).toBe('revision-conflict');
    expect(runtime.snapshot().revision).toBe('rev-1');
  });

  it('keeps returned records detached from mutation arrays', () => {
    const input = baseRecords();
    const runtime = new SearchCorpusRuntimeV6(input, 'rev-1');
    expect(runtime.records()).not.toBe(input);
    expect(runtime.records().map((record) => record.fingerprint)).toEqual(input.map((record) => record.fingerprint));
  });
});
