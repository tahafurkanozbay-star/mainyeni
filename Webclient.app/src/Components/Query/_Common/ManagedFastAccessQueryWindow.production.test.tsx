import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, lazy } from 'react';
import { createWindowManager } from '../../../Store/Managers/WindowManager';
import LazyManagedWindow from '../../Common/LazyManagedWindow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedFastAccessQueryWindow, type ManagedWindowHandle } from './ManagedFastAccessQueryWindow';
import { Constants_ServiceResultType } from '../../../Core/Constants';

const ports = vi.hoisted(() => ({
  layer: vi.fn(), geoJson: vi.fn(), zoom: vi.fn(), log: vi.fn(),
  add: vi.fn(), remove: vi.fn(), goTo: vi.fn(), getMap: vi.fn(), debug: vi.fn(),
}));
vi.mock('../../../Business/CommonBusiness', () => ({ CommonBusiness: { Clustering: { CreateLayerWithoutClustering: ports.layer } } }));
vi.mock('../../../Business/LoggingBusiness', () => ({ LoggingBusiness: { CreateClientLog: ports.log } }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: ports.getMap } }));
vi.mock('../../../Toolbox/DebugHelper', () => ({ DebugHelper: { Log: ports.debug } }));
vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({ GisGraphicsHelper: { ZoomToGeometry: ports.zoom } }));
vi.mock('../../../gis-engine/iconPresentation', () => ({ createPictureMarkerSymbol: () => ({ type: 'picture-marker' }) }));
vi.mock('../../../data-services/kentRehberiGeoJsonLayer', () => ({ createKentRehberiGeoJsonLayer: ports.geoJson }));
vi.mock('../../Common/SharedGISIcon', () => ({ SharedGISIcon: () => <span aria-hidden="true" /> }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
};
const success = (count = 25) => ({
  type: Constants_ServiceResultType.Success,
  data: Array.from({ length: count }, (_, index) => ({
    attr: { OBJECTID: index, ADI: index === 0 ? 'Işık Parkı' : `Park ${index}`, ADRES: 'Çankaya' },
    geometry: { x: 32.85, y: 39.92 },
  })),
});
const makeLayer = () => ({ destroy: vi.fn(), queryExtent: vi.fn(async () => ({ extent: null })) });
const setup = (query = vi.fn(async () => success())) => {
  const manager = { RegisterWindow: vi.fn(), GetQueryParams: () => ({}), ShowMessage: vi.fn(), ShowWindow: vi.fn(), ToggleMinimiseWindow: vi.fn() };
  const Component = createManagedFastAccessQueryWindow({ title: 'Parklar', serviceKey: 'parks', pageSize: 10, business: { Query: query } });
  const ref = createRef<ManagedWindowHandle>();
  const view = render(<Component id="parks-test" windowManager={manager} ref={ref} />);
  const open = async () => { await act(async () => { await ref.current!.OnShow(); }); };
  return { ...view, ref, open, query, manager };
};
beforeEach(() => {
  vi.clearAllMocks();
  ports.log.mockResolvedValue(undefined);
  ports.layer.mockImplementation(async () => ({ layerObj: makeLayer() }));
  ports.goTo.mockResolvedValue(undefined);
  ports.getMap.mockReturnValue({ map: { add: ports.add, remove: ports.remove }, zoom: 12, goTo: ports.goTo });
});

describe('real fast-access window presentation and resource ownership', () => {
  it('reveals bounded result batches without dropping prior records or actions', async () => {
    const view = setup(vi.fn(async () => success(1_000)));
    await view.open();
    const list = screen.getByRole('list', { name: 'Parklar sonuçları' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-posinset', '1');
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '1000');
    expect(screen.getByRole('button', { name: /Daha fazla sonuç göster \(190 kaldı\)/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Daha fazla sonuç göster/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(within(list).getAllByRole('listitem')[19]).toHaveAttribute('aria-posinset', '20');
    expect(within(list).getByText('Işık Parkı')).toBeVisible();
    expect(within(list).getByText('Park 10')).toBeVisible();
    expect(screen.getByRole('button', { name: /Daha fazla sonuç göster \(180 kaldı\)/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Daha fazla sonuç göster/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    expect(within(list).getByText('Park 20')).toBeVisible();
    expect(within(list).getByRole('button', { name: 'Işık Parkı — Haritada göster' })).toBeEnabled();
  });

  it('bounds mounted cards and keeps later records reachable without refetching', async () => {
    const view = setup(vi.fn(async () => success(1_000)));
    await view.open();
    const list = screen.getByRole('list', { name: 'Parklar sonuçları' });
    // Keep the action reference while mounted. Repeated accessible-name
    // traversal across an expanding 200-card list is quadratic in jsdom.
    const reveal = screen.getByRole('button', { name: /Daha fazla sonuç göster/ });
    for (let batch = 0; batch < 19; batch += 1) {
      fireEvent.click(reveal);
      expect(list.querySelectorAll(':scope > li').length).toBeLessThanOrEqual(200);
    }
    // Retain a semantic assertion at the largest rendered result window.
    expect(within(list).getAllByRole('listitem')).toHaveLength(200);
    expect(screen.getByText('1–200 / 1000 kayıt')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki sonuçlara geç' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText('Park 200')).toBeVisible();
    expect(screen.getByText('201–210 / 1000 kayıt')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Önceki sonuçlara dön' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(200);
    expect(within(list).getByText('Işık Parkı')).toBeVisible();
    expect(view.query).toHaveBeenCalledOnce();
  });

  it('filters Turkish text, resets visible results and offers an empty-state recovery', async () => {
    const view = setup(); await view.open();
    fireEvent.click(screen.getByRole('button', { name: /Daha fazla sonuç göster/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    const field = screen.getByRole('searchbox'); field.focus();
    fireEvent.change(field, { target: { value: 'isik parki' } });
    expect(field).toHaveFocus();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Işık Parkı')).toBeVisible();
    fireEvent.change(field, { target: { value: 'bulunmayan' } });
    expect(screen.getByText(/Aramanızla eşleşen sonuç yok/)).toBeVisible();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filtreyi temizle' }));
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('does not wait for client logging before querying or presenting results', async () => {
    ports.log.mockReturnValue(new Promise(() => undefined));
    const view = setup(); await view.open();
    expect(view.query).toHaveBeenCalledOnce();
    expect(screen.getByText('Işık Parkı')).toBeVisible();
    expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'false');
  });

  it('does not send query values or record addresses to client logging', async () => {
    const view = setup();
    view.manager.GetQueryParams = () => ({ search: 'PRIVATE_TEST_VALUE' });
    await view.open();
    fireEvent.click(screen.getByRole('button', { name: 'Işık Parkı — Haritada göster' }));
    await waitFor(() => expect(ports.log).toHaveBeenCalledTimes(2));
    const logged = JSON.stringify(ports.log.mock.calls);
    expect(logged).toContain('query-fields:1');
    expect(logged).toContain('record-detail-opened');
    expect(logged).not.toContain('PRIVATE_TEST_VALUE');
    expect(logged).not.toContain('Çankaya');
  });

  it('destroys a superseded layer without replacing the newer query layer', async () => {
    const first = deferred<{ layerObj: ReturnType<typeof makeLayer> }>();
    const stale = makeLayer(); const current = makeLayer();
    ports.layer.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ layerObj: current });
    const view = setup();
    let firstOpen!: Promise<void>;
    act(() => { firstOpen = Promise.resolve(view.ref.current!.OnShow()); });
    await waitFor(() => expect(ports.layer).toHaveBeenCalledOnce());
    await view.open();
    await act(async () => { first.resolve({ layerObj: stale }); await firstOpen; });
    expect(stale.destroy).toHaveBeenCalledOnce();
    expect(ports.add).toHaveBeenCalledTimes(1);
    expect(ports.add).toHaveBeenCalledWith(current);
    expect(current.destroy).not.toHaveBeenCalled();
    expect(view.manager.ShowMessage).not.toHaveBeenCalled();
  });

  it('destroys a layer resolving after the window has closed', async () => {
    const pending = deferred<{ layerObj: ReturnType<typeof makeLayer> }>();
    const stale = makeLayer(); ports.layer.mockReturnValueOnce(pending.promise);
    const view = setup(); let opening!: Promise<void>;
    act(() => { opening = Promise.resolve(view.ref.current!.OnShow()); });
    await waitFor(() => expect(ports.layer).toHaveBeenCalledOnce());
    act(() => view.ref.current!.OnClose());
    await act(async () => { pending.resolve({ layerObj: stale }); await opening; });
    expect(stale.destroy).toHaveBeenCalledOnce();
    expect(ports.add).not.toHaveBeenCalled();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('ignores a detail response after closing without moving the map', async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const query = vi.fn().mockResolvedValueOnce(success()).mockReturnValueOnce(pending.promise);
    const view = setup(query); await view.open();
    fireEvent.click(screen.getByRole('button', { name: 'Işık Parkı — Haritada göster' }));
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    const control = query.mock.calls[1]?.[2] as { signal?: AbortSignal } | undefined;
    expect(control?.signal).toBeInstanceOf(AbortSignal);
    act(() => view.ref.current!.OnClose());
    expect(control?.signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(success(1)); });
    expect(ports.zoom).not.toHaveBeenCalled();
    expect(view.manager.ToggleMinimiseWindow).not.toHaveBeenCalled();
    expect(view.manager.ShowMessage).not.toHaveBeenCalled();
  });  it('closes the actual managed query before revealing the persistent navigation', async () => {
    const manager = createWindowManager();
    manager.RegisterPlaceholder('sidebar');
    const Component = createManagedFastAccessQueryWindow({ title: 'Parklar', serviceKey: 'parks', business: { Query: vi.fn(async () => success()) } });
    const Loaded = lazy(async () => ({ default: Component }));
    const view = render(<LazyManagedWindow id="return-services-fixture" label="Parklar" component={Loaded} windowManager={manager} />);
    act(() => { manager.ShowWindow('return-services-fixture'); });
    await screen.findByText('Işık Parkı');
    act(() => { manager.ShowWindow('sidebar'); });
    expect(manager.IsVisible('return-services-fixture')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hizmetlere dön' }));
    await waitFor(() => expect(screen.queryByText('Işık Parkı')).not.toBeInTheDocument());
    expect(manager.IsVisible('return-services-fixture')).toBe(false);
    expect(manager.IsVisible('sidebar')).toBe(true);
    view.unmount(); manager.UnregisterWindow('sidebar'); manager.Dispose();
  });

  it('keeps focus in place when result reveal was activated without keyboard focus', async () => {
    const view = setup(vi.fn(async () => success(1_000)));
    await view.open();
    const callbacks: FrameRequestCallback[] = [];
    const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    try {
      const filter = screen.getByRole('searchbox');
      filter.focus();
      filter.blur();
      fireEvent.click(screen.getByRole('button', { name: /Daha fazla sonuç göster/ }));
      act(() => { callbacks.forEach((callback) => callback(0)); });
      expect(document.activeElement).toBe(document.body);
      expect(view.query).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

});
