import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedFastAccessQueryWindow,
  type FastAccessServiceResult,
  type ManagedWindowHandle,
} from './ManagedFastAccessQueryWindow';
import MapManager from '../../../Store/Managers/MapManager';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { createKentRehberiGeoJsonLayer } from '../../../data-services/kentRehberiGeoJsonLayer';
import { getKentRehberiMapFilterSnapshot, setKentRehberiMapFilter } from '../../../shell/kentRehberiMapFilter';

vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: vi.fn() } }));
vi.mock('../../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: vi.fn(async () => undefined) } }));
vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({ GisGraphicsHelper: { ZoomToGeometry: vi.fn() } }));
vi.mock('../../../Toolbox/DebugHelper', () => ({ DebugHelper: { Log: vi.fn() } }));
vi.mock('../../../data-services/kentRehberiGeoJsonLayer', () => ({ createKentRehberiGeoJsonLayer: vi.fn() }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
};
const response = (count = 1): FastAccessServiceResult => ({
  type: 10, source: 'kent-rehberi',
  data: Array.from({ length: count }, (_, index) => ({ attr: { objectid: index + 1, adi: `Merkez ${index + 1}`, adres: 'Ankara' } })),
  featureCollection: { type: 'FeatureCollection', features: [] },
});
const setup = () => {
  const map = { add: vi.fn(), remove: vi.fn() };
  const goTo = vi.fn();
  vi.mocked(MapManager.GetMapView).mockReturnValue({ map, zoom: 12, goTo });
  const Query = vi.fn(async (): Promise<FastAccessServiceResult> => response());
  const manager = {
    RegisterWindow: vi.fn(), UnregisterWindow: vi.fn(), IsVisible: () => true, IsMinimized: vi.fn(() => false),
    HideWindow: vi.fn(), ShowMessage: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowWindow: vi.fn(),
  };
  const Window = createManagedFastAccessQueryWindow({ title: 'Merkezler', serviceKey: 'merkezler', business: { Query } });
  const ref = createRef<ManagedWindowHandle>();
  const rendered = render(<Window id="service-window" windowManager={manager} ref={ref} />);
  return { ...rendered, ref, map, goTo, manager, Query, Window };
};
beforeEach(() => {
  vi.clearAllMocks();
  setKentRehberiMapFilter(null);
  vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({ destroy: vi.fn() });
  vi.mocked(LoggingBusiness.CreateClientLog).mockResolvedValue(undefined);
});

describe('shared service result window ownership and usability', () => {
  it('shows complete long service titles and addresses in the narrow results panel', async () => {
    const { ref, Query } = setup();
    const longTitle = 'ABB KAHRAMANKAZAN KADIN DANIŞMA MERKEZİ SOSYAL DESTEK BİRİMİ';
    const longAddress = 'ANKARA ÇANKAYA MAHALLESİ ÇOK UZUN BULVAR VE SOKAK BİLGİSİ NUMARA 42 KAT 3';
    Query.mockResolvedValueOnce({
      type: 10,
      source: 'kent-rehberi',
      data: [{ attr: { objectid: 501, adi: longTitle, adres: longAddress } }],
      featureCollection: { type: 'FeatureCollection', features: [] },
    });
    await act(async () => { await ref.current!.OnShow(); });
    const heading = screen.getByRole('heading', { name: longTitle });
    expect(heading).toHaveAttribute('title', longTitle);
    expect(heading.closest('.kr-fast-query__copy')).toContainElement(screen.getByText(longAddress));
    expect(screen.getByText(longAddress)).toHaveAttribute('title', longAddress);
    expect(screen.getByRole('button', { name: longTitle + ' — Haritada göster' })).toBeEnabled();
  });

  it('preserves results across controlled minimize and expand', async () => {
    const { ref, Window, manager, rerender } = setup();
    await act(async () => { await ref.current!.OnShow(); });
    fireEvent.click(screen.getByRole('button', { name: 'Sonuçları küçült' }));
    expect(manager.ToggleMinimiseWindow).toHaveBeenCalledExactlyOnceWith('service-window');
    manager.IsMinimized.mockReturnValue(true);
    rerender(<Window id="service-window" windowManager={manager} ref={ref} />);
    expect(screen.getByRole('region', { name: 'Merkezler' })).toHaveAttribute('data-minimized', 'true');
    expect(screen.getByRole('button', { name: 'Sonuçları genişlet' })).toHaveAttribute('aria-expanded', 'false');
    manager.IsMinimized.mockReturnValue(false);
    rerender(<Window id="service-window" windowManager={manager} ref={ref} />);
    expect(screen.getByRole('heading', { name: 'Merkez 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sonuçları küçült' })).toHaveAttribute('aria-expanded', 'true');
  });
  it.each(['Hizmetlere dön', 'Merkezler penceresini kapat'])('closes the result window, clears the map filter and returns to services with %s', (label) => {
    const { manager } = setup();
    setKentRehberiMapFilter({ label: 'EGO Genel Müdürlüğü', iconKeys: ['ego_metro'] });
    expect(getKentRehberiMapFilterSnapshot().iconKeys).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(manager.HideWindow).toHaveBeenCalledExactlyOnceWith('service-window');
    expect(manager.ShowWindow).toHaveBeenCalledExactlyOnceWith('sidebar');
    expect(manager.HideWindow.mock.invocationCallOrder[0]).toBeLessThan(manager.ShowWindow.mock.invocationCallOrder[0]!);
    expect(getKentRehberiMapFilterSnapshot().iconKeys).toBeNull();
  });

  it('does not wait for logging before querying', async () => {
    vi.mocked(LoggingBusiness.CreateClientLog).mockReturnValue(new Promise(() => undefined));
    const { ref, Query } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    expect(Query).toHaveBeenCalledWith({}, false, { signal: expect.any(AbortSignal) });
    expect(screen.getByRole('heading', { name: 'Merkez 1' })).toBeInTheDocument();
  });

  it('aborts the query and releases a late layer after close', async () => {
    const late = deferred<{ destroy: ReturnType<typeof vi.fn> }>();
    vi.mocked(createKentRehberiGeoJsonLayer).mockReturnValue(late.promise);
    const { ref, map, Query } = setup();
    let pending!: Promise<void>;
    await act(async () => { pending = ref.current!.OnShow() as Promise<void>; await Promise.resolve(); });
    const signal = vi.mocked(createKentRehberiGeoJsonLayer).mock.calls[0]?.[3];
    act(() => { ref.current!.OnClose(); });
    expect(signal?.aborted).toBe(true);
    expect((Query.mock.calls[0] as unknown as [unknown, boolean, { signal: AbortSignal }])[2].signal.aborted).toBe(true);
    const layer = { destroy: vi.fn() };
    await act(async () => { late.resolve(layer); await pending; });
    expect(map.add).not.toHaveBeenCalled();
    expect(layer.destroy).toHaveBeenCalledOnce();
  });

  it('does not move the map when a closed layer finishes its extent request', async () => {
    const extent = deferred<{ extent: { expand: () => unknown } }>();
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({ queryExtent: () => extent.promise, destroy: vi.fn() });
    const { ref, goTo } = setup();
    let pending!: Promise<void>;
    await act(async () => { pending = ref.current!.OnShow() as Promise<void>; await Promise.resolve(); await Promise.resolve(); });
    act(() => { ref.current!.OnClose(); });
    await act(async () => { extent.resolve({ extent: { expand: () => ({}) } }); await pending; });
    expect(goTo).not.toHaveBeenCalled();
  });

  it('disposes an owned layer when attaching it to the map fails', async () => {
    const layer = { destroy: vi.fn() };
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue(layer);
    const { ref, map } = setup();
    map.add.mockImplementation(() => { throw new Error('Harita katmanı eklenemedi.'); });
    await act(async () => { await ref.current!.OnShow(); });
    expect(layer.destroy).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeInTheDocument();
  });

  it('ignores late map-position details after close', async () => {
    const { ref, Query } = setup();
    await act(async () => { await ref.current!.OnShow(); });
    const late = deferred<FastAccessServiceResult>();
    Query.mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole('button', { name: /Haritada göster/ }));
    expect(screen.getAllByRole('button', { name: /Merkez 1 —/ }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    act(() => { ref.current!.OnClose(); });
    await act(async () => { late.resolve({ type: 10, data: [{ geometry: { latitude: 39.9, longitude: 32.8 } }] }); });
    expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
  });

  it('contains async map navigation failure and restores the action controls', async () => {
    const { ref, Query, manager } = setup();
    await act(async () => { await ref.current!.OnShow(); });
    Query.mockResolvedValueOnce({ type: 10, data: [{ geometry: { latitude: 39.9, longitude: 32.8 } }] });
    vi.mocked(GisGraphicsHelper.ZoomToGeometry).mockRejectedValueOnce(new Error('Konum gösterilemedi.') as never);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Haritada göster/ })); });
    expect(manager.ShowMessage).toHaveBeenCalledWith(expect.any(String), 'Konum gösterilemedi.');
    expect(screen.getByRole('button', { name: /Haritada göster/ })).toBeEnabled();
  });

  it('explains an empty filter and resets it without requesting the service again', async () => {
    const { ref, Query } = setup();
    Query.mockResolvedValue(response(70));
    await act(async () => { await ref.current!.OnShow(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bulunmayan' } });
    expect(screen.getByText('Aramanızla eşleşen sonuç yok.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filtreyi temizle' }));
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    expect(Query).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla sonuç göster (10 kaldı)' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(70);
  });

  it('presents missing configuration without exposing the internal service key', async () => {
    const { ref, Query } = setup();
    Query.mockRejectedValue(new Error('Servis bulunamadı (YeniMerkezQueryUrl)'));
    await act(async () => { await ref.current!.OnShow(); });
    expect(screen.getByText('Bu hizmet şu anda kullanılamıyor. Daha sonra tekrar deneyebilirsiniz.')).toBeInTheDocument();
    expect(screen.queryByText(/YeniMerkezQueryUrl/)).not.toBeInTheDocument();
  });

  it('unregisters only its owned window ref on unmount', () => {
    const { unmount, ref, manager } = setup();
    unmount();
    expect(manager.UnregisterWindow).toHaveBeenCalledExactlyOnceWith('service-window', ref);
  });
  it('cancels pending page focus when the window unmounts', async () => {
    const { ref, Query, unmount } = setup();
    Query.mockResolvedValue(response(70));
    await act(async () => { await ref.current!.OnShow(); });
    const schedule = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(77);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Daha fazla sonuç göster (10 kaldı)' }));
      unmount();
      expect(cancel).toHaveBeenCalledWith(77);
    } finally { schedule.mockRestore(); cancel.mockRestore(); }
  });
  it('bounds a stalled layer and releases its late result without losing the records', async () => {
    vi.useFakeTimers();
    try {
      const late = deferred<{ destroy: ReturnType<typeof vi.fn> }>();
      vi.mocked(createKentRehberiGeoJsonLayer).mockReturnValue(late.promise);
      const { ref, map } = setup();
      let pending!: Promise<void>;
      await act(async () => { pending = ref.current!.OnShow() as Promise<void>; await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); await pending; });
      expect(screen.getByText('İşlem beklenenden uzun sürdü. Lütfen tekrar deneyin.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Merkez 1' })).toBeInTheDocument();
      const layer = { destroy: vi.fn() };
      await act(async () => { late.resolve(layer); });
      expect(map.add).not.toHaveBeenCalled();
      expect(layer.destroy).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('releases stalled detail controls and ignores navigation after their deadline', async () => {
    vi.useFakeTimers();
    try {
      const { ref, Query } = setup();
      await act(async () => { await ref.current!.OnShow(); });
      const late = deferred<FastAccessServiceResult>();
      Query.mockReturnValueOnce(late.promise);
      fireEvent.click(screen.getByRole('button', { name: /Haritada göster/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole('button', { name: /Haritada göster/ })).toBeEnabled();
      await act(async () => { late.resolve({ type: 10, data: [{ geometry: { latitude: 39.9, longitude: 32.8 } }] }); });
      expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
