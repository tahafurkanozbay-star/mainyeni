import type { ReactNode } from 'react';

export interface ExperienceDataColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: string;
}

export interface ExperienceDataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly ExperienceDataColumn<Row>[];
  readonly getRowKey: (row: Row, index: number) => string | number;
  readonly caption: string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly selectedRowKey?: string | number | null;
  readonly onRowActivate?: (row: Row) => void;
}

export function ExperienceDataTable<Row>({ rows, columns, getRowKey, caption, emptyTitle = 'Sonuç bulunamadı', emptyDescription = 'Filtreleri değiştirip yeniden deneyin.', busy = false, busyLabel = 'Veriler yükleniyor', selectedRowKey = null, onRowActivate }: ExperienceDataTableProps<Row>): ReactNode {
  if (busy) return <div className="experience-table-state" role="status" aria-live="polite" aria-busy="true"><span className="experience-table-state__spinner" aria-hidden="true" /><span>{busyLabel}</span></div>;
  if (rows.length === 0) return <div className="experience-table-state"><strong>{emptyTitle}</strong><span>{emptyDescription}</span></div>;
  return <div className="experience-table-wrap" role="region" aria-label={caption} tabIndex={0}><table className="experience-data-table"><caption className="experience-sr-only">{caption}</caption><thead><tr>{columns.map(column => <th key={column.id} scope="col" data-align={column.align ?? 'start'} style={column.width ? { width: column.width } : undefined}>{column.header}</th>)}</tr></thead><tbody>{rows.map((row, index) => { const key = getRowKey(row, index); const selected = selectedRowKey === key; return <tr key={key} data-selected={selected || undefined} tabIndex={onRowActivate ? 0 : undefined} onDoubleClick={onRowActivate ? () => onRowActivate(row) : undefined} onKeyDown={onRowActivate ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowActivate(row); } } : undefined} aria-selected={onRowActivate ? selected : undefined}>{columns.map(column => <td key={column.id} data-label={typeof column.header === 'string' ? column.header : column.id} data-align={column.align ?? 'start'}>{column.cell(row)}</td>)}</tr>; })}</tbody></table></div>;
}
