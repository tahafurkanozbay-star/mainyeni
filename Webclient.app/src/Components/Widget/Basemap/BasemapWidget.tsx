import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect,
  useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode, type RefObject,
} from 'react';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import type { ArcgisAccessorWatch, ArcgisReactiveHandle } from '../../../gis-engine/arcgisReactiveRuntime';
import MapManager from '../../../Store/Managers/MapManager';
import Store from '../../../Store/Store';
import { normalizeSearchText } from '../../../experience/experienceRuntime';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';
import { useMapWidgetFocus } from '../_shared/useMapWidgetFocus';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import { MapWidgetEmptyState, MapWidgetSkeleton, MapWidgetSurface, type MapWidgetManagerLike } from '../_shared/MapWidgetSurface';
import { createLatestOperationGate, isAbortLikeError, type LatestOperationGate } from '../_shared/MapWidgetRuntime';
import { createBasemapExperienceModel } from './basemapExperienceModel';
import { applySelectedBasemap, releaseDetachedBasemap, type AppliedBasemapOwnership, type SelectableBasemap, type BasemapMap } from './basemapSelection';
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
interface SelectionOwner {
  readonly id: string;
  readonly map: BasemapMap;
  readonly previous: SelectableBasemap | null;
  candidate: SelectableBasemap | null;
}
export interface BasemapWidgetProps { readonly id: string; readonly windowManager: MapWidgetManagerLike; }

const reportCatalogFailure = (error: unknown): void => {
  try {
    runtimeDiagnostics.captureError(new Error('Basemap catalog option failed.'), {
      source: 'experience.basemap.catalog',
      failureKind: error instanceof Error ? (error.name || 'Error').slice(0, 48) : typeof error,
    }, 'warn');
  } catch { console.warn('Altlık seçenek hatası raporlanamadı.'); }
};

export const BasemapWidget = forwardRef<ManagedWindowHandle, BasemapWidgetProps>(({ id, windowManager }, ref): ReactNode => {
  const visible = windowManager.IsVisible(id);
  useMapWidgetFocus(id, visible);
  const constructorRef = useRef<BasemapConstructor | null>(null);
  const watchRef = useRef<ArcgisAccessorWatch | null>(null);
  const catalogRef = useRef<readonly BasemapOption[]>([]);
  const gateRef = useRef<LatestOperationGate | null>(null);
  const initialLoadRequestedRef = useRef(false);
  const mountedRef = useRef(false);
  const operationRevisionRef = useRef(0);
  const selectionRef = useRef<SelectionOwner | null>(null);
  const appliedRef = useRef<AppliedBasemapOwnership | null>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusOptionRef = useRef<string | null>(null);
  const [catalog, setCatalog] = useState<readonly BasemapOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const model = useMemo(() => createBasemapExperienceModel({ maxAttempts: 3 }), []);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  if (gateRef.current === null) gateRef.current = createLatestOperationGate();

  const cancelSelection = useCallback((message: string | null = null): void => {
    operationRevisionRef.current += 1;
    gateRef.current?.cancel('selection-cancelled');
    selectionRef.current = null;
    setPendingId(null);
    setSelectionError(null);
    setNotice(message);
  }, []);

  const initialize = useCallback(async (): Promise<void> => {
    const map = (MapManager.GetMapView() as BasemapView | null)?.map;
    setSelectedId(map?.basemap?.id ?? null);
    if (catalogRef.current.length > 0 || !model.beginLoad()) return;
    const revision = ++operationRevisionRef.current;
    try {
      await gateRef.current?.run(async (operation) => {
        const [Basemap, reactive] = await loadArcgisModules<readonly [BasemapConstructor, { watch: ArcgisAccessorWatch }]>(['esri/Basemap', 'esri/core/watchUtils']);
        if (!operation.isCurrent()) return;
        constructorRef.current = Basemap;
        watchRef.current = reactive.watch;
        const available = BASEMAP_OPTIONS.filter((option) => {
          let candidate: SelectableBasemap | null | undefined;
          try {
            candidate = Basemap.fromId(option.id);
            return Boolean(candidate);
          } catch (error) {
            reportCatalogFailure(error);
            return false;
          } finally {
            try { candidate?.destroy?.(); } catch (error) { reportCatalogFailure(error); }
          }
        });
        if (!available.length) throw new Error('No supported basemap options.');
        catalogRef.current = available;
        setCatalog(available);
        model.succeed(available.length);
      });
    } catch (error) {
      if (!mountedRef.current || revision !== operationRevisionRef.current) return;
      if (isAbortLikeError(error)) { model.cancel(); return; }
      reportCatalogFailure(error);
      model.fail(new Error('Altlık seçenekleri hazırlanamadı. Bağlantınızı kontrol ederek yeniden deneyin.'));
    }
  }, [model]);

  // Observe the real map, including replacement by another tool; do not poll or
  // create another source of selected-basemap state.
  useEffect(() => {
    if (!visible || !catalog.length || !watchRef.current) return undefined;
    let observedView: BasemapView | null = null;
    let observedMap: BasemapMap | null = null;
    let handles: ArcgisReactiveHandle[] = [];
    const release = (): void => { handles.forEach(handle => handle.remove?.()); handles = []; };
    const synchronize = (): void => {
      const view = MapManager.GetMapView() as BasemapView | null;
      const map = view?.map ?? null;
      if (view !== observedView || map !== observedMap) {
        release(); observedView = view; observedMap = map;
        if (view) handles.push(watchRef.current!(view, 'map', synchronize));
        if (map) handles.push(watchRef.current!(map, 'basemap', synchronize));
      }
      if (releaseDetachedBasemap(appliedRef.current)) appliedRef.current = null;
      const owner = selectionRef.current;
      if (owner && (map !== owner.map || (map.basemap !== owner.previous && map.basemap !== owner.candidate))) {
        cancelSelection('Harita görünümü değişti. Bekleyen altlık seçimi durduruldu.');
      }
      setSelectedId(map?.basemap?.id ?? null);
    };
    synchronize();
    const unsubscribe = Store.subscribe(synchronize);
    return () => { unsubscribe(); release(); };
  }, [cancelSelection, catalog.length, visible]);

  const selectBasemap = useCallback(async (option: BasemapOption): Promise<void> => {
    const map = (MapManager.GetMapView() as BasemapView | null)?.map;
    if (!map) { setSelectionError('Altlık seçmek için harita görünümünün hazır olmasını bekleyin.'); return; }
    if (!constructorRef.current) return;
    if (map.basemap?.id === option.id) {
      cancelSelection('Mevcut altlık haritanız korunuyor.');
      setSelectedId(option.id);
      return;
    }
    if (selectionRef.current?.id === option.id && selectionRef.current.map === map) return;
    const owner: SelectionOwner = { id: option.id, map, previous: map.basemap, candidate: null };
    selectionRef.current = owner;
    const revision = ++operationRevisionRef.current;
    setPendingId(option.id);
    setSelectionError(null);
    setNotice(null);
    try {
      await gateRef.current?.run(async (operation) => {
        operation.signal.throwIfAborted();
        const candidate = constructorRef.current?.fromId(option.id);
        if (!candidate) throw new Error('Basemap option unavailable.');
        owner.candidate = candidate;
        await applySelectedBasemap(candidate, map, {
          ...operation,
          isCurrent: () => operation.isCurrent() && selectionRef.current === owner
            && (MapManager.GetMapView() as BasemapView | null)?.map === map
            && (map.basemap === owner.previous || map.basemap === owner.candidate),
        });
        if (operation.isCurrent()) {
          releaseDetachedBasemap(appliedRef.current);
          appliedRef.current = { map, basemap: candidate };
          setSelectedId(option.id);
          setNotice(`${option.label} altlığı uygulandı.`);
        }
      });
    } catch (error) {
      if (!mountedRef.current || revision !== operationRevisionRef.current) return;
      if (isAbortLikeError(error)) {
        setSelectedId((MapManager.GetMapView() as BasemapView | null)?.map?.basemap?.id ?? null);
        setNotice('Altlık seçimi durduruldu. Mevcut haritanız korunuyor.');
        return;
      }
      setSelectionError('Seçilen altlık yüklenemedi. Mevcut haritanız korunuyor; yeniden seçebilir veya başka bir altlık deneyebilirsiniz.');
    } finally {
      if (mountedRef.current && revision === operationRevisionRef.current) {
        selectionRef.current = null;
        setPendingId(null);
      }
    }
  }, [cancelSelection]);

  const captureCancelButton = useCallback((node: HTMLButtonElement | null): void => {
    if (!node && cancelButtonRef.current === document.activeElement) focusOptionRef.current = selectionRef.current?.id ?? pendingId;
    cancelButtonRef.current = node;
  }, [pendingId, visible]);
  useLayoutEffect(() => {
    if (!visible) { focusOptionRef.current = null; return; }
    const optionId = focusOptionRef.current;
    if (pendingId || !optionId) return;
    focusOptionRef.current = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    const button = Array.from(galleryRef.current?.querySelectorAll<HTMLButtonElement>('[data-basemap-id]') ?? [])
      .find(candidate => candidate.dataset.basemapId === optionId);
    (button ?? searchRef.current)?.focus();
  }, [pendingId, visible]);

  useImperativeHandle(ref, () => ({
    id, visible: false, minimized: false,
    OnShow: () => {
      setSelectionError(null); setNotice(null); setQuery('');
      if (model.getSnapshot().phase === 'error' && !model.getSnapshot().canReload) model.resetAttempts();
      void initialize();
    },
    OnClose: () => {
      cancelSelection(); focusOptionRef.current = null;
      if (model.getSnapshot().phase === 'loading') model.cancel();
    },
  }), [cancelSelection, id, initialize, model]);
  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
    return () => {
      mountedRef.current = false;
      operationRevisionRef.current += 1;
      selectionRef.current = null;
      gateRef.current?.cancel('widget-unmounted');
      releaseDetachedBasemap(appliedRef.current);
      appliedRef.current = null;
      if (model.getSnapshot().phase === 'loading') model.cancel();
      if (!catalogRef.current.length) initialLoadRequestedRef.current = false;
      windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
      queueMicrotask(() => {
        if (mountedRef.current) return;
        gateRef.current?.dispose(); model.dispose();
      });
    };
  }, [id, model, ref, windowManager]);
  useEffect(() => {
    if (initialLoadRequestedRef.current || !visible) return;
    initialLoadRequestedRef.current = true; void initialize();
  }, [initialize, visible]);

  const terms = normalizeSearchText(query).split(' ').filter(Boolean);
  const matches = catalog.filter(option => {
    const text = normalizeSearchText(`${option.label} ${option.detail}`);
    return terms.every(term => text.includes(term));
  });
  const selected = catalog.find(option => option.id === selectedId);
  const pending = catalog.find(option => option.id === pendingId);
  const status = pending ? `${pending.label} yükleniyor; mevcut altlığınız korunuyor.`
    : notice ?? (catalog.length ? `${catalog.length} altlık harita seçeneği` : null);

  return (
    <MapWidgetSurface id={id} title="Altlık Haritalar" className="basemap-gallery-surface" windowManager={windowManager}
      busy={snapshot.busy || pendingId !== null} error={snapshot.error || selectionError} status={status} statusTone="info">
      <div className="basemap-gallery" ref={galleryRef}>
        <p className="basemap-picker__intro">Haritanıza uygun bir görünüm seçin. Veri katmanlarınız ve haritadaki konumunuz korunur.</p>
        {catalog.length > 0 ? <>
          <div className="basemap-picker__current">
            <div><span>Etkin altlık</span><strong>{selected?.label ?? (selectedId ? 'Özel harita altlığı' : 'Henüz altlık seçilmedi')}</strong></div>
            {pending ? <button type="button" className="map-widget-action" ref={captureCancelButton}
              onClick={() => cancelSelection('Yükleme iptal edildi. Mevcut altlık haritanız korunuyor.')}>
              Yüklemeyi iptal et
            </button> : selectedId ? <span className="basemap-picker__current-mark" aria-hidden="true">✓</span> : null}
          </div>
          <div className="basemap-picker__search">
            <label htmlFor={`${id}-basemap-search`}>Altlık ara</label>
            <div>
              <input ref={searchRef} id={`${id}-basemap-search`} type="search" value={query} maxLength={120}
                placeholder="Uydu, sokak, açık gri…" onChange={event => setQuery(event.currentTarget.value)}
                aria-describedby={`${id}-basemap-count`} autoComplete="off" />
              {query ? <button type="button" className="map-widget-action" aria-label="Altlık aramasını temizle"
                onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Temizle</button> : null}
            </div>
            <p id={`${id}-basemap-count`} role="status" aria-live="polite">{matches.length} / {catalog.length} altlık gösteriliyor</p>
          </div>
        </> : null}
        <p className="sr-only" role="status" aria-live="polite">{snapshot.announcement}</p>
        {snapshot.busy && !catalog.length ? <MapWidgetSkeleton rows={4} label="Altlık haritalar hazırlanıyor" /> : null}
        {snapshot.phase === 'error' ? <MapWidgetEmptyState title="Altlık seçenekleri açılamadı" description={snapshot.canReload ? 'Bağlantınızı kontrol ederek yeniden deneyebilirsiniz.' : 'Yükleme sınırına ulaşıldı. Pencereyi kapatıp yeniden açabilirsiniz.'} action={snapshot.canReload ? <button type="button" className="map-widget-action map-widget-action--primary" onClick={() => void initialize()}>Seçenekleri yeniden yükle</button> : undefined} /> : null}
        {catalog.length > 0 && !matches.length ? <MapWidgetEmptyState title="Eşleşen altlık bulunamadı" description="Daha kısa bir ad deneyin veya aramayı temizleyin." /> : null}
        <div className="basemap-picker" role="group" aria-label="Altlık harita seçenekleri">
          {matches.map(option => <button key={option.id} type="button" data-basemap-id={option.id}
            className={`basemap-picker__option basemap-picker__option--${option.tone}`}
            aria-label={option.label} aria-description={option.detail} aria-pressed={selectedId === option.id}
            aria-busy={pendingId === option.id || undefined} onClick={() => void selectBasemap(option)}>
            <svg className="basemap-picker__symbol" viewBox="0 0 60 38" aria-hidden="true"><path d="M0 0h60v38H0z" className="basemap-picker__land" /><path d="M0 24 18 19 28 2M27 38l5-18L60 8" className="basemap-picker__road" /><path d="m0 8 18 7 24 16 18 4" className="basemap-picker__water" /></svg>
            <span className="basemap-picker__copy"><strong>{option.label}</strong><span>{option.detail}</span>
              {pendingId === option.id ? <em>Yükleniyor</em> : selectedId === option.id ? <em>Etkin</em> : null}
            </span>
            <span className="basemap-picker__selection" aria-hidden="true">{pendingId === option.id ? '…' : selectedId === option.id ? '✓' : ''}</span>
          </button>)}
        </div>
        <p className="basemap-picker__hint">Altlıklar bağlantı gerektirir. Yükleme tamamlanana kadar mevcut görünümünüz değişmez.</p>
      </div>
    </MapWidgetSurface>
  );
});
BasemapWidget.displayName = 'BasemapWidget';
