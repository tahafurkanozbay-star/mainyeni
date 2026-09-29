import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle, WindowManagerLike } from '../../experience/contracts';
import { SidebarModern } from './SidebarModern';

vi.mock('../../Store/Managers/MapManager', () => ({
  default: { GetMapView: vi.fn(() => null) },
}));

vi.mock('../../Business/CommonBusiness', () => ({
  CommonBusiness: {
    Clustering: { CreateLayerWithoutClustering: vi.fn() },
  },
}));

vi.mock('../../gis-engine/iconPresentation', () => ({
  createPictureMarkerSymbol: vi.fn(() => ({})),
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

beforeEach(() => {
  window.localStorage.clear();
});

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

  it('filters services using Turkish accent-tolerant search', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Kent servislerinde ara' });
    await user.type(search, 'kutuphane');
    expect(serviceButton('Kütüphaneler')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Parklar sorgusunu aç' })).not.toBeInTheDocument();
    expect(screen.getByText('1 hizmet')).toBeInTheDocument();
  });

  it('clears search with the explicit clear button', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Kent servislerinde ara' });
    await user.type(search, 'metro');
    expect(screen.getByRole('button', { name: 'Hizmet aramasını temizle' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hizmet aramasını temizle' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('40 hizmet')).toBeInTheDocument();
  });

  it('moves from search to the first service with ArrowDown', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Kent servislerinde ara' });
    search.focus();
    await user.keyboard('{ArrowDown}');
    expect(serviceButton('Kadın Danışma Merkezleri')).toHaveFocus();
  });

  it('moves from search to the last service with ArrowUp', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Kent servislerinde ara' });
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

  it('renders a distinct no-search-results state', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.type(screen.getByRole('searchbox', { name: 'Kent servislerinde ara' }), 'eşleşmeyen servis');
    expect(screen.getByText('Hizmet bulunamadı')).toBeInTheDocument();
    expect(screen.getByText('Arama ifadenizi değiştirin veya filtreyi temizleyin.')).toBeInTheDocument();
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

  it('toggles the selected institution back to all services', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const ego = screen.getByRole('button', { name: 'EGO Genel Müdürlüğü' });
    await user.click(ego);
    expect(ego).toHaveAttribute('aria-pressed', 'true');
    await user.click(ego);
    expect(ego).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('40 hizmet')).toBeInTheDocument();
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

  it('clears an active service search before collapsing on Escape', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Kent servislerinde ara' });
    await user.type(search, 'park');
    serviceButton('Parklar').focus();
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).not.toHaveClass('is-collapsed');
    expect(search).toHaveFocus();
  });

  it('announces result-count changes through a polite atomic status', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const status = screen.getByRole('status', { hidden: true });
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    await user.type(screen.getByRole('searchbox', { name: 'Kent servislerinde ara' }), 'park');
    expect(status).toHaveTextContent('1 hizmet gösteriliyor.');
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

  it('closes through the registered managed-window handle', () => {
    const { RegisterWindow } = renderSidebar();
    const ref = RegisterWindow.mock.calls[0]?.[0] as { readonly current: ManagedWindowHandle | null } | undefined;
    expect(ref?.current?.OnClose).toBeTypeOf('function');
    act(() => ref?.current?.OnClose?.());
    expect(screen.queryByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).not.toBeInTheDocument();
  });

  it('reopens through the registered managed-window handle after close', () => {
    const { RegisterWindow } = renderSidebar();
    const ref = RegisterWindow.mock.calls[0]?.[0] as { readonly current: ManagedWindowHandle | null } | undefined;
    act(() => ref?.current?.OnClose?.());
    expect(screen.queryByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).not.toBeInTheDocument();
    act(() => ref?.current?.OnShow?.());
    expect(screen.getByRole('complementary', { name: 'Kent Rehberi hizmet kategorileri' })).toBeInTheDocument();
  });

  it('keeps favorite activation independent from service opening', async () => {
    const user = userEvent.setup();
    const { ShowWindow } = renderSidebar();
    await user.click(favoriteButton('Parklar'));
    expect(ShowWindow).not.toHaveBeenCalled();
  });

  it('describes keyboard interaction from the search field', () => {
    renderSidebar();
    const search = screen.getByRole('searchbox', { name: 'Kent servislerinde ara' });
    expect(search).toHaveAttribute('aria-describedby', expect.stringContaining('kr-sidebar-keyboard-help'));
    expect(screen.getByText(/Hizmetler arasında yukarı ve aşağı okları/u)).toHaveClass('experience-sr-only');
  });

  it('keeps canonical shared icon presentation in every service row', () => {
    renderSidebar();
    expect(screen.getByTestId('icon-Parklar')).toBeInTheDocument();
    expect(screen.getByTestId('icon-Metro Hattı')).toBeInTheDocument();
  });
});
