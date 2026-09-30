import { act, createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { GoogleMapsBusiness } from '../../../Business/GoogleMapsBusiness';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { openExternalUrl } from '../_shared/MapWidgetRuntime';
import { ContextMenuWidget } from './ContextMenuWidget';

vi.mock('../../../Store/Managers/MapManager', () => ({
  default: {
    GetMapClickEvent: vi.fn(),
    GetMapView: vi.fn(),
  },
}));

vi.mock('../../../Toolbox/GisGraphicsHelper', () => ({
  GisGraphicsHelper: {
    ZoomToGeometry: vi.fn(),
  },
}));

vi.mock('../../../Business/GoogleMapsBusiness', () => ({
  GoogleMapsBusiness: {
    CreateStreetViewUrlFromPoint: vi.fn(() => 'https://maps.example/street-view'),
  },
}));

vi.mock('../_shared/MapWidgetRuntime', async (importOriginal) => {
  const original = await importOriginal<typeof import('../_shared/MapWidgetRuntime')>();
  return {
    ...original,
    openExternalUrl: vi.fn(() => true),
  };
});

const createManager = () => {
  let visible = false;
  return {
    manager: {
      RegisterWindow: vi.fn(),
      UnregisterWindow: vi.fn(),
      ShowWindow: vi.fn(),
      HideWindow: vi.fn(() => { visible = false; }),
      IsVisible: vi.fn(() => visible),
    },
    show() { visible = true; },
    hide() { visible = false; },
  };
};

const clickedPoint = {
  latitude: 39.93,
  longitude: 32.82,
  x: 32.82,
  y: 39.93,
};

describe('ContextMenuWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MapManager.GetMapClickEvent).mockReturnValue({
      x: 300,
      y: 220,
      mapPoint: clickedPoint,
    } as never);
    vi.mocked(MapManager.GetMapView).mockReturnValue({ id: 'map-view' } as never);
  });

  it('keeps hidden menu items out of the tab order', () => {
    const { manager } = createManager();
    render(<ContextMenuWidget id="context-menu" windowManager={manager as never} />);
    const menu = screen.getByRole('menu', { hidden: true });
    expect(menu.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getAllByRole('menuitem', { hidden: true }).every((item) => item.tabIndex === -1)).toBe(true);
  });

  it('opens as a semantic menu and focuses the first action', async () => {
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    await waitFor(() => {
      expect(screen.getByRole('menu', { name: 'Harita işlemleri' }).getAttribute('data-visible')).toBe('true');
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bilgi Al' }));
    });
  });

  it('supports vertical arrow navigation through the shared menu authority', async () => {
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    const menu = await screen.findByRole('menu', { name: 'Harita işlemleri' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bilgi Al' })));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Yakınımda Ara' }));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sokak Görünümü' }));
  });

  it('restores the previous focus target when Escape closes the menu', async () => {
    const origin = document.createElement('button');
    origin.textContent = 'Harita';
    document.body.append(origin);
    origin.focus();
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bilgi Al' })));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(manager.HideWindow).toHaveBeenCalledWith('context-menu');
    await waitFor(() => expect(document.activeElement).toBe(origin));
    origin.remove();
  });

  it('opens identify through the existing window manager and closes the menu', async () => {
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Bilgi Al' }));
    expect(manager.ShowWindow).toHaveBeenCalledWith('global-identify-widget');
    expect(manager.HideWindow).toHaveBeenCalledWith('context-menu');
  });

  it('opens nearby search and zooms to the selected point', async () => {
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Yakınımda Ara' }));
    expect(manager.ShowWindow).toHaveBeenCalledWith('vicinity-query-window');
    expect(GisGraphicsHelper.ZoomToGeometry).toHaveBeenCalledWith(
      { id: 'map-view' },
      clickedPoint,
      14,
    );
  });

  it('builds route navigation with the selected destination through the governed opener', async () => {
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Yol Tarifi Al' }));
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    const url = String(vi.mocked(openExternalUrl).mock.calls[0]?.[0]);
    expect(url).toContain('google.com.tr/maps');
    expect(url).toContain('saddr=My+Location');
    expect(url).toContain('daddr=39.93%2C32.82');
  });

  it('opens street view through the governed external URL helper', async () => {
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sokak Görünümü' }));
    expect(GoogleMapsBusiness.CreateStreetViewUrlFromPoint).toHaveBeenCalledWith(clickedPoint);
    expect(openExternalUrl).toHaveBeenCalledWith('https://maps.example/street-view');
  });

  it('does not open point actions when no map point exists', async () => {
    vi.mocked(MapManager.GetMapClickEvent).mockReturnValue({ x: 100, y: 100, mapPoint: null } as never);
    const { manager, show } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    show();
    act(() => ref.current?.OnShow?.());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Bilgi Al' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Yol Tarifi Al' }));
    expect(manager.ShowWindow).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('unregisters the managed window on unmount', () => {
    const { manager } = createManager();
    const ref = createRef<ManagedWindowHandle>();
    const { unmount } = render(<ContextMenuWidget ref={ref} id="context-menu" windowManager={manager as never} />);
    unmount();
    expect(manager.UnregisterWindow).toHaveBeenCalledWith('context-menu', ref);
  });
});
