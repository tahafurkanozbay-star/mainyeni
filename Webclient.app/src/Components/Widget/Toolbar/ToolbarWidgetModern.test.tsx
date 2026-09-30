import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { openExternalUrl } from '../_shared/MapWidgetRuntime';
import { ToolbarWidgetModern } from './ToolbarWidgetModern';

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
    expect(screen.getAllByRole('button')).toHaveLength(8);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Geri Bildirim (Başkent 153)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' })).toBeTruthy();
  });

  it('keeps a single tab stop and supports vertical roving focus', () => {
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    const toolbar = screen.getByRole('toolbar', { name: 'Harita araçları' });
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    const first = screen.getByRole('button', { name: 'Geri Bildirim (Başkent 153)' });
    const second = screen.getByRole('button', { name: 'Altlık Haritalar' });
    first.focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    fireEvent.keyDown(toolbar, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('uses the governed external navigation helper for Başkent 153', () => {
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Geri Bildirim (Başkent 153)' }));
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://ulakbell.ankara.bel.tr/WebForm/basket153basvuru#/',
    );
  });

  it.each([
    ['Altlık Haritalar', 'basemap-widget'],
    ['Adres Arama', 'numbering-query-window'],
    ['Ada-Parsel Arama', 'cityblockparcel-query-window'],
    ['Ölçüm Aracı', 'measurement-widget'],
    ['Sokak Görüntüsü', 'streetview-widget'],
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
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Konum bulunuyor' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Konumunuz bulunuyor.');

    geolocation.resolve(32.82, 39.93);

    await waitFor(() => {
      expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledWith({ x: 32.82, y: 39.93 });
      expect(MapManager.AddGraphics).toHaveBeenCalledWith({ id: 'location-graphic' }, true);
      expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        15,
      );
      expect(screen.getByRole('status').textContent).toBe('Konumunuz haritada gösterildi.');
    });
  });

  it('coalesces repeated location activation while geolocation is pending', () => {
    const geolocation = installGeolocationHarness();
    render(<ToolbarWidgetModern windowManager={createWindowManager()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    const busy = screen.getByRole('button', { name: 'Konum bulunuyor' });
    fireEvent.click(busy);
    expect(geolocation.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('falls back to Ankara center and restores the sidebar when browser location fails', async () => {
    const geolocation = installGeolocationHarness();
    const manager = createWindowManager();
    render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Konum Bul' }));
    geolocation.reject();

    await waitFor(() => {
      expect(GisGraphicsHelper.CreatePoint).toHaveBeenCalledWith({
        x: 32.80409955978453,
        y: 39.94494728389463,
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
    geolocation.reject();
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Konum gösterilemedi. Harita araçlarını kullanmaya devam edebilirsiniz.',
      );
    });
  });

  it('returns to the captured initial extent and restores the sidebar', () => {
    const mapView = createMapView();
    vi.mocked(MapManager.GetMapView).mockReturnValue(mapView.view as never);
    const manager = createWindowManager();
    render(<ToolbarWidgetModern windowManager={manager} />);
    fireEvent.click(screen.getByRole('button', { name: 'Başlangıç görünümüne dön' }));
    expect(mapView.goTo).toHaveBeenCalledWith(mapView.clonedExtent);
    expect(manager.ShowWindow).toHaveBeenCalledWith('sidebar');
  });

  it('captures the extent when the map becomes ready later', () => {
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
    expect(view.goTo).toHaveBeenCalledWith(lateExtent);
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
    unmount();
    geolocation.resolve(32.82, 39.93);
    await Promise.resolve();
    await Promise.resolve();
    expect(GisGraphicsHelper.CreatePoint).not.toHaveBeenCalled();
  });
});
