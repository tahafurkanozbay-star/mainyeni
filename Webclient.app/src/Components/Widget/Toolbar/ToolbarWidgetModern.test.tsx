import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { ToolbarWidgetModern } from './ToolbarWidgetModern';

// Real portal placement is covered by ExperienceToolbar.hints and browser QA;
// isolate ownership/keyboard tests from Popper's asynchronous layout lifecycle.
vi.mock('react-bootstrap', async importOriginal => ({
  ...await importOriginal<typeof import('react-bootstrap')>(),
  OverlayTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: vi.fn(),
    AddGraphics: vi.fn(),
  },
}));

vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({
  GisGraphicsHelper: {
    CreatePoint: vi.fn(),
    CreateGraphicFromGeometry: vi.fn(),
    ZoomToGeometry: vi.fn(),
    AddGraphics: vi.fn(),
    RemoveGraphics: vi.fn(),
  },
}));

vi.mock('../_shared/MapWidgetRuntime', async (importOriginal) => {
  const original = await importOriginal<typeof import('../_shared/MapWidgetRuntime')>();
  return {
    ...original,
    openExternalUrl: vi.fn(() => true),
  };
});

interface WindowManagerStub {
  readonly ShowWindow: ReturnType<typeof vi.fn>;
}

interface GeolocationHarness {
  readonly getCurrentPosition: ReturnType<typeof vi.fn>;
  resolve: (longitude: number, latitude: number) => void;
  reject: (error?: unknown) => void;
}

const createWindowManager = (): WindowManagerStub => ({
  ShowWindow: vi.fn(),
});

const installGeolocationHarness = (): GeolocationHarness => {
  let successCallback: PositionCallback | undefined;
  let errorCallback: PositionErrorCallback | undefined;
  const getCurrentPosition = vi.fn((
    success: PositionCallback,
    error?: PositionErrorCallback | null,
  ) => {
    successCallback = success;
    errorCallback = error ?? undefined;
  });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  });
  return {
    getCurrentPosition,
    resolve(longitude, latitude) {
      successCallback?.({
        coords: {
          longitude,
          latitude,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    },
    reject(error = new Error('denied')) {
      errorCallback?.(error as GeolocationPositionError);
    },
  };
};

const createMapView = () => {
  const clonedExtent = { id: 'initial-extent' };
  const remove = vi.fn();
  const watch = vi.fn((_name: string, _callback: (ready: boolean) => void) => ({ remove }));
  const goTo = vi.fn(async () => undefined);
  return {
    view: {
      ready: true,
      graphics: { add: vi.fn(), remove: vi.fn() },
      extent: { clone: vi.fn(() => clonedExtent) },
      watch,
      goTo,
    },
    clonedExtent,
    remove,
    watch,
    goTo,
  };
};

afterEach(() => vi.useRealTimers());

describe('ToolbarWidgetModern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mapView = createMapView();
    vi.mocked(MapManager.GetMapView).mockReturnValue(mapView.view as never);
    vi.mocked(GisGraphicsHelper.CreatePoint).mockImplementation(async (point) => ({ point }) as never);
    vi.mocked(GisGraphicsHelper.CreateGraphicFromGeometry).mockResolvedValue({ id: 'location-graphic' } as never);
  });

  it('renders one semantic vertical toolbar with deterministic actions', () => {
    render(<ToolbarWidgetModern id="map-toolbar" windowManager={createWindowManager()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Harita araçları' });
    expect(toolbar.id).toBe('map-toolbar');
    expect(toolbar.getAttribute('aria-orientation')).toBe('vertical');
    expect(toolbar.getAttribute('aria-describedby')).toBe('map-toolbar-instructions');
    expect(within(toolbar).getAllByRole('button')).toHaveLength(4);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Altlık Haritalar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' })).toBeTruthy();
  });

  it('keeps a single tab stop and supports vertical roving focus', () => {
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Harita araçları' });
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    const first = screen.getByRole('button', { name: 'Altlık Haritalar' });
    const second = screen.getByRole('button', { name: 'Konum Bul' });
    first.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    fireEvent.keyDown(toolbar, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it.each([
    ['Altlık Haritalar', 'basemap-widget'],
    ['Ölçüm Aracı', 'measurement-widget'],
  ])('routes %s through the existing window manager authority', (label, target) => {
    const manager = createWindowManager();
    render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(manager.ShowWindow).toHaveBeenCalledWith(target);
  });

  it('renders a successful browser position through existing GIS helpers', async () => {
    const geolocation = installGeolocationHarness();
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    const locationButton = screen.getByRole('button', { name: 'Konum Bul' });
    fireEvent.click(locationButton);
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Konum bulunuyor' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Konumunuz bulunuyor.');

    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    geolocation.resolve(32.82, 39.93);

    await waitFor(() => {
      expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledWith({ x: 32.82, y: 39.93, spatialReference: { wkid: 4326 } });
      expect(GisGraphicsHelper.AddGraphics).toHaveBeenCalledWith(expect.anything(), { id: 'location-graphic' });
      expect(MapManager.AddGraphics).not.toHaveBeenCalled();
      expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        15,
      );
      expect(screen.getByRole('status').textContent).toBe('Konumunuz haritada gösterildi.');
    });
  });

  it('coalesces repeated location activation while geolocation is pending', async () => {
    const geolocation = installGeolocationHarness();
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    const busy = screen.getByRole('button', { name: 'Konum bulunuyor' });
    fireEvent.click(busy);
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to Ankara center and restores the sidebar when browser location fails', async () => {
    const geolocation = installGeolocationHarness();
    const manager = createWindowManager();
    render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    geolocation.reject();

    await waitFor(() => {
      expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledWith({
        x: 32.80409955978453,
        y: 39.94494728389463,
        spatialReference: { wkid: 4326 },
      });
      expect(manager.ShowWindow).toHaveBeenCalledWith('sidebar');
      expect(screen.getByRole('status').textContent).toBe(
        'Konum alınamadı. Ankara merkez konumu gösterildi.',
      );
    });
  });

  it('announces a stable error if neither requested nor fallback location can render', async () => {
    const geolocation = installGeolocationHarness();
    vi.mocked(GisGraphicsHelper.CreatePoint).mockRejectedValue(new Error('map unavailable'));
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    geolocation.reject();
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Konum gösterilemedi. Harita araçlarını kullanmaya devam edebilirsiniz.',
      );
    });
  });

  it('returns to the captured initial extent and restores the sidebar', async () => {
    const mapView = createMapView();
    vi.mocked(MapManager.GetMapView).mockReturnValue(mapView.view as never);
    const manager = createWindowManager();
    render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    await waitFor(() => expect(mapView.goTo).toHaveBeenCalledWith(mapView.clonedExtent));
    expect(manager.ShowWindow).toHaveBeenCalledWith('sidebar');
  });

  it('captures the extent when the map becomes ready later', async () => {
    const mapView = createMapView();
    const lateExtent = { id: 'late-extent' };
    const clone = vi.fn(() => lateExtent);
    const view = {
      ...mapView.view,
      extent: undefined,
      watch: vi.fn((_property: string, callback: (ready: boolean) => void) => {
        Object.assign(view, { extent: { clone } });
        callback(true);
        return { remove: mapView.remove };
      }),
    };
    vi.mocked(MapManager.GetMapView).mockReturnValue(view as never);
    const manager = createWindowManager();
    render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    await waitFor(() => expect(view.goTo).toHaveBeenCalledWith(lateExtent));
  });

  it('releases the map readiness watcher when unmounted', () => {
    const mapView = createMapView();
    vi.mocked(MapManager.GetMapView).mockReturnValue(mapView.view as never);
    const { unmount } = render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    unmount();
    expect(mapView.remove).toHaveBeenCalledTimes(1);
  });

  it('does not publish a late geolocation result after unmount', async () => {
    const geolocation = installGeolocationHarness();
    const { unmount } = render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    unmount();
    geolocation.resolve(32.82, 39.93);
    await Promise.resolve();
    await Promise.resolve();
    expect(GisGraphicsHelper.CreatePoint).not.toHaveBeenCalled();
  });
  it('remains usable after StrictMode setup/cleanup replay', async () => {
    const geolocation = installGeolocationHarness();
    render(<StrictMode><ToolbarWidgetModern windowManager={createWindowManager()} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    geolocation.resolve(32.82, 39.93);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Konumunuz haritada gösterildi.'));
  });

  it('offers visible cancellation and ignores the late browser position', async () => {
    const geolocation = installGeolocationHarness();
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status').closest('.toolbarwidget-notice')).toHaveAttribute('data-visible', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    await act(async () => { geolocation.resolve(32.82, 39.93); });
    expect(GisGraphicsHelper.CreatePoint).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Konum Bul' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Konum Bul' })).toHaveFocus();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('retires a pending position before returning home', async () => {
    const geolocation = installGeolocationHarness();
    const map = createMapView(); vi.mocked(MapManager.GetMapView).mockReturnValue(map.view as never);
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Başlangıç görünümü gösterildi.'));
    await act(async () => { geolocation.resolve(32.82, 39.93); });
    expect(GisGraphicsHelper.CreatePoint).not.toHaveBeenCalled();
    expect(map.goTo).toHaveBeenCalledTimes(1);
  });

  it.each(['point', 'graphic'] as const)('ignores late %s creation after cancellation', async step => {
    const geolocation = installGeolocationHarness();
    let finish: (value: unknown) => void = () => undefined;
    const pending = new Promise(resolve => { finish = resolve; });
    if (step === 'point') vi.mocked(GisGraphicsHelper.CreatePoint).mockReturnValueOnce(pending as never);
    else vi.mocked(GisGraphicsHelper.CreateGraphicFromGeometry).mockReturnValueOnce(pending as never);
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    geolocation.resolve(32.82, 39.93);
    await waitFor(() => expect(step === 'point' ? GisGraphicsHelper.CreatePoint : GisGraphicsHelper.CreateGraphicFromGeometry).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    await act(async () => { finish(step === 'point' ? { type: 'point' } : { id: 'late-graphic' }); });
    expect(GisGraphicsHelper.AddGraphics).not.toHaveBeenCalled();
    expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
  });

  it('binds a fresh initial extent when its map owner changes', async () => {
    const first = createMapView(); const next = createMapView();
    const nextExtent = { id: 'next-map-extent' }; next.view.extent.clone.mockReturnValue(nextExtent);
    vi.mocked(MapManager.GetMapView).mockReturnValue(first.view as never);
    const manager = createWindowManager(); const { rerender } = render(<ToolbarWidgetModern windowManager={manager} />);
    vi.mocked(MapManager.GetMapView).mockReturnValue(next.view as never);
    rerender(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    await waitFor(() => expect(next.goTo).toHaveBeenCalledWith(nextExtent));
    expect(first.goTo).not.toHaveBeenCalled(); expect(first.remove).toHaveBeenCalledTimes(1);
  });

  it('rejects late position work owned by a replaced map', async () => {
    const geolocation = installGeolocationHarness(); const first = createMapView();
    vi.mocked(MapManager.GetMapView).mockReturnValue(first.view as never);
    const manager = createWindowManager(); const { rerender } = render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    vi.mocked(MapManager.GetMapView).mockReturnValue(createMapView().view as never);
    rerender(<ToolbarWidgetModern windowManager={manager} />);
    await act(async () => { geolocation.resolve(32.82, 39.93); });
    expect(GisGraphicsHelper.AddGraphics).not.toHaveBeenCalled(); expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
  });

  it('replaces only its own location marker and releases it on unmount', async () => {
    const geolocation = installGeolocationHarness(); const map = createMapView();
    vi.mocked(MapManager.GetMapView).mockReturnValue(map.view as never);
    const first = { id: 'own-one' }; const second = { id: 'own-two' };
    vi.mocked(GisGraphicsHelper.CreateGraphicFromGeometry).mockResolvedValueOnce(first as never).mockResolvedValueOnce(second as never);
    const { unmount } = render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    for (let call = 1; call <= 2; call++) {
      fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
      await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(call));
      geolocation.resolve(32.82, 39.93);
      await waitFor(() => expect(GisGraphicsHelper.AddGraphics).toHaveBeenCalledTimes(call));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Konumunuz haritada gösterildi.'));
    }
    expect(MapManager.AddGraphics).not.toHaveBeenCalled();
    expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledWith(map.view, [first]);
    unmount(); expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledWith(map.view, [second]);
  });

  it('does not claim success before camera movement finishes', async () => {
    const geolocation = installGeolocationHarness();
    let finish: () => void = () => undefined;
    vi.mocked(GisGraphicsHelper.ZoomToGeometry).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1)); geolocation.resolve(32.82, 39.93);
    await waitFor(() => expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent('Konumunuz bulunuyor.');
    await act(async () => { finish(); }); expect(screen.getByRole('status')).toHaveTextContent('Konumunuz haritada gösterildi.');
  });

  it.each([false, true])('cancels only its own captured SDK animation (newer animation: %s)', async newer => {
    const geolocation = installGeolocationHarness(); const map = createMapView();
    const animation = { stop: vi.fn() }; const foreign = { stop: vi.fn() };
    vi.mocked(MapManager.GetMapView).mockReturnValue(map.view as never);
    vi.mocked(GisGraphicsHelper.ZoomToGeometry).mockImplementationOnce(() => { Object.assign(map.view, { animation }); return new Promise(() => undefined); });
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1)); geolocation.resolve(32.82, 39.93);
    await waitFor(() => expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledTimes(1));
    if (newer) Object.assign(map.view, { animation: foreign });
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    expect(animation.stop).toHaveBeenCalledTimes(newer ? 0 : 1); expect(foreign.stop).not.toHaveBeenCalled();
    expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledWith(map.view, [{ id: 'location-graphic' }]);
  });

  it('bounds a browser callback that never arrives and explicitly labels the fallback', async () => {
    const geolocation = installGeolocationHarness();
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Konum alınamadı. Ankara merkez konumu gösterildi.');
    expect(screen.getByText(/Bu nokta cihazınızın konumu değildir/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeEnabled();
  });

  it('bounds a stalled home action, coalesces repeats and ignores late completion', async () => {
    const map = createMapView(); let finish: () => void = () => undefined;
    map.goTo.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.mocked(MapManager.GetMapView).mockReturnValue(map.view as never);
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    vi.useFakeTimers(); const home = screen.getByRole('button', { name: 'Başlangıç görünümüne dön' });
    fireEvent.click(home); fireEvent.click(home);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(map.goTo).toHaveBeenCalledTimes(1); expect(home).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Başlangıç görünümü gösterilemedi.');
    fireEvent.click(screen.getByRole('button', { name: 'Mesajı kapat' }));
    await act(async () => { finish(); }); expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('reports home failure without reflecting upstream details', async () => {
    const map = createMapView(); map.goTo.mockRejectedValue(new Error('private coordinate and token data'));
    vi.mocked(MapManager.GetMapView).mockReturnValue(map.view as never);
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Başlangıç görünümü gösterilemedi.'));
    expect(screen.queryByText('private coordinate and token data')).toBeNull();
  });

  it('does not request browser permission when cancelled before the queued operation starts', async () => {
    const geolocation = installGeolocationHarness();
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    await act(async () => { await Promise.resolve(); });
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
  });
  it('returns keyboard focus to Home after its outcome is dismissed', async () => {
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    const home = screen.getByRole('button', { name: 'Başlangıç görünümüne dön' });
    fireEvent.click(home);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Başlangıç görünümü gösterildi.'));
    fireEvent.click(screen.getByRole('button', { name: 'Mesajı kapat' }));
    expect(home).toHaveFocus();
  });

  it('does not force a fallback after the user interrupts location camera movement', async () => {
    const geolocation = installGeolocationHarness();
    vi.mocked(GisGraphicsHelper.ZoomToGeometry).mockRejectedValueOnce(new DOMException('User panned the map.', 'AbortError'));
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1)); geolocation.resolve(32.82, 39.93);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Konum gösterimi durduruldu.'));
    expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledTimes(1); expect(GisGraphicsHelper.RemoveGraphics).toHaveBeenCalledTimes(1);
  });
  it('presents a neutral home interruption instead of a false error', async () => {
    const map = createMapView(); map.goTo.mockRejectedValueOnce(new DOMException('User panned the map.', 'AbortError'));
    vi.mocked(MapManager.GetMapView).mockReturnValue(map.view as never);
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Görünüm değiştirme durduruldu.'));
    expect(screen.getByRole('status').closest('.toolbarwidget-notice')).toHaveAttribute('data-tone', 'info');
    expect(screen.queryByRole('button', { name: 'Yeniden dene' })).toBeNull();
  });

  it.each(['success', 'fallback'] as const)('keeps keyboard focus in the notice when a pending operation becomes %s', async outcome => {
    const geolocation = installGeolocationHarness(); render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'İptal et' })).toHaveFocus();
    if (outcome === 'success') geolocation.resolve(32.82, 39.93); else geolocation.reject();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(outcome === 'success' ? 'Konumunuz haritada gösterildi.' : 'Ankara merkez konumu gösterildi.'));
    expect(screen.getByRole('button', { name: outcome === 'success' ? 'Mesajı kapat' : 'Yeniden dene' })).toHaveFocus();
  });
  it('preserves focus deliberately moved outside the notice before completion', async () => {
    const geolocation = installGeolocationHarness(); render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    await waitFor(() => expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1));
    const other = screen.getByRole('button', { name: 'Ölçüm Aracı' }); await act(async () => { other.focus(); });
    geolocation.resolve(32.82, 39.93);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Konumunuz haritada gösterildi.'));
    expect(other).toHaveFocus();
  });

});
