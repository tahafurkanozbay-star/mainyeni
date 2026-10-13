import { StrictMode, createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { SketchWidget } from './SketchWidget';
const runtime = vi.hoisted(() => ({ load: vi.fn(), getView: vi.fn(), construct: vi.fn(), layerDestroy: vi.fn(), sketchDestroy: vi.fn(), cancel: vi.fn(), clear: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock('../../../gis-engine/arcgisModuleRuntime', () => ({ loadArcgisModules: runtime.load }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: runtime.getView } }));
const manager = () => ({ IsVisible: () => true, IsMinimized: () => false, ShowWindow: vi.fn(), RegisterWindow: vi.fn(), UnregisterWindow: vi.fn(), HideWindow: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowMessage: vi.fn() });
const setup = () => { const ref = createRef<ManagedWindowHandle>(); const windowManager = manager(); return { ...render(<SketchWidget id="sketch-test" windowManager={windowManager} ref={ref} />), ref, windowManager }; };
beforeEach(() => {
  vi.clearAllMocks(); runtime.getView.mockReturnValue({ map: { add: runtime.add, remove: runtime.remove } });
  runtime.load.mockResolvedValue([
    class Sketch { constructor() { runtime.construct(); } cancel = runtime.cancel; destroy = runtime.sketchDestroy; },
    class GraphicsLayer { removeAll = runtime.clear; destroy = runtime.layerDestroy; },
  ]);
});
describe('sketch resource ownership', () => {
  it('does not load a closed tool until its real managed OnShow', async () => {
    const { ref, windowManager } = setup(); expect(runtime.load).not.toHaveBeenCalled();
    await act(async () => { ref.current?.OnShow?.(); });
    expect(runtime.add).toHaveBeenCalledTimes(1); expect(windowManager.ShowWindow).not.toHaveBeenCalled();
  });
  it('removes and destroys the layer if the SDK widget constructor fails', async () => {
    runtime.construct.mockImplementationOnce(() => { throw new Error('construction failed'); });
    const { ref } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    expect(runtime.remove).toHaveBeenCalledTimes(1); expect(runtime.layerDestroy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    await waitFor(() => expect(runtime.construct).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Çizim katmanı hazır')).toBeVisible();
  });
  it('disposes against the original map even if the active map changes', async () => {
    const { ref, unmount } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    const wrongRemove = vi.fn(); runtime.getView.mockReturnValue({ map: { remove: wrongRemove } });
    unmount(); expect(runtime.remove).toHaveBeenCalledTimes(1); expect(wrongRemove).not.toHaveBeenCalled();
    expect(runtime.layerDestroy).toHaveBeenCalledTimes(1); expect(runtime.sketchDestroy).toHaveBeenCalledTimes(1);
  });
  it('still releases the layer if sketch cancellation and widget disposal fail', async () => {
    const { ref, unmount } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    runtime.cancel.mockImplementationOnce(() => { throw new Error('cancel failed'); });
    runtime.sketchDestroy.mockImplementationOnce(() => { throw new Error('destroy failed'); });
    unmount(); expect(runtime.remove).toHaveBeenCalledTimes(1); expect(runtime.layerDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('sketch reopening and bounded admission', () => {
  it('coalesces repeated openings while the module is pending', async () => {
    let finish: (modules: unknown[]) => void = () => undefined;
    const modules = await runtime.load(); runtime.load.mockClear();
    runtime.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { ref } = setup();
    await act(async () => { ref.current?.OnShow?.(); ref.current?.OnShow?.(); });
    expect(runtime.load).toHaveBeenCalledTimes(1);
    await act(async () => { finish(modules); });
    expect(runtime.construct).toHaveBeenCalledTimes(1);
  });
  it('survives StrictMode replay before the first managed opening', async () => {
    const ref = createRef<ManagedWindowHandle>(); const windowManager = manager();
    render(<StrictMode><SketchWidget id="sketch-test" windowManager={windowManager} ref={ref} /></StrictMode>);
    await act(async () => { ref.current?.OnShow?.(); });
    expect(runtime.construct).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Çizim katmanı hazır')).toBeVisible();
  });
  it('rebinds to the current view and retires the old resources on reopen', async () => {
    const { ref } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    const nextAdd = vi.fn(); const nextRemove = vi.fn();
    runtime.getView.mockReturnValue({ map: { add: nextAdd, remove: nextRemove } });
    await act(async () => { ref.current?.OnClose?.(); ref.current?.OnShow?.(); });
    expect(runtime.remove).toHaveBeenCalledTimes(1);
    expect(runtime.layerDestroy).toHaveBeenCalledTimes(1);
    expect(nextAdd).toHaveBeenCalledTimes(1);
    expect(nextRemove).not.toHaveBeenCalled();
    expect(runtime.construct).toHaveBeenCalledTimes(2);
  });
  it('ignores old module failure after closing and reopening into a ready tool', async () => {
    let rejectOld: (error: Error) => void = () => undefined;
    runtime.load.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const { ref } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    await act(async () => { ref.current?.OnClose?.(); ref.current?.OnShow?.(); });
    await waitFor(() => expect(runtime.construct).toHaveBeenCalledTimes(1));
    await act(async () => { rejectOld(new Error('obsolete failure')); });
    expect(screen.getByText('Çizim katmanı hazır')).toBeVisible();
    expect(runtime.sketchDestroy).not.toHaveBeenCalled();
  });
  it('refuses admission to a superseded map before constructing the SDK tool', async () => {
    const modules = await runtime.load(); runtime.load.mockClear();
    let finish: (modules: unknown[]) => void = () => undefined;
    runtime.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { ref } = setup(); await act(async () => { ref.current?.OnShow?.(); });
    runtime.getView.mockReturnValue({ map: { add: vi.fn(), remove: vi.fn() } });
    await act(async () => { finish(modules); });
    expect(runtime.construct).not.toHaveBeenCalled();
    expect(runtime.add).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Harita hazır olduğunda yeniden deneyin.');
  });
  it('bounds stalled SDK admission and permits an explicit retry', async () => {
    runtime.load.mockImplementationOnce(() => new Promise(() => undefined));
    const { ref } = setup(); vi.useFakeTimers();
    try {
      await act(async () => { ref.current?.OnShow?.(); await vi.advanceTimersByTimeAsync(15_001); });
      expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeVisible();
    } finally { vi.useRealTimers(); }
    fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
    await waitFor(() => expect(runtime.construct).toHaveBeenCalledTimes(1));
  });
});
