import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExperienceDataTable } from './ExperienceDataTable';
import { ExperienceInput, ExperienceSelect } from './ExperienceForm';
import {
  ExperiencePagination,
  createPaginationWindow,
  normalizePage,
} from './ExperiencePagination';
import { ExperienceProgress, ExperienceStatus } from './ExperienceStatus';
import { ExperienceToolbar } from './ExperienceToolbar';

describe('Experience primitives', () => {
  it('connects input errors to the control', () => {
    render(<ExperienceInput label="Ad" error="Ad zorunludur" value="" readOnly />);
    const input = screen.getByLabelText('Ad');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Ad zorunludur');
  });

  it('connects select hints to the control', () => {
    render(
      <ExperienceSelect label="İlçe" hint="Bir ilçe seçin" defaultValue="">
        <option value="">Seçiniz</option>
        <option value="1">Çankaya</option>
      </ExperienceSelect>,
    );
    const select = screen.getByLabelText('İlçe');
    const describedBy = select.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe('Bir ilçe seçin');
  });

  it('announces assertive status content', () => {
    render(<ExperienceStatus tone="danger" live="assertive">İşlem başarısız</ExperienceStatus>);
    const status = screen.getByText('İşlem başarısız').closest('output');
    expect(status?.getAttribute('aria-live')).toBe('assertive');
    expect(status?.dataset.tone).toBe('danger');
  });

  it('bounds determinate progress values', () => {
    render(<ExperienceProgress label="İlerleme" value={150} max={100} />);
    const progress = screen.getByLabelText('İlerleme') as HTMLProgressElement;
    expect(progress.value).toBe(100);
    expect(progress.max).toBe(100);
  });

  it('renders an accessible indeterminate progressbar', () => {
    render(<ExperienceProgress label="Veri hazırlanıyor" />);
    const progress = screen.getByRole('progressbar', { name: 'Veri hazırlanıyor' });
    expect(progress.getAttribute('aria-valuetext')).toBe('İşlem sürüyor');
  });

  it('activates table rows from keyboard', () => {
    const onActivate = vi.fn();
    render(
      <ExperienceDataTable
        caption="Sonuçlar"
        rows={[{ id: 1, name: 'Park' }]}
        columns={[{ id: 'name', header: 'Ad', cell: (row) => row.name }]}
        getRowKey={(row) => row.id}
        onRowActivate={onActivate}
      />,
    );
    const row = screen.getByText('Park').closest('tr');
    expect(row).toBeTruthy();
    fireEvent.keyDown(row as HTMLTableRowElement, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('renders a useful empty table state', () => {
    render(
      <ExperienceDataTable
        caption="Boş sonuçlar"
        rows={[]}
        columns={[]}
        getRowKey={(_, index) => index}
      />,
    );
    expect(screen.getByText('Sonuç bulunamadı')).toBeTruthy();
  });

  it('moves toolbar focus while skipping disabled items', () => {
    render(
      <ExperienceToolbar
        label="Araçlar"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki', disabled: true },
          { id: 'three', label: 'Üç' },
        ]}
      />,
    );
    const first = screen.getByRole('button', { name: 'Bir' });
    const third = screen.getByRole('button', { name: 'Üç' });
    first.focus();
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(third);
  });

  it('activates toolbar items', () => {
    const activate = vi.fn();
    render(
      <ExperienceToolbar
        label="Araçlar"
        items={[{ id: 'one', label: 'Bir', onActivate: activate }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bir' }));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('normalizes out-of-range pages', () => {
    expect(normalizePage(0, 5)).toBe(1);
    expect(normalizePage(99, 5)).toBe(5);
    expect(normalizePage(Number.NaN, 5)).toBe(1);
  });

  it('builds a bounded pagination window', () => {
    expect(createPaginationWindow(50, 100, 1)).toEqual([1, 49, 50, 51, 100]);
  });

  it('changes pages with semantic controls', () => {
    const onPageChange = vi.fn();
    render(
      <ExperiencePagination page={2} pageCount={4} onPageChange={onPageChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
