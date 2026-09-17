import { createRef } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MapManager from '../../Store/Managers/MapManager';
import type { ManagedWindowHandle, WindowManagerLike } from '../../experience/contracts';
import { MapAna } from './MapAna';

vi.mock('../../Store/Managers/MapManager', () => ({
  default: {
    GetMapView: vi.fn(),
  },
}));

const getMapViewMock = vi.mocked(MapManager.GetMapView);

const createWindowManager = (): WindowManagerLike => ({
  ShowWindow: vi.fn(),
  RegisterWindow: vi.fn(),
  UnregisterWindow: vi.fn(),
});

describe('MapAna', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers once, opens the sidebar when a map exists, and unregisters on cleanup', () => {
    getMapViewMock.mockReturnValue({ map: {} });
    const windowManager = createWindowManager();
    const ref = createRef<ManagedWindowHandle>();

    const { unmount } = render(<MapAna id="map-ana" windowManager={windowManager} ref={ref} />);

    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
    expect(windowManager.ShowWindow).toHaveBeenCalledWith('sidebar');
    expect(ref.current?.id).toBe('map-ana');

    unmount();

    expect(windowManager.UnregisterWindow).toHaveBeenCalledTimes(1);
  });

  it('does not open the sidebar before a map exists', () => {
    getMapViewMock.mockReturnValue(null);
    const windowManager = createWindowManager();

    render(<MapAna id="map-ana" windowManager={windowManager} />);

    expect(windowManager.RegisterWindow).toHaveBeenCalledTimes(1);
    expect(windowManager.ShowWindow).not.toHaveBeenCalled();
  });
});
