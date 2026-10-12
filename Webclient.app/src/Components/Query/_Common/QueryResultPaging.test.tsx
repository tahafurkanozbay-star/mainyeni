import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useQueryResultPage } from './QueryResultPaging';

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
  });
});
