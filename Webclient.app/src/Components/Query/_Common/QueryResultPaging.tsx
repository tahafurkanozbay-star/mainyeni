import { useMemo, useState } from 'react';

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

/** Keeps the full response available to the map while bounding list DOM. */
export const useQueryResultPage = <RecordType extends QuerySearchableRecord,>(
  records: readonly RecordType[],
  pageSize: number,
) => {
  const [filterText, setFilterText] = useState('');
  const [page, setPage] = useState(0);
  const searchIndex = useMemo(() => records.map((record) => ({
    record,
    text: normalizeQueryResultText(record.title + ' ' + record.address + ' ' + record.phone),
  })), [records]);
  const filteredRecords = useMemo(() => {
    const needle = normalizeQueryResultText(filterText);
    return needle ? searchIndex.filter((entry) => entry.text.includes(needle)).map((entry) => entry.record) : records;
  }, [filterText, records, searchIndex]);
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * pageSize;
  const visibleRecords = useMemo(
    () => filteredRecords.slice(pageStart, pageStart + pageSize),
    [filteredRecords, pageSize, pageStart],
  );
  return { filterText, setFilterText, setPage, filteredRecords, visibleRecords, pageCount, currentPage, pageStart };
};

export interface QueryResultPaginationProps {
  readonly title: string;
  readonly listId: string;
  readonly page: number;
  readonly pageCount: number;
  readonly start: number;
  readonly shown: number;
  readonly total: number;
  readonly onPageChange: (page: number) => void;
}

export const QueryResultPagination = ({
  title, listId, page, pageCount, start, shown, total, onPageChange,
}: QueryResultPaginationProps) => total > 0 ? (
  <nav className="kr-fast-query__pagination" aria-label={title + ' sonuç sayfaları'}>
    <p aria-live="polite">{start + 1}–{start + shown} / {total} kayıt · Sayfa {page + 1}/{pageCount}</p>
    {pageCount > 1 ? <div>
      <button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 0} aria-controls={listId}>Önceki sayfa</button>
      <button type="button" onClick={() => onPageChange(page + 1)} disabled={page === pageCount - 1} aria-controls={listId}>Sonraki sayfa</button>
    </div> : null}
  </nav>
) : null;
