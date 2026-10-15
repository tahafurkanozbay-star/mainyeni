import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { matchesQueryResultTerms, queryResultSearchTerms, useQueryResultPage } from './QueryResultPaging';

const records = Array.from({ length: 1_000 }, (_, index) => ({ title: `Park ${index}`, address: 'Çankaya', phone: '' }));

describe('shared result page admission', () => {
  it('bounds the rendering window for excessive caller-supplied page sizes', () => {
    const { result } = renderHook(() => useQueryResultPage(records, Number.MAX_SAFE_INTEGER));
    expect(result.current.visibleRecords).toHaveLength(200);
    expect(result.current.filteredRecords).toHaveLength(1_000);
    expect(result.current.pageCount).toBe(5);
  });

  it('clamps invalid cursors and keeps the last data page reachable', () => {
    const { result } = renderHook(() => useQueryResultPage(records, 60));
    act(() => result.current.setPage(-100));
    expect(result.current.visibleRecords[0]?.title).toBe('Park 0');
    act(() => result.current.setPage(100_000));
    expect(result.current.visibleRecords.at(-1)?.title).toBe('Park 999');
    expect(result.current.visibleRecords).toHaveLength(40);
  });

  it('searches the full response from a later page without losing matching records', () => {
    const { result } = renderHook(() => useQueryResultPage(records, 60));
    act(() => result.current.setPage(10));
    act(() => result.current.setFilterText('Park 999'));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.visibleRecords).toEqual([records[999]]);
    act(() => result.current.setFilterText(''));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.visibleRecords[0]?.title).toBe('Park 0');
  });

  it('normalizes and deduplicates Turkish search words', () => {
    const terms = queryResultSearchTerms('  ÇANKAYA Park çankaya ');
    expect(terms).toEqual(['cankaya', 'park']);
    expect(matchesQueryResultTerms('park 42 cankaya', terms)).toBe(true);
    expect(matchesQueryResultTerms('park 42 kecioren', terms)).toBe(false);
    expect(queryResultSearchTerms('  ')).toEqual([]);
    expect(queryResultSearchTerms('ÇANKAYA, Park / Kızılay!')).toEqual(['cankaya', 'park', 'kizilay']);
    expect(queryResultSearchTerms('Park—999; Çankaya')).toEqual(['park', '999', 'cankaya']);
  });

  it('matches unordered Turkish words across title and address without fetching another page', () => {
    const { result } = renderHook(() => useQueryResultPage(records, 60));
    act(() => result.current.setPage(8));
    act(() => result.current.setFilterText('Çankaya, Park—999!'));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.filteredRecords).toEqual([records[999]]);
    act(() => result.current.setFilterText('park olmayan'));
    expect(result.current.filteredRecords).toHaveLength(0);
    expect(result.current.visibleRecords).toHaveLength(0);
  });
});
