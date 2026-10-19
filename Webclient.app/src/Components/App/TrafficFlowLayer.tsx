import { useEffect } from 'react';
import { loadArcgisModule } from '../../gis-engine/arcgisModuleRuntime';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import {
  buildTomTomTrafficFlowUrlTemplate,
  getTomTomTrafficApiKey,
} from '../../data-services/tomTomTrafficFlow';

interface TrafficMapLike {
  add?: (layer: unknown) => void;
  remove?: (layer: unknown) => void;
}

interface TrafficLayerLike {
  destroy?: () => void;
}

type WebTileLayerConstructor = new (options: Record<string, unknown>) => TrafficLayerLike;

interface TrafficFlowLayerProps {
  readonly map: unknown;
  readonly visible: boolean;
  readonly onStatusChange: (message: string) => void;
}

const reportTrafficLayerFailure = (phase: string, error: unknown): void => {
  runtimeDiagnostics.record('map-traffic-layer.operation.failed', {
    phase,
    failureKind: error instanceof Error ? error.name : typeof error,
  }, { severity: 'warn' });
};

/** Creates the visual traffic tile layer only while the toolbar toggle is on. */
export const TrafficFlowLayer = ({ map, visible, onStatusChange }: TrafficFlowLayerProps) => {
  useEffect(() => {
    const apiKey = getTomTomTrafficApiKey();
    const trafficMap = map as TrafficMapLike | null;
    if (!visible || !trafficMap) return undefined;

    if (!apiKey) {
      onStatusChange('Gerçek zamanlı trafik için VITE_TOMTOM_TRAFFIC_API_KEY ayarlanmalı.');
      return undefined;
    }
    const addLayer = trafficMap.add;
    const removeLayer = trafficMap.remove;
    if (typeof addLayer !== 'function' || typeof removeLayer !== 'function') {
      onStatusChange('Trafik katmanı harita katman yöneticisine bağlanamadı.');
      return undefined;
    }

    let disposed = false;
    let layer: TrafficLayerLike | null = null;
    const removeOwnedLayer = (phase: string): void => {
      const ownedLayer = layer;
      layer = null;
      if (!ownedLayer) return;
      try { removeLayer.call(trafficMap, ownedLayer); }
      catch (error) { reportTrafficLayerFailure(`${phase}-remove`, error); }
      try { ownedLayer.destroy?.(); }
      catch (error) { reportTrafficLayerFailure(`${phase}-destroy`, error); }
    };

    const activate = async (): Promise<void> => {
      const WebTileLayer = await loadArcgisModule<WebTileLayerConstructor>('esri/layers/WebTileLayer');
      if (disposed) return;
      layer = new WebTileLayer({
        id: 'kent-rehberi-live-traffic',
        title: 'Gerçek zamanlı trafik yoğunluğu',
        urlTemplate: buildTomTomTrafficFlowUrlTemplate(apiKey),
        opacity: 0.94,
        copyright: 'Traffic flow data © TomTom',
      });
      addLayer.call(trafficMap, layer);
      onStatusChange('Trafik katmanı açıldı. Kırmızı/sarı/yeşil çizgiler için TomTom anahtarının ve Traffic Flow API erişiminin etkin olması gerekir.');
    };

    void activate().catch((error: unknown) => {
      if (disposed) return;
      reportTrafficLayerFailure('activate', error);
      const message = error instanceof Error ? error.message : '';
      onStatusChange(message
        ? `Trafik katmanı açılamadı: ${message}`
        : 'Trafik katmanı açılamadı. Servis bağlantısını ve API anahtarını kontrol edin.');
      removeOwnedLayer('activation-cleanup');
    });

    return () => {
      disposed = true;
      removeOwnedLayer('teardown');
    };
  }, [map, onStatusChange, visible]);

  return null;
};
