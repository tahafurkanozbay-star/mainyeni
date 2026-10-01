import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ExperienceResponsiveDataTable,
  type ExperienceResponsiveDataColumn,
} from './ExperienceResponsiveDataTable';

interface Row {
  readonly id: string;
  readonly no: string;
  readonly name: string;
  readonly type: string;
  readonly district: string;
}

const rows: readonly Row[] = Object.freeze([
  { id: '1', no: '1001', name: 'Kızılay', type: 'Merkez', district: 'Çankaya' },
  { id: '2', no: '1002', name: 'Ulus', type: 'Aktarma', district: 'Altındağ' },
]);

const columns: readonly ExperienceResponsiveDataColumn<Row>[] = Object.freeze([
  {
    id: 'no',
    header: 'Durak no',
    cell: (row: Row) => row.no,
    essential: true,
    priority: 0,
    minimumWidth: 96,
    preferredWidth: 120,
  },
  {
    id: 'name',
    header: 'Durak adı',
    cell: (row: Row) => row.name,
    essential: true,
    priority: 1,
    minimumWidth: 160,
    preferredWidth: 260,
  },
  {
    id: 'type',
    header: 'Tür',
    cell: (row: Row) => row.type,
    priority: 2,
    hideOnPhone: true,
    minimumWidth: 96,
    preferredWidth: 140,
  },
  {
    id: 'district',
    header: 'İlçe',
    cell: (row: Row) => row.district,
    priority: 3,
    minimumWidth: 110,
    preferredWidth: 160,
  },
]);

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

const installMatchMedia = (matchesByQuery: Readonly<Record<string, boolean>> = {}): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: matchesByQuery[query] === true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
};

const setWidth = (value: number): void => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value,
  });
};

const renderTable = (overrides: Partial<React.ComponentProps<typeof ExperienceResponsiveDataTable<Row>>> = {}) => render(
  <ExperienceResponsiveDataTable<Row>
    rows={rows}
    columns={columns}
    getRowKey={(row) => row.id}
    caption="Duraklar"
    description="Kent içi durak sonuçları"
    pageSize={20}
    {...overrides}
  />,
);

describe('ExperienceResponsiveDataTable', () => {
  beforeEach(() => {
    setWidth(1280);
    installMatchMedia();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    setWidth(originalInnerWidth);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: originalScrollIntoView,
    });
  });

  it('renders the existing managed semantic table through the responsive adapter', () => {
    renderTable();
    expect(screen.getByRole('heading', { name: 'Duraklar' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Duraklar' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Durak no' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Durak adı' })).toBeInTheDocument();
    expect(screen.getByText('Kızılay')).toBeInTheDocument();
  });

  it('exposes deterministic projection metadata on the wrapper', () => {
    const { container } = renderTable();
    const root = container.querySelector('.experience-responsive-table');
    expect(root).toHaveAttribute('data-viewport', 'desktop');
    expect(root).toHaveAttribute('data-density', 'comfortable');
    expect(screen.getByLabelText('Tablo görünümü')).toHaveTextContent('4/4 sütun');
  });

  it('switches density without recreating row data', () => {
    const { container } = renderTable();
    fireEvent.click(screen.getByRole('button', { name: 'Sıkı' }));
    expect(container.querySelector('.experience-responsive-table')).toHaveAttribute('data-density', 'compact');
    expect(screen.getByText('Kızılay')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rahat' }));
    expect(container.querySelector('.experience-responsive-table')).toHaveAttribute('data-density', 'comfortable');
  });

  it('allows optional columns to be hidden and reset', () => {
    renderTable();
    fireEvent.click(screen.getByText('Sütunlar'));
    const district = screen.getByRole('checkbox', { name: /İlçe/i });
    expect(district).toBeChecked();
    fireEvent.click(district);
    expect(screen.queryByRole('columnheader', { name: 'İlçe' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sütun görünümünü sıfırla' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sütun görünümünü sıfırla' }));
    expect(screen.getByRole('columnheader', { name: 'İlçe' })).toBeInTheDocument();
  });

  it('prevents essential columns from being hidden', () => {
    renderTable();
    fireEvent.click(screen.getByText('Sütunlar'));
    expect(screen.getByRole('checkbox', { name: /Durak no/i })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Durak adı/i })).toBeDisabled();
  });

  it('automatically reduces columns for narrow viewport startup', () => {
    setWidth(390);
    renderTable();
    expect(screen.getByRole('columnheader', { name: 'Durak no' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Durak adı' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Tür' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tablo görünümü')).toHaveTextContent('2/4 sütun');
  });

  it('announces hidden columns for assistive technology', () => {
    setWidth(390);
    renderTable();
    expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(/gizli sütunlar/i);
  });

  it('propagates coarse pointer, reduced motion and forced-colors facts', () => {
    installMatchMedia({
      '(pointer: coarse)': true,
      '(prefers-reduced-motion: reduce)': true,
      '(forced-colors: active)': true,
    });
    const { container } = renderTable();
    const root = container.querySelector('.experience-responsive-table');
    expect(root).toHaveAttribute('data-coarse-pointer', 'true');
    expect(root).toHaveAttribute('data-reduced-motion', 'true');
    expect(root).toHaveAttribute('data-forced-colors', 'true');
  });

  it('forwards row activation to the existing data-table authority', () => {
    const onRowActivate = vi.fn();
    renderTable({ onRowActivate, selectionMode: 'none' });
    fireEvent.click(screen.getByText('Kızılay').closest('tr') as HTMLTableRowElement);
    expect(onRowActivate).toHaveBeenCalledWith(rows[0], 0);
  });

  it('forwards selection state without inventing a second selection model', () => {
    const onSelectionChange = vi.fn();
    renderTable({ selectionMode: 'multiple', onSelectionChange });
    fireEvent.click(screen.getByText('Kızılay').closest('tr') as HTMLTableRowElement);
    expect(onSelectionChange).toHaveBeenCalledWith(['1']);
  });

  it('preserves sort callbacks and aria-sort semantics after projection', () => {
    const onSort = vi.fn();
    const sortable = columns.map((column) => column.id === 'name'
      ? { ...column, sortDirection: 'ascending' as const, onSort }
      : column);
    renderTable({ columns: sortable });
    const header = screen.getByRole('columnheader', { name: /Durak adı sütununu sırala/i });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Durak adı sütununu sırala' }));
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it('forwards busy presentation', () => {
    renderTable({ busy: true, busyLabel: 'Duraklar yenileniyor' });
    expect(screen.getByRole('status')).toHaveTextContent('Duraklar yenileniyor');
  });

  it('forwards empty presentation', () => {
    renderTable({ rows: [], emptyTitle: 'Durak yok', emptyDescription: 'Başka bir arama deneyin.' });
    expect(screen.getByText('Durak yok')).toBeInTheDocument();
    expect(screen.getByText('Başka bir arama deneyin.')).toBeInTheDocument();
  });

  it('can suppress view controls for fixed-layout consumers', () => {
    renderTable({ allowColumnChooser: false, allowDensityControl: false });
    expect(screen.queryByLabelText('Tablo görünüm araçları')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Duraklar' })).toBeInTheDocument();
  });

  it('uses the caller projection status label', () => {
    renderTable({ projectionStatusLabel: 'Durak sütun görünümü' });
    expect(screen.getByLabelText('Durak sütun görünümü')).toBeInTheDocument();
  });
});
