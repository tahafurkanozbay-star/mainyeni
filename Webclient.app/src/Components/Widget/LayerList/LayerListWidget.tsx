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
import { createArcgisWidgetHost, type OwnedArcgisWidgetHost } from '../../../gis-engine/arcgisWidgetHost';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';
import { withTimeout } from '../../../platform/runtime/resilience';
import { createManagedWindowFocusLifecycle } from '../../Query/_Common/ManagedWindowFocus';

const OWNER_ID = 'layer-list-widget';
const MAX_RUNTIME_GROUPS = 64;
const MAX_RUNTIME_LAYERS = 512;
const LAYER_PANEL_POLICY = Object.freeze({ catalogTimeoutMs: 15_000, legendTimeoutMs: 15_000, layerTimeoutMs: 15_000 });

interface LayerRuntime {
  visible: boolean;
  opacity: number;
  load?: (options: { signal: AbortSignal }) => Promise<unknown>;
  cancelLoad?: () => void;
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
  new(options: Readonly<{ view: MapViewLike; container: HTMLElement }>): LegendLike;
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

const reportLayerListError = (error: unknown, context: 'catalog' | 'legend' | 'cleanup'): void => {
  try {
    runtimeDiagnostics.captureError(error, { source: `experience.layer-list.${context}` }, 'warn');
  } catch {
    globalThis.console?.warn?.(`LayerList ${context} error reporter failed.`);
  }
};

// Preserve every code point in a key; replacing punctuation with a dash can
// make distinct configured layers share the same aria-activedescendant ID.
const rowDomId = (treeId: string, key: string): string =>
  `${treeId}-row-${Array.from(key, (character) => character.codePointAt(0)?.toString(16)).join('-')}`;

const disposePanelLayer = (layer: LayerRuntime | null): void => {
  try { layer?.cancelLoad?.(); }
  catch (error) { reportLayerListError(error, 'cleanup'); }
  try { layer?.destroy?.(); }
  catch (error) { reportLayerListError(error, 'cleanup'); }
};

const loadPanelLayer = async (source: LayerDefinition, parentSignal: AbortSignal): Promise<LayerRuntime> => {
  let candidate: LayerRuntime | null = null;
  const dispose = (): void => {
    const layer = candidate;
    candidate = null;
    disposePanelLayer(layer);
  };
  try {
    const layer = await withTimeout(async (signal) => {
      try {
        const created: unknown = await CommonBusiness.CreateLayer(source);
        if (!isRecord(created)) throw new TypeError('Katman çalışma zamanı oluşturulamadı.');
        const runtime = created as unknown as LayerRuntime;
        candidate = runtime;
        signal.throwIfAborted();
        await runtime.load?.({ signal });
        signal.throwIfAborted();
        return runtime;
      } catch (error) { dispose(); throw error; }
    }, LAYER_PANEL_POLICY.layerTimeoutMs, parentSignal);
    candidate = null;
    return layer;
  } catch (error) { dispose(); throw error; }
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
    const [legendError, setLegendError] = useState(false);
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
    const ownerViewRef = useRef<MapViewLike | null>(null);
    const catalogViewRef = useRef<MapViewLike | null>(null);
    const catalogNeedsReloadRef = useRef(true);
    const catalogAbortRef = useRef<AbortController | null>(null);
    const rootRef = useRef<HTMLElement | null>(null);
    const legendRef = useRef<LegendLike | null>(null);
    const legendHostParentRef = useRef<HTMLDivElement | null>(null);
    const legendHostRef = useRef<OwnedArcgisWidgetHost | null>(null);
    const legendRequestRef = useRef(0);
    const legendLoadingRef = useRef(false);
    const legendViewRef = useRef<MapViewLike | null>(null);
    const activeTabRef = useRef<LayerListTab>('layers');
    const mountedRef = useRef(true);
    const requestVersionRef = useRef(0);
    const runtimeByKeyRef = useRef(new Map<string, RuntimeLayerRecord>());
    const sourceGroupsRef = useRef<readonly LayerGroup[]>(Object.freeze([]));
    const searchRef = useRef<HTMLInputElement | null>(null);
    const treeRef = useRef<HTMLDivElement | null>(null);
    const layersTabRef = useRef<HTMLButtonElement | null>(null);
    const legendTabRef = useRef<HTMLButtonElement | null>(null);

    const clearOwnedLayers = useCallback((): void => {
      try { ownerRef.current?.clear(); }
      catch (error) { reportLayerListError(error, 'cleanup'); }
      const layers = new Set(Array.from(runtimeByKeyRef.current.values(), (record) => record.runtime));
      runtimeByKeyRef.current.clear();
      for (const layer of layers) disposePanelLayer(layer);
    }, []);

    const getOwner = useCallback((view: MapViewLike): LayerOwner<LayerRuntime> | null => {
      if (!view) return null;
      if (ownerViewRef.current !== view) {
        clearOwnedLayers();
        ownerRef.current = createLayerOwner<LayerRuntime>(view, OWNER_ID);
        ownerViewRef.current = view;
      }
      return ownerRef.current;
    }, [clearOwnedLayers]);

    const disposeLegend = useCallback((): void => {
      legendRequestRef.current += 1;
      legendLoadingRef.current = false;
      legendViewRef.current = null;
      const legend = legendRef.current;
      legendRef.current = null;
      try {
        legend?.destroy?.();
      } catch (error) {
        reportLayerListError(error, 'cleanup');
      } finally {
        legendHostRef.current?.dispose();
        legendHostRef.current = null;
        if (mountedRef.current) {
          setLegendReady(false);
          setLegendError(false);
        }
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

    const fetchQueryResults = useCallback(async (force = false): Promise<void> => {
      const view = asMapView(MapManager.GetMapView());
      if (!view) {
        requestVersionRef.current += 1;
        catalogAbortRef.current?.abort();
        loader.cancel();
        catalogViewRef.current = null;
        catalogNeedsReloadRef.current = true;
        disposeLegend();
        sourceGroupsRef.current = Object.freeze([]);
        clearOwnedLayers();
        model.replace([]);
        model.markError('Harita görünümü hazır değil.');
        setMapView(null);
        return;
      }

      if (!force && catalogViewRef.current === view && !catalogNeedsReloadRef.current) return;
      catalogViewRef.current = view;
      catalogNeedsReloadRef.current = false;
      catalogAbortRef.current?.abort();
      const lifetime = new AbortController();
      catalogAbortRef.current = lifetime;

      setMapView(view);
      model.markLoading();
      loader.cancel();
      const owner = getOwner(view);
      clearOwnedLayers();
      const requestVersion = ++requestVersionRef.current;

      try {
        const result: unknown = await withTimeout(() => LayerBusiness.GetLayers(), LAYER_PANEL_POLICY.catalogTimeoutMs, lifetime.signal);
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
          (item) => loadPanelLayer(item.source.source, lifetime.signal),
          disposePanelLayer,
        );

        const viewChanged = asMapView(MapManager.GetMapView()) !== view;
        if (!mountedRef.current || requestVersion !== requestVersionRef.current || loaded.cancelled || viewChanged) {
          for (const success of loaded.successes) disposePanelLayer(success.result);
          if (viewChanged && mountedRef.current && requestVersion === requestVersionRef.current) {
            catalogNeedsReloadRef.current = true;
            model.replace([]);
            model.markError('Harita görünümü değişti. Katmanları yeniden yükleyin.');
            disposeLegend();
            setMapView(null);
          }
          return;
        }

        // Track every newly-created runtime before attachment so an admission
        // failure can release both attached and remaining candidates.
        for (const success of loaded.successes) {
          const { groupId: loadedGroupId, layerId, source } = success.source;
          runtimeByKeyRef.current.set(runtimeKey(loadedGroupId, layerId), Object.freeze({
            groupId: loadedGroupId,
            layerId,
            source,
            runtime: success.result,
          }));
        }
        for (const success of loaded.successes) {
          if (owner?.add(success.result, success.source.priority) === null) {
            throw new Error('Katman haritaya eklenemedi.');
          }
        }

        applyPresentationCatalog();
      } catch (error) {
        if (mountedRef.current && requestVersion === requestVersionRef.current) {
          reportLayerListError(error, 'catalog');
          sourceGroupsRef.current = Object.freeze([]);
          clearOwnedLayers();
          model.replace([]);
          model.markError('Katman kataloğu yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.');
        }
      }
    }, [applyPresentationCatalog, clearOwnedLayers, disposeLegend, getOwner, loader, model]);

    useImperativeHandle(ref, () => ({
      id,
      visible: windowManager.IsVisible(id),
      minimized: windowManager.IsMinimized(id),
      OnShow: () => {
        const mode = windowManager.GetQueryParams?.(id)?.mode === 'legend' ? 'legend' : 'layers';
        activeTabRef.current = mode;
        setActiveTab(mode);
        void fetchQueryResults();
      },
      OnClose: () => {
        catalogNeedsReloadRef.current = model.getSnapshot().status === 'loading' || loader.getSnapshot().status === 'loading';
        requestVersionRef.current += 1;
        catalogAbortRef.current?.abort();
        loader.cancel();
        activeTabRef.current = 'layers';
        setActiveTab('layers');
        disposeLegend();
      },
    }), [disposeLegend, fetchQueryResults, id, loader, model, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      windowManager.RegisterWindow(ref);

      return () => {
        mountedRef.current = false;
        catalogAbortRef.current?.abort();
        requestVersionRef.current += 1;
        loader.cancel();
        clearOwnedLayers();
        ownerRef.current = null;
        ownerViewRef.current = null;
        catalogViewRef.current = null;
        catalogNeedsReloadRef.current = true;
        // StrictMode replays effects synchronously. Retire the observable
        // models only after a real unmount, keeping that replay usable.
        queueMicrotask(() => {
          if (mountedRef.current) return;
          loader.dispose();
          model.dispose();
        });
        sourceGroupsRef.current = Object.freeze([]);
        legendRequestRef.current += 1;
        legendLoadingRef.current = false;
        legendViewRef.current = null;
        try {
          legendRef.current?.destroy?.();
        } catch (error) {
          reportLayerListError(error, 'cleanup');
        } finally {
          legendRef.current = null;
          legendHostRef.current?.dispose();
          legendHostRef.current = null;
        }
        windowManager.UnregisterWindow?.(id, ref);
      };
    }, [clearOwnedLayers, id, loader, model, ref, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      if (windowManager.IsVisible(id) || reloadGeneration > 0) void fetchQueryResults(reloadGeneration > 0);
      return () => {
        requestVersionRef.current += 1;
        loader.cancel();
      };
    }, [fetchQueryResults, id, loader, reloadGeneration, windowManager]);

    const refreshLegend = useCallback(async (): Promise<void> => {
      if (!mountedRef.current || activeTabRef.current !== 'legend' || !mapView) return;
      if (legendViewRef.current === mapView && (legendRef.current || legendLoadingRef.current)) return;
      if (legendRef.current || legendLoadingRef.current) disposeLegend();
      const request = ++legendRequestRef.current;
      legendLoadingRef.current = true;
      legendViewRef.current = mapView;
      setLegendReady(false);
      setLegendError(false);
      try {
        const [Legend] = await withTimeout(() => loadArcgisModules<readonly [LegendConstructor]>(['esri/widgets/Legend']), LAYER_PANEL_POLICY.legendTimeoutMs);
        if (
          !mountedRef.current
          || activeTabRef.current !== 'legend'
          || legendRequestRef.current !== request
          || legendViewRef.current !== mapView
        ) return;
        const parent = legendHostParentRef.current;
        if (!parent) return;
        legendHostRef.current = createArcgisWidgetHost(parent);
        legendRef.current = new Legend({ view: mapView, container: legendHostRef.current.container });
        legendLoadingRef.current = false;
        setLegendReady(true);
      } catch (error) {
        if (!mountedRef.current || activeTabRef.current !== 'legend' || legendRequestRef.current !== request) return;
        legendLoadingRef.current = false;
        legendViewRef.current = null;
        legendHostRef.current?.dispose();
        legendHostRef.current = null;
        setLegendReady(false);
        setLegendError(true);
        reportLayerListError(error, 'legend');
      }
    }, [disposeLegend, legendContainerId, mapView]);

    const switchTab = useCallback((tab: LayerListTab): void => {
      activeTabRef.current = tab;
      setActiveTab(tab);
      if (tab === 'legend') void refreshLegend();
      else disposeLegend();
    }, [disposeLegend, refreshLegend]);

    useEffect(() => {
      if (activeTab === 'legend' && mapView) void refreshLegend();
    }, [activeTab, mapView, refreshLegend]);

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
      if (event.target !== event.currentTarget) return;
      const active = snapshot.rows.find((row) => row.key === snapshot.activeKey) ?? null;
      keyboardController.handleKeyDown(event.nativeEvent, active, Boolean(snapshot.query));
    }, [keyboardController, snapshot.activeKey, snapshot.query, snapshot.rows]);

    useEffect(() => {
      if (!snapshot.activeKey) return;
      const rowId = rowDomId(treeId, snapshot.activeKey);
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
    useEffect(() => {
      if (!visible) return;
      const focus = createManagedWindowFocusLifecycle();
      focus.open({ root: rootRef.current, initialFocusSelector: '.layer-list-tab[aria-selected="true"], .common-query-window-tool-button' });
      return () => { focus.close(); focus.dispose(); };
    }, [visible]);
    const activeDescendantId = snapshot.activeKey
      ? rowDomId(treeId, snapshot.activeKey)
      : undefined;
    const loading = snapshot.status === 'loading' || loadSnapshot.status === 'loading';
    const degraded = loadSnapshot.status === 'partial';

    return (
      <section
        ref={rootRef}
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

        <div className="common-query-window-body layer-list-window-body" hidden={minimized}>
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
                      <button type="button" onClick={() => { model.clearQuery(); searchRef.current?.focus({ preventScroll: true }); }} aria-label="Katman aramasını temizle">
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
                  data-tone={snapshot.status === 'error' ? 'danger' : degraded ? 'warning' : loading ? 'busy' : 'neutral'}
                >
                  <span>{loading && loadSnapshot.total > 0
                    ? loadSnapshot.announcement
                    : degraded
                      ? loadSnapshot.announcement
                      : snapshot.announcement}</span>
                  {loading && loadSnapshot.total > 0 ? (
                    <span aria-hidden="true">%{loadSnapshot.progressPercent}</span>
                  ) : null}
                </div>

                {degraded ? (
                  <div className="layer-list-degraded" role="note" aria-label="Kısmi katman yükleme durumu">
                    <div>
                      <strong>Bazı katmanlar yüklenemedi</strong>
                      <span>
                        {loadSnapshot.completed} katman kullanılabilir durumda; {loadSnapshot.failed} katman yüklenemedi.
                      </span>
                    </div>
                    <button type="button" onClick={retryLoad}>Katmanları yeniden yükle</button>
                  </div>
                ) : null}

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
                          const rowId = rowDomId(treeId, row.key);
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
                                onFocus={() => model.setActive(row.key)}
                                onPointerDown={() => model.setActive(row.key)}
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
                              onFocus={() => model.setActive(row.key)}
                              onPointerDown={() => model.setActive(row.key)}
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
                  {legendError ? (
                    <div className="layer-list-recovery" role="alert">
                      <strong>Lejant yüklenemedi</strong>
                      <button type="button" onClick={() => { void refreshLegend(); }}>Tekrar dene</button>
                    </div>
                  ) : !legendReady ? (
                    <p className="layer-list-legend-status" role="status">Lejant hazırlanıyor…</p>
                  ) : null}
                  <div ref={legendHostParentRef} id={legendContainerId} aria-label="Harita lejantı" />
                </div>
              </section>
            </>
        </div>
      </section>
    );
  },
);

LayerListWidget.displayName = 'LayerListWidget';
