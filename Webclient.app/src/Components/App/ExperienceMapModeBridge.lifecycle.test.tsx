import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperienceMapModeBridge } from './ExperienceMapModeBridge';
import { EXPERIENCE_COMMAND_EVENT, EXPERIENCE_MAP_MODE_EVENT } from '../../experience/experienceRuntime';

const ports = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn(), ready: vi.fn(), applyScene: vi.fn(), applyMap: vi.fn(), setState: vi.fn(), log: vi.fn() }));
const state = { mode: '2d', center: [32.85, 39.92], scale: 25_000, heading: 0, tilt: 0 };
vi.mock('../../Store/Managers/MapManager', () => ({ default: { GetViewStateBridge: () => ({ getState: () => state, setState: ports.setState }) } }));
vi.mock('../../Toolbox/DebugHelper', () => ({ DebugHelper: { Log: ports.log } }));
vi.mock('../../gis-engine/viewReadiness', () => ({ waitForArcgisView: ports.ready }));
vi.mock('../../gis-engine/viewRuntime', () => ({ snapshotMapViewState: () => state, applyViewStateToMapView: ports.applyMap }));
vi.mock('../../gis-engine/sceneRuntime', () => ({
  createSceneView: ports.create, destroySceneView: ports.destroy,
  applyViewStateToSceneView: ports.applyScene, snapshotSceneState: () => ({ ...state, mode: '3d', tilt: 48 }),
  bindSceneState: () => vi.fn(), synchronizeSceneViewSize: vi.fn(), waitForSceneContainer: vi.fn(async () => undefined),
}));
vi.mock('../../gis-engine/sceneExperienceRuntime', () => ({ createSceneExperienceRuntime: () => ({
  dispose: vi.fn(), setActive: vi.fn(), subscribe: () => vi.fn(),
  getSnapshot: () => ({ profile: 'balanced', status: 'ready', p95FrameMs: 0, recovery: { attempts: 0 } }),
}) }));
vi.mock('../../gis-engine/sceneNavigationRuntime', () => ({ createSceneNavigationRuntime: () => ({ dispose: vi.fn(), setHome: vi.fn() }) }));

const command = (mode: '2d' | '3d') => window.dispatchEvent(new CustomEvent(EXPERIENCE_COMMAND_EVENT, { detail: { name: 'map-mode', mode } }));
const flush = async () => { for (let count = 0; count < 20; count += 1) await Promise.resolve(); };
const scene = () => ({ map: {}, view: { destroyed: false, container: {}, padding: null }, ownsMap: false });
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1; });
  ports.create.mockResolvedValue(scene()); ports.ready.mockResolvedValue(undefined);
  ports.applyScene.mockResolvedValue(true); ports.applyMap.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('real map mode bridge bounded transitions', () => {
  it('bounds a stalled scene factory and frees the queue for a successful retry', async () => {
    vi.useFakeTimers();
    ports.create.mockReturnValueOnce(new Promise(() => undefined));
    const view = render(<ExperienceMapModeBridge mapView={{ map: {} }} />);
    await act(async () => { command('3d'); await flush(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); await flush(); });
    expect(view.container.querySelector('[data-view-mode="2d"]')).toHaveClass('is-inactive');
    await act(async () => { command('3d'); await vi.advanceTimersByTimeAsync(32); await flush(); });
    expect(ports.create).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-view-mode="3d"]')).toHaveClass('is-active');
  });

  it('disposes a factory result arriving after the deadline without promoting it', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof scene>) => void;
    ports.create.mockReturnValueOnce(new Promise((accept) => { resolve = accept; }));
    const view = render(<ExperienceMapModeBridge mapView={{ map: {} }} />);
    await act(async () => { command('3d'); await flush(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(7_000); await flush(); });
    const late = scene();
    await act(async () => { resolve(late); await flush(); });
    expect(ports.destroy).toHaveBeenCalledWith(late, expect.any(Function));
    expect(view.container.querySelector('[data-view-mode="3d"]')).toBeNull();
    expect(ports.applyScene).not.toHaveBeenCalled();
  });

  it('restores the original bridge state after a camera failure', async () => {
    ports.applyScene.mockRejectedValueOnce(new Error('camera failed'));
    const view = render(<ExperienceMapModeBridge mapView={{ map: {} }} />);
    act(() => { command('3d'); });
    await waitFor(() => expect(ports.setState).toHaveBeenLastCalledWith(state));
    expect(view.container.querySelector('[data-view-mode="2d"]')).toHaveClass('is-inactive');
  });

  it('does not publish a late mode acknowledgement after unmount', async () => {
    let resolve!: (value: ReturnType<typeof scene>) => void;
    ports.create.mockReturnValueOnce(new Promise((accept) => { resolve = accept; }));
    const modes: unknown[] = [];
    const listener = (event: Event) => { modes.push((event as CustomEvent).detail); };
    window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, listener);
    const view = render(<ExperienceMapModeBridge mapView={{ map: {} }} />);
    await act(async () => { command('3d'); await flush(); });
    view.unmount(); modes.length = 0;
    await act(async () => { resolve(scene()); await flush(); });
    expect(modes).toEqual([]);
    expect(ports.destroy).toHaveBeenCalledOnce();
    window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, listener);
  });
});
