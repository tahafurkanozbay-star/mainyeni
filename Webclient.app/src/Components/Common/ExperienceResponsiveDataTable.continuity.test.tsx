import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ExperienceResponsiveDataTable,
  type ExperienceResponsiveDataColumn,
} from './ExperienceResponsiveDataTable';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly district: string;
}

const rows: readonly Row[] = Object.freeze([
  Object.freeze({ id: '1', name: 'Kızılay', district: 'Çankaya' }),
]);

const createColumns = (
  nameCell: (row: Row) => React.ReactNode = (row) => row.name,
): readonly ExperienceResponsiveDataColumn<Row>[] => Object.freeze([
  Object.freeze({
    id: 'name',
    header: 'Durak adı',
    cell: nameCell,
    essential: true,
    priority: 0,
    minimumWidth: 160,
    preferredWidth: 260,
  }),
  Object.freeze({
    id: 'district',
    header: 'İlçe',
    cell: (row: Row) => row.district,
    priority: 1,
    minimumWidth: 120,
    preferredWidth: 180,
  }),
]);

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

const installBrowserFacts = (): void => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1280,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
};

const table = (columns: readonly ExperienceResponsiveDataColumn<Row>[]) => (
  <ExperienceResponsiveDataTable<Row>
    rows={rows}
    columns={columns}
    getRowKey={(row) => row.id}
    caption="Duraklar"
    pageSize={20}
  />
);

describe('ExperienceResponsiveDataTable projection continuity', () => {
  beforeEach(() => {
    installBrowserFacts();
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
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

  it('preserves density and user-hidden columns when equivalent column objects are recreated', () => {
    const { container, rerender } = render(table(createColumns()));

    fireEvent.click(screen.getByRole('button', { name: 'Sıkı' }));
    fireEvent.click(screen.getByText('Sütunlar'));
    fireEvent.click(screen.getByRole('checkbox', { name: /İlçe/i }));

    expect(container.querySelector('.experience-responsive-table')).toHaveAttribute('data-density', 'compact');
    expect(screen.queryByRole('columnheader', { name: 'İlçe' })).not.toBeInTheDocument();

    rerender(table(createColumns((row) => row.name)));

    expect(container.querySelector('.experience-responsive-table')).toHaveAttribute('data-density', 'compact');
    expect(screen.queryByRole('columnheader', { name: 'İlçe' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sütun görünümünü sıfırla' })).toBeInTheDocument();
  });

  it('uses fresh cell renderers while retaining the stable projection authority', () => {
    const { rerender } = render(table(createColumns()));
    expect(screen.getByText('Kızılay')).toBeInTheDocument();

    rerender(table(createColumns((row) => `${row.name} durağı`)));

    expect(screen.getByText('Kızılay durağı')).toBeInTheDocument();
    expect(screen.queryByText('Kızılay', { exact: true })).not.toBeInTheDocument();
  });
});
