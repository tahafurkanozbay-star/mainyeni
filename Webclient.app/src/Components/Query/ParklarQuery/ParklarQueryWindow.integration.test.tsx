import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParklarQueryWindow, type ParkWindowHandle } from './ParklarQueryWindow';
import { ParklarQeryBusiness } from '../../../Business/ParklarQeryBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { createKentRehberiGeoJsonLayer } from '../../../data-services/kentRehberiGeoJsonLayer';

vi.mock('../../../Business/ParklarQeryBusiness', () => ({ ParklarQeryBusiness: { Query: vi.fn() } }));
vi.mock('../../../Business/CommonBusiness', () => ({ CommonBusiness: { Clustering: { CreateLayerWithoutClustering: vi.fn() } } }));
vi.mock('../../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: vi.fn(async () => undefined) } }));
vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({ GisGraphicsHelper: { ZoomToGeometry: vi.fn() } }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: vi.fn() } }));
vi.mock('../../../data-services/kentRehberiGeoJsonLayer', () => ({ createKentRehberiGeoJsonLayer: vi.fn() }));
vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: vi.fn(async () => [{ when: (_view: unknown, _key: unknown, callback: () => void) => { callback(); return { remove: vi.fn() }; }, whenTrue: (_view: unknown, _key: unknown, callback: () => void) => { callback(); return { remove: vi.fn() }; }, watch: () => ({ remove: vi.fn() }) }]) }));

const makeResponse = (count = 1) => ({
  type: 10, source: 'kent-rehberi',
  data: Array.from({ length: count }, (_, index) => ({ attr: { objectid: index + 1, adi: `Park ${index + 1}`, adres: 'Ankara' } })),
  featureCollection: { type: 'FeatureCollection', features: [] },
});

const setup = () => {
  const map = { add: vi.fn(), remove: vi.fn() };
  const goTo = vi.fn(async () => undefined);
  vi.mocked(MapManager.GetMapView).mockReturnValue({ map, zoom: 12, extent: { xmin: 32, ymin: 39, xmax: 33, ymax: 40 }, goTo });
  const manager = { RegisterWindow: vi.fn(), IsVisible: () => true, ShowMessage: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowWindow: vi.fn(), HideWindow: vi.fn() };
  const ref = createRef<ParkWindowHandle>();
  const view = render(<ParklarQueryWindow id="park-window" windowManager={manager} ref={ref} />);
  return { ...view, ref, map, manager, goTo };
};

beforeEach(() => { vi.clearAllMocks(); vi.mocked(LoggingBusiness.CreateClientLog).mockResolvedValue(undefined as never); });

describe('Parklar service window', () => {
  it('renders the same-origin data layer through the shared window presentation and releases it on close', async () => {
    const layer = { destroy: vi.fn() };
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse() as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue(layer);
    const { ref, map } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    expect(screen.getByRole('region', { name: 'Parklar' })).toHaveClass('kr-fast-query');
    expect(screen.getByRole('button', { name: 'Parklar penceresini kapat' })).toBeInTheDocument();
    expect(CommonBusiness.Clustering.CreateLayerWithoutClustering).not.toHaveBeenCalled();
    expect(map.add).toHaveBeenCalledExactlyOnceWith(layer);
    expect(createKentRehberiGeoJsonLayer).toHaveBeenCalledWith(expect.any(Object), undefined, expect.objectContaining({ title: 'Parklar' }), expect.any(AbortSignal));
    await act(async () => { ref.current?.OnClose(); });
    expect(map.remove).toHaveBeenCalledExactlyOnceWith(layer);
    expect(layer.destroy).toHaveBeenCalledOnce();
  });

  it('keeps every result reachable with bounded pages', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(100) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(40);
    expect(screen.getByRole('list')).toHaveFocus();
    expect(screen.getByRole('navigation')).toHaveTextContent('61–100 / 100 kayıt');
    expect(screen.getByRole('button', { name: 'Sonraki sayfa' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Önceki sayfa' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
  });

  it('filters the full response from a later page and returns focus when clearing', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(120) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
    const field = screen.getByRole('searchbox'); field.focus();
    fireEvent.change(field, { target: { value: 'Park 120' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'yok' } });
    expect(screen.getByText(/Filtreye uygun sonuç bulunamadı/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filtreyi temizle' }));
    expect(field).toHaveFocus();
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    expect(screen.getByRole('navigation')).toHaveTextContent('1–60 / 120 kayıt');
  });

  it('presents park results without waiting for a stalled log request', async () => {
    vi.mocked(LoggingBusiness.CreateClientLog).mockReturnValue(new Promise(() => undefined));
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse() as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'false');
  });

  it('returns to services immediately while camera restoration is still pending', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse() as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref, goTo, manager } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    let finish!: () => void;
    goTo.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Hizmetlere dön' }));
    expect(manager.HideWindow).toHaveBeenCalledWith('park-window');
    expect(manager.ShowWindow).toHaveBeenCalledWith('sidebar');
    await act(async () => { await Promise.resolve(); });
    expect(goTo).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => { finish(); });
  });

  it('cancels park detail transport on close and ignores its late response', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValueOnce(makeResponse() as never)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref, manager } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    fireEvent.click(screen.getByRole('button', { name: 'Haritada göster' }));
    const signal = vi.mocked(ParklarQeryBusiness.Query).mock.calls[1]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    act(() => ref.current?.OnClose());
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ type: 10, data: [{ geometry: { x: 32.85, y: 39.92 } }] }); });
    expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
    expect(manager.ToggleMinimiseWindow).not.toHaveBeenCalled();
    expect(manager.ShowMessage).not.toHaveBeenCalled();
  });

  it('cancels a pending layer on close and disposes its late result', async () => {
    let finish!: (layer: { destroy: ReturnType<typeof vi.fn> }) => void;
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse() as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { ref, map } = setup();
    let pending!: Promise<void>;
    await act(async () => { pending = ref.current?.OnShow() as Promise<void>; await Promise.resolve(); });
    const signal = vi.mocked(createKentRehberiGeoJsonLayer).mock.calls[0]?.[3];
    await act(async () => { ref.current?.OnClose(); });
    expect(signal?.aborted).toBe(true);
    const layer = { destroy: vi.fn() };
    await act(async () => { finish(layer); await pending; });
    expect(map.add).not.toHaveBeenCalled();
    expect(layer.destroy).toHaveBeenCalledOnce();
  });
});
