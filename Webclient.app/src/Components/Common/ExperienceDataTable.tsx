import type { ReactNode } from 'react';

export interface ExperienceColumn<Row> {
  readonly id: string;
  readonly header: string;
  readonly render: (row: Row) => ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: string;
}

export interface ExperienceDataTableProps<Row> {
  readonly caption: string;
  readonly columns: readonly ExperienceColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row, index: number) => string;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly busy?: boolean;
  readonly selectedKey?: string | null;
  readonly onRowActivate?: (row: Row) => void;
}

export function ExperienceDataTable<Row>({ caption, columns, rows, rowKey, emptyTitle = 'Kayıt bulunamadı', emptyDescription = 'Filtreleri değiştirerek yeniden deneyin.', busy = false, selectedKey, onRowActivate }: ExperienceDataTableProps<Row>) {
  return (
    <div className="kr-table-wrap" aria-busy={busy ? 'true' : undefined}>
      <table className="kr-table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map(column => <th key={column.id} scope="col" style={{ width: column.width }} data-align={column.align ?? 'start'}>{column.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, index);
            const active = selectedKey === key;
            return (
              <tr key={key} data-selected={active ? 'true' : undefined} onDoubleClick={onRowActivate ? () => onRowActivate(row) : undefined}>
                {columns.map((column, columnIndex) => (
                  <td key={column.id} data-align={column.align ?? 'start'}>
                    {columnIndex === 0 && onRowActivate ? <button type="button" className="kr-table__row-action" onClick={() => onRowActivate(row)} aria-current={active ? 'true' : undefined}>{column.render(row)}</button> : column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!busy && rows.length === 0 && <div className="kr-empty" role="status"><strong>{emptyTitle}</strong><span>{emptyDescription}</span></div>}
      {busy && <div className="kr-table__loading" role="status" aria-live="polite"><span className="kr-spinner" aria-hidden="true" />Veriler yükleniyor…</div>}
    </div>
  );
}

export default ExperienceDataTable;
