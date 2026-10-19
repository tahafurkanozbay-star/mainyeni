import { useEffect } from 'react';
import { loadArcgisModule } from '../../gis-engine/arcgisModuleRuntime';
import {
  buildTomTomTrafficFlowTileUrl,
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

/** Adds no traffic requests while switched off. A single Ankara tile is checked
 * before the layer is mounted so a missing/rejected API key is reported clearly. */
export const TrafficFlowLayer = ({ map, visible, onStatusChange }: TrafficFlowLayerProps) => {
  useEffect(() => {
    const apiKey = getTomTomTrafficApiKey();
    const trafficMap = map as TrafficMapLike | null;
    if (!visible || !trafficMap) return undefined;

    if (typeof trafficMap.add !== 'function' || typeof trafficMap.remove !== 'function') {
      onStatusChange('Trafik katmanı harita katman yöneticisine bağlanamadı.');
      return undefined;
    }
    if (!apiKey) {
      onStatusChange('Gerçek zamanlı trafik için VITE_TOMTOM_TRAFFIC_API_KEY ayarlanmalı.');
      return undefined;
    }

    const controller = new AbortController();
    let disposed = false;
    let layer: TrafficLayerLike | null = null;

    const verifyTileService = async (): Promise<void> => {
      const response = await fetch(buildTomTomTrafficFlowTileUrl(apiKey, 8, 151, 97), {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new Error('TomTom anahtarı geçersiz veya Trafik Flow API yetkisi kapalı.');
        }
        if (response.status === 429) {
          throw new Error('TomTom trafik servisi istek kotasına ulaştı.');
        }
        throw new Error(`TomTom trafik servisi HTTP ${response.status} yanıtı verdi.`);
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('image/png')) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail.slice(0, 180) || 'TomTom trafik servisi beklenen PNG karo verisini döndürmedi.');
      }
      await response.arrayBuffer();
    };

    const activate = async (): Promise<void> => {
      await verifyTileService();
      if (disposed || controller.signal.aborted) return;
      const WebTileLayer = await loadArcgisModule<WebTileLayerConstructor>('esri/layers/WebTileLayer');
      if (disposed || controller.signal.aborted) return;

      layer = new WebTileLayer({
        id: 'kent-rehberi-live-traffic',
        title: 'Gerçek zamanlı trafik yoğunluğu',
        urlTemplate: buildTomTomTrafficFlowUrlTemplate(apiKey),
        opacity: 0.94,
        copyright: 'Traffic flow data © TomTom',
      });
      trafficMap.add(layer);
      onStatusChange('Gerçek zamanlı trafik katmanı açıldı.');
    };

    void activate().catch((error: unknown) => {
      if (disposed || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : '';
      onStatusChange(message
        ? `Trafik katmanı açılamadı: ${message}`
        : 'Trafik katmanı açılamadı. Servis bağlantısını ve API anahtarını kontrol edin.');
      if (layer) {
        try { trafficMap.remove(layer); } catch { /* Keep the map usable if cleanup fails. */ }
        try { layer.destroy?.(); } catch { /* Layer may already have been disposed by ArcGIS. */ }
        layer = null;
      }
    });

    return () => {
      disposed = true;
      controller.abort();
      if (layer) {
        try { trafficMap.remove?.(layer); } catch { /* Keep teardown resilient during view replacement. */ }
        try { layer.destroy?.(); } catch { /* ArcGIS may already have destroyed the layer. */ }
        layer = null;
      }
    };
  }, [map, onStatusChange, visible]);

  return null;
};
