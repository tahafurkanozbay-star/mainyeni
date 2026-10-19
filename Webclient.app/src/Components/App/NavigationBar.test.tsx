import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationBar } from './NavigationBar';

const themeMocks = vi.hoisted(() => ({
  theme: 'light' as 'light' | 'dark',
  toggleTheme: vi.fn(),
}));

vi.mock('../Common/ExperienceDesignSystem', () => ({
  useExperienceTheme: () => ({
    theme: themeMocks.theme,
    preference: themeMocks.theme,
    setTheme: vi.fn(),
    toggleTheme: themeMocks.toggleTheme,
  }),
}));

const createAddressSearch = () => vi.fn(async (query: string, _signal: AbortSignal) => (
  query + ', Çankaya, Ankara'
));

const getSearchInput = (): HTMLInputElement => screen.getByRole('searchbox', {
  name: /adres.*cadde.*mahalle.*yer ara/i,
});

describe('NavigationBar', () => {
  beforeEach(() => {
    themeMocks.theme = 'light';
    themeMocks.toggleTheme.mockReset();
  });

  it('submits the trimmed address to the address geocoder instead of the legacy category query', async () => {
    const user = userEvent.setup();
    const onAddressSearch = createAddressSearch();
    render(<NavigationBar onAddressSearch={onAddressSearch} />);

    await user.type(getSearchInput(), '  Kızılay  ');
    await user.click(screen.getByRole('button', { name: 'Adres aramasını başlat' }));

    expect(onAddressSearch).toHaveBeenCalledTimes(1);
    expect(onAddressSearch.mock.calls[0]?.[0]).toBe('Kızılay');
    expect(onAddressSearch.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText('Bulundu: Kızılay, Çankaya, Ankara')).toBeInTheDocument();
    expect(screen.queryByText(/Kategori\s+\d+/i)).not.toBeInTheDocument();
  });

  it('does not submit whitespace-only input', async () => {
    const user = userEvent.setup();
    const onAddressSearch = createAddressSearch();
    render(<NavigationBar onAddressSearch={onAddressSearch} />);

    await user.type(getSearchInput(), '   ');
    expect(screen.getByRole('button', { name: 'Adres aramasını başlat' })).toBeDisabled();
    expect(onAddressSearch).not.toHaveBeenCalled();
  });

  it('clears search and releases focus with Escape', async () => {
    const user = userEvent.setup();
    render(<NavigationBar onAddressSearch={createAddressSearch()} />);
    const search = getSearchInput();

    await user.type(search, 'Ankara');
    expect(search).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
  });

  it('preserves search text and focus when Escape belongs to an active IME composition', () => {
    render(<NavigationBar onAddressSearch={createAddressSearch()} />);
    const search = getSearchInput();
    search.focus();
    fireEvent.change(search, { target: { value: 'Ankara' } });
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: 'Escape', isComposing: true });

    expect(search).toHaveValue('Ankara');
    expect(search).toHaveFocus();
    expect(screen.getByText('Metin girişi sürüyor.')).toBeInTheDocument();
  });

  it('does not wire slash as a global shortcut or steal it from another text field', async () => {
    const user = userEvent.setup();
    render(<NavigationBar onAddressSearch={createAddressSearch()} />);
    const search = getSearchInput();
    const other = document.createElement('input');
    other.setAttribute('aria-label', 'Yardımcı alan');
    document.body.appendChild(other);

    try {
      other.focus();
      await user.keyboard('/');
      expect(other).toHaveFocus();
      expect(search).not.toHaveFocus();
      expect(search).not.toHaveAttribute('aria-keyshortcuts');
    } finally {
      other.remove();
    }
  });

  it('exposes CBS Başkent as a safe external link', () => {
    const { container } = render(<NavigationBar onAddressSearch={createAddressSearch()} />);
    const cbsLink = container.querySelector<HTMLAnchorElement>('a.kr-header-portal');

    expect(cbsLink).not.toBeNull();
    expect(cbsLink?.getAttribute('aria-label')).toBe('CBS Başkent portalını yeni sekmede aç');
    expect(cbsLink?.getAttribute('href')).toBe('https://cbsbaskent.ankara.bel.tr/');
    expect(cbsLink?.getAttribute('target')).toBe('_blank');
    expect(new Set(cbsLink?.getAttribute('rel')?.trim().split(/\s+/))).toEqual(new Set(['noopener', 'noreferrer']));
  });

  it('places the accessible theme toggle in the top navigation with a clear action icon', () => {
    render(<NavigationBar onAddressSearch={createAddressSearch()} />);

    const themeButton = screen.getByRole('button', { name: 'Karanlık temaya geç' });
    expect(themeButton.querySelector('svg')).not.toBeNull();
    fireEvent.click(themeButton);
    expect(themeMocks.toggleTheme).toHaveBeenCalledTimes(1);
  });
});
