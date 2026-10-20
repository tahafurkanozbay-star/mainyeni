import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationBar } from './NavigationBar';
import type { AddressGeocodingResult } from '../../data-services/addressGeocoding';

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

const createAddressResult = (
  displayName = 'Kızılay, Çankaya, Ankara, Türkiye',
  latitude = 39.9208,
  longitude = 32.8541,
): AddressGeocodingResult => Object.freeze({
  displayName,
  latitude,
  longitude,
  zoom: 16,
  attribution: '© OpenStreetMap katkıcıları',
  attributionUrl: 'https://www.openstreetmap.org/copyright',
});

const createAddressSearch = () => vi.fn(async (query: string, _signal: AbortSignal) => ([
  createAddressResult(query + ', Çankaya, Ankara, Türkiye'),
  createAddressResult('Kızılay Meydanı, Çankaya, Ankara, Türkiye', 39.9209, 32.8542),
]));

const createAddressSelect = () => vi.fn(async (
  _result: AddressGeocodingResult,
  _signal: AbortSignal,
) => undefined);

const renderNavigationBar = (
  onAddressSearch = createAddressSearch(),
  onAddressSelect = createAddressSelect(),
) => render(<NavigationBar onAddressSearch={onAddressSearch} onAddressSelect={onAddressSelect} />);

const getSearchInput = (): HTMLInputElement => screen.getByRole('searchbox', {
  name: /adres.*cadde.*mahalle.*yer ara/i,
});

describe('NavigationBar', () => {
  beforeEach(() => {
    themeMocks.theme = 'light';
    themeMocks.toggleTheme.mockReset();
  });

  it('uses Kent Rehberi branding in the header', () => {
    renderNavigationBar();
    const homeLink = screen.getByRole('link', { name: 'KENT REHBERİ ana sayfası' });

    expect(homeLink).toHaveAttribute('href', './');
    expect(homeLink.closest('header')).toHaveStyle({ top: '0px', insetBlockStart: '0px' });
    expect(homeLink).toHaveTextContent('KENT REHBERİ');
  });

  it('shows address choices for the current map and pins a clicked choice without a success message or redirect', async () => {
    const user = userEvent.setup();
    const onAddressSearch = createAddressSearch();
    const onAddressSelect = createAddressSelect();
    renderNavigationBar(onAddressSearch, onAddressSelect);

    await user.type(getSearchInput(), '  Kızılay  ');
    await user.click(screen.getByRole('button', { name: 'Adres aramasını başlat' }));

    expect(onAddressSearch).toHaveBeenCalledTimes(1);
    expect(onAddressSearch.mock.calls[0]?.[0]).toBe('Kızılay');
    expect(onAddressSearch.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    const firstChoice = await screen.findByRole('option', { name: /Kızılay, Çankaya.*Türkiye/i });
    expect(screen.getByRole('listbox', { name: 'Adres arama sonuçları' })).toBeInTheDocument();
    await user.click(firstChoice);

    expect(onAddressSelect).toHaveBeenCalledTimes(1);
    expect(onAddressSelect.mock.calls[0]?.[0]).toMatchObject({ displayName: expect.stringContaining('Kızılay') });
    expect(onAddressSelect.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Adres aramasını başlat' })).toBeEnabled());
    expect(screen.queryByText(/Haritada bulundu/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Adres arama sonuçları' })).not.toBeInTheDocument();
    expect(document.querySelector('.kr-address-search-feedback--success')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Google Haritalar/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Kategori\s+\d+/i)).not.toBeInTheDocument();
  });


  it('does not offer an external map redirect when an address cannot be found', async () => {
    const user = userEvent.setup();
    const onAddressSearch = vi.fn(async () => {
      throw new Error('Adres bulunamadı. Daha açık bir adres deneyin.');
    });
    renderNavigationBar(onAddressSearch);

    await user.type(getSearchInput(), 'Bilinmeyen yer');
    await user.click(screen.getByRole('button', { name: 'Adres aramasını başlat' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Adres bulunamadı');
    expect(screen.queryByRole('link', { name: /Google Haritalar/i })).not.toBeInTheDocument();
  });

  it('does not submit whitespace-only input', async () => {
    const user = userEvent.setup();
    const onAddressSearch = createAddressSearch();
    renderNavigationBar(onAddressSearch);

    await user.type(getSearchInput(), '   ');
    expect(screen.getByRole('button', { name: 'Adres aramasını başlat' })).toBeDisabled();
    expect(onAddressSearch).not.toHaveBeenCalled();
  });

  it('clears search and releases focus with Escape', async () => {
    const user = userEvent.setup();
    renderNavigationBar();
    const search = getSearchInput();

    await user.type(search, 'Ankara');
    expect(search).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).not.toHaveFocus();
  });

  it('preserves search text and focus when Escape belongs to an active IME composition', () => {
    renderNavigationBar();
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
    renderNavigationBar();
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
    const { container } = renderNavigationBar();
    const cbsLink = container.querySelector<HTMLAnchorElement>('a.kr-header-portal');

    expect(cbsLink).not.toBeNull();
    expect(cbsLink?.getAttribute('aria-label')).toBe('CBS Başkent portalını yeni sekmede aç');
    expect(cbsLink?.getAttribute('href')).toBe('https://cbsbaskent.ankara.bel.tr/');
    expect(cbsLink?.getAttribute('target')).toBe('_blank');
    expect(new Set(cbsLink?.getAttribute('rel')?.trim().split(/\s+/))).toEqual(new Set(['noopener', 'noreferrer']));
  });

  it('places the accessible theme toggle in the top navigation with a clear action icon', () => {
    renderNavigationBar();

    const themeButton = screen.getByRole('button', { name: 'Karanlık temaya geç' });
    expect(themeButton.querySelector('svg')).not.toBeNull();
    fireEvent.click(themeButton);
    expect(themeMocks.toggleTheme).toHaveBeenCalledTimes(1);
  });
});
