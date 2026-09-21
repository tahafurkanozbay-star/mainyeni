import ArcGISMap from '@arcgis/core/Map.js';
import Basemap from '@arcgis/core/Basemap.js';
import MapView from '@arcgis/core/views/MapView.js';
import { useCallback, useEffect, useRef } from 'react';
import { Button } from 'react-bootstrap';
import { AiOutlineDoubleLeft } from 'react-icons/ai';

import '@arcgis/core/assets/esri/themes/light/main.css';
import './Map.css';

export interface AdminMapConfig {
  readonly Centerx: number | string;
  readonly Centery: number | string;
  readonly Zoom: number | string;
  readonly DefaultBasemapTitle?: string | null;
}

export interface AdminMapExportDetails {
  readonly Zoom: number;
  readonly Center: Readonly<{
    longitude: number;
    latitude: number;
  }>;
}

export interface AdminMapProps {
  readonly config: AdminMapConfig;
  readonly exportCallBack: (details: AdminMapExportDetails) => void;
  readonly className?: string;
}

const DEFAULT_CENTER = Object.freeze({ longitude: 32.854, latitude: 39.92 });
const DEFAULT_ZOOM = 12;
const DEFAULT_BASEMAP = 'topo-vector';

const finiteNumber = (value: number | string | null | undefined, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeBasemapId = (value: string | null | undefined): string => {
  const candidate = value?.trim();
  return candidate || DEFAULT_BASEMAP;
};

export const Map = ({ config, exportCallBack, className }: AdminMapProps) => {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);

  useEffect(() => {
    const container = mapDiv.current;
    if (!container) return undefined;

    const longitude = finiteNumber(config.Centerx, DEFAULT_CENTER.longitude);
    const latitude = finiteNumber(config.Centery, DEFAULT_CENTER.latitude);
    const zoom = finiteNumber(config.Zoom, DEFAULT_ZOOM);
    const basemapId = normalizeBasemapId(config.DefaultBasemapTitle);

    const map = new ArcGISMap({ basemap: basemapId });
    const view = new MapView({
      container,
      map,
      center: [longitude, latitude],
      zoom,
      ui: { components: [] },
      padding: { top: 0 },
      constraints: { rotationEnabled: false },
    });

    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.container = null;
      view.destroy();
      map.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const longitude = finiteNumber(config.Centerx, view.center?.longitude ?? DEFAULT_CENTER.longitude);
    const latitude = finiteNumber(config.Centery, view.center?.latitude ?? DEFAULT_CENTER.latitude);
    const zoom = finiteNumber(config.Zoom, view.zoom ?? DEFAULT_ZOOM);

    view.center = [longitude, latitude];
    view.zoom = zoom;

    const basemap = Basemap.fromId(normalizeBasemapId(config.DefaultBasemapTitle));
    if (basemap) view.map.basemap = basemap;
  }, [config.Centerx, config.Centery, config.Zoom, config.DefaultBasemapTitle]);

  const exportConfig = useCallback(() => {
    const view = viewRef.current;
    const center = view?.center;
    if (!view || !center) return;

    exportCallBack({
      Zoom: view.zoom,
      Center: {
        longitude: center.longitude,
        latitude: center.latitude,
      },
    });
  }, [exportCallBack]);

  return (
    <>
      <div>
        <Button
          type="button"
          variant="outline-secondary"
          onClick={exportConfig}
          aria-label="Haritadaki mevcut koordinatları başlangıç konumu olarak kullan"
        >
          <AiOutlineDoubleLeft aria-hidden="true" />
          &nbsp;Bu koordinatları kullan
        </Button>
      </div>
      <div
        className={`esri-map map-container${className ? ` ${className}` : ''}`}
        ref={mapDiv}
        role="region"
        aria-label="Harita başlangıç konumu önizlemesi"
      />
    </>
  );
};
