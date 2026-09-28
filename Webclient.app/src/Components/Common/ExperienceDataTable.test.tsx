import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ExperienceDataTable,
  type ExperienceDataColumn,
} from './ExperienceDataTable';

vi.mock('../../platform/runtime/runtimeDiagnostics', () => ({
  runtimeDiagnostics: {
    captureError: vi.fn(),
    record: vi.fn(),
  },
}));

interface Row {
  readonly id: string;
  readonly name: string;
  readonly district: string;
  readonly score: number;
}

const rows: readonly Row[] = [
  { id: 'ankara-1', name: 'Gençlik Parkı', district: 'Altındağ', score: 93 },
  { id: 'ankara-2', name: 'Seğmenler Parkı', district: 'Çankaya', score: 89 },
  { id: 'ankara-3', name: 'Göksu Parkı', district: 'Etimesgut', score: 84 },
  { id: 'ankara-4', name: 'Mavi Göl', district: 'Mamak', score: 81 },
];

const columns = (onSort?: () => void): readonly ExperienceDataColumn<Row>[] => [
  {
    id: 'name',
    header: 'Ad',
    cell: (row) => row.name,
    sortDirection: onSort ? 'ascending' : undefined,
    onSort,
  },
  {
    id: 'district',
    header: 'İlçe',
    cell: (row) => row.district,
  },
  {
    id: 'score',
    header: 'Puan',
    cell: (row) => row.score,
    align: 'end',
    width: '6rem',
  },
];

const renderTable = (overrides: Partial<React.ComponentProps<typeof ExperienceDataTable<Row>>> = {}) => render(
  <ExperienceDataTable<Row>
    rows={rows}
    columns={columns()}
    getRowKey={(row) => row.id}
    caption="Park sonuçları"
    description="Kent rehberi park sonuçları"
    getRowLabel={(row) => `${row.name}, ${row.district}`}
    {...overrides}
  />,
);

const bodyRows = (container: HTMLElement): HTMLTableRowElement[] =>
  Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr'));

const activeRows = (container: HTMLElement): HTMLTableRowElement[] =>
  bodyRows(container).filter((row) => row.tabIndex === 0);

describe('ExperienceDataTable', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('renders semantic table metadata, caption and bounded count', () => {
    const { container } = renderTable();

    const region = screen.getByRole('region', { name: 'Park sonuçları tablosu' });
    const table = within(region).getByRole('table', { name: 'Park sonuçları' });
    expect(table).toHaveAttribute('aria-rowcount', '5');
    expect(screen.getByRole('heading', { name: 'Park sonuçları' })).toBeInTheDocument();
    expect(screen.getByText('Kent rehberi park sonuçları')).toBeInTheDocument();
    expect(screen.getByText('4 kayıt')).toBeInTheDocument();
    expect(bodyRows(container)).toHaveLength(4);
  });

  test('keeps exactly one roving row tab stop after initialization', () => {
    const { container } = renderTable({ onRowActivate: vi.fn() });

    expect(activeRows(container)).toHaveLength(1);
    expect(activeRows(container)[0]).toHaveTextContent('Gençlik Parkı');
    expect(bodyRows(container).slice(1).every((row) => row.tabIndex === -1)).toBe(true);
  });

  test('moves active focus with ArrowDown and ArrowUp', () => {
    const { container } = renderTable({ onRowActivate: vi.fn() });
    const first = activeRows(container)[0];
    expect(first).toBeDefined();

    first?.focus();
    fireEvent.keyDown(first as HTMLTableRowElement, { key: 'ArrowDown' });

    const afterDown = activeRows(container)[0];
    expect(afterDown).toHaveTextContent('Seğmenler Parkı');
    expect(document.activeElement).toBe(afterDown);

    fireEvent.keyDown(afterDown as HTMLTableRowElement, { key: 'ArrowUp' });
    const afterUp = activeRows(container)[0];
    expect(afterUp).toHaveTextContent('Gençlik Parkı');
    expect(document.activeElement).toBe(afterUp);
  });

  test('moves to first and last records with Ctrl+Home and Ctrl+End', () => {
    const { container } = renderTable({ onRowActivate: vi.fn() });
    const first = activeRows(container)[0] as HTMLTableRowElement;

    fireEvent.keyDown(first, { key: 'End', ctrlKey: true });
    expect(activeRows(container)[0]).toHaveTextContent('Mavi Göl');

    fireEvent.keyDown(activeRows(container)[0] as HTMLTableRowElement, {
      key: 'Home',
      ctrlKey: true,
    });
    expect(activeRows(container)[0]).toHaveTextContent('Gençlik Parkı');
  });

  test('activates the focused row with Enter without introducing duplicate tab stops', () => {
    const activate = vi.fn();
    const { container } = renderTable({ onRowActivate: activate });
    const first = activeRows(container)[0] as HTMLTableRowElement;

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = activeRows(container)[0] as HTMLTableRowElement;
    fireEvent.keyDown(second, { key: 'Enter' });

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(rows[1], 1);
    expect(activeRows(container)).toHaveLength(1);
    expect(second).toHaveAttribute('aria-selected', 'true');
  });

  test('activates a row with pointer input and exposes its accessible label', () => {
    const activate = vi.fn();
    const { container } = renderTable({ onRowActivate: activate });
    const second = bodyRows(container)[1] as HTMLTableRowElement;

    expect(second).toHaveAttribute('aria-label', 'Seğmenler Parkı, Çankaya');
    fireEvent.click(second);

    expect(activate).toHaveBeenCalledWith(rows[1], 1);
    expect(second).toHaveAttribute('data-selected', 'true');
  });

  test('synchronizes controlled single selection without changing source row order', () => {
    const { container, rerender } = render(
      <ExperienceDataTable<Row>
        rows={rows}
        columns={columns()}
        getRowKey={(row) => row.id}
        caption="Park sonuçları"
        selectedRowKey="ankara-2"
      />,
    );

    expect(bodyRows(container)[1]).toHaveAttribute('aria-selected', 'true');

    rerender(
      <ExperienceDataTable<Row>
        rows={rows}
        columns={columns()}
        getRowKey={(row) => row.id}
        caption="Park sonuçları"
        selectedRowKey="ankara-4"
      />,
    );

    expect(bodyRows(container)[1]).toHaveAttribute('aria-selected', 'false');
    expect(bodyRows(container)[3]).toHaveAttribute('aria-selected', 'true');
    expect(bodyRows(container).map((row) => row.textContent)).toEqual([
      expect.stringContaining('Gençlik Parkı'),
      expect.stringContaining('Seğmenler Parkı'),
      expect.stringContaining('Göksu Parkı'),
      expect.stringContaining('Mavi Göl'),
    ]);
  });

  test('supports controlled multiple selection and announces the selected count', () => {
    const { container } = renderTable({
      selectionMode: 'multiple',
      selectedRowKeys: ['ankara-1', 'ankara-3'],
    });

    expect(bodyRows(container)[0]).toHaveAttribute('aria-selected', 'true');
    expect(bodyRows(container)[1]).toHaveAttribute('aria-selected', 'false');
    expect(bodyRows(container)[2]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('4 kayıt · 2 seçili')).toBeInTheDocument();
  });

  test('Ctrl+A selects visible rows and Escape clears the internal selection', () => {
    const onSelectionChange = vi.fn();
    const { container } = renderTable({
      selectionMode: 'multiple',
      onSelectionChange,
    });
    const first = activeRows(container)[0] as HTMLTableRowElement;

    fireEvent.keyDown(first, { key: 'a', ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      'ankara-1',
      'ankara-2',
      'ankara-3',
      'ankara-4',
    ]);
    expect(screen.getByText('4 kayıt · 4 seçili')).toBeInTheDocument();

    fireEvent.keyDown(activeRows(container)[0] as HTMLTableRowElement, { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByText('4 kayıt')).toBeInTheDocument();
  });

  test('paginates without dropping total row semantics', () => {
    const { container } = renderTable({ pageSize: 2, onRowActivate: vi.fn() });
    const pager = screen.getByRole('navigation', { name: 'Park sonuçları sayfalama' });

    expect(bodyRows(container)).toHaveLength(2);
    expect(within(pager).getByText('Sayfa', { exact: false })).toHaveTextContent('Sayfa 1 / 2');
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '5');

    fireEvent.click(within(pager).getByRole('button', { name: 'Sonraki' }));

    expect(bodyRows(container)).toHaveLength(2);
    expect(bodyRows(container)[0]).toHaveTextContent('Göksu Parkı');
    expect(within(pager).getByText('Sayfa', { exact: false })).toHaveTextContent('Sayfa 2 / 2');
    expect(within(pager).getByRole('button', { name: 'Sonraki' })).toBeDisabled();
    expect(within(pager).getByRole('button', { name: 'Önceki' })).not.toBeDisabled();
    expect(activeRows(container)).toHaveLength(1);
    expect(activeRows(container)[0]).toHaveTextContent('Göksu Parkı');
  });

  test('preserves external sorting callback and aria-sort contract', () => {
    const onSort = vi.fn();
    renderTable({ columns: columns(onSort) });

    const sortButton = screen.getByRole('button', { name: 'Ad sütununu sırala' });
    const header = sortButton.closest('th');
    expect(header).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(sortButton);
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  test('renders stable empty state without an empty table shell', () => {
    const { container } = renderTable({
      rows: [],
      emptyTitle: 'Kayıt bulunamadı',
      emptyDescription: 'Arama ölçütünü değiştirin.',
    });

    expect(screen.getByRole('status')).toHaveTextContent('Kayıt bulunamadı');
    expect(screen.getByRole('status')).toHaveTextContent('Arama ölçütünü değiştirin.');
    expect(container.querySelector('table')).toBeNull();
  });

  test('renders busy state with polite live semantics and custom label', () => {
    const { container } = renderTable({
      busy: true,
      busyLabel: 'Park verileri hazırlanıyor',
    });

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Park verileri hazırlanıyor');
    expect(container.querySelector('table')).toBeNull();
  });

  test('keeps responsive stacking opt-out explicit for dense desktop tables', () => {
    renderTable({ stackOnCompact: false });
    expect(screen.getByRole('table')).toHaveAttribute('data-stack-on-compact', 'false');
  });

  test('describes the table region with visible description and keyboard instructions', () => {
    renderTable({ selectionMode: 'multiple' });
    const region = screen.getByRole('region', { name: 'Park sonuçları tablosu' });
    const describedBy = region.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(/\s+/).filter(Boolean);

    expect(ids).toHaveLength(2);
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Kent rehberi park sonuçları',
      expect.stringContaining('Ctrl+A görünür kayıtları seçer'),
    ]);
  });
});
