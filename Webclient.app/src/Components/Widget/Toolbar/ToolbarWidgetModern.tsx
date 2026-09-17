import React, { useEffect, useRef, useState } from 'react';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import type { WindowManagerLike } from '../../../experience/contracts';
import './ToolbarWidget.css';

const FALLBACK_LOCATION = Object.freeze({ x: 32.80409955978453, y: 39.94494728389463 });

type ToolbarIcon =
  | 'feedback'
  | 'basemap'
  | 'address'
  | 'location'
  | 'parcel'
  | 'measure'
  | 'streetview'
  | 'home';

type LocationState = 'idle' | 'locating' | 'success' | 'fallback';

interface ToolbarWidgetModernProps {
  readonly id?: string;
  readonly windowManager: Pick<WindowManagerLike, 'ShowWindow'>;
}

interface RemovableHandle {
  readonly remove?: () => void;
}

interface ExtentLike {
  readonly clone?: () => ExtentLike;
}

interface MapViewLike {
  readonly extent?: ExtentLike;
  readonly ready?: boolean;
  readonly watch?: (propertyName: string, callback: (value: boolean) => void) => RemovableHandle;
  readonly goTo?: (target: unknown) => Promise<unknown> | unknown;
}

interface PointLocation {
  readonly x: number;
  readonly y: number;
}

interface ToolbarControlProps {
  readonly icon: ToolbarIcon;
  readonly label: string;
  readonly onClick: () => void;
  readonly busy?: boolean;
}

const ToolbarGlyph = ({ name }: { readonly name: ToolbarIcon }) => {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'feedback':
      return <svg {...common}><path d="M7 18.5 3.5 21l1-4A8.2 8.2 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8-4 8-9 8a10.6 10.6 0 0 1-5-.5Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></svg>;
    case 'basemap':
      return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></svg>;
    case 'address':
      return <svg {...common}><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
    case 'location':
      return <svg {...common}><circle cx="12" cy="12" r="5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>;
    case 'parcel':
      return <svg {...common}><path d="m4 6 5-3 6 3 5-3v15l-5 3-6-3-5 3V6Z" /><path d="M9 3v15M15 6v15" /></svg>;
    case 'measure':
      return <svg {...common}><path d="m5 19 14-14 2 2L7 21l-2-2Z" /><path d="m13 7 4 4M10 10l2 2M7 13l2 2" /></svg>;
    case 'streetview':
      return <svg {...common}><circle cx="12" cy="5" r="2.3" /><path d="M8 21v-5l-2-2 2-5h8l2 5-2 2v5M9 12h6M12 12v9" /></svg>;
    case 'home':
      return <svg {...common}><path d="m3 11 9-8 9 8" /><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" /></svg>;
  }
};

const ToolbarControl = ({ icon, label, onClick, busy = false }: ToolbarControlProps) => (
  <button
    type="button"
    className="toolbarwidget-button"
    onClick={onClick}
    aria-label={label}
    aria-busy={busy || undefined}
    data-tooltip={label}
    disabled={busy}
  >
    <span className="toolbarwidget-button-glyph" aria-hidden="true">
      <ToolbarGlyph name={icon} />
    </span>
  </button>
);

const requestCurrentPosition = (): Promise<GeolocationPosition> => new Promise((resolve, reject) => {
  navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 60000,
  });
});

const locationMessage: Record<LocationState, string> = {
  idle: '',
  locating: 'Konumunuz bulunuyor.',
  success: 'Konumunuz haritada gösterildi.',
  fallback: 'Konum alınamadı. Ankara merkez konumu gösterildi.',
};

export const ToolbarWidgetModern = ({ id, windowManager }: ToolbarWidgetModernProps) => {
  const initialExtentRef = useRef<ExtentLike | null>(null);
  const [locationState, setLocationState] = useState<LocationState>('idle');

  useEffect(() => {
    const mapView = MapManager.GetMapView() as MapViewLike | null;
    if (!mapView) return undefined;

    const captureInitialExtent = (): void => {
      if (!initialExtentRef.current && mapView.extent) {
        initialExtentRef.current = mapView.extent.clone?.() ?? mapView.extent;
      }
    };

    captureInitialExtent();
    const readyHandle = mapView.watch?.('ready', (ready) => {
      if (ready) captureInitialExtent();
    });

    return () => readyHandle?.remove?.();
  }, []);

  const showWindow = (windowId: string): void => windowManager.ShowWindow(windowId);

  const createLocation = async (location: PointLocation): Promise<void> => {
    const point = await GisGraphicsHelper.CreatePoint(location);
    const mapView = MapManager.GetMapView();
    if (!mapView) return;

    const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
    MapManager.AddGraphics(graphic, true);
    GisGraphicsHelper.ZoomToGeometry(mapView, point, 15);
  };

  const getUserLocation = async (): Promise<void> => {
    if (locationState === 'locating') return;
    setLocationState('locating');

    try {
      if (!navigator.geolocation) throw new Error('Geolocation is unavailable');
      const position = await requestCurrentPosition();
      await createLocation({
        x: position.coords.longitude,
        y: position.coords.latitude,
      });
      setLocationState('success');
    } catch {
      await createLocation(FALLBACK_LOCATION);
      windowManager.ShowWindow('sidebar');
      setLocationState('fallback');
    }
  };

  const gotoInitialView = (): void => {
    const mapView = MapManager.GetMapView() as MapViewLike | null;
    const initialExtent = initialExtentRef.current;
    if (mapView && initialExtent) {
      void Promise.resolve(mapView.goTo?.(initialExtent)).catch(() => undefined);
    }
    windowManager.ShowWindow('sidebar');
  };

  const openFeedbackPortal = (): void => {
    const opened = window.open(
      'https://ulakbell.ankara.bel.tr/WebForm/basket153basvuru#/',
      '_blank',
      'noopener,noreferrer',
    );
    if (opened) opened.opener = null;
  };

  return (
    <div id={id} className="toolbarwidget toolbarwidget--modern" aria-label="Harita araçları">
      <div className="toolbarwidget-group" role="group" aria-label="Belediye ve harita görünümü">
        <ToolbarControl icon="feedback" label="Geri Bildirim (Başkent 153)" onClick={openFeedbackPortal} />
        <ToolbarControl icon="basemap" label="Altlık Haritalar" onClick={() => showWindow('basemap-widget')} />
      </div>

      <span className="toolbarwidget-separator" aria-hidden="true" />

      <div className="toolbarwidget-group" role="group" aria-label="Arama ve analiz araçları">
        <ToolbarControl icon="address" label="Adres Arama" onClick={() => showWindow('numbering-query-window')} />
        <ToolbarControl
          icon="location"
          label={locationState === 'locating' ? 'Konum bulunuyor' : 'Konum Bul'}
          onClick={() => void getUserLocation()}
          busy={locationState === 'locating'}
        />
        <ToolbarControl icon="parcel" label="Ada-Parsel Arama" onClick={() => showWindow('cityblockparcel-query-window')} />
        <ToolbarControl icon="measure" label="Ölçüm Aracı" onClick={() => showWindow('measurement-widget')} />
        <ToolbarControl icon="streetview" label="Sokak Görüntüsü" onClick={() => showWindow('streetview-widget')} />
      </div>

      <span className="toolbarwidget-separator" aria-hidden="true" />

      <div className="toolbarwidget-group" role="group" aria-label="Harita görünümünü sıfırla">
        <ToolbarControl icon="home" label="Başlangıç görünümüne dön" onClick={gotoInitialView} />
      </div>

      <span className="toolbarwidget-status" role="status" aria-live="polite">
        {locationMessage[locationState]}
      </span>
    </div>
  );
};
