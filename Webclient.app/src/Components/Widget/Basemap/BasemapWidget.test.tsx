import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { BasemapWidget } from './BasemapWidget';
import type { SelectableBasemap } from './basemapSelection';

const runtime = vi.hoisted(() => ({ loadModules: vi.fn(), getMapView: vi.fn(), fromId: vi.fn(), load: vi.fn(), destroyed: vi.fn(), cancel: vi.fn() }));
vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: runtime.loadModules }));
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
  vi.clearAllMocks(); map = { basemap: { id: 'osm' } };
  runtime.getMapView.mockReturnValue({ map }); runtime.fromId.mockImplementation(candidate);
  runtime.load.mockResolvedValue(undefined); runtime.loadModules.mockResolvedValue([{ fromId: runtime.fromId }]);
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
    expect(runtime.loadModules).toHaveBeenCalledWith(['esri/Basemap']);
    expect(screen.getByRole('group', { name: 'Altlık harita seçenekleri' }).children).toHaveLength(17);
    expect(runtime.load).not.toHaveBeenCalled();
    expect(runtime.destroyed).toHaveBeenCalledTimes(17);
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
    runtime.loadModules.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([{ fromId: runtime.fromId }]);
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
});
