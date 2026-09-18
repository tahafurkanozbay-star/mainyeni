import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import './ExperiencePrimitives.css';

export type ExperienceColumnAlign = 'start' | 'center' | 'end';
export type ExperienceSortDirection = 'ascending' | 'descending' | 'none';

export interface ExperienceDataColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row, index: number) => ReactNode;
  readonly align?: ExperienceColumnAlign;
  readonly width?: string;
  readonly sortDirection?: ExperienceSortDirection;
  readonly onSort?: () => void;
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
  readonly onRowActivate?: (row: Row, index: number) => void;
  readonly getRowLabel?: (row: Row, index: number) => string;
  readonly stackOnCompact?: boolean;
  readonly className?: string;
}

const activationKey = (key: string): boolean => key === 'Enter' || key === ' ';

export function ExperienceDataTable<Row>({
  rows,
  columns,
  getRowKey,
  caption,
  emptyTitle = 'Sonuç bulunamadı',
  emptyDescription = 'Filtreleri değiştirip yeniden deneyin.',
  busy = false,
  busyLabel = 'Veriler yükleniyor',
  selectedRowKey = null,
  onRowActivate,
  getRowLabel,
  stackOnCompact = true,
  className = '',
}: ExperienceDataTableProps<Row>): ReactNode {
  if (busy) {
    return (
      <div
        className="experience-table-state"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="experience-table-state__spinner" aria-hidden="true" />
        <span>{busyLabel}</span>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="experience-table-state" role="status">
        <strong>{emptyTitle}</strong>
        <span>{emptyDescription}</span>
      </div>
    );
  }

  const activateFromKeyboard = (
    event: KeyboardEvent<HTMLTableRowElement>,
    row: Row,
    index: number,
  ): void => {
    if (!onRowActivate || !activationKey(event.key)) return;
    event.preventDefault();
    onRowActivate(row, index);
  };

  return (
    <div
      className={`experience-table-wrap ${className}`.trim()}
      role="region"
      aria-label={caption}
      tabIndex={0}
    >
      <table
        className="experience-data-table"
        data-stack-on-compact={stackOnCompact ? 'true' : 'false'}
      >
        <caption className="experience-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const style: CSSProperties | undefined = column.width
                ? { inlineSize: column.width }
                : undefined;
              return (
                <th
                  key={column.id}
                  scope="col"
                  data-align={column.align ?? 'start'}
                  aria-sort={column.onSort ? column.sortDirection ?? 'none' : undefined}
                  style={style}
                >
                  {column.onSort ? (
                    <button
                      type="button"
                      className="experience-data-table__sort"
                      onClick={column.onSort}
                    >
                      <span>{column.header}</span>
                      <span aria-hidden="true">
                        {column.sortDirection === 'ascending'
                          ? '↑'
                          : column.sortDirection === 'descending'
                            ? '↓'
                            : '↕'}
                      </span>
                    </button>
                  ) : column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = getRowKey(row, index);
            const selected = selectedRowKey === key;
            return (
              <tr
                key={key}
                data-selected={selected ? 'true' : undefined}
                tabIndex={onRowActivate ? 0 : undefined}
                onDoubleClick={onRowActivate ? () => onRowActivate(row, index) : undefined}
                onKeyDown={onRowActivate
                  ? (event) => activateFromKeyboard(event, row, index)
                  : undefined}
                aria-selected={onRowActivate ? selected : undefined}
                aria-label={getRowLabel?.(row, index)}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    data-label={typeof column.header === 'string' ? column.header : column.id}
                    data-align={column.align ?? 'start'}
                  >
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
