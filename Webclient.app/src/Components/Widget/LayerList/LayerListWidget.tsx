import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { LayerBusiness } from '../../../Business/LayerBusiness';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import {
  createLayerOwner,
  type LayerOwner,
  type LayerViewLike,
} from '../../../gis-engine/layerOwnership';
import DynamicLayerManager from '../../../Store/Managers/DynamicLayerManager';
import MapManager from '../../../Store/Managers/MapManager';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
import { CommonQueryWindowTools } from '../../Query/_Common/CommonQueryWindowTools';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
  UnknownRecord,
} from '../../Query/_Common/QuerySurfaceContracts';
import {
  LayerListExperienceModel,
  type LayerListGroupInput,
  type LayerListVisibleRow,
} from './layerListExperienceModel';
import { createLayerListKeyboardController } from './layerListKeyboardController';
import { auditLayerListCatalog, summarizeLayerListCatalogAudit } from './layerListCatalogAudit';
import { LayerListLoadCoordinator } from './layerListLoadCoordinator';
import './LayerListWidget.css';

const OWNER_ID = 'layer-list-widget';
const MAX_RUNTIME_GROUPS = 64;
const MAX_RUNTIME_LAYERS = 512;

interface LayerRuntime {
  visible: boolean;
  opacity: number;
  destroy?: () => void;
}

interface LayerDefinition extends UnknownRecord {
  readonly id?: string | number;
  readonly title?: string;
  readonly priority?: string | number;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly layerObj?: LayerRuntime | null;
}

interface LayerGroup extends UnknownRecord {
  readonly id?: string | number;
  readonly title?: string;
  readonly layers?: readonly LayerDefinition[];
}

interface LayerServiceResult {
  readonly type?: unknown;
  readonly data?: readonly unknown[] | null;
}

interface LayerMap {
  add?: (layer: LayerRuntime, index?: number) => unknown;
  remove?: (layer: LayerRuntime) => unknown;
}

interface MapViewLike extends LayerViewLike<LayerRuntime> {
  readonly map?: LayerMap | null;
}

interface LegendLike {
  destroy?: () => void;
}

interface LegendConstructor {
  new(options: Readonly<{ view: MapViewLike; container: string }>): LegendLike;
}

interface LayerListWidgetProps {
  readonly id: string;
  readonly windowManager: ManagedQueryWindowManager;
}

interface RuntimeLayerRecord {
  readonly groupId: string;
  readonly layerId: string;
  readonly source: LayerDefinition;
  readonly runtime: LayerRuntime;
}

interface LayerLoadSource {
  readonly groupId: string;
  readonly layerId: string;
  readonly source: LayerDefinition;
  readonly priority: number;
}

type LayerListTab = 'layers' | 'legend';

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asLayer = (value: unknown): LayerDefinition | null =>
  isRecord(value) ? value as LayerDefinition : null;

const asGroup = (value: unknown): LayerGroup | null => {
  if (!isRecord(value)) return null;
  const layers = Array.isArray(value.layers)
    ? value.layers.map(asLayer).filter((item): item is LayerDefinition => item !== null)
    : [];
  return { ...value, layers };
};

const readGroups = (value: unknown): LayerGroup[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(asGroup)
    .filter((item): item is LayerGroup => item !== null)
    .slice(0, MAX_RUNTIME_GROUPS);
};

const getConfiguredOperationalGroup = (groups: readonly LayerGroup[]): LayerGroup | null => {
  const configured = groups[2];
  if (configured?.layers?.length) return configured;
  return groups.find((group) => Boolean(group.layers?.length)) ?? null;
};

const asMapView = (value: unknown): MapViewLike | null => {
  if (!isRecord(value) || !isRecord(value.map)) return null;
  const map = value.map as LayerMap;
  if (typeof map.add !== 'function' || typeof map.remove !== 'function') return null;
  return value as unknown as MapViewLike;
};

const readDynamicLayer = (value: unknown): LayerDefinition | null => asLayer(value);

const safeTitle = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const normalized = String(value).replace(/\s+/gu, ' ').trim().slice(0, 180);
  return normalized || fallback;
};

const safeId = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const normalized = String(value).trim().slice(0, 96);
  return normalized || fallback;
};

const safeOpacity = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 100;
};

const groupIdFor = (group: LayerGroup, index: number): string =>
  safeId(group.id, `group-${index + 1}`);

const layerIdFor = (layer: LayerDefinition, groupId: string, index: number): string =>
  safeId(layer.id, `${groupId}-layer-${index + 1}`);

const runtimeKey = (groupId: string, layerId: string): string => `${groupId}::${layerId}`;

const buildPresentationGroups = (
  groups: readonly LayerGroup[],
  runtimeByKey: ReadonlyMap<string, RuntimeLayerRecord>,
): readonly LayerListGroupInput[] => Object.freeze(
  groups.slice(0, MAX_RUNTIME_GROUPS).map((group, groupIndex) => {
    const groupId = groupIdFor(group, groupIndex);
    const layers = (group.layers ?? []).slice(0, MAX_RUNTIME_LAYERS).map((layer, layerIndex) => {
      const layerId = layerIdFor(layer, groupId, layerIndex);
      const runtime = runtimeByKey.get(runtimeKey(groupId, layerId))?.runtime ?? layer.layerObj ?? null;
      return Object.freeze({
        id: layerId,
        title: safeTitle(layer.title, 'Katman'),
        visible: runtime?.visible ?? Boolean(layer.visible),
        opacity: runtime ? safeOpacity(runtime.opacity * 100) : safeOpacity(layer.opacity),
        disabled: !runtime,
      });
    });
    return Object.freeze({
      id: groupId,
      title: safeTitle(group.title, 'Katman grubu'),
      layers: Object.freeze(layers),
    });
  }),
);

const VisibilityMark = ({ visible, mixed = false }: Readonly<{ visible: boolean; mixed?: boolean }>) => (
  <span
    className="kr-layer-visibility-mark"
    data-visible={String(visible)}
    data-mixed={String(mixed)}
    aria-hidden="true"
  />
);

export const LayerListWidget = forwardRef<ManagedQueryWindowHandle, LayerListWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const treeId = useId();
    const statusId = useId();
    const searchId = useId();
    const legendContainerId = useMemo(
      () => `layer-list-legend-${id.replace(/[^a-z0-9_-]/giu, '-')}`,
      [id],
    );
    const [mapView, setMapView] = useState<MapViewLike | null>(null);
    const [activeTab, setActiveTab] = useState<LayerListTab>('layers');
    const [legendReady, setLegendReady] = useState(false);
    const [reloadGeneration, setReloadGeneration] = useState(0);

    const modelRef = useRef<LayerListExperienceModel | null>(null);
    if (!modelRef.current) {
      modelRef.current = new LayerListExperienceModel({
        maxGroups: MAX_RUNTIME_GROUPS,
        maxLayers: MAX_RUNTIME_LAYERS,
      });
    }
    const model = modelRef.current;
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);

    const loaderRef = useRef<LayerListLoadCoordinator<LayerLoadSource, LayerRuntime> | null>(null);
    if (!loaderRef.current) {
      loaderRef.current = new LayerListLoadCoordinator<LayerLoadSource, LayerRuntime>({
        concurrency: 4,
        maxItems: MAX_RUNTIME_LAYERS,
      });
    }
    const loader = loaderRef.current;
    const loadSnapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);

    const ownerRef = useRef<LayerOwner<LayerRuntime> | null>(null);
    const legendRef = useRef<LegendLike | null>(null);
    const mountedRef = useRef(true);
    const requestVersionRef = useRef(0);
    const runtimeByKeyRef = useRef(new Map<string, RuntimeLayerRecord>());
    const sourceGroupsRef = useRef<readonly LayerGroup[]>(Object.freeze([]));
    const searchRef = useRef<HTMLInputElement | null>(null);
    const treeRef = useRef<HTMLDivElement | null>(null);
    const layersTabRef = useRef<HTMLButtonElement | null>(null);
    const legendTabRef = useRef<HTMLButtonElement | null>(null);

    const getOwner = useCallback((): LayerOwner<LayerRuntime> | null => {
      const view = asMapView(MapManager.GetMapView());
      if (!view) return null;
      if (!ownerRef.current) ownerRef.current = createLayerOwner<LayerRuntime>(view, OWNER_ID);
      return ownerRef.current;
    }, []);

    const disposeLegend = useCallback((): void => {
      try {
        legendRef.current?.destroy?.();
      } finally {
        legendRef.current = null;
        if (mountedRef.current) setLegendReady(false);
      }
    }, []);

    const applyPresentationCatalog = useCallback((): void => {
      const catalog = buildPresentationGroups(sourceGroupsRef.current, runtimeByKeyRef.current);
      const audit = auditLayerListCatalog(catalog, {
        maxGroups: MAX_RUNTIME_GROUPS,
        maxLayers: MAX_RUNTIME_LAYERS,
      });
      if (!audit.valid) {
        globalThis.console?.warn?.('LayerList catalog integrity rejected.', summarizeLayerListCatalogAudit(audit));
        model.replace([]);
        model.markError('Katman kataloğu doğrulanamadı.');
        return;
      }
      if (audit.warningCount > 0) {
        globalThis.console?.warn?.('LayerList catalog integrity warnings.', summarizeLayerListCatalogAudit(audit));
      }
      model.replace(catalog);
    }, [model]);

    const fetchQueryResults = useCallback(async (): Promise<void> => {
      const view = asMapView(MapManager.GetMapView());
      if (!view) {
        sourceGroupsRef.current = Object.freeze([]);
        runtimeByKeyRef.current.clear();
        model.replace([]);
        model.markError('Harita görünümü hazır değil.');
        setMapView(null);
        return;
      }

      setMapView(view);
      model.markLoading();
      loader.cancel();
      const owner = getOwner();
      owner?.clear();
      runtimeByKeyRef.current.clear();
      const requestVersion = ++requestVersionRef.current;

      try {
        const result: unknown = await LayerBusiness.GetLayers();
        if (!mountedRef.current || requestVersion !== requestVersionRef.current) return;

        const envelope = isRecord(result) ? result as LayerServiceResult : null;
        if (envelope?.type !== Constants_ServiceResultType.Success) {
          sourceGroupsRef.current = Object.freeze([]);
          model.replace([]);
          model.markError('Katman kataloğu alınamadı.');
          return;
        }

        const groups = Object.freeze(readGroups(envelope.data));
        sourceGroupsRef.current = groups;
        const operationalGroup = getConfiguredOperationalGroup(groups);
        const operationalGroupIndex = operationalGroup ? groups.indexOf(operationalGroup) : -1;
        const groupId = operationalGroup && operationalGroupIndex >= 0
          ? groupIdFor(operationalGroup, operationalGroupIndex)
          : null;
        const layerItems = operationalGroup?.layers?.slice(0, MAX_RUNTIME_LAYERS) ?? [];
        const layerCount = layerItems.length;

        const work: readonly { key: string; source: LayerLoadSource }[] = groupId
          ? Object.freeze(layerItems.map((layer, layerIndex) => {
              const layerId = layerIdFor(layer, groupId, layerIndex);
              const requestedPriority = Number.parseInt(String(layer.priority ?? ''), 10);
              const priority = Number.isFinite(requestedPriority)
                ? Math.max(0, layerCount - requestedPriority)
                : layerIndex;
              return Object.freeze({
                key: runtimeKey(groupId, layerId),
                source: Object.freeze({ groupId, layerId, source: layer, priority }),
              });
            }))
          : Object.freeze([]);

        const loaded = await loader.load(
          work,
          async (item) => {
            const created: unknown = await CommonBusiness.CreateLayer(item.source.source);
            if (!isRecord(created)) throw new TypeError('Katman çalışma zamanı oluşturulamadı.');
            return created as unknown as LayerRuntime;
          },
          (runtime) => runtime.destroy?.(),
        );

        if (!mountedRef.current || requestVersion !== requestVersionRef.current || loaded.cancelled) {
          for (const success of loaded.successes) success.result.destroy?.();
          return;
        }

        for (const success of loaded.successes) {
          const { groupId: loadedGroupId, layerId, source, priority } = success.source;
          owner?.add(success.result, priority);
          runtimeByKeyRef.current.set(runtimeKey(loadedGroupId, layerId), Object.freeze({
            groupId: loadedGroupId,
            layerId,
            source,
            runtime: success.result,
          }));
        }

        applyPresentationCatalog();
      } catch (error) {
        globalThis.reportError?.(error);
        if (mountedRef.current && requestVersion === requestVersionRef.current) {
          sourceGroupsRef.current = Object.freeze([]);
          runtimeByKeyRef.current.clear();
          model.replace([]);
          model.markError(error);
        }
      }
    }, [applyPresentationCatalog, getOwner, loader, model]);

    useImperativeHandle(ref, () => ({
      id,
      visible: windowManager.IsVisible(id),
      minimized: windowManager.IsMinimized(id),
      OnShow: () => {
        windowManager.ShowWindow('sidebar');
        void fetchQueryResults();
      },
      OnClose: () => {
        requestVersionRef.current += 1;
        loader.cancel();
        disposeLegend();
      },
    }), [disposeLegend, fetchQueryResults, id, loader, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      windowManager.RegisterWindow(ref);

      return () => {
        mountedRef.current = false;
        requestVersionRef.current += 1;
        loader.dispose();
        model.dispose();
        ownerRef.current?.clear();
        ownerRef.current = null;
        runtimeByKeyRef.current.clear();
        sourceGroupsRef.current = Object.freeze([]);
        try {
          legendRef.current?.destroy?.();
        } finally {
          legendRef.current = null;
        }
        windowManager.UnregisterWindow?.(id, ref);
      };
    }, [id, loader, model, ref, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      void fetchQueryResults();
      return () => {
        requestVersionRef.current += 1;
        loader.cancel();
      };
    }, [fetchQueryResults, loader, reloadGeneration]);

    const refreshLegend = useCallback(async (): Promise<void> => {
      if (legendRef.current || !mapView) return;
      try {
        const [Legend] = await loadArcgisModules<readonly [LegendConstructor]>(['esri/widgets/Legend']);
        if (!mountedRef.current || legendRef.current) return;
        const nextLegend = new Legend({ view: mapView, container: legendContainerId });
        legendRef.current = nextLegend;
        setLegendReady(true);
      } catch (error) {
        globalThis.reportError?.(error);
        disposeLegend();
      }
    }, [disposeLegend, legendContainerId, mapView]);

    const switchTab = useCallback((tab: LayerListTab): void => {
      setActiveTab(tab);
      if (tab === 'legend') void refreshLegend();
      else disposeLegend();
    }, [disposeLegend, refreshLegend]);

    const focusTab = useCallback((tab: LayerListTab): void => {
      switchTab(tab);
      const target = tab === 'layers' ? layersTabRef.current : legendTabRef.current;
      target?.focus({ preventScroll: true });
    }, [switchTab]);

    const handleTabKeyDown = useCallback((
      event: ReactKeyboardEvent<HTMLButtonElement>,
      tab: LayerListTab,
    ): void => {
      let next: LayerListTab | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        next = tab === 'layers' ? 'legend' : 'layers';
      } else if (event.key === 'Home') {
        next = 'layers';
      } else if (event.key === 'End') {
        next = 'legend';
      }
      if (!next) return;
      event.preventDefault();
      focusTab(next);
    }, [focusTab]);

    const toggleVisibility = useCallback((row: LayerListVisibleRow): void => {
      if (row.kind === 'group') {
        const nextVisible = !(row.visible || row.mixed);
        for (const runtimeRecord of runtimeByKeyRef.current.values()) {
          if (runtimeRecord.groupId !== row.groupId) continue;
          runtimeRecord.runtime.visible = nextVisible;
        }
        model.setGroupVisibility(row.groupId, nextVisible);
        return;
      }

      if (!row.layerId) return;
      const record = runtimeByKeyRef.current.get(runtimeKey(row.groupId, row.layerId));
      if (!record) return;
      const nextVisible = !record.runtime.visible;
      record.runtime.visible = nextVisible;
      model.setLayerVisibility(row.groupId, row.layerId, nextVisible);
    }, [model]);

    const changeOpacity = useCallback((
      event: ChangeEvent<HTMLInputElement>,
      row: LayerListVisibleRow,
    ): void => {
      if (!row.layerId) return;
      const opacity = Math.max(0, Math.min(100, Number(event.currentTarget.value) || 0));
      const record = runtimeByKeyRef.current.get(runtimeKey(row.groupId, row.layerId));
      if (!record) return;
      record.runtime.opacity = opacity / 100;
      model.setLayerOpacity(row.groupId, row.layerId, opacity);
    }, [model]);

    const keyboardController = useMemo(() => createLayerListKeyboardController(
      model,
      () => searchRef.current?.focus({ preventScroll: true }),
      toggleVisibility,
    ), [model, toggleVisibility]);

    const handleTreeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const active = snapshot.rows.find((row) => row.key === snapshot.activeKey) ?? null;
      keyboardController.handleKeyDown(event.nativeEvent, active, Boolean(snapshot.query));
    }, [keyboardController, snapshot.activeKey, snapshot.query, snapshot.rows]);

    useEffect(() => {
      if (!snapshot.activeKey) return;
      const rowId = `${treeId}-${snapshot.activeKey.replace(/[^a-z0-9_-]/giu, '-')}`;
      document.getElementById(rowId)?.scrollIntoView?.({ block: 'nearest' });
    }, [snapshot.activeKey, treeId]);

    const retryLoad = useCallback((): void => {
      setReloadGeneration((generation) => generation + 1);
    }, []);

    const dynamicLayers = DynamicLayerManager
      .GetLayers()
      .map(readDynamicLayer)
      .filter((item): item is LayerDefinition => item !== null)
      .slice(0, MAX_RUNTIME_LAYERS);

    const visible = windowManager.IsVisible(id);
    const minimized = windowManager.IsMinimized(id);
    const activeDescendantId = snapshot.activeKey
      ? `${treeId}-${snapshot.activeKey.replace(/[^a-z0-9_-]/giu, '-')}`
      : undefined;
    const loading = snapshot.status === 'loading' || loadSnapshot.status === 'loading';

    return (
      <section
        className="common-query-window common-query-window-right layer-list-modern"
        aria-label="Katman ve lejand yönetimi"
        aria-hidden={!visible}
        style={{ visibility: visible ? 'visible' : 'hidden' }}
      >
        <header className="common-query-window-header">
          <img
            className="common-query-window-header-icon"
            src="images/icons/toolbar/katmanyonetimi.png"
            alt=""
            aria-hidden="true"
            decoding="async"
          />
          <span>Katmanlar</span>
          <CommonQueryWindowTools
            windowManager={windowManager}
            windowId={id}
            showNearbySearch={false}
            showMapSelect={false}
          />
        </header>

        <div className="common-query-window-body layer-list-window-body">
          {minimized ? <div aria-hidden="true" /> : (
            <>
              <div className="layer-list-tabs" role="tablist" aria-label="Katman yönetimi görünümleri">
                <button
                  ref={layersTabRef}
                  type="button"
                  id={`${treeId}-layers-tab`}
                  role="tab"
                  aria-selected={activeTab === 'layers'}
                  aria-controls={`${treeId}-layers-panel`}
                  className="layer-list-tab"
                  tabIndex={activeTab === 'layers' ? 0 : -1}
                  onClick={() => switchTab('layers')}
                  onKeyDown={(event) => handleTabKeyDown(event, 'layers')}
                >
                  Katmanlar
                </button>
                <button
                  ref={legendTabRef}
                  type="button"
                  id={`${treeId}-legend-tab`}
                  role="tab"
                  aria-selected={activeTab === 'legend'}
                  aria-controls={`${treeId}-legend-panel`}
                  className="layer-list-tab"
                  tabIndex={activeTab === 'legend' ? 0 : -1}
                  onClick={() => switchTab('legend')}
                  onKeyDown={(event) => handleTabKeyDown(event, 'legend')}
                >
                  Lejant
                </button>
              </div>

              <section
                id={`${treeId}-layers-panel`}
                role="tabpanel"
                aria-labelledby={`${treeId}-layers-tab`}
                hidden={activeTab !== 'layers'}
                className="layer-list-panel"
              >
                <div className="layer-list-search-region">
                  <label htmlFor={searchId}>Katman ara</label>
                  <div className="layer-list-search-shell">
                    <span className="layer-list-search-glyph" aria-hidden="true">⌕</span>
                    <input
                      ref={searchRef}
                      id={searchId}
                      type="search"
                      value={snapshot.query}
                      placeholder="Örn. imar, park, kadastro"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Katman ara"
                      aria-controls={treeId}
                      aria-describedby={statusId}
                      onChange={(event) => model.setQuery(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape' || !snapshot.query) return;
                        event.preventDefault();
                        model.clearQuery();
                      }}
                    />
                    {snapshot.query ? (
                      <button type="button" onClick={() => model.clearQuery()} aria-label="Katman aramasını temizle">
                        Temizle
                      </button>
                    ) : null}
                  </div>
                </div>

                <div
                  id={statusId}
                  className="layer-list-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  data-tone={snapshot.status === 'error' ? 'danger' : loading ? 'busy' : 'neutral'}
                >
                  <span>{loading && loadSnapshot.total > 0 ? loadSnapshot.announcement : snapshot.announcement}</span>
                  {loading && loadSnapshot.total > 0 ? (
                    <span aria-hidden="true">%{loadSnapshot.progressPercent}</span>
                  ) : null}
                </div>

                {snapshot.status === 'error' ? (
                  <div className="layer-list-recovery" role="alert">
                    <strong>Katmanlar kullanılamıyor</strong>
                    <span>{snapshot.errorMessage ?? 'Katman kataloğu yüklenemedi.'}</span>
                    <button type="button" onClick={retryLoad}>Tekrar dene</button>
                  </div>
                ) : (
                  <>
                    {dynamicLayers.length > 0 ? (
                      <section className="layer-list-dynamic" aria-labelledby={`${treeId}-dynamic-title`}>
                        <div className="layer-list-section-heading">
                          <span id={`${treeId}-dynamic-title`}>Özel Katmanlar</span>
                          <span aria-label={`${dynamicLayers.length} özel katman`}>{dynamicLayers.length}</span>
                        </div>
                        <div className="layer-list-dynamic-grid">
                          {dynamicLayers.map((layer, index) => {
                            const title = safeTitle(layer.title, 'Özel katman');
                            return (
                              <div className="layer-list-dynamic-item" key={safeId(layer.id, `${title}-${index}`)}>
                                <SharedGISIcon record={layer} size={24} />
                                <span title={title}>{title}</span>
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ) : null}

                    {snapshot.rows.length === 0 && !loading ? (
                      <div className="layer-list-empty" role="note">
                        <strong>{snapshot.query ? 'Eşleşme bulunamadı' : 'Gösterilecek katman yok'}</strong>
                        <span>{snapshot.query ? 'Arama ifadesini değiştirin veya temizleyin.' : 'Katman kataloğu şu anda boş.'}</span>
                        {snapshot.query ? <button type="button" onClick={() => model.clearQuery()}>Tüm katmanları göster</button> : null}
                      </div>
                    ) : (
                      <div
                        ref={treeRef}
                        id={treeId}
                        className="layer-list-tree"
                        role="tree"
                        aria-label="Harita katmanları"
                        aria-busy={loading || undefined}
                        aria-activedescendant={activeDescendantId}
                        tabIndex={0}
                        onKeyDown={handleTreeKeyDown}
                      >
                        {snapshot.rows.map((row) => {
                          const rowId = `${treeId}-${row.key.replace(/[^a-z0-9_-]/giu, '-')}`;
                          const opacityId = `${rowId}-opacity`;
                          if (row.kind === 'group') {
                            return (
                              <div
                                id={rowId}
                                key={row.key}
                                data-layer-row-key={row.key}
                                className="layer-list-tree-row layer-list-tree-group"
                                role="treeitem"
                                aria-level={1}
                                aria-expanded={Boolean(row.expanded)}
                                aria-selected={row.active}
                                data-active={row.active || undefined}
                                onMouseMove={() => model.setActive(row.key)}
                              >
                                <button
                                  type="button"
                                  className="layer-list-expand"
                                  onClick={() => model.toggleGroup(row.groupId)}
                                  aria-label={`${row.title} grubunu ${row.expanded ? 'daralt' : 'genişlet'}`}
                                  tabIndex={-1}
                                >
                                  <span aria-hidden="true">{row.expanded ? '▾' : '▸'}</span>
                                </button>
                                <SharedGISIcon record={{ category: 'default' }} size={24} />
                                <button
                                  type="button"
                                  className="layer-list-row-title"
                                  onClick={() => model.toggleGroup(row.groupId)}
                                  tabIndex={-1}
                                >
                                  {row.title}
                                </button>
                                <button
                                  type="button"
                                  className="layer-list-visibility"
                                  onClick={() => toggleVisibility(row)}
                                  aria-label={`${row.title} grubunu ${row.visible || row.mixed ? 'gizle' : 'göster'}`}
                                  aria-pressed={row.mixed ? 'mixed' : row.visible}
                                  disabled={row.disabled}
                                  tabIndex={-1}
                                >
                                  <VisibilityMark visible={row.visible} mixed={row.mixed} />
                                </button>
                              </div>
                            );
                          }

                          return (
                            <div
                              id={rowId}
                              key={row.key}
                              data-layer-row-key={row.key}
                              className="layer-list-tree-row layer-list-tree-layer"
                              role="treeitem"
                              aria-level={2}
                              aria-posinset={row.position}
                              aria-setsize={row.setSize}
                              aria-selected={row.active}
                              aria-disabled={row.disabled || undefined}
                              data-active={row.active || undefined}
                              onMouseMove={() => model.setActive(row.key)}
                            >
                              <span className="layer-list-tree-indent" aria-hidden="true" />
                              <SharedGISIcon record={{ category: 'default' }} size={24} />
                              <button
                                type="button"
                                className="layer-list-row-title"
                                onClick={() => toggleVisibility(row)}
                                disabled={row.disabled}
                                tabIndex={-1}
                                title={row.title}
                              >
                                {row.title}
                              </button>
                              <button
                                type="button"
                                className="layer-list-visibility"
                                onClick={() => toggleVisibility(row)}
                                aria-label={`${row.title} katmanını ${row.visible ? 'gizle' : 'göster'}`}
                                aria-pressed={row.visible}
                                disabled={row.disabled}
                                tabIndex={-1}
                              >
                                <VisibilityMark visible={row.visible} />
                              </button>
                              <div className="layer-list-opacity">
                                <label htmlFor={opacityId}>
                                  <span className="experience-sr-only">Katman opaklığı: {row.title}</span>
                                  <span aria-hidden="true">{row.opacity ?? 100}%</span>
                                </label>
                                <input
                                  id={opacityId}
                                  type="range"
                                  min={0}
                                  max={100}
                                  step={5}
                                  value={row.opacity ?? 100}
                                  onChange={(event) => changeOpacity(event, row)}
                                  aria-label={`Katman opaklığı: ${row.title}`}
                                  aria-valuetext={`Yüzde ${row.opacity ?? 100}`}
                                  disabled={row.disabled}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <p className="layer-list-keyboard-help">
                      <kbd>/</kbd> arama · <kbd>↑</kbd><kbd>↓</kbd> gezinme · <kbd>←</kbd><kbd>→</kbd> grup · <kbd>Enter</kbd> veya <kbd>Boşluk</kbd> eylem
                    </p>
                  </>
                )}
              </section>

              <section
                id={`${treeId}-legend-panel`}
                role="tabpanel"
                aria-labelledby={`${treeId}-legend-tab`}
                hidden={activeTab !== 'legend'}
                className="layer-list-panel"
              >
                <div className="legend-container">
                  {!legendReady ? <p className="layer-list-legend-status">Lejant hazırlanıyor…</p> : null}
                  <div id={legendContainerId} aria-label="Harita lejantı" />
                </div>
              </section>
            </>
          )}
        </div>
      </section>
    );
  },
);

LayerListWidget.displayName = 'LayerListWidget';
