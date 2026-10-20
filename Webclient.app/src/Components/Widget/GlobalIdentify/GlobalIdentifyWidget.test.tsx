import { createRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { GlobalIdentifyWidget } from './GlobalIdentifyWidget';
const runtime = vi.hoisted(() => ({ run: vi.fn(), cancel: vi.fn(), getView: vi.fn(), getActiveView: vi.fn(), getClick: vi.fn() }));
vi.mock('../../../gis-engine/identifyRuntime', () => ({ createIdentifySession: () => ({ run: runtime.run, cancel: runtime.cancel }) }));
vi.mock('../../../Store/Managers/MapManager', () => ({ default: { GetMapView: runtime.getView, GetActiveMapView: runtime.getActiveView, GetMapClickEvent: runtime.getClick } }));
vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({ GisGraphicsHelper: { RemoveGraphics: vi.fn() } }));
const manager = () => ({ IsVisible: () => true, IsMinimized: () => false, ShowWindow: vi.fn(), RegisterWindow: vi.fn(), UnregisterWindow: vi.fn(), HideWindow: vi.fn(), ToggleMinimiseWindow: vi.fn(), ShowMessage: vi.fn() });
const deferred = () => {
  let resolve: (value: { groups: Array<{ layerName: string; features: [] }> }) => void = () => undefined;
  const promise = new Promise<{ groups: Array<{ layerName: string; features: [] }> }>(yes => { resolve = yes; });
  return { promise, resolve };
};
const setup = () => {
  const ref = createRef<ManagedWindowHandle>(); const windowManager = manager();
  return { ...render(<GlobalIdentifyWidget id="identify-test" ref={ref} windowManager={windowManager} />), ref, windowManager };
};
beforeEach(() => { vi.clearAllMocks(); runtime.getView.mockReturnValue({ id: 'view' }); runtime.getActiveView.mockReturnValue(null); runtime.getClick.mockReturnValue({ mapPoint: { x: 32.85, y: 39.92 } }); });
describe('identify result ownership', () => {
  it('uses the currently visible scene view instead of the hidden base map view', async () => {
    const sceneView = { id: 'active-scene-view' };
    runtime.getActiveView.mockReturnValue(sceneView);
    runtime.run.mockResolvedValue({ groups: [] });
    const { ref } = setup();
    await act(async () => { ref.current?.OnShow?.(); });
    expect(runtime.run).toHaveBeenCalledWith(sceneView, expect.anything(), expect.objectContaining({ returnGeometry: true }));
  });

  it('opens its own surface without activating another window', async () => {
    runtime.run.mockResolvedValue({ groups: [] }); const { ref, windowManager } = setup();
    await act(async () => { ref.current?.OnShow?.(); });
    expect(windowManager.ShowWindow).not.toHaveBeenCalled(); expect(screen.getByText('Bu konumda kayıt bulunamadı')).toBeVisible();
  });
  it('never displays a result from a request completed after closing', async () => {
    const pending = deferred(); runtime.run.mockReturnValue(pending.promise); const { ref } = setup();
    act(() => { ref.current?.OnShow?.(); });
    await waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(1));
    await act(async () => { ref.current?.OnClose?.(); pending.resolve({ groups: [{ layerName: 'Late result', features: [] }] }); });
    expect(screen.queryByText('Late result')).toBeNull(); expect(document.getElementById('identify-test-surface')).not.toHaveAttribute('aria-busy', 'true');
  });
  it('does not let the previous completion clear the latest request loading state', async () => {
    const first = deferred(); const second = deferred(); runtime.run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { ref } = setup(); act(() => { ref.current?.OnShow?.(); ref.current?.OnShow?.(); });
    await act(async () => { first.resolve({ groups: [{ layerName: 'Obsolete result', features: [] }] }); });
    expect(screen.queryByText('Obsolete result')).toBeNull(); expect(document.getElementById('identify-test-surface')).toHaveAttribute('aria-busy', 'true');
    await act(async () => { second.resolve({ groups: [] }); });
    expect(document.getElementById('identify-test-surface')).not.toHaveAttribute('aria-busy', 'true');
  });
});
