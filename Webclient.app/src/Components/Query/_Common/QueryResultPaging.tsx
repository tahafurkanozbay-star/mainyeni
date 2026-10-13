import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

export const QUERY_RESULT_PAGE_POLICY = Object.freeze({ minPageSize: 10, defaultPageSize: 60, maxPageSize: 200 });

export const normalizeQueryResultPageSize = (value: number): number => Number.isFinite(value)
  ? Math.min(QUERY_RESULT_PAGE_POLICY.maxPageSize, Math.max(QUERY_RESULT_PAGE_POLICY.minPageSize, Math.trunc(value)))
  : QUERY_RESULT_PAGE_POLICY.defaultPageSize;

export interface QuerySearchableRecord {
  readonly title: string;
  readonly address: string;
  readonly phone: string;
}

export const normalizeQueryResultText = (value: unknown): string => String(value ?? '')
  .trim()
  .toLocaleLowerCase('tr-TR')
  .replace(/ı/g, 'i')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '');

/** Normalized Turkish terms shared by service result filters. */
export const queryResultSearchTerms = (value: unknown): readonly string[] => {
  const normalized = normalizeQueryResultText(value);
  return normalized ? [...new Set(normalized.split(/\s+/).filter(Boolean))] : [];
};

export const matchesQueryResultTerms = (
  normalizedRecordText: string,
  terms: readonly string[],
): boolean => terms.every((term) => normalizedRecordText.includes(term));

/** Keeps the full response available to the map while bounding list DOM. */
export const useQueryResultPage = <RecordType extends QuerySearchableRecord,>(
  records: readonly RecordType[],
  pageSize: number,
) => {
  const normalizedPageSize = normalizeQueryResultPageSize(pageSize);
  const [filterText, setFilterValue] = useState('');
  const [page, setPage] = useState(0);
  const setFilterText = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    setFilterValue(value);
    setPage(0);
  }, []);
  const searchIndex = useMemo(() => records.map((record) => ({
    record,
    text: normalizeQueryResultText(record.title + ' ' + record.address + ' ' + record.phone),
  })), [records]);
  const filteredRecords = useMemo(() => {
    const terms = queryResultSearchTerms(filterText);
    if (!terms.length) return records;
    return searchIndex.filter((entry) => matchesQueryResultTerms(entry.text, terms))
      .map((entry) => entry.record);
  }, [filterText, records, searchIndex]);
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / normalizedPageSize));
  const currentPage = Math.min(Math.max(0, Math.trunc(page) || 0), pageCount - 1);
  const pageStart = currentPage * normalizedPageSize;
  const visibleRecords = useMemo(
    () => filteredRecords.slice(pageStart, pageStart + normalizedPageSize),
    [filteredRecords, normalizedPageSize, pageStart],
  );
  return { filterText, setFilterText, setPage, filteredRecords, visibleRecords, pageCount, currentPage, pageStart };
};

export interface QueryResultPaginationProps {
  readonly title: string;
  readonly listId: string;
  readonly page: number;
  readonly pageCount: number;
  readonly firstRecordIndex: number;
  readonly shown: number;
  readonly total: number;
  readonly onPageChange: (page: number) => void;
}

export const QueryResultPagination = ({
  title, listId, page, pageCount, firstRecordIndex, shown, total, onPageChange,
}: QueryResultPaginationProps) => total > 0 ? (
  <nav className="kr-fast-query__pagination" aria-label={title + ' sonuç sayfaları'}>
    <p aria-live="polite">{firstRecordIndex + 1}–{firstRecordIndex + shown} / {total} kayıt · Sayfa {page + 1}/{pageCount}</p>
    {pageCount > 1 ? <div>
      <button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 0} aria-controls={listId}>Önceki sayfa</button>
      <button type="button" onClick={() => onPageChange(page + 1)} disabled={page === pageCount - 1} aria-controls={listId}>Sonraki sayfa</button>
    </div> : null}
  </nav>
) : null;
