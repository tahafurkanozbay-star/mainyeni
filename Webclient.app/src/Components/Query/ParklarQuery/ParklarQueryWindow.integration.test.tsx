import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParklarQueryWindow, type ParkWindowHandle } from './ParklarQueryWindow';
import { ParklarQeryBusiness } from '../../../Business/ParklarQeryBusiness';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import { createKentRehberiGeoJsonLayer } from '../../../data-services/kentRehberiGeoJsonLayer';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';

vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({ GisGraphicsHelper: { ZoomToGeometry: vi.fn() } }));
vi.mock('../../../Business/ParklarQeryBusiness', () => ({ ParklarQeryBusiness: { Query: vi.fn() } }));
vi.mock('../../../Business/CommonBusiness', () => ({ CommonBusiness: { Clustering: { CreateLayerWithoutClustering: vi.fn() } } }));
vi.mock('../../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: vi.fn(async () => undefined) } }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: vi.fn() } }));
vi.mock('../../../data-services/kentRehberiGeoJsonLayer', () => ({ createKentRehberiGeoJsonLayer: vi.fn() }));
vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: vi.fn(async () => [{ when: () => ({ remove: vi.fn() }), watch: () => ({ remove: vi.fn() }) }]) }));

const makeResponse = (count = 1) => ({
  type: 10, source: 'kent-rehberi',
  data: Array.from({ length: count }, (_, index) => ({ attr: { objectid: index + 1, adi: `Park ${index + 1}`, adres: 'Ankara' } })),
  featureCollection: { type: 'FeatureCollection', features: [] },
});

const setup = () => {
  const map = { add: vi.fn(), remove: vi.fn() };
  vi.mocked(MapManager.GetMapView).mockReturnValue({ map, zoom: 12 });
  const manager = { RegisterWindow: vi.fn(), IsVisible: () => true, ShowMessage: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowWindow: vi.fn(), HideWindow: vi.fn() };
  const ref = createRef<ParkWindowHandle>();
  const view = render(<ParklarQueryWindow id="park-window" windowManager={manager} ref={ref} />);
  return { ...view, ref, map, manager };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('Parklar service window', () => {
  it('closes the park window when returning to services', () => {
    const { manager } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Hizmetlere dön' }));
    expect(manager.HideWindow).toHaveBeenCalledExactlyOnceWith('park-window');
    expect(manager.ShowWindow).toHaveBeenCalledExactlyOnceWith('sidebar');
  });
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

  it('bounds initial result rendering while retaining every record behind the more action', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(100) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla park göster (40 kaldı)' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(100);
    expect(screen.queryByRole('button', { name: /Daha fazla park/ })).not.toBeInTheDocument();
    expect(screen.getByText('1–100 / 100 park')).toBeVisible();
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
  it('keeps park queries responsive when logging stalls and omits private query details', async () => {
    const logger = vi.mocked(LoggingBusiness.CreateClientLog);
    logger.mockReturnValue(new Promise<unknown>(() => undefined));
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse() as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref, manager } = setup();
    Object.assign(manager, {
      GetQueryParams: () => ({ name: 'PRIVATE_PARK_QUERY', districtName: 'PRIVATE_DISTRICT' }),
    });
    await act(async () => { await ref.current?.OnShow(); });
    expect(ParklarQeryBusiness.Query).toHaveBeenCalledOnce();
    expect(screen.getByText('Park 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' }));
    expect(logger).toHaveBeenCalledTimes(2);
    const audit = JSON.stringify(logger.mock.calls);
    expect(audit).toContain('query-fields:2');
    expect(audit).toContain('record-detail-opened');
    expect(audit).not.toContain('PRIVATE_PARK_QUERY');
    expect(audit).not.toContain('PRIVATE_DISTRICT');
    expect(audit).not.toContain('Ankara');
  });

  it('offers a second park result group for large responses', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(201) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki park grubuna geç' }));
    expect(screen.getByText('Park 201')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(ParklarQeryBusiness.Query).toHaveBeenCalledOnce();
  });


  it('aborts a pending detail on close and ignores a late response', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ParklarQeryBusiness.Query>>) => void;
    vi.mocked(ParklarQeryBusiness.Query)
      .mockResolvedValueOnce(makeResponse() as never)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref, manager } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    fireEvent.click(screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' }));
    await waitFor(() => expect(ParklarQeryBusiness.Query).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(ParklarQeryBusiness.Query).mock.calls[1]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    act(() => { ref.current?.OnClose(); });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish({ ...makeResponse(), data: [{ geometry: { x: 32.85, y: 39.92 } }] } as never);
    });
    expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
    expect(manager.ToggleMinimiseWindow).not.toHaveBeenCalled();
    expect(manager.ShowMessage).not.toHaveBeenCalled();
  });

  it('prevents a superseded detail from moving the map', async () => {
    let finishFirst!: (value: Awaited<ReturnType<typeof ParklarQeryBusiness.Query>>) => void;
    let finishSecond!: (value: Awaited<ReturnType<typeof ParklarQeryBusiness.Query>>) => void;
    vi.mocked(ParklarQeryBusiness.Query)
      .mockResolvedValueOnce(makeResponse(2) as never)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    fireEvent.click(screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' }));
    fireEvent.click(screen.getByRole('button', { name: 'Park 2 konumunu haritada göster' }));
    const firstSignal = vi.mocked(ParklarQeryBusiness.Query).mock.calls[1]?.[2]?.signal;
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => {
      finishSecond({ ...makeResponse(), data: [{ geometry: { x: 32.85, y: 39.92 } }] } as never);
    });
    expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledOnce();
    await act(async () => {
      finishFirst({ ...makeResponse(), data: [{ geometry: { x: 30, y: 40 } }] } as never);
    });
    expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledOnce();
  });

  it('uses native button activation once and gives every secondary action a record name', async () => {
    vi.mocked(ParklarQeryBusiness.Query)
      .mockResolvedValueOnce(makeResponse(2) as never)
      .mockResolvedValueOnce({
        ...makeResponse(), data: [{ geometry: { x: 32.85, y: 39.92 } }],
      } as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    const primary = screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' });
    expect(screen.getByRole('button', { name: 'Park 1 — Haritada göster' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Park 2 — Yol tarifi' })).toBeVisible();
    fireEvent.keyDown(primary, { key: 'Enter' });
    fireEvent.click(primary, { detail: 0 });
    await waitFor(() => expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledOnce());
    expect(ParklarQeryBusiness.Query).toHaveBeenCalledTimes(2);
  });

  it('moves keyboard focus between bounded park groups without a second service query', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(201) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    const callbacks: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    try {
      const next = screen.getByRole('button', { name: 'Sonraki park grubuna geç' });
      next.focus();
      fireEvent.click(next, { detail: 0 });
      act(() => { callbacks.splice(0).forEach((callback) => callback(0)); });
      expect(screen.getByRole('button', { name: 'Park 201 konumunu haritada göster' })).toHaveFocus();
      const previous = screen.getByRole('button', { name: 'Önceki park grubuna dön' });
      previous.focus();
      fireEvent.click(previous, { detail: 0 });
      act(() => { callbacks.splice(0).forEach((callback) => callback(0)); });
      expect(screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' })).toHaveFocus();
      expect(ParklarQeryBusiness.Query).toHaveBeenCalledOnce();
    } finally { frame.mockRestore(); }
  });

  it('does not reclaim focus from a pointer-triggered park reveal', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(100) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    try {
      const back = screen.getByRole('button', { name: 'Hizmetlere dön' });
      back.focus();
      fireEvent.click(screen.getByRole('button', { name: 'Daha fazla park göster (40 kaldı)' }), { detail: 1 });
      expect(back).toHaveFocus();
      expect(screen.getAllByRole('listitem')).toHaveLength(100);
      expect(frame).not.toHaveBeenCalled();
    } finally { frame.mockRestore(); }
  });

  it('cancels pending keyboard paging focus on close', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(100) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    const callbacks: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    try {
      const more = screen.getByRole('button', { name: 'Daha fazla park göster (40 kaldı)' });
      more.focus();
      fireEvent.click(more, { detail: 0 });
      expect(callbacks).toHaveLength(1);
      act(() => { ref.current?.OnClose(); });
      expect(cancel).toHaveBeenCalledWith(1);
      act(() => { callbacks[0]?.(0); });
      expect(screen.queryByRole('button', { name: 'Park 61 konumunu haritada göster' })).not.toBeInTheDocument();
    } finally { frame.mockRestore(); cancel.mockRestore(); }
  });


  it('announces pending park action and bounds an unresponsive detail transport', async () => {
    vi.mocked(ParklarQeryBusiness.Query)
      .mockResolvedValueOnce(makeResponse() as never)
      .mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref, manager } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    vi.useFakeTimers();
    try {
      const primary = screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' });
      fireEvent.click(primary);
      expect(primary).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByText('Park konumu hazırlanıyor…')).toBeVisible();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      const signal = vi.mocked(ParklarQeryBusiness.Query).mock.calls[1]?.[2]?.signal;
      expect(signal?.aborted).toBe(true);
      expect(screen.getByText('Park konumu zaman aşımına uğradı. Tekrar deneyin.')).toBeVisible();
      expect(primary).not.toHaveAttribute('aria-busy');
      expect(manager.ShowMessage).not.toHaveBeenCalled();
      expect(GisGraphicsHelper.ZoomToGeometry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expose stale action feedback after closing the window', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ParklarQeryBusiness.Query>>) => void;
    vi.mocked(ParklarQeryBusiness.Query)
      .mockResolvedValueOnce(makeResponse() as never)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Park 1 konumunu haritada göster' }));
      await Promise.resolve(); // Flush the detail operation microtask before closing.
    });
    expect(screen.getByText('Park konumu hazırlanıyor…')).toBeInTheDocument();
    act(() => { ref.current?.OnClose(); });
    expect(screen.queryByText('Park konumu hazırlanıyor…')).not.toBeInTheDocument();
    await act(async () => {
      finish({ ...makeResponse(), data: [{ geometry: { x: 32.85, y: 39.92 } }] } as never);
    });
    expect(screen.queryByText('Park konumu haritada gösterildi.')).not.toBeInTheDocument();
  });

});
