import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  attachKentRehberiGeoJsonLayer,
  type KentRehberiLayerHandle,
  type KentRehberiMapLike,
} from '../../data-services/kentRehberiGeoJsonLayer';
import { createSidebarLayerLoadController } from '../../shell/sidebarLayerLoadController';
import './KentRehberiDataLayer.css';
const DATA_LAYER_RETRY_POLICY = Object.freeze({ maxAttempts: 3 });

/** Own the primary Kent Rehberi data layer independently of panel visibility. */
export const KentRehberiDataLayer = ({ map }: { readonly map: KentRehberiMapLike }) => {
  const controller = useMemo(() => createSidebarLayerLoadController<KentRehberiLayerHandle>({
    serviceKeys: ['kent-rehberi'],
    concurrency: 1,
    timeoutMs: 30_000,
    loadLayer: async (_key, { signal }) => attachKentRehberiGeoJsonLayer({ map, signal }),
    disposeLayer: (handle) => handle.dispose(),
  }), [map]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    void controller.start();
    return () => controller.reset();
  }, [controller]);

  const failed = state.phase === 'degraded';
  const canRetry = state.canRetry && state.attempt < DATA_LAYER_RETRY_POLICY.maxAttempts;
  const featureCount = state.loadedLayers[0]?.layer.featureCount ?? 0;
  const announcement = failed
    ? 'Kent verileri yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.'
    : state.phase === 'ready'
      ? featureCount > 0
        ? `${featureCount} kent kaydı haritaya yüklendi.`
        : 'Bu görünüm için gösterilecek kent kaydı bulunamadı.'
      : 'Kent verileri haritaya yükleniyor…';

  return (
    <div
      className={state.phase === 'ready' && featureCount > 0 ? 'experience-sr-only' : 'kr-map-data-status'}
      data-phase={state.phase}
      aria-label="Kent verisi durumu"
    >
      <p role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      {canRetry ? (
        <button type="button" onClick={() => { void controller.retryFailed(); }}>
          Kent verilerini yeniden yükle
        </button>
      ) : failed ? <small>Yeniden deneme sınırına ulaşıldı. Sayfayı yenileyebilirsiniz.</small> : null}
    </div>
  );
};
