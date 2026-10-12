import { createRef } from 'react';
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
