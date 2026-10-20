import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishKentRehberiPoiSearchIndex } from '../../data-services/kentRehberiPoiSearchIndex';
import { getKentRehberiMapFilterSnapshot, setKentRehberiMapFilter } from '../../shell/kentRehberiMapFilter';
import { MapManager } from '../../Store/Managers/MapManager';
import type { ManagedWindowHandle, WindowManagerLike } from '../../experience/contracts';
import { SidebarModern } from './SidebarModern';

vi.mock('../../Store/Managers/MapManager', () => ({
  MapManager: { GetMapView: vi.fn(), GetActiveMapView: vi.fn() },
}));

vi.mock('../Common/SharedGISIcon', () => ({
  SharedGISIcon: ({ record }: { readonly record: { readonly title?: string } }) => (
    <span data-testid={`icon-${record.title ?? 'unknown'}`} aria-hidden="true" />
  ),
}));

interface ManagerHarness {
  readonly manager: WindowManagerLike;
  readonly ShowWindow: ReturnType<typeof vi.fn>;
  readonly RegisterWindow: ReturnType<typeof vi.fn>;
  readonly UnregisterWindow: ReturnType<typeof vi.fn>;
  readonly getRegisteredHandle: () => ManagedWindowHandle | null;
}

const createManager = (): ManagerHarness => {
  let registeredHandle: ManagedWindowHandle | null = null;
  const ShowWindow = vi.fn();
  const RegisterWindow = vi.fn((windowRef: { readonly current: ManagedWindowHandle | null }) => {
    registeredHandle = windowRef.current;
  });
  const UnregisterWindow = vi.fn();
  const manager: WindowManagerLike = {
    ShowWindow,
    RegisterWindow,
    UnregisterWindow,
  };
  return {
    manager,
    ShowWindow,
    RegisterWindow,
    UnregisterWindow,
    getRegisteredHandle: () => registeredHandle,
  };
};

const renderSidebar = () => {
  const harness = createManager();
  const result = render(<SidebarModern id="services-sidebar" windowManager={harness.manager} />);
  return { ...harness, ...result };
};

const serviceButton = (name: string): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: `${name} sorgusunu aç` });

const favoriteButton = (name: string): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: `${name} favorilere ekle` });

let clearPoiIndex: (() => void) | null = null;

beforeEach(() => {
  clearPoiIndex?.();
  clearPoiIndex = null;
  window.localStorage.clear();
  setKentRehberiMapFilter(null);
  vi.mocked(MapManager.GetMapView).mockReset();
  vi.mocked(MapManager.GetMapView).mockReturnValue(null);
  vi.mocked(MapManager.GetActiveMapView).mockReset();
  vi.mocked(MapManager.GetActiveMapView).mockReturnValue(null);
});

afterEach(() => {
  clearPoiIndex?.();
  clearPoiIndex = null;
  setKentRehberiMapFilter(null);
});

const seedPoiIndex = (records: Parameters<typeof publishKentRehberiPoiSearchIndex>[0] = [
  { id: 101, name: 'Seğmen Su Satış Noktası', address: 'Kızılay, Çankaya', district: 'Çankaya', neighborhood: 'Kızılay', longitude: 32.854, latitude: 39.920, iconKey: 'segmen su' },
  { id: 102, name: 'Seğmen Su Fabrikası', address: 'Gölbaşı', district: 'Gölbaşı', neighborhood: '', longitude: 32.802, latitude: 39.791, iconKey: 'segmen su' },
  { id: 103, name: 'Ulus Metro Durağı', address: 'Altındağ', district: 'Altındağ', neighborhood: 'Ulus', longitude: 32.860, latitude: 39.941, iconKey: 'metro' },
]) => {
  clearPoiIndex?.();
  clearPoiIndex = publishKentRehberiPoiSearchIndex(records);
};

describe('SidebarModern governed interaction integration', () => {
  it('registers a managed window handle on mount and unregisters on unmount', () => {
    const { RegisterWindow, UnregisterWindow, unmount } = renderSidebar();
    expect(RegisterWindow).toHaveBeenCalledTimes(1);
    expect(RegisterWindow.mock.calls[0]?.[0]?.current).toMatchObject({
      id: 'services-sidebar',
      visible: true,
      minimized: false,
    });
    unmount();
    expect(UnregisterWindow).toHaveBeenCalledTimes(1);
    expect(UnregisterWindow).toHaveBeenCalledWith('services-sidebar', expect.any(Object));
  });

  it('exposes the existing in-panel host for service query content', () => {
    const harness = createManager();
    const onToolHostChange = vi.fn();
    const result = render(
      <SidebarModern
        id="services-sidebar"
        windowManager={harness.manager}
        onToolHostChange={onToolHostChange}
      />,
    );
    const sidebar = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
    const host = sidebar.querySelector<HTMLDivElement>('.kr-sidebar__tool-slot');

    expect(host).toBeInTheDocument();
    expect(onToolHostChange).toHaveBeenCalledWith(host);
    result.unmount();
    expect(onToolHostChange).toHaveBeenLastCalledWith(null);
  });

  it('renders the governed all-services view with semantic list structure', () => {
    renderSidebar();
    const sidebar = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
    expect(sidebar).toHaveClass('kr-sidebar--governed');
    const list = screen.getByRole('list', { name: 'Tüm kent servisleri hizmet listesi' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(40);
    expect(screen.getByText('40 hizmet')).toBeInTheDocument();
  });

  it('keeps exactly one service button in the roving tab sequence', () => {
    renderSidebar();
    const list = screen.getByRole('list', { name: 'Tüm kent servisleri hizmet listesi' });
    const buttons = within(list).getAllByRole('button').filter((button) => button.classList.contains('kr-sidebar__item'));
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(buttons.filter((button) => button.tabIndex === -1)).toHaveLength(buttons.length - 1);
  });

  it('exposes only one institution group as a keyboard tab stop', () => {
    renderSidebar();
    const nav = screen.getByRole('navigation', { name: 'Kurum kategorileri' });
    const groups = within(nav).getAllByRole('button');
    expect(groups.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(groups[0]).toHaveAttribute('title', 'Ankara Büyükşehir Belediyesi');
  });

  it('clears the institution map filter from beside the selected category without leaving the list', async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(getKentRehberiMapFilterSnapshot().iconKeys).toBeNull();
    await user.click(screen.getByRole('button', { name: 'EGO Genel Müdürlüğü' }));

    const selected = getKentRehberiMapFilterSnapshot();
    expect(selected.label).toBe('EGO Genel Müdürlüğü');
    expect(selected.iconKeys).not.toBeNull();
    expect(screen.getByText('Haritada yalnızca')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tüm noktaları göster' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tüm noktaları göster' }));
    expect(getKentRehberiMapFilterSnapshot().iconKeys).toBeNull();
    expect(screen.getByRole('heading', { name: 'EGO Genel Müdürlüğü' })).toBeInTheDocument();
    expect(serviceButton('Metro Hattı')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tüm noktaları göster' })).not.toBeInTheDocument();
  });

  it('clears the selected service map filter with one click without resetting navigation', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(serviceButton('Parklar'));
    expect(getKentRehberiMapFilterSnapshot().label).toBe('Parklar');
    await user.click(screen.getByRole('button', { name: 'Tüm noktaları göster' }));

    expect(getKentRehberiMapFilterSnapshot().iconKeys).toBeNull();
    expect(screen.getByRole('list', { name: 'Tüm kent servisleri hizmet listesi' })).toBeInTheDocument();
  });

  it('resolves institution logos relative to the configured app base path', () => {
    renderSidebar();
    const nav = screen.getByRole('navigation', { name: 'Kurum kategorileri' });
    const logoSources = Array.from(
      nav.querySelectorAll('img'),
      (image) => image.getAttribute('src'),
    );

    expect(logoSources).toEqual([
      `${import.meta.env.BASE_URL}images/abbbuton.svg`,
      `${import.meta.env.BASE_URL}images/egobuton.svg`,
      `${import.meta.env.BASE_URL}images/askibuton.svg`,
      `${import.meta.env.BASE_URL}images/istiraklerbuton.svg`,
    ]);
    expect(logoSources.every((source) => source !== null && !source.startsWith('/') && !source.startsWith('../'))).toBe(true);
  });

  it('searches point names across all institutions with Turkish accent tolerance', async () => {
    seedPoiIndex();
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Harita noktalarında ara' });
    expect(search).toHaveAttribute('placeholder', 'Nokta adı ara…');
    await user.type(search, 'segmen su');
    expect(screen.getByRole('button', { name: 'Seğmen Su Satış Noktası noktasına git' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seğmen Su Fabrikası noktasına git' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ulus Metro Durağı noktasına git' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Parklar sorgusunu aç' })).not.toBeInTheDocument();
    expect(screen.getByText('2 nokta')).toBeInTheDocument();
  });

  it('zooms to a selected point and renders upstream popup text safely', async () => {
    seedPoiIndex([{
      id: 106,
      name: 'Test <em>Place</em>',
      address: '\u003cimg src=x onerror=alert(1)\u003e',
      district: 'Çankaya',
      neighborhood: 'Kızılay',
      longitude: 32.854,
      latitude: 39.920,
    }]);
    const popupOpen = vi.fn((options: unknown) => { void options; });
    const goTo = vi.fn().mockResolvedValue(undefined);
    vi.mocked(MapManager.GetMapView).mockReturnValue({
      destroyed: false,
      goTo,
      popup: { open: popupOpen },
    } as never);

    const user = userEvent.setup();
    renderSidebar();
    await user.type(screen.getByRole('searchbox', { name: 'Harita noktalarında ara' }), 'test');
    await user.click(screen.getByRole('button', { name: 'Test <em>Place</em> noktasına git' }));

    expect(goTo).toHaveBeenCalledWith(
      { center: [32.854, 39.920], zoom: 17 },
      { duration: 650 },
    );
    await waitFor(() => expect(popupOpen).toHaveBeenCalledTimes(1));
    const popupOptions = popupOpen.mock.calls[0]?.[0] as { readonly content: HTMLElement };
    expect(popupOptions.content).toBeInstanceOf(HTMLElement);
    expect(popupOptions.content.textContent).toContain('Test <em>Place</em>');
    expect(popupOptions.content.textContent).toContain('\u003cimg src=x onerror=alert(1)\u003e');
    expect(popupOptions.content.querySelector('em, img')).toBeNull();
  });

  it('uses the active 3D view instead of the hidden 2D view for point results', async () => {
    seedPoiIndex([{ id: 107, name: 'Aktif görünüm noktası', address: 'Çankaya', district: 'Çankaya', neighborhood: '', longitude: 32.854, latitude: 39.920 }]);
    const activeGoTo = vi.fn().mockResolvedValue(undefined);
    const inactiveGoTo = vi.fn().mockResolvedValue(undefined);
    vi.mocked(MapManager.GetMapView).mockReturnValue({ destroyed: false, goTo: inactiveGoTo } as never);
    vi.mocked(MapManager.GetActiveMapView).mockReturnValue({ destroyed: false, goTo: activeGoTo } as never);
    const user = userEvent.setup();
    renderSidebar();
    await user.type(screen.getByRole('searchbox', { name: 'Harita noktalarında ara' }), 'aktif görünüm');
    await user.click(screen.getByRole('button', { name: 'Aktif görünüm noktası noktasına git' }));
    expect(activeGoTo).toHaveBeenCalledWith({ center: [32.854, 39.920], zoom: 17 }, { duration: 650 });
    expect(inactiveGoTo).not.toHaveBeenCalled();
  });

  it('clears search with the explicit clear button', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Harita noktalarında ara' });
    await user.type(search, 'metro');
    expect(screen.getByRole('button', { name: 'Aramayı temizle' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Aramayı temizle' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('40 hizmet')).toBeInTheDocument();
  });

  it('moves from search to the first service with ArrowDown', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Harita noktalarında ara' });
    search.focus();
    await user.keyboard('{ArrowDown}');
    expect(serviceButton('Kadın Danışma Merkezleri')).toHaveFocus();
  });

  it('moves from search to the last service with ArrowUp', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Harita noktalarında ara' });
    search.focus();
    await user.keyboard('{ArrowUp}');
    expect(serviceButton('Halk Ekmek Satış Noktaları')).toHaveFocus();
  });

  it('moves through service buttons with ArrowDown', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const first = serviceButton('Kadın Danışma Merkezleri');
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(serviceButton('Kadınlar Lokali')).toHaveFocus();
  });

  it('wraps service focus from the first item to the last with ArrowUp', async () => {
    const user = userEvent.setup();
    renderSidebar();
    serviceButton('Kadın Danışma Merkezleri').focus();
    await user.keyboard('{ArrowUp}');
    expect(serviceButton('Halk Ekmek Satış Noktaları')).toHaveFocus();
  });

  it('supports Home and End service navigation', async () => {
    const user = userEvent.setup();
    renderSidebar();
    serviceButton('Parklar').focus();
    await user.keyboard('{End}');
    expect(serviceButton('Halk Ekmek Satış Noktaları')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(serviceButton('Kadın Danışma Merkezleri')).toHaveFocus();
  });

  it('opens the active service with Enter and records it as recent', async () => {
    const user = userEvent.setup();
    const { ShowWindow } = renderSidebar();
    const park = serviceButton('Parklar');
    park.focus();
    await user.keyboard('{Enter}');
    expect(ShowWindow).toHaveBeenCalledWith('park-query-window');
    expect(JSON.parse(window.localStorage.getItem('kentrehberi:service-recents') ?? '[]')).toContain('park-query-window');
  });

  it('opens a service by pointer activation and records it as recent', async () => {
    const user = userEvent.setup();
    const { ShowWindow } = renderSidebar();
    await user.click(serviceButton('Metro Hattı'));
    expect(ShowWindow).toHaveBeenCalledWith('egometroduraklar-query-window');
    expect(window.localStorage.getItem('kentrehberi:service-recents')).toContain('egometroduraklar-query-window');
  });

  it('keeps the existing category panel expanded on mobile when opening a service', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      const user = userEvent.setup();
      const { ShowWindow } = renderSidebar();
      const aside = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });

      expect(aside).not.toHaveClass('is-collapsed');
      expect(screen.getByRole('button', { name: 'Hizmet panelini daralt' })).toHaveAttribute('aria-expanded', 'true');

      await user.click(serviceButton('Parklar'));
      expect(ShowWindow).toHaveBeenCalledWith('park-query-window');
      expect(aside).not.toHaveClass('is-collapsed');
      expect(screen.getByRole('button', { name: 'Hizmet panelini daralt' })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('keeps the selected service focused and the panel expanded after mobile keyboard activation', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      const user = userEvent.setup();
      const { ShowWindow } = renderSidebar();
      const aside = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
      expect(aside).not.toHaveClass('is-collapsed');
      const park = serviceButton('Parklar');
      park.focus();
      await user.keyboard('{Enter}');

      expect(ShowWindow).toHaveBeenCalledWith('park-query-window');
      expect(aside).not.toHaveClass('is-collapsed');
      expect(park).toHaveFocus();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('keeps the existing category panel expanded on tablet when opening a service', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 });
    try {
      const user = userEvent.setup();
      const { ShowWindow } = renderSidebar();
      const aside = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
      expect(aside).not.toHaveClass('is-collapsed');

      await user.click(serviceButton('Parklar'));

      expect(ShowWindow).toHaveBeenCalledWith('park-query-window');
      expect(aside).not.toHaveClass('is-collapsed');
      expect(screen.getByRole('button', { name: 'Hizmet panelini daralt' })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('keeps the selected service focused and the panel expanded after tablet keyboard activation', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 768 });
    try {
      const user = userEvent.setup();
      const { ShowWindow } = renderSidebar();
      const aside = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
      expect(aside).not.toHaveClass('is-collapsed');
      const park = serviceButton('Parklar');
      park.focus();
      await user.keyboard('{Enter}');

      expect(ShowWindow).toHaveBeenCalledWith('park-query-window');
      expect(aside).not.toHaveClass('is-collapsed');
      expect(park).toHaveFocus();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    }
  });

  it('adds a favorite and persists only the canonical window id', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(favoriteButton('Parklar'));
    expect(screen.getByRole('button', { name: 'Parklar favorilerden çıkar' })).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('kentrehberi:service-favorites')).toBe('["park-query-window"]');
  });

  it('removes an existing favorite and persists the empty bounded list', async () => {
    window.localStorage.setItem('kentrehberi:service-favorites', '["park-query-window"]');
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'Parklar favorilerden çıkar' }));
    expect(window.localStorage.getItem('kentrehberi:service-favorites')).toBe('[]');
  });

  it('shows only favorited services in the favorites view', async () => {
    window.localStorage.setItem('kentrehberi:service-favorites', '["park-query-window","kutuphaneler-query-window"]');
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /Favoriler 2/u }));
    const list = screen.getByRole('list', { name: 'Favorilerim hizmet listesi' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(serviceButton('Parklar')).toBeInTheDocument();
    expect(serviceButton('Kütüphaneler')).toBeInTheDocument();
  });

  it('shows only recent services in most-recent-first order', async () => {
    window.localStorage.setItem('kentrehberi:service-recents', '["park-query-window","egometroduraklar-query-window"]');
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /Son 2/u }));
    const items = within(screen.getByRole('list', { name: 'Son kullanılanlar hizmet listesi' })).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('button', { name: 'Parklar sorgusunu aç' })).toBeInTheDocument();
    expect(within(items[1]!).getByRole('button', { name: 'Metro Hattı sorgusunu aç' })).toBeInTheDocument();
  });

  it('renders a distinct no-favorites state', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /Favoriler 0/u }));
    expect(screen.getByText('Henüz favori yok')).toBeInTheDocument();
    expect(screen.getByText('Sık kullandığınız bir hizmeti yıldızlayın.')).toBeInTheDocument();
  });

  it('renders a distinct no-recents state', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /Son 0/u }));
    expect(screen.getByText('Henüz geçmiş yok')).toBeInTheDocument();
    expect(screen.getByText('Açtığınız hizmetler burada en yeniden eskiye görünür.')).toBeInTheDocument();
  });

  it('renders a distinct no-point-name-results state', async () => {
    seedPoiIndex([]);
    const user = userEvent.setup();
    renderSidebar();
    await user.type(screen.getByRole('searchbox', { name: 'Harita noktalarında ara' }), 'eşleşmeyen nokta');
    expect(screen.getByText('Nokta bulunamadı')).toBeInTheDocument();
    expect(screen.getByText('Başka bir nokta adı deneyin veya aramayı temizleyin.')).toBeInTheDocument();
  });

  it('filters to an institution group and updates contextual counts', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: 'EGO Genel Müdürlüğü' }));
    expect(screen.getByRole('heading', { name: 'EGO Genel Müdürlüğü' })).toBeInTheDocument();
    expect(screen.getByText('8 hizmet')).toBeInTheDocument();
    expect(serviceButton('Metro Hattı')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Parklar sorgusunu aç' })).not.toBeInTheDocument();
  });

  it('toggles the active institution map filter off while keeping its subcategory list open', async () => {
    const user = userEvent.setup();
    const { ShowWindow } = renderSidebar();
    const sidebar = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
    const ego = screen.getByRole('button', { name: 'EGO Genel Müdürlüğü' });

    await user.click(ego);
    expect(ego).toHaveAttribute('aria-pressed', 'true');
    expect(getKentRehberiMapFilterSnapshot().label).toBe('EGO Genel Müdürlüğü');
    expect(screen.getByText('8 hizmet')).toBeInTheDocument();

    await user.click(ego);
    expect(ego).toHaveAttribute('aria-pressed', 'true');
    expect(getKentRehberiMapFilterSnapshot().iconKeys).toBeNull();
    expect(screen.getByText('8 hizmet')).toBeInTheDocument();
    expect(screen.queryByText('40 hizmet')).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toBe(sidebar);
    expect(ShowWindow).not.toHaveBeenCalled();
  });

  it('switches the existing category panel to another institution without creating a new panel', async () => {
    const user = userEvent.setup();
    const { ShowWindow } = renderSidebar();
    const sidebar = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });

    await user.click(screen.getByRole('button', { name: 'EGO Genel Müdürlüğü' }));
    expect(screen.getByText('8 hizmet')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'ASKİ Genel Müdürlüğü' }));
    expect(screen.getByRole('heading', { name: 'ASKİ Genel Müdürlüğü' })).toBeInTheDocument();
    expect(screen.getByText('6 hizmet')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toBe(sidebar);
    expect(screen.getAllByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toHaveLength(1);
    expect(ShowWindow).not.toHaveBeenCalled();
  });

  it('moves group focus with ArrowRight without selecting the next group', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const abb = screen.getByRole<HTMLButtonElement>('button', { name: 'Ankara Büyükşehir Belediyesi' });
    const ego = screen.getByRole<HTMLButtonElement>('button', { name: 'EGO Genel Müdürlüğü' });
    abb.focus();
    await user.keyboard('{ArrowRight}');
    expect(ego).toHaveFocus();
    expect(ego).toHaveAttribute('aria-pressed', 'false');
  });

  it('wraps group focus from the first to the last group with ArrowLeft', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const abb = screen.getByRole<HTMLButtonElement>('button', { name: 'Ankara Büyükşehir Belediyesi' });
    abb.focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Belediye iştirakleri' })).toHaveFocus();
  });

  it('collapses the panel without deleting the governed interaction state', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const toggle = screen.getByRole('button', { name: 'Hizmet panelini daralt' });
    await user.click(toggle);
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toHaveClass('is-collapsed');
    expect(screen.getByRole('button', { name: 'Hizmet panelini genişlet' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses from a service with Escape when query is empty', async () => {
    const user = userEvent.setup();
    renderSidebar();
    serviceButton('Parklar').focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toHaveClass('is-collapsed');
  });

  it('clears an active point-name search before collapsing on Escape', async () => {
    seedPoiIndex([{ id: 104, name: 'Park ve Bahçeler', address: 'Çankaya', district: 'Çankaya', neighborhood: '', longitude: 32.85, latitude: 39.92 }]);
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Harita noktalarında ara' });
    await user.type(search, 'park');
    const point = screen.getByRole('button', { name: 'Park ve Bahçeler noktasına git' });
    point.focus();
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).not.toHaveClass('is-collapsed');
    expect(search).toHaveFocus();
  });

  it('announces point-name result counts through a polite atomic status', async () => {
    seedPoiIndex([{ id: 105, name: 'Kütüphane Gençlik Merkezi', address: 'Çankaya', district: 'Çankaya', neighborhood: 'Kızılay', longitude: 32.85, latitude: 39.92 }]);
    const user = userEvent.setup();
    renderSidebar();
    const status = screen.getByRole('status', { hidden: true });
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    await user.type(screen.getByRole('searchbox', { name: 'Harita noktalarında ara' }), 'kutuphane');
    expect(status).toHaveTextContent('1 nokta bulundu.');
  });

  it('hydrates malformed stored preferences as empty without breaking the surface', () => {
    window.localStorage.setItem('kentrehberi:service-favorites', '{invalid');
    window.localStorage.setItem('kentrehberi:service-recents', '{invalid');
    expect(() => renderSidebar()).not.toThrow();
    expect(screen.getByText('40 hizmet')).toBeInTheDocument();
  });

  it('ignores persisted ids that are not admitted by the sidebar catalog', async () => {
    window.localStorage.setItem('kentrehberi:service-favorites', '["missing","park-query-window"]');
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: /Favoriler 1/u }));
    expect(serviceButton('Parklar')).toBeInTheDocument();
    expect(screen.getByText('1 hizmet')).toBeInTheDocument();
  });

  it('collapses through the registered managed-window handle without removing the sidebar', () => {
    const { RegisterWindow } = renderSidebar();
    const ref = RegisterWindow.mock.calls[0]?.[0] as { readonly current: ManagedWindowHandle | null } | undefined;
    const aside = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });
    expect(ref?.current?.OnClose).toBeTypeOf('function');

    act(() => ref?.current?.OnClose?.());

    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toBe(aside);
    expect(aside).toHaveClass('is-collapsed');
  });

  it('expands the still-mounted sidebar through the managed OnShow handle', () => {
    const { RegisterWindow } = renderSidebar();
    const ref = RegisterWindow.mock.calls[0]?.[0] as { readonly current: ManagedWindowHandle | null } | undefined;
    const aside = screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' });

    act(() => ref?.current?.OnClose?.());
    expect(aside).toHaveClass('is-collapsed');

    act(() => ref?.current?.OnShow?.());

    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toBe(aside);
    expect(aside).not.toHaveClass('is-collapsed');
  });

  it('keeps favorite activation independent from service opening', async () => {
    const user = userEvent.setup();
    const { ShowWindow } = renderSidebar();
    await user.click(favoriteButton('Parklar'));
    expect(ShowWindow).not.toHaveBeenCalled();
  });

  it('describes keyboard interaction from the search field', () => {
    renderSidebar();
    const search = screen.getByRole('searchbox', { name: 'Harita noktalarında ara' });
    expect(search).toHaveAttribute('aria-describedby', expect.stringContaining('kr-sidebar-keyboard-help'));
    expect(screen.getByText(/Hizmetler arasında yukarı ve aşağı okları/u)).toHaveClass('experience-sr-only');
  });

  it('keeps canonical shared icon presentation in every service row', () => {
    renderSidebar();
    expect(screen.getByTestId('icon-Parklar')).toBeInTheDocument();
    expect(screen.getByTestId('icon-Metro Hattı')).toBeInTheDocument();
  });
});
