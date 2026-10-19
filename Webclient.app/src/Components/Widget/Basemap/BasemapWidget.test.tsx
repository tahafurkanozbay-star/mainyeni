import { StrictMode, createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ArcgisAccessorWatch } from '../../../gis-engine/arcgisReactiveRuntime';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { BasemapWidget } from './BasemapWidget';
import type { SelectableBasemap } from './basemapSelection';

const runtime = vi.hoisted(() => ({ loadModules: vi.fn(), getMapView: vi.fn(), fromId: vi.fn(), load: vi.fn(), destroyed: vi.fn(), cancel: vi.fn(), watch: vi.fn<ArcgisAccessorWatch>(() => ({ remove: vi.fn() })), storeListeners: new Set<() => void>() }));
vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: runtime.loadModules }));
vi.mock('../../../Store/Store', () => ({ default: { subscribe: (listener: () => void) => { runtime.storeListeners.add(listener); return () => runtime.storeListeners.delete(listener); } } }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: runtime.getMapView } }));
const createWindowManager = (visible = true) => ({
  IsVisible: vi.fn(() => visible), IsMinimized: vi.fn(() => false), ToggleMinimiseWindow: vi.fn(),
  HideWindow: vi.fn(), ShowMessage: vi.fn(), ShowWindow: vi.fn(), RegisterWindow: vi.fn(), UnregisterWindow: vi.fn(),
});
const renderWidget = (visible = true) => {
  const windowManager = createWindowManager(visible); const ref = createRef<ManagedWindowHandle>();
  return { ...render(<BasemapWidget id="basemap-test" windowManager={windowManager} ref={ref} />), ref, windowManager };
};
const optionsReady = () => screen.findByRole('button', { name: /^Topoğrafya$/ });
let map: { basemap: SelectableBasemap | null };
const candidate = (id: string): SelectableBasemap => ({ id, load: runtime.load, cancelLoad: runtime.cancel, destroy: runtime.destroyed });
beforeEach(() => {
  vi.clearAllMocks(); runtime.watch.mockReset().mockImplementation(() => ({ remove: vi.fn() })); runtime.storeListeners.clear(); map = { basemap: { id: 'osm' } };
  runtime.getMapView.mockReturnValue({ map }); runtime.fromId.mockImplementation(candidate);
  runtime.load.mockResolvedValue(undefined); runtime.loadModules.mockResolvedValue([{ fromId: runtime.fromId }, { watch: runtime.watch }]);
});
afterEach(() => vi.useRealTimers());

describe('native on-demand basemap selection', () => {
  it('bounds a stalled selection and cancels SDK work while retaining the current map', async () => {
    renderWidget(); await optionsReady();
    vi.useFakeTimers(); runtime.load.mockImplementation(() => new Promise(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(screen.getByText(/Seçilen altlık yüklenemedi/)).toBeVisible();
    expect(map.basemap?.id).toBe('osm'); expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.destroyed).toHaveBeenCalledTimes(18);
  });
  it('registers while closed without loading SDK modules or basemap metadata', () => {
    const { windowManager } = renderWidget(false);
    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
    expect(runtime.loadModules).not.toHaveBeenCalled(); expect(runtime.load).not.toHaveBeenCalled();
  });
  it('loads only the Basemap constructor and presents all existing supported choices', async () => {
    renderWidget(); await optionsReady();
    expect(runtime.loadModules).toHaveBeenCalledWith(['esri/Basemap', 'esri/core/watchUtils']);
    expect(screen.getByRole('group', { name: 'Altlık harita seçenekleri' }).children).toHaveLength(17);
    expect(runtime.load).not.toHaveBeenCalled();
    expect(runtime.destroyed).toHaveBeenCalledTimes(17);
  });
  it('uses a provided HTTPS thumbnail for a basemap preview', async () => {
    runtime.fromId.mockImplementation((id: string) => ({ ...candidate(id), thumbnailUrl: id === 'satellite' ? 'https://static.arcgis.com/basemaps/satellite/thumb.jpg' : undefined }));
    renderWidget();
    await optionsReady();
    const satellite = screen.getByRole('button', { name: /^Uydu$/ });
    expect(satellite.querySelector('img.basemap-picker__image')).toHaveAttribute('src', 'https://static.arcgis.com/basemaps/satellite/thumb.jpg');
    expect(screen.getByRole('button', { name: /^Topoğrafya$/ }).querySelector('svg[data-preview-id="topo"]')).toBeInTheDocument();
  });

  it('filters unsupported SDK options and labels the current basemap', async () => {
    runtime.fromId.mockImplementation((id: string) => id === 'oceans' ? null : candidate(id));
    renderWidget(); await optionsReady();
    expect(screen.queryByRole('button', { name: /Okyanuslar/ })).toBeNull();
    expect(screen.getByRole('button', { name: /OpenStreetMap/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('16 altlık harita seçeneği')).toBeVisible();
  });
  it('does not download metadata again for the already selected map', async () => {
    renderWidget(); await optionsReady(); fireEvent.click(screen.getByRole('button', { name: /OpenStreetMap/ }));
    expect(runtime.load).not.toHaveBeenCalled();
  });
  it('keeps the existing map until a selected basemap finishes loading', async () => {
    let finish: () => void = () => undefined;
    runtime.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    renderWidget(); await optionsReady(); fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(runtime.load).toHaveBeenCalledTimes(1)); expect(map.basemap?.id).toBe('osm');
    await act(async () => { finish(); });
    expect(map.basemap?.id).toBe('topo');
    expect(screen.getByRole('button', { name: /^Topoğrafya$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(runtime.destroyed).toHaveBeenCalledTimes(17);
  });
  it('contains remote failures and preserves operational layers and the current map', async () => {
    runtime.load.mockRejectedValue(new Error('private upstream details'));
    renderWidget(); await optionsReady(); fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    expect(await screen.findByText(/Seçilen altlık yüklenemedi/)).toBeVisible();
    expect(screen.queryByText('private upstream details')).toBeNull(); expect(map.basemap?.id).toBe('osm');
    expect(runtime.destroyed).toHaveBeenCalledTimes(18);
  });
  it('supports a different choice after failure', async () => {
    runtime.load.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    renderWidget(); await optionsReady(); fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await screen.findByText(/Seçilen altlık yüklenemedi/);
    fireEvent.click(screen.getByRole('button', { name: /^Açık gri$/ }));
    await waitFor(() => expect(map.basemap?.id).toBe('gray'));
    expect(screen.queryByText(/Seçilen altlık yüklenemedi/)).toBeNull();
  });
  it('supersedes a slow selection without allowing it to overwrite the next map', async () => {
    let finish: () => void = () => undefined;
    runtime.load.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    renderWidget(); await optionsReady(); fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(runtime.load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /^Açık gri$/ }));
    await waitFor(() => expect(map.basemap?.id).toBe('gray'));
    await act(async () => { finish(); });
    expect(map.basemap?.id).toBe('gray'); expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.destroyed).toHaveBeenCalledTimes(18);
  });
  it('releases a stalled selection on close even if the SDK ignores AbortSignal', async () => {
    runtime.load.mockImplementation(() => new Promise(() => undefined));
    const { ref } = renderWidget(); await optionsReady(); fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(runtime.load).toHaveBeenCalledTimes(1));
    await act(async () => { ref.current?.OnClose?.(); });
    expect(map.basemap?.id).toBe('osm'); expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.destroyed).toHaveBeenCalledTimes(18);
  });
  it('can reload a failed constructor explicitly without a retry loop', async () => {
    runtime.loadModules.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([{ fromId: runtime.fromId }, { watch: runtime.watch }]);
    renderWidget(); await screen.findByText('Altlık seçenekleri açılamadı');
    expect(runtime.loadModules).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Seçenekleri yeniden yükle' }));
    await optionsReady(); expect(runtime.loadModules).toHaveBeenCalledTimes(2);
  });
  it('limits failed constructor retries to three per opening', async () => {
    runtime.loadModules.mockRejectedValue(new Error('unavailable'));
    renderWidget(); await screen.findByText('Altlık seçenekleri açılamadı');
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Seçenekleri yeniden yükle' }));
      await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(i + 2));
      await screen.findByText('Altlık seçenekleri açılamadı');
    }
    expect(screen.queryByRole('button', { name: 'Seçenekleri yeniden yükle' })).toBeNull();
  });
  it('does not close its own managed window and reuses the lightweight option catalog', async () => {
    const { ref, windowManager } = renderWidget(); await optionsReady();
    await act(async () => { ref.current?.OnShow?.(); });
    expect(windowManager.ShowWindow).not.toHaveBeenCalled(); expect(runtime.loadModules).toHaveBeenCalledTimes(1);
  });
  it('unregisters on unmount and leaves the applied map alive', async () => {
    const { unmount, windowManager } = renderWidget(); await optionsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ })); await waitFor(() => expect(map.basemap?.id).toBe('topo'));
    unmount(); expect(runtime.destroyed).toHaveBeenCalledTimes(17); expect(windowManager.UnregisterWindow).toHaveBeenCalledTimes(1);
  });
  it('keeps the catalog usable through StrictMode replay', async () => {
    const windowManager = createWindowManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<StrictMode><BasemapWidget id="basemap-test" windowManager={windowManager} ref={ref} /></StrictMode>);
    await optionsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(map.basemap?.id).toBe('topo'));
    expect(screen.getByRole('button', { name: /^Topoğrafya$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores an obsolete catalog rejection after close and reopen', async () => {
    let rejectOld: (error: Error) => void = () => undefined;
    runtime.loadModules.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const { ref } = renderWidget();
    await waitFor(() => expect(runtime.loadModules).toHaveBeenCalledTimes(1));
    await act(async () => { ref.current?.OnClose?.(); ref.current?.OnShow?.(); });
    await optionsReady();
    await act(async () => { rejectOld(new Error('obsolete private details')); });
    expect(screen.queryByText('Altlık seçenekleri açılamadı')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Açık gri$/ }));
    await waitFor(() => expect(map.basemap?.id).toBe('gray'));
  });

  it('does not apply a late selection to a superseded map', async () => {
    let finish: () => void = () => undefined;
    runtime.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    renderWidget(); await optionsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(runtime.load).toHaveBeenCalledTimes(1));
    const nextMap = { basemap: { id: 'gray' } };
    runtime.getMapView.mockReturnValue({ map: nextMap });
    await act(async () => { finish(); });
    expect(map.basemap?.id).toBe('osm');
    expect(nextMap.basemap.id).toBe('gray');
    expect(runtime.destroyed).toHaveBeenCalledTimes(18);
    expect(screen.queryByText(/Seçilen altlık yükleniyor/)).toBeNull();
  });

  it('explains unavailable map readiness instead of silently ignoring selection', async () => {
    renderWidget(); await optionsReady();
    runtime.getMapView.mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    expect(screen.getByText(/harita görünümünün hazır olmasını bekleyin/)).toBeVisible();
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it('restores modeless opener focus when the real window hides', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Altlıkları aç'; document.body.appendChild(opener); opener.focus();
    const { ref, windowManager, rerender } = renderWidget(false);
    windowManager.IsVisible.mockReturnValue(true);
    rerender(<BasemapWidget id="basemap-test" windowManager={windowManager} ref={ref} />);
    await act(async () => { ref.current?.OnShow?.(); });
    await optionsReady();
    screen.getByRole('button', { name: /^Topoğrafya$/ }).focus();
    windowManager.IsVisible.mockReturnValue(false);
    rerender(<BasemapWidget id="basemap-test" windowManager={windowManager} ref={ref} />);
    expect(opener).toHaveFocus(); opener.remove();
  });

  it('cancels a pending change when the currently displayed option is selected again', async () => {
    let finish: () => void = () => undefined;
    runtime.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    renderWidget(); await optionsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /OpenStreetMap/ }));
    await act(async () => { finish(); });
    expect(map.basemap?.id).toBe('osm');
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Yüklemeyi iptal et' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenStreetMap/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('coalesces repeated pending selections and explicitly cancels without accepting a late result', async () => {
    let finish: () => void = () => undefined;
    runtime.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    renderWidget(); const option = await optionsReady();
    fireEvent.click(option); fireEvent.click(option);
    await waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    const cancel = screen.getByRole('button', { name: 'Yüklemeyi iptal et' });
    cancel.focus(); fireEvent.click(cancel);
    await act(async () => { finish(); });
    expect(map.basemap?.id).toBe('osm');
    expect(runtime.load).toHaveBeenCalledOnce();
    expect(option).toHaveFocus();
  });

  it('hands focused cancellation control back to its option on completion without overriding outside focus', async () => {
    let finish: () => void = () => undefined;
    runtime.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    renderWidget(); const option = await optionsReady(); fireEvent.click(option);
    await waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    screen.getByRole('button', { name: 'Yüklemeyi iptal et' }).focus();
    await act(async () => { finish(); });
    expect(option).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /^Açık gri$/ }));
    await waitFor(() => expect(runtime.load).toHaveBeenCalledTimes(2));
    screen.getByRole('button', { name: 'Yüklemeyi iptal et' }).focus();
    const search = screen.getByRole('searchbox', { name: 'Altlık ara' }); search.focus();
    await act(async () => { finish(); });
    expect(search).toHaveFocus();
  });

  it('filters local choices using normalized Turkish words and restores the full catalog without SDK work', async () => {
    renderWidget(); await optionsReady();
    const search = screen.getByRole('searchbox', { name: 'Altlık ara' });
    fireEvent.change(search, { target: { value: 'ACIK GRI' } });
    expect(screen.getByText('2 / 17 altlık gösteriliyor')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Açık gri$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Topoğrafya$/ })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'eşleşmeyen' } });
    expect(screen.getByText('Eşleşen altlık bulunamadı')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Altlık aramasını temizle' }));
    expect(search).toHaveFocus();
    expect(screen.getByRole('group', { name: 'Altlık harita seçenekleri' }).children).toHaveLength(17);
    expect(runtime.loadModules).toHaveBeenCalledOnce(); expect(runtime.load).not.toHaveBeenCalled();
  });

  it('returns cancellation focus to search if its option was filtered out', async () => {
    runtime.load.mockImplementation(() => new Promise(() => undefined));
    renderWidget(); fireEvent.click(await optionsReady());
    const search = screen.getByRole('searchbox', { name: 'Altlık ara' });
    fireEvent.change(search, { target: { value: 'uydu' } });
    const cancel = screen.getByRole('button', { name: 'Yüklemeyi iptal et' });
    cancel.focus(); fireEvent.click(cancel);
    expect(search).toHaveFocus();
  });

  it('observes a foreign basemap change and cancels stale work without destroying the foreign map', async () => {
    const callbacks: Array<{ target: unknown; property: string; callback: () => void; remove: ReturnType<typeof vi.fn> }> = [];
    runtime.watch.mockImplementation((target, property, callback) => {
      const remove = vi.fn(); callbacks.push({ target, property, callback: () => callback(undefined), remove }); return { remove };
    });
    let finish: () => void = () => undefined;
    runtime.load.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { unmount } = renderWidget(); fireEvent.click(await optionsReady());
    await waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    const foreign = { id: 'gray', destroy: vi.fn() }; map.basemap = foreign;
    await act(async () => { callbacks.find(c => c.target === map && c.property === 'basemap')!.callback(); finish(); });
    expect(map.basemap).toBe(foreign); expect(foreign.destroy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Açık gri$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Yüklemeyi iptal et' })).not.toBeInTheDocument();
    unmount(); expect(callbacks.every(c => c.remove.mock.calls.length > 0)).toBe(true);
    expect(runtime.storeListeners.size).toBe(0);
  });

  it('cancels work immediately when the shared map view is replaced', async () => {
    runtime.load.mockImplementation(() => new Promise(() => undefined));
    renderWidget(); fireEvent.click(await optionsReady());
    await waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    const replacement = { basemap: { id: 'gray' } };
    await act(async () => {
      runtime.getMapView.mockReturnValue({ map: replacement });
      runtime.storeListeners.forEach(listener => listener());
    });
    expect(map.basemap?.id).toBe('osm'); expect(replacement.basemap.id).toBe('gray');
    expect(screen.getByRole('button', { name: /^Açık gri$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(runtime.cancel).toHaveBeenCalledOnce();
  });

  it('isolates a failing catalog option and never displays constructor failure details', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runtime.fromId.mockImplementation((id: string) => { if (id === 'oceans') throw new Error('private-provider-value'); return candidate(id); });
    renderWidget(); await optionsReady();
    expect(screen.getByText('16 altlık harita seçeneği')).toBeVisible();
    expect(screen.queryByText(/private-provider-value/)).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('releases its own detached applied basemap while preserving the original and currently displayed maps', async () => {
    const created: Array<SelectableBasemap & { destroy: ReturnType<typeof vi.fn> }> = [];
    runtime.fromId.mockImplementation((id: string) => { const item = { id, load: runtime.load, destroy: vi.fn() }; created.push(item); return item; });
    const original = { id: 'osm', destroy: vi.fn() }; map.basemap = original;
    const { unmount } = renderWidget(); await optionsReady();
    fireEvent.click(screen.getByRole('button', { name: /^Topoğrafya$/ }));
    await waitFor(() => expect(map.basemap?.id).toBe('topo'));
    const appliedTopo = map.basemap as typeof created[number];
    fireEvent.click(screen.getByRole('button', { name: /^Açık gri$/ }));
    await waitFor(() => expect(map.basemap?.id).toBe('gray'));
    expect(appliedTopo.destroy).toHaveBeenCalledOnce();
    expect(original.destroy).not.toHaveBeenCalled();
    const appliedGray = map.basemap as typeof created[number];
    unmount(); expect(appliedGray.destroy).not.toHaveBeenCalled();
  });

  it('does not send focus into the hidden gallery when it closes with Cancel focused', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    runtime.load.mockImplementation(() => new Promise(() => undefined));
    const { ref, windowManager, rerender } = renderWidget(); fireEvent.click(await optionsReady());
    screen.getByRole('button', { name: 'Yüklemeyi iptal et' }).focus();
    act(() => { ref.current?.OnClose?.(); windowManager.IsVisible.mockReturnValue(false); });
    rerender(<BasemapWidget id="basemap-test" windowManager={windowManager} ref={ref} />);
    expect(opener).toHaveFocus(); opener.remove();
  });

});
