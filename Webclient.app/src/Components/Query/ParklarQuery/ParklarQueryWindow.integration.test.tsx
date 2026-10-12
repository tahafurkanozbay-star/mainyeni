import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParklarQueryWindow, type ParkWindowHandle } from './ParklarQueryWindow';
import { ParklarQeryBusiness } from '../../../Business/ParklarQeryBusiness';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import MapManager from '../../../Store/Managers/MapManager';
import { createKentRehberiGeoJsonLayer } from '../../../data-services/kentRehberiGeoJsonLayer';

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
  const manager = { RegisterWindow: vi.fn(), IsVisible: () => true, ShowMessage: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowWindow: vi.fn() };
  const ref = createRef<ParkWindowHandle>();
  const view = render(<ParklarQueryWindow id="park-window" windowManager={manager} ref={ref} />);
  return { ...view, ref, map, manager };
};

beforeEach(() => { vi.clearAllMocks(); });

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

  it('bounds initial result rendering while retaining every record behind the more action', async () => {
    vi.mocked(ParklarQeryBusiness.Query).mockResolvedValue(makeResponse(100) as never);
    vi.mocked(createKentRehberiGeoJsonLayer).mockResolvedValue({});
    const { ref } = setup();
    await act(async () => { await ref.current?.OnShow(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(60);
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla park göster (40 kaldı)' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(100);
    expect(screen.queryByRole('button', { name: /Daha fazla park/ })).not.toBeInTheDocument();
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
