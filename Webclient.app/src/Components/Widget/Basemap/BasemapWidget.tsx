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
type BasemapOption = typeof BASEMAP_OPTIONS[number] & { readonly previewUrl?: string };
interface BasemapPreviewMetadata extends SelectableBasemap {
  readonly thumbnailUrl?: unknown;
  readonly portalItem?: { readonly thumbnailUrl?: unknown } | null;
}

const normalizeBasemapPreviewUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const FALLBACK_PREVIEW_ART: Readonly<Record<string, ReactNode>> = Object.freeze({
  topo: <><path d="M-5 10 Q8 -2 21 10 T47 10 T73 10" /><path d="M-5 17 Q8 5 21 17 T47 17 T73 17" /><path d="M-5 24 Q8 12 21 24 T47 24 T73 24" /><path d="M-5 31 Q8 19 21 31 T47 31 T73 31" /></>,
  streets: <><path d="M-4 7 L64 31 M6 -4 L30 43 M34 -3 L58 42 M-5 30 L66 9" /><path d="M-4 22 L64 22" className="basemap-preview__minor-road" /></>,
  satellite: <><path d="M0 3 11 0 19 8 14 17 4 16Z M30 0 41 3 38 13 26 11Z M4 25 20 18 28 31 13 40Z M38 21 60 18 64 31 48 39Z" className="basemap-preview__vegetation" /><path d="M-3 22 18 13 34 20 64 3" className="basemap-preview__satellite-road" /></>,
  hybrid: <><path d="M0 3 11 0 19 8 14 17 4 16Z M30 0 41 3 38 13 26 11Z M4 25 20 18 28 31 13 40Z M38 21 60 18 64 31 48 39Z" className="basemap-preview__vegetation" /><path d="M-3 22 18 13 34 20 64 3 M0 33 L60 18" className="basemap-preview__satellite-road" /><path d="M8 6h5 M42 26h6 M29 8h5" className="basemap-preview__label" /></>,
  'dark-gray': <><path d="M0 7 H60 M0 19 H60 M0 31 H60 M11 0 V38 M29 0 V38 M47 0 V38" className="basemap-preview__grid" /><path d="M-4 30 L18 19 30 23 64 4 M7 -4 L28 41" /></>,
  gray: <><path d="M3 3h13v9H3z M24 4h12v12H24z M43 2h13v8H43z M7 25h12v10H7z M29 26h10v8H29z M47 23h12v12H47z" className="basemap-preview__blocks" /><path d="M-3 19 L63 19 M21 -3 L21 41 M41 -3 L41 41" /></>,
  'national-geographic': <><path d="M-5 6 Q10 0 19 8 T43 8 T70 7 M-5 12 Q10 6 19 14 T43 14 T70 13 M-5 27 Q10 21 19 29 T43 29 T70 28" className="basemap-preview__contours" /><path d="M-3 35 L18 21 28 25 63 3" className="basemap-preview__highlight-road" /></>,
  oceans: <><path d="M0 7 Q7 2 14 7 T28 7 T42 7 T56 7 T70 7 M0 17 Q7 12 14 17 T28 17 T42 17 T56 17 T70 17 M0 27 Q7 22 14 27 T28 27 T42 27 T56 27 T70 27" className="basemap-preview__waves" /><path d="M10 0 25 3 30 12 23 19 16 17 11 25 2 20 5 9Z M44 22 55 19 62 27 58 36 47 33Z" className="basemap-preview__landmass" /></>,
  osm: <><path d="M0 5h14v8H0z M20 2h10v13H20z M39 3h16v9H39z M4 23h12v12H4z M25 24h13v9H25z M45 22h11v12H45z" className="basemap-preview__parks" /><path d="M-2 18 L62 18 M17 -3 L17 41 M36 -2 L36 41 M-3 32 L63 8" /></>,
  terrain: <><path d="M0 0 14 3 23 0 33 6 44 2 60 7 V38 H0Z" className="basemap-preview__elevation" /><path d="M-3 10 Q8 1 18 10 T39 10 T65 10 M-3 19 Q8 10 18 19 T39 19 T65 19 M-3 28 Q8 19 18 28 T39 28 T65 28" className="basemap-preview__contours" /></>,
  'dark-gray-vector': <><path d="M0 7 H60 M0 19 H60 M0 31 H60 M11 0 V38 M29 0 V38 M47 0 V38" className="basemap-preview__grid" /><path d="M-4 30 L18 19 30 23 64 4 M7 -4 L28 41" className="basemap-preview__vector-road" /></>,
  'gray-vector': <><path d="M0 7 H60 M0 19 H60 M0 31 H60 M11 0 V38 M29 0 V38 M47 0 V38" className="basemap-preview__grid" /><path d="M-4 30 L18 19 30 23 64 4 M7 -4 L28 41" className="basemap-preview__vector-road" /></>,
  'streets-vector': <><path d="M0 4 H60 M0 15 H60 M0 27 H60 M12 0 V38 M31 0 V38 M49 0 V38" className="basemap-preview__grid" /><path d="M-4 34 L18 19 30 22 64 1 M5 -4 L28 41" className="basemap-preview__vector-road" /><path d="M4 9h7 M37 21h9 M34 32h10" className="basemap-preview__label" /></>,
  'streets-night-vector': <><path d="M0 4 H60 M0 15 H60 M0 27 H60 M12 0 V38 M31 0 V38 M49 0 V38" className="basemap-preview__grid" /><path d="M-4 34 L18 19 30 22 64 1 M5 -4 L28 41" className="basemap-preview__night-road" /><path d="M4 9h7 M37 21h9 M34 32h10" className="basemap-preview__night-label" /></>,
  'streets-navigation-vector': <><path d="M0 4 H60 M0 15 H60 M0 27 H60 M12 0 V38 M31 0 V38 M49 0 V38" className="basemap-preview__grid" /><path d="M-4 34 L18 19 30 22 64 1" className="basemap-preview__route-casing" /><path d="M-4 34 L18 19 30 22 64 1" className="basemap-preview__route" /></>,
  'topo-vector': <><path d="M-5 7 Q8 -3 21 7 T47 7 T73 7 M-5 14 Q8 4 21 14 T47 14 T73 14 M-5 22 Q8 12 21 22 T47 22 T73 22 M-5 30 Q8 20 21 30 T47 30 T73 30" className="basemap-preview__contours" /><path d="M-3 34 L18 21 28 25 63 3" className="basemap-preview__vector-road" /><path d="M9 7h5 M39 15h7 M43 29h5" className="basemap-preview__label" /></>,
  'streets-relief-vector': <><path d="M-5 6 Q8 -4 21 6 T47 6 T73 6 M-5 14 Q8 4 21 14 T47 14 T73 14 M-5 25 Q8 15 21 25 T47 25 T73 25" className="basemap-preview__contours" /><path d="M-4 33 L18 18 30 22 64 2 M9 -4 L28 41" className="basemap-preview__vector-road" /></>,
});

const BasemapPreview = ({ option }: { readonly option: BasemapOption }): ReactNode => {
  if (option.previewUrl) {
    return <img className="basemap-picker__symbol basemap-picker__image" src={option.previewUrl} alt="" loading="lazy" decoding="async" />;
  }
  return <svg className={`basemap-picker__symbol basemap-picker__fallback basemap-picker__fallback--${option.id}`} data-preview-id={option.id} viewBox="0 0 60 38" aria-hidden="true">
    <rect width="60" height="38" className="basemap-preview__background" />
    {FALLBACK_PREVIEW_ART[option.id] ?? FALLBACK_PREVIEW_ART.streets}
  </svg>;
};
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
        const available = BASEMAP_OPTIONS.flatMap((option): BasemapOption[] => {
          let candidate: SelectableBasemap | null | undefined;
          try {
            candidate = Basemap.fromId(option.id);
            if (!candidate) return [];
            const metadata = candidate as BasemapPreviewMetadata;
            const previewUrl = normalizeBasemapPreviewUrl(
              metadata.thumbnailUrl ?? metadata.portalItem?.thumbnailUrl,
            );
            return [{ ...option, ...(previewUrl ? { previewUrl } : {}) }];
          } catch (error) {
            reportCatalogFailure(error);
            return [];
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
            <BasemapPreview option={option} />
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
