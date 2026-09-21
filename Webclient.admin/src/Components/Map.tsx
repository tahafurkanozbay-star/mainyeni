import '@arcgis/core/assets/esri/themes/light/main.css';

import ArcGISMap from '@arcgis/core/Map.js';
import type Point from '@arcgis/core/geometry/Point.js';
import MapView from '@arcgis/core/views/MapView.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-bootstrap';
import { AiOutlineDoubleLeft } from 'react-icons/ai';

import {
  normalizeAdminMapConfig,
  type AdminMapConfigInput,
  type NormalizedAdminMapConfig,
} from '../runtime/adminMapRuntime';
import './Map.css';

export interface AdminMapSnapshot {
  readonly Zoom: number;
  readonly Center: Point | null;
}

export interface AdminMapProps {
  readonly config?: AdminMapConfigInput | null;
  readonly exportCallBack: (snapshot: AdminMapSnapshot) => void;
}

type MapStatus = 'initializing' | 'ready' | 'error';

const applyConfig = (
  view: MapView,
  config: NormalizedAdminMapConfig,
): void => {
  view.center = [config.center[0], config.center[1]];
  view.zoom = config.zoom;

  if (view.map) {
    view.map.basemap = config.basemap;
  }
};

export const Map = ({ config, exportCallBack }: AdminMapProps) => {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const configRef = useRef<NormalizedAdminMapConfig>(
    normalizeAdminMapConfig(config),
  );
  const [status, setStatus] = useState<MapStatus>('initializing');

  const normalizedConfig = useMemo(
    () => normalizeAdminMapConfig(config),
    [
      config?.Centerx,
      config?.Centery,
      config?.Zoom,
      config?.DefaultBasemapTitle,
    ],
  );
  configRef.current = normalizedConfig;

  useEffect(() => {
    if (!mapDiv.current || viewRef.current) return undefined;

    let disposed = false;
    const initialConfig = configRef.current;
    const map = new ArcGISMap({
      basemap: initialConfig.basemap,
    });
    const view = new MapView({
      container: mapDiv.current,
      map,
      zoom: initialConfig.zoom,
      center: [initialConfig.center[0], initialConfig.center[1]],
      ui: {
        components: [],
      },
      constraints: {
        rotationEnabled: false,
      },
      padding: {
        top: 0,
      },
    });

    viewRef.current = view;

    void view.when().then(
      () => {
        if (disposed) return;
        applyConfig(view, configRef.current);
        setStatus('ready');
      },
      () => {
        if (!disposed) setStatus('error');
      },
    );

    return () => {
      disposed = true;
      if (viewRef.current === view) {
        viewRef.current = null;
      }
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.destroyed) return;
    applyConfig(view, normalizedConfig);
  }, [
    normalizedConfig.basemap,
    normalizedConfig.center,
    normalizedConfig.zoom,
  ]);

  const exportConfig = (): void => {
    const view = viewRef.current;
    if (!view || view.destroyed) return;

    exportCallBack({
      Zoom: view.zoom,
      Center: view.center,
    });
  };

  return (
    <>
      <div>
        <Button
          variant="outline-secondary"
          type="button"
          onClick={exportConfig}
          disabled={status !== 'ready'}
        >
          <AiOutlineDoubleLeft aria-hidden="true" />
          &nbsp;Bu koordinatları kullan
        </Button>
        {status === 'error' ? (
          <div className="alert alert-danger mt-2" role="alert">
            Harita başlatılamadı. Lütfen harita ayarlarını ve servis erişimini kontrol edin.
          </div>
        ) : null}
      </div>
      <div
        className="esri-map map-container"
        ref={mapDiv}
        aria-label="Harita ayarları önizlemesi"
      />
    </>
  );
};
