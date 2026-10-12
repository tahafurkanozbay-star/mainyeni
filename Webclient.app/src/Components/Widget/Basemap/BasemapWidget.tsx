import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import MapManager from '../../../Store/Managers/MapManager';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { MapWidgetEmptyState, MapWidgetSkeleton, MapWidgetSurface, type MapWidgetManagerLike } from '../_shared/MapWidgetSurface';
import { createLatestOperationGate, isAbortLikeError, type LatestOperationGate } from '../_shared/MapWidgetRuntime';
import { createBasemapExperienceModel } from './basemapExperienceModel';
import { applySelectedBasemap, type SelectableBasemap, type BasemapMap } from './basemapSelection';
import './BasemapWidget.css';

const BASEMAP_OPTIONS = Object.freeze([
  { id: 'topo', label: 'Topoğrafya', detail: 'Arazi ve yer adları', tone: 'terrain' },
  { id: 'streets', label: 'Sokaklar', detail: 'Yollar ve yerleşimler', tone: 'street' },
  { id: 'satellite', label: 'Uydu', detail: 'Uydu görüntüleri', tone: 'imagery' },
  { id: 'hybrid', label: 'Uydu ve yollar', detail: 'Görüntü ve etiketler', tone: 'imagery' },
  { id: 'dark-gray', label: 'Koyu gri', detail: 'Verileri öne çıkarır', tone: 'dark' },
  { id: 'gray', label: 'Açık gri', detail: 'Sade harita', tone: 'gray' },
  { id: 'national-geographic', label: 'National Geographic', detail: 'Coğrafi ayrıntılar', tone: 'terrain' },
  { id: 'oceans', label: 'Okyanuslar', detail: 'Deniz ve kıyı bilgileri', tone: 'water' },
  { id: 'osm', label: 'OpenStreetMap', detail: 'Açık sokak haritası', tone: 'street' },
  { id: 'terrain', label: 'Arazi', detail: 'Yüzey şekilleri', tone: 'terrain' },
  { id: 'dark-gray-vector', label: 'Koyu gri vektör', detail: 'Sade vektör harita', tone: 'dark' },
  { id: 'gray-vector', label: 'Açık gri vektör', detail: 'Sade vektör harita', tone: 'gray' },
  { id: 'streets-vector', label: 'Sokaklar vektör', detail: 'Ayrıntılı yol haritası', tone: 'street' },
  { id: 'streets-night-vector', label: 'Gece sokakları', detail: 'Koyu yol haritası', tone: 'dark' },
  { id: 'streets-navigation-vector', label: 'Navigasyon', detail: 'Yol ve yön bilgileri', tone: 'street' },
  { id: 'topo-vector', label: 'Topoğrafya vektör', detail: 'Ayrıntılı arazi haritası', tone: 'terrain' },
  { id: 'streets-relief-vector', label: 'Yollar ve rölyef', detail: 'Arazi üzerinde yollar', tone: 'terrain' },
]);
type BasemapOption = typeof BASEMAP_OPTIONS[number];
interface BasemapConstructor { fromId: (id: string) => SelectableBasemap | null | undefined; }
interface BasemapView { readonly map?: BasemapMap; }
export interface BasemapWidgetProps { readonly id: string; readonly windowManager: MapWidgetManagerLike; }

export const BasemapWidget = forwardRef<ManagedWindowHandle, BasemapWidgetProps>(({ id, windowManager }, ref): ReactNode => {
  const constructorRef = useRef<BasemapConstructor | null>(null);
  const catalogRef = useRef<readonly BasemapOption[]>([]);
  const gateRef = useRef<LatestOperationGate | null>(null);
  const initialLoadRequestedRef = useRef(false);
  const [catalog, setCatalog] = useState<readonly BasemapOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const model = useMemo(() => createBasemapExperienceModel({ maxAttempts: 3 }), []);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  if (gateRef.current === null) gateRef.current = createLatestOperationGate();

  const initialize = useCallback(async (): Promise<void> => {
    const map = (MapManager.GetMapView() as BasemapView | null)?.map;
    setSelectedId(map?.basemap?.id ?? null);
    if (catalogRef.current.length > 0 || !model.beginLoad()) return;
    try {
      await gateRef.current?.run(async (operation) => {
        const [Basemap] = await loadArcgisModules<readonly [BasemapConstructor]>(['esri/Basemap']);
        if (!operation.isCurrent()) return;
        constructorRef.current = Basemap;
        const available = BASEMAP_OPTIONS.filter((option) => {
          const candidate = Basemap.fromId(option.id);
          if (!candidate) return false;
          candidate.destroy?.();
          return true;
        });
        if (!available.length) throw new Error('Altlık harita seçenekleri hazırlanamadı.');
        catalogRef.current = available;
        setCatalog(available);
        model.succeed(available.length);
      });
    } catch (error) {
      if (isAbortLikeError(error)) { model.cancel(); return; }
      model.fail(error);
    }
  }, [model]);

  const selectBasemap = useCallback(async (option: BasemapOption): Promise<void> => {
    const map = (MapManager.GetMapView() as BasemapView | null)?.map;
    if (!map || !constructorRef.current || map.basemap?.id === option.id) return;
    setPendingId(option.id);
    setSelectionError(null);
    try {
      await gateRef.current?.run(async (operation) => {
        const candidate = constructorRef.current?.fromId(option.id);
        if (!candidate) throw new Error('Altlık harita seçeneği kullanılamıyor.');
        await applySelectedBasemap(candidate, map, operation);
        if (operation.isCurrent()) setSelectedId(option.id);
      });
    } catch (error) {
      if (isAbortLikeError(error)) return;
      setSelectionError('Seçilen altlık yüklenemedi. Mevcut haritanız korunuyor; yeniden seçebilir veya başka bir altlık deneyebilirsiniz.');
    } finally {
      if (gateRef.current?.snapshot().phase !== 'running') setPendingId(null);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    id, visible: false, minimized: false,
    OnShow: () => { setSelectionError(null); if (model.getSnapshot().phase === 'error' && !model.getSnapshot().canReload) model.resetAttempts(); void initialize(); },
    OnClose: () => { gateRef.current?.cancel('widget-closed'); setPendingId(null); setSelectionError(null); if (model.getSnapshot().phase === 'loading') model.cancel(); },
  }), [id, initialize, model]);
  useEffect(() => {
    windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
    return () => {
      gateRef.current?.dispose(); model.dispose();
      windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
    };
  }, [id, model, ref, windowManager]);
  useEffect(() => {
    if (initialLoadRequestedRef.current || !windowManager.IsVisible(id)) return;
    initialLoadRequestedRef.current = true; void initialize();
  }, [id, initialize, windowManager]);

  return (
    <MapWidgetSurface id={id} title="Altlık Haritalar" windowManager={windowManager} busy={snapshot.busy || pendingId !== null} error={snapshot.error || selectionError} status={pendingId ? 'Seçilen altlık yükleniyor; mevcut görünüm korunuyor.' : catalog.length ? `${catalog.length} altlık harita seçeneği` : null} statusTone="info">
      <p className="basemap-picker__intro">Haritanın görünümünü seçin. Yalnız seçtiğiniz altlık yüklenir; veri katmanlarınız korunur.</p>
      <p className="sr-only" role="status" aria-live="polite">{snapshot.announcement}</p>
      {snapshot.busy && !catalog.length ? <MapWidgetSkeleton rows={4} label="Altlık haritalar hazırlanıyor" /> : null}
      {snapshot.phase === 'error' ? <MapWidgetEmptyState title="Altlık seçenekleri açılamadı" description={snapshot.canReload ? 'Bağlantınızı kontrol ederek yeniden deneyebilirsiniz.' : 'Yükleme sınırına ulaşıldı. Pencereyi kapatıp yeniden açabilirsiniz.'} action={snapshot.canReload ? <button type="button" className="map-widget-action map-widget-action--primary" onClick={() => void initialize()}>Seçenekleri yeniden yükle</button> : undefined} /> : null}
      <div className="basemap-picker" role="group" aria-label="Altlık harita seçenekleri">
        {catalog.map((option) => <button key={option.id} type="button" className={`basemap-picker__option basemap-picker__option--${option.tone}`} aria-label={option.label} aria-description={option.detail} aria-pressed={selectedId === option.id} aria-busy={pendingId === option.id || undefined} onClick={() => void selectBasemap(option)}>
          <svg className="basemap-picker__symbol" viewBox="0 0 60 38" aria-hidden="true"><path d="M0 0h60v38H0z" className="basemap-picker__land" /><path d="M0 24 18 19 28 2M27 38l5-18L60 8" className="basemap-picker__road" /><path d="m0 8 18 7 24 16 18 4" className="basemap-picker__water" /></svg>
          <span><strong>{option.label}</strong><span>{option.detail}</span></span>
          <span className="basemap-picker__selection" aria-hidden="true">{pendingId === option.id ? '…' : selectedId === option.id ? '✓' : ''}</span>
        </button>)}
      </div>
    </MapWidgetSurface>
  );
});
BasemapWidget.displayName = 'BasemapWidget';
