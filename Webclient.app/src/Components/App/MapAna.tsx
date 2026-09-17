import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import MapManager from '../../Store/Managers/MapManager';
import type { ManagedWindowHandle, WindowManagerLike } from '../../experience/contracts';
import './Sidebar.css';

interface MapAnaProps {
  readonly id: string;
  readonly windowManager: WindowManagerLike;
}

interface MapViewLike {
  readonly map?: unknown;
}

export const MapAna = forwardRef<ManagedWindowHandle, MapAnaProps>(({ id, windowManager }, ref) => {
  const managedWindow = useMemo<ManagedWindowHandle>(() => ({
    id,
    visible: true,
    minimized: false,
    OnShow: () => undefined,
    OnClose: () => undefined,
  }), [id]);
  const registrationRef = useRef<ManagedWindowHandle | null>(managedWindow);
  registrationRef.current = managedWindow;

  useImperativeHandle(ref, () => managedWindow, [managedWindow]);

  useEffect(() => {
    windowManager.RegisterWindow(registrationRef);

    const mapView = MapManager.GetMapView() as MapViewLike | null;
    if (mapView?.map) {
      windowManager.ShowWindow('sidebar');
    }

    return () => {
      windowManager.UnregisterWindow?.(id, registrationRef);
    };
  }, [id, windowManager]);

  return null;
});

MapAna.displayName = 'MapAna';

export default MapAna;
