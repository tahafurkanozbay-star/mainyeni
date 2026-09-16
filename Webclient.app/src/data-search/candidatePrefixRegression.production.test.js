import {
  DataSearchRuntime,
  buildCandidateIndex,
  normalizeRecordCollection,
  planCandidates,
} from './index';

describe('candidate prefix regression', () => {
  const records = normalizeRecordCollection([
    { id: '1', title: 'Kuğulu Park', category: 'Park' },
    { id: '2', title: 'Seğmenler Parkı', category: 'Park' },
    { id: '3', title: 'Parkur Başlangıcı', category: 'Spor' },
    { id: '4', title: 'Müze', category: 'Müze' },
  ]).records;

  test('short token posting is a superset of exact and longer lexical forms', () => {
    const index = buildCandidateIndex(records);
    const plan = planCandidates(index, { query: 'park' });

    expect(plan.candidatePositions).toEqual([0, 1, 2]);
    expect(plan.tokenPostings[0].positions).toEqual([0, 1, 2]);
  });

  test('exact token no longer shadows prefix candidates in production search', () => {
    const runtime = new DataSearchRuntime();
    runtime.register('places', records.map(record => record.source));
    const response = runtime.search('places', { query: 'park', limit: 20 });

    expect(response.results.map(hit => hit.record.id)).toEqual(expect.arrayContaining(['1', '2', '3']));
    expect(response.diagnostics.candidateCount).toBe(3);
  });

  test('long query tokens beyond prefix budget still use exact postings', () => {
    const source = normalizeRecordCollection([
      { id: '1', title: 'abcdefghijklmnop' },
      { id: '2', title: 'abcdefghijklmnop-extra' },
    ]).records;
    const index = buildCandidateIndex(source, { maxPrefixLength: 8 });
    const plan = planCandidates(index, { query: 'abcdefghijklmnop' });

    expect(plan.candidatePositions).toEqual([0]);
  });

  test('unrelated records remain outside candidate set', () => {
    const index = buildCandidateIndex(records);
    const plan = planCandidates(index, { query: 'park' });

    expect(plan.candidatePositions).not.toContain(3);
  });
});
