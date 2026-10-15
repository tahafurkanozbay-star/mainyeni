import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { SketchWidget } from './SketchWidget';

const state = vi.hoisted(() => ({
  load: vi.fn(), getView: vi.fn(), add: vi.fn(), remove: vi.fn(),
  layerDestroy: vi.fn(), sketchDestroy: vi.fn(), clear: vi.fn(),
  listeners: new Set<() => void>(),
  watches: [] as Array<{ target: unknown; property: string; callback: () => void; remove: ReturnType<typeof vi.fn> }>,
  layers: [] as Array<{ graphics: { length: number } }>,
  sketches: [] as Array<{ activeTool: string | null }>,
}));
vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: state.load }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: state.getView } }));
vi.mock('../../../Store/Store', () => ({ default: {
  subscribe: (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
} }));
const notify = (target: unknown, property: string): void => {
  for (const watch of state.watches) {
    if (watch.target === target && watch.property === property && watch.remove.mock.calls.length === 0) watch.callback();
  }
};
const nextView = () => ({ ready: true, destroyed: false, map: { add: vi.fn(), remove: vi.fn() } });
const setup = () => {
  const ref = createRef<ManagedWindowHandle>();
  let visible = true;
  const windowManager = {
    IsVisible: () => visible, IsMinimized: () => false, ShowWindow: vi.fn(),
    RegisterWindow: vi.fn(), UnregisterWindow: vi.fn(), HideWindow: vi.fn(),
    ToggleMinimiseWindow: vi.fn(), ShowMessage: vi.fn(),
  };
  const result = render(<SketchWidget id="sketch-lifecycle" windowManager={windowManager} ref={ref} />);
  return { ...result, ref, hide: () => {
    visible = false;
    result.rerender(<SketchWidget id="sketch-lifecycle" windowManager={windowManager} ref={ref} />);
  } };
};
const open = async (ref: ReturnType<typeof createRef<ManagedWindowHandle>>): Promise<void> => {
  await act(async () => { ref.current?.OnShow?.(); });
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
};
const draw = async (count: number): Promise<void> => {
  await act(async () => { const layer = state.layers.at(-1)!; layer.graphics.length = count; notify(layer.graphics, 'length'); });
};
beforeEach(() => {
  vi.clearAllMocks(); state.listeners.clear(); state.watches.length = 0; state.layers.length = 0; state.sketches.length = 0;
  state.getView.mockReturnValue({ ready: true, map: { add: state.add, remove: state.remove } });
  state.load.mockResolvedValue([
    class Sketch {
      activeTool: string | null = null;
      constructor() { state.sketches.push(this); }
      cancel = () => { this.activeTool = null; notify(this, 'activeTool'); };
      destroy = state.sketchDestroy;
    },
    class GraphicsLayer {
      graphics = { length: 0 };
      constructor() { state.layers.push(this); }
      removeAll = () => { state.clear(); this.graphics.length = 0; notify(this.graphics, 'length'); };
      destroy = state.layerDestroy;
    },
    { watch: (target: unknown, property: string, callback: () => void) => {
      const remove = vi.fn(); state.watches.push({ target, property, callback, remove }); return { remove };
    } },
  ]);
});

describe('sketch visible view ownership', () => {
  it('retires a foreign view while open and admits only its replacement', async () => {
    const { ref } = setup(); await open(ref);
    const staleCount = state.watches.find(w => w.property === 'length')!;
    const view = nextView(); state.getView.mockReturnValue(view);
    await act(async () => { state.listeners.forEach(listener => listener()); });
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(view.map.add).toHaveBeenCalledTimes(1);
    expect(state.sketchDestroy).toHaveBeenCalledTimes(1);
    expect(staleCount.remove).toHaveBeenCalledTimes(1);
    state.layers[0]!.graphics.length = 99;
    await act(async () => { staleCount.callback(); });
    expect(screen.getByText('0 çizim')).toBeVisible();
  });
  it('waits for actual view readiness and recovers without reopening', async () => {
    const view = nextView(); view.ready = false; state.getView.mockReturnValue(view);
    const { ref } = setup(); await open(ref);
    expect(state.sketches).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('henüz hazır değil');
    await act(async () => { view.ready = true; notify(view, 'ready'); });
    expect(state.sketches).toHaveLength(1);
    expect(screen.getByText('Çizim katmanı hazır')).toBeVisible();
  });
  it('releases a destroyed view and recreates the SDK child when readiness returns', async () => {
    const view = nextView(); state.getView.mockReturnValue(view);
    const { ref, container } = setup(); await open(ref); await draw(2);
    await act(async () => { view.destroyed = true; notify(view, 'destroyed'); });
    expect(state.layerDestroy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 çizim')).toBeVisible();
    await act(async () => { view.destroyed = false; notify(view, 'destroyed'); });
    expect(state.sketches).toHaveLength(2);
    expect(container.querySelector('.sketch-widget__tools')?.children).toHaveLength(1);
  });
  it('removes store and SDK observers on hide/unmount, and ignores old callbacks', async () => {
    const { ref, hide, unmount } = setup(); await open(ref);
    const watches = [...state.watches]; hide();
    expect(state.listeners.size).toBe(0);
    expect(watches.every(w => w.remove.mock.calls.length === 1)).toBe(true);
    await act(async () => { watches.forEach(w => w.callback()); });
    expect(state.sketches).toHaveLength(1);
    unmount(); expect(state.layerDestroy).toHaveBeenCalledTimes(1);
  });
  it('refuses a late module result after visibility disappears without OnClose', async () => {
    const modules = await state.load();
    let finish: (value: unknown) => void = () => undefined;
    state.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { ref, hide } = setup(); await open(ref); hide();
    await act(async () => { finish(modules); });
    expect(state.sketches).toHaveLength(0);
    expect(state.watches).toHaveLength(0);
    expect(state.listeners.size).toBe(0);
  });
});

describe('sketch drawing feedback and deliberate clearing', () => {
  it('counts actual graphics, confirms bulk deletion, and restores safe keyboard focus', async () => {
    const { ref } = setup(); await open(ref);
    const clear = screen.getByRole('button', { name: 'Çizimleri temizle' });
    expect(clear).toBeDisabled(); await draw(3);
    expect(screen.getByText('3 çizim')).toBeVisible(); clear.focus(); fireEvent.click(clear);
    expect(screen.getByRole('button', { name: 'Vazgeç' })).toHaveFocus();
    expect(state.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(screen.getByRole('button', { name: 'Çizimleri temizle' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Çizimleri temizle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tümünü sil' }));
    expect(state.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 çizim')).toBeVisible();
    expect(screen.getByText(/Bir çizim aracı seçin/).parentElement).toHaveFocus();
  });
  it('cancels the active operation while retaining completed graphics', async () => {
    const { ref } = setup(); await open(ref); await draw(2);
    await act(async () => { const sketch = state.sketches[0]!; sketch.activeTool = 'polygon'; notify(sketch, 'activeTool'); });
    const cancel = screen.getByRole('button', { name: 'Aktif işlemi iptal et' }); cancel.focus(); fireEvent.click(cancel);
    expect(screen.queryByRole('button', { name: 'Aktif işlemi iptal et' })).not.toBeInTheDocument();
    expect(screen.getByText('2 çizim')).toBeVisible(); expect(state.clear).not.toHaveBeenCalled();
    expect(screen.getByText(/Bir çizim aracı seçin/).parentElement).toHaveFocus();
  });
  it('dismisses only the clear confirmation with Escape', async () => {
    const { ref } = setup(); await open(ref); await draw(2);
    const clear = screen.getByRole('button', { name: 'Çizimleri temizle' }); clear.focus(); fireEvent.click(clear);
    const windowKey = vi.fn(); window.addEventListener('keydown', windowKey);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Vazgeç' }), { key: 'Escape' });
    expect(windowKey).not.toHaveBeenCalled(); window.removeEventListener('keydown', windowKey);
    expect(screen.getByRole('button', { name: 'Çizimleri temizle' })).toHaveFocus();
    expect(state.clear).not.toHaveBeenCalled();
  });
  it('returns focus after an initialization retry removes its focused button', async () => {
    state.load.mockRejectedValueOnce(new Error('temporary module failure'));
    const { ref } = setup(); await open(ref);
    const retry = screen.getByRole('button', { name: 'Yeniden dene' }); retry.focus(); fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('Çizim katmanı hazır')).toBeVisible());
    expect(screen.getByText(/Bir çizim aracı seçin/).parentElement).toHaveFocus();
  });
  it('preserves outside focus when the confirmed collection becomes empty elsewhere', async () => {
    const { ref } = setup(); await open(ref); await draw(2);
    const clear = screen.getByRole('button', { name: 'Çizimleri temizle' }); clear.focus(); fireEvent.click(clear);
    const outside = document.createElement('button'); document.body.append(outside); outside.focus();
    await draw(0);
    expect(screen.queryByRole('group', { name: 'Çizimleri temizleme onayı' })).not.toBeInTheDocument();
    expect(outside).toHaveFocus(); outside.remove();
  });
  it('clears close-session confirmation and does not let it reclaim focus', async () => {
    const { ref } = setup(); await open(ref); await draw(1);
    const clear = screen.getByRole('button', { name: 'Çizimleri temizle' }); clear.focus(); fireEvent.click(clear);
    await act(async () => { ref.current?.OnClose?.(); });
    expect(screen.queryByRole('group', { name: 'Çizimleri temizleme onayı' })).not.toBeInTheDocument();
    await waitFor(() => expect(state.clear).toHaveBeenCalledTimes(1));
  });
});
