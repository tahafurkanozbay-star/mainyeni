import { forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExperiencePagination, buildPaginationItems } from './ExperiencePagination';
import { ExperienceFilterBar } from './ExperienceFilterBar';
import { ExperienceQuerySurface } from './ExperienceQuerySurface';
import { ExperienceProgress, ExperienceStatus } from './ExperienceStatus';
import { ExperienceToolbar } from './ExperienceToolbar';
import { LazyManagedWindow } from './LazyManagedWindow';
import type { ManagedWindowHandle } from '../../Store/Managers/WindowManager';

describe('Experience pagination', () => {
  test('builds bounded pages with stable ellipsis positions', () => {
    expect(buildPaginationItems(1, 1)).toEqual([1]);
    expect(buildPaginationItems(1, 20, 1)).toEqual([1, 2, 'ellipsis-end', 20]);
    expect(buildPaginationItems(10, 20, 1)).toEqual([1, 'ellipsis-start', 9, 10, 11, 'ellipsis-end', 20]);
    expect(buildPaginationItems(20, 20, 1)).toEqual([1, 'ellipsis-start', 19, 20]);
  });

  test('clamps invalid inputs and only emits real page changes', () => {
    const changes: number[] = [];
    render(<ExperiencePagination page={Number.NaN} totalPages={3.9} onPageChange={(page) => changes.push(page)} />);
    expect(screen.getByRole('button', { name: '1. sayfa' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Önceki sayfa' }));
    expect(changes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '2. sayfa' }));
    expect(changes).toEqual([2]);
  });

  test('disables all navigation when requested', () => {
    render(<ExperiencePagination page={2} totalPages={4} onPageChange={() => undefined} disabled />);
    screen.getAllByRole('button').forEach((button) => expect(button).toBeDisabled());
  });
});

describe('Experience filter bar', () => {
  test('announces search, supports clear and renders removable active filters', () => {
    const searchChanges: string[] = [];
    const removed: string[] = [];
    render(
      <ExperienceFilterBar
        searchValue="park"
        onSearchChange={(value) => searchChanges.push(value)}
        filters={[{ id: 'district', label: 'İlçe', value: 'Çankaya', onRemove: () => removed.push('district') }]}
        onClearAll={() => removed.push('all')}
      />,
    );
    expect(screen.getByRole('region', { name: 'Filtreler' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aramayı temizle' }));
    expect(searchChanges).toEqual(['']);
    fireEvent.click(screen.getByRole('button', { name: 'İlçe filtresini kaldır' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tümünü temizle' }));
    expect(removed).toEqual(['district', 'all']);
  });
});

describe('Experience status and progress', () => {
  test('uses alert semantics only for assertive status', () => {
    const { rerender } = render(<ExperienceStatus title="Bilgi" tone="info" live="polite">Hazır</ExperienceStatus>);
    expect(screen.getByRole('status')).toHaveTextContent('Hazır');
    rerender(<ExperienceStatus title="Hata" tone="danger" live="assertive">Başarısız</ExperienceStatus>);
    expect(screen.getByRole('alert')).toHaveTextContent('Başarısız');
  });

  test('bounds determinate progress and keeps indeterminate ARIA valid', () => {
    const { rerender } = render(<ExperienceProgress label="Yükleniyor" value={150} max={100} />);
    const progress = screen.getByRole('progressbar', { name: 'Yükleniyor' });
    expect(progress).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
    rerender(<ExperienceProgress label="Bekleniyor" max={0} />);
    const indeterminate = screen.getByRole('progressbar', { name: 'Bekleniyor' });
    expect(indeterminate).not.toHaveAttribute('aria-valuenow');
    expect(indeterminate).not.toHaveAttribute('aria-valuemax');
  });
});

describe('Experience toolbar', () => {
  const renderToolbar = (): void => {
    render(
      <ExperienceToolbar
        label="Harita işlemleri"
        actions={[
          { id: 'disabled', label: 'Devre dışı', disabled: true, onActivate: () => undefined },
          { id: 'first', label: 'İlk', onActivate: () => undefined },
          { id: 'second', label: 'İkinci', pressed: true, onActivate: () => undefined },
        ]}
      />,
    );
  };

  test('makes the first enabled action the single tab stop', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Devre dışı' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'İlk' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: 'İkinci' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'İkinci' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('supports arrow, Home and End focus navigation across enabled actions', () => {
    renderToolbar();
    const first = screen.getByRole('button', { name: 'İlk' });
    const second = screen.getByRole('button', { name: 'İkinci' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'Home' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(second).toHaveFocus();
  });
});

describe('Experience query surface', () => {
  test('connects heading/description semantics and exposes busy state', () => {
    render(
      <ExperienceQuerySurface title="Parklar" description="Kent genelindeki park sonuçları" count={1234} busy status={{ tone: 'info', title: 'Güncelleniyor', live: 'polite' }}>
        <div>Sonuçlar</div>
      </ExperienceQuerySurface>,
    );
    const region = screen.getByRole('region', { name: 'Parklar' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAccessibleDescription('Kent genelindeki park sonuçları');
    expect(screen.getByLabelText('1234 kayıt')).toHaveTextContent('1.234');
    expect(screen.getByRole('status')).toHaveTextContent('Güncelleniyor');
  });
});

interface ManagedFixtureProps {
  readonly id: string;
  readonly marker?: string;
  readonly windowManager: unknown;
}

const ManagedFixture = forwardRef<ManagedWindowHandle, ManagedFixtureProps>(({ id, marker }, ref): ReactNode => {
  useImperativeHandle(ref, () => ({ id }), [id]);
  return <section aria-label="Test penceresi"><button type="button" data-window-autofocus>{marker ?? id}</button></section>;
});
ManagedFixture.displayName = 'ManagedFixture';

describe('LazyManagedWindow', () => {
  test('registers placeholders and protects lifecycle props from caller overrides', async () => {
    const registrations: string[] = [];
    let visible = true;
    const manager = {
      RegisterPlaceholder: (id: string) => { registrations.push(id); return true; },
      UnregisterWindow: () => true,
      IsVisible: () => visible,
    };
    render(
      <LazyManagedWindow
        id="parks-window"
        component={ManagedFixture}
        windowManager={manager}
        componentProps={{ id: 'malicious-id', marker: 'Gerçek pencere', windowManager: 'malicious-manager' }}
      />,
    );
    expect(registrations).toEqual(['parks-window']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Gerçek pencere' })).toHaveFocus());
    visible = false;
  });

  test('restores focus to the invoking control when the managed window closes', async () => {
    let visible = false;
    const manager = {
      RegisterPlaceholder: () => true,
      UnregisterWindow: () => true,
      IsVisible: () => visible,
    };
    const opener = document.createElement('button');
    opener.textContent = 'Açıcı';
    document.body.append(opener);
    opener.focus();

    const view = render(<LazyManagedWindow id="focus-window" component={ManagedFixture} windowManager={manager} />);
    visible = true;
    view.rerender(<LazyManagedWindow id="focus-window" component={ManagedFixture} windowManager={manager} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'focus-window' })).toHaveFocus());

    visible = false;
    view.rerender(<LazyManagedWindow id="focus-window" component={ManagedFixture} windowManager={manager} />);
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});
