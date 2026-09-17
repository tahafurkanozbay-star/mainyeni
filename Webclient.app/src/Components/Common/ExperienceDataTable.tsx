import { type CSSProperties, type ReactNode } from 'react';

export interface ExperienceColumn<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: string;
}

export interface ExperienceDataTableProps<Row> {
  readonly caption: string;
  readonly columns: readonly ExperienceColumn<Row>[];
  readonly rows: readonly Row[];
  readonly getRowKey: (row: Row, index: number) => string;
  readonly emptyMessage?: string;
  readonly selectedRowKey?: string;
  readonly onRowActivate?: (row: Row) => void;
}

const getColumnStyle = <Row,>(column: ExperienceColumn<Row>): CSSProperties => ({
  ...(column.width ? { width: column.width } : {}),
  ...(column.align ? { textAlign: column.align } : {}),
});

export const ExperienceDataTable = <Row,>({ caption, columns, rows, getRowKey, emptyMessage = 'Kayıt bulunamadı', selectedRowKey, onRowActivate }: ExperienceDataTableProps<Row>): ReactNode => (
  <div className="experience-table-region" role="region" aria-label={caption} tabIndex={0}>
    <table className="experience-table">
      <caption className="experience-sr-only">{caption}</caption>
      <thead><tr>{columns.map((column) => <th key={column.key} scope="col" style={getColumnStyle(column)}>{column.header}</th>)}</tr></thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={Math.max(columns.length, 1)} className="experience-table__empty">{emptyMessage}</td></tr> : rows.map((row, index) => {
          const key = getRowKey(row, index);
          const selected = key === selectedRowKey;
          return (
            <tr key={key} aria-selected={selected || undefined} className={selected ? 'experience-table__row--selected' : undefined} onDoubleClick={onRowActivate ? () => onRowActivate(row) : undefined}>
              {columns.map((column, columnIndex) => (
                <td key={column.key} style={getColumnStyle(column)}>
                  {columnIndex === 0 && onRowActivate ? <button type="button" className="experience-table__row-action" onClick={() => onRowActivate(row)}>{column.cell(row)}</button> : column.cell(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
