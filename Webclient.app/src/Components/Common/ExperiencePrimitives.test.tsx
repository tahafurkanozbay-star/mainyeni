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
    const progress = screen.getByLabelText('Veri hazırlanıyor') as HTMLProgressElement;
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

  it('uses vertical arrow semantics when toolbar orientation is vertical', () => {
    render(
      <ExperienceToolbar
        label="Dikey araçlar"
        orientation="vertical"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
          { id: 'three', label: 'Üç' },
        ]}
      />,
    );
    const first = screen.getByRole('button', { name: 'Bir' });
    const second = screen.getByRole('button', { name: 'İki' });
    first.focus();
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(screen.getByRole('toolbar').getAttribute('aria-orientation')).toBe('vertical');
  });

  it('wraps toolbar focus and supports Home and End', () => {
    render(
      <ExperienceToolbar
        label="Araçlar"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'two', label: 'İki' },
          { id: 'three', label: 'Üç' },
        ]}
      />,
    );
    const toolbar = screen.getByRole('toolbar');
    const first = screen.getByRole('button', { name: 'Bir' });
    const third = screen.getByRole('button', { name: 'Üç' });
    first.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(toolbar, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(third);
  });

  it('treats busy toolbar items as disabled roving targets', () => {
    render(
      <ExperienceToolbar
        label="Araçlar"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'busy', label: 'Konum bulunuyor', busy: true },
          { id: 'three', label: 'Üç' },
        ]}
      />,
    );
    const busy = screen.getByRole('button', { name: 'Konum bulunuyor' });
    expect(busy).toBeDisabled();
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.tabIndex).toBe(-1);
    const first = screen.getByRole('button', { name: 'Bir' });
    const third = screen.getByRole('button', { name: 'Üç' });
    first.focus();
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(third);
  });

  it('renders group boundaries as semantic separators without adding tab stops', () => {
    render(
      <ExperienceToolbar
        label="Gruplu araçlar"
        orientation="vertical"
        items={[
          { id: 'one', label: 'Bir', group: 'primary', groupLabel: 'Birincil araçlar' },
          { id: 'two', label: 'İki', group: 'primary' },
          { id: 'three', label: 'Üç', group: 'secondary', groupLabel: 'İkincil araçlar' },
        ]}
      />,
    );
    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.getAttribute('aria-orientation')).toBe('horizontal');
    expect(separators[0]?.getAttribute('data-group-start')).toBe('secondary');
    expect(screen.getByText('Birincil araçlar')).toBeTruthy();
    expect(screen.getByText('İkincil araçlar')).toBeTruthy();
  });

  it('omits hidden toolbar items from both rendering and focus navigation', () => {
    render(
      <ExperienceToolbar
        label="Araçlar"
        items={[
          { id: 'one', label: 'Bir' },
          { id: 'hidden', label: 'Gizli', hidden: true },
          { id: 'three', label: 'Üç' },
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Gizli' })).toBeNull();
    const first = screen.getByRole('button', { name: 'Bir' });
    const third = screen.getByRole('button', { name: 'Üç' });
    first.focus();
    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(third);
  });

  it('exposes stable id, description, tooltip and keyboard shortcut metadata', () => {
    render(
      <>
        <p id="toolbar-help">Ok tuşlarıyla araçlar arasında ilerleyin.</p>
        <ExperienceToolbar
          id="map-toolbar"
          describedBy="toolbar-help"
          label="Harita araçları"
          items={[
            {
              id: 'home',
              label: 'Başlangıç görünümü',
              tooltip: 'Haritayı başlangıca döndür',
              ariaKeyShortcuts: 'Home',
            },
          ]}
        />
      </>,
    );
    const toolbar = screen.getByRole('toolbar', { name: 'Harita araçları' });
    expect(toolbar.id).toBe('map-toolbar');
    expect(toolbar.getAttribute('aria-describedby')).toBe('toolbar-help');
    const button = screen.getByRole('button', { name: 'Başlangıç görünümü' });
    expect(button.getAttribute('data-tooltip')).toBe('Haritayı başlangıca döndür');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Home');
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
