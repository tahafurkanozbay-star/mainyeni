import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Accordion, Form, Tab, Tabs } from 'react-bootstrap';
import { BiCheckCircle, BiCircle, BiMinusCircle } from 'react-icons/bi';
import { CommonBusiness } from '../../../Business/CommonBusiness';
import { LayerBusiness } from '../../../Business/LayerBusiness';
import { Constants_ServiceResultType } from '../../../Core/Constants';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import {
  createLayerOwner,
  type LayerOwner,
  type LayerViewLike,
} from '../../../gis-engine/layerOwnership';
import MapManager from '../../../Store/Managers/MapManager';
import DynamicLayerManager from '../../../Store/Managers/DynamicLayerManager';
import { ContainerLoading, NoResultsFound } from '../../Common/Loading';
import { SharedGISIcon } from '../../Common/SharedGISIcon';
import { CommonQueryWindowTools } from '../../Query/_Common/CommonQueryWindowTools';
import type {
  ManagedQueryWindowHandle,
  ManagedQueryWindowManager,
  UnknownRecord,
} from '../../Query/_Common/QuerySurfaceContracts';
import './LayerListWidget.css';

const OWNER_ID = 'layer-list-widget';

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
  readonly visible?: boolean;
  readonly semiVisible?: boolean;
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
  return value.map(asGroup).filter((item): item is LayerGroup => item !== null);
};

const evaluateGroupVisibility = (layerGroup: LayerGroup): LayerGroup => {
  const layers = Array.isArray(layerGroup.layers) ? layerGroup.layers : [];
  const visibleLayersCount = layers.filter((layer) => layer.visible).length;
  return {
    ...layerGroup,
    layers,
    visible: layers.length > 0 && visibleLayersCount === layers.length,
    semiVisible: visibleLayersCount > 0 && visibleLayersCount < layers.length,
  };
};

const getConfiguredOperationalGroup = (
  groups: readonly LayerGroup[],
): LayerGroup | null => {
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

const readDynamicLayer = (value: unknown): LayerDefinition | null =>
  asLayer(value);

const safeTitle = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
};

export const LayerListWidget = forwardRef<
  ManagedQueryWindowHandle,
  LayerListWidgetProps
>(({ id, windowManager }, ref): ReactNode => {
  const [layerGroups, setLayerGroups] = useState<LayerGroup[] | null>(null);
  const [mapView, setMapView] = useState<MapViewLike | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [, setLegend] = useState<LegendLike | null>(null);

  const ownerRef = useRef<LayerOwner<LayerRuntime> | null>(null);
  const legendRef = useRef<LegendLike | null>(null);
  const requestVersionRef = useRef(0);
  const mountedRef = useRef(true);

  const getOwner = useCallback((): LayerOwner<LayerRuntime> | null => {
    const view = asMapView(MapManager.GetMapView());
    if (!view) return null;
    if (!ownerRef.current) {
      ownerRef.current = createLayerOwner<LayerRuntime>(view, OWNER_ID);
    }
    return ownerRef.current;
  }, []);

  const disposeLegend = useCallback((): void => {
    try {
      legendRef.current?.destroy?.();
    } finally {
      legendRef.current = null;
      if (mountedRef.current) setLegend(null);
    }
  }, []);

  const fetchQueryResults = useCallback(async (): Promise<void> => {
    const view = asMapView(MapManager.GetMapView());
    if (!view) {
      if (mountedRef.current) {
        setLayerGroups([]);
        setMapView(null);
      }
      return;
    }

    setMapView(view);
    const owner = getOwner();
    owner?.clear();
    const requestVersion = ++requestVersionRef.current;

    try {
      const result: unknown = await LayerBusiness.GetLayers();
      if (!mountedRef.current || requestVersion !== requestVersionRef.current) return;

      const envelope = isRecord(result) ? result as LayerServiceResult : null;
      if (envelope?.type !== Constants_ServiceResultType.Success) {
        setLayerGroups([]);
        return;
      }

      const groups = readGroups(envelope.data);
      const operationalGroup = getConfiguredOperationalGroup(groups);
      const layerItems = operationalGroup?.layers ?? [];
      const layerCount = layerItems.length;

      const creations = layerItems.map(async (layerItem, layerIndex) => {
        try {
          const created: unknown = await CommonBusiness.CreateLayer(layerItem);
          const layerObject = isRecord(created)
            ? created as unknown as LayerRuntime
            : null;

          if (!mountedRef.current || requestVersion !== requestVersionRef.current) {
            layerObject?.destroy?.();
            return null;
          }
          if (!layerObject) return null;

          const requestedPriority = Number.parseInt(String(layerItem.priority ?? ''), 10);
          const normalizedPriority = Number.isFinite(requestedPriority)
            ? Math.max(0, layerCount - requestedPriority)
            : layerIndex;
          owner?.add(layerObject, normalizedPriority);
          return { source: layerItem, layerObject, priority: normalizedPriority };
        } catch (error) {
          globalThis.reportError?.(error);
          return null;
        }
      });

      const createdLayers = await Promise.all(creations);
      if (!mountedRef.current || requestVersion !== requestVersionRef.current) return;

      const layerObjectBySource = new Map<
        LayerDefinition,
        { readonly layerObject: LayerRuntime; readonly priority: number }
      >();

      for (const entry of createdLayers) {
        if (!entry) continue;
        layerObjectBySource.set(entry.source, {
          layerObject: entry.layerObject,
          priority: entry.priority,
        });
      }

      const hydratedGroups = groups.map((group) => {
        const hydratedLayers = (group.layers ?? []).map((layerItem) => {
          const created = layerObjectBySource.get(layerItem);
          return created
            ? {
                ...layerItem,
                priority: created.priority,
                layerObj: created.layerObject,
                visible: created.layerObject.visible,
                opacity: Math.round(created.layerObject.opacity * 100),
              }
            : {
                ...layerItem,
                layerObj: layerItem.layerObj ?? null,
              };
        });
        return evaluateGroupVisibility({ ...group, layers: hydratedLayers });
      });

      setLayerGroups(hydratedGroups);
    } catch (error) {
      globalThis.reportError?.(error);
      if (mountedRef.current && requestVersion === requestVersionRef.current) {
        setLayerGroups([]);
      }
    }
  }, [getOwner]);

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
      disposeLegend();
    },
  }), [disposeLegend, fetchQueryResults, id, windowManager]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow(ref);
    void fetchQueryResults();

    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
      ownerRef.current?.clear();
      ownerRef.current = null;
      try {
        legendRef.current?.destroy?.();
      } finally {
        legendRef.current = null;
      }
      windowManager.UnregisterWindow?.(id, ref);
    };
  }, [fetchQueryResults, id, ref, windowManager]);

  const toggleGroupVisibility = (
    event: MouseEvent<HTMLButtonElement>,
    groupIndex: number,
  ): void => {
    event.stopPropagation();
    setLayerGroups((current) => {
      if (!current?.[groupIndex]) return current;
      const groups = [...current];
      const source = groups[groupIndex];
      if (!source) return current;
      const visible = !source.visible;
      const layers = (source.layers ?? []).map((layer) => {
        if (layer.layerObj) layer.layerObj.visible = visible;
        return { ...layer, visible };
      });
      groups[groupIndex] = {
        ...source,
        layers,
        visible,
        semiVisible: false,
      };
      return groups;
    });
  };

  const toggleLayerVisibility = (
    event: MouseEvent<HTMLButtonElement>,
    layer: LayerDefinition,
    groupIndex: number,
    layerIndex: number,
  ): void => {
    event.stopPropagation();
    const layerObject = layer.layerObj;
    if (!layerObject) return;

    layerObject.visible = !layerObject.visible;
    setLayerGroups((current) => {
      if (!current?.[groupIndex]) return current;
      const groups = [...current];
      const source = groups[groupIndex];
      if (!source) return current;
      const layers = [...(source.layers ?? [])];
      const currentLayer = layers[layerIndex];
      if (!currentLayer) return current;
      layers[layerIndex] = {
        ...currentLayer,
        visible: layerObject.visible,
      };
      groups[groupIndex] = evaluateGroupVisibility({ ...source, layers });
      return groups;
    });
  };

  const changeLayerOpacity = (
    event: ChangeEvent<HTMLInputElement>,
    layer: LayerDefinition,
    groupIndex: number,
    layerIndex: number,
  ): void => {
    const opacity = Math.min(100, Math.max(0, Number(event.target.value) || 0));
    if (layer.layerObj) layer.layerObj.opacity = opacity / 100;

    setLayerGroups((current) => {
      if (!current?.[groupIndex]) return current;
      const groups = [...current];
      const source = groups[groupIndex];
      if (!source) return current;
      const layers = [...(source.layers ?? [])];
      const currentLayer = layers[layerIndex];
      if (!currentLayer) return current;
      layers[layerIndex] = { ...currentLayer, opacity };
      groups[groupIndex] = { ...source, layers };
      return groups;
    });
  };

  const refreshLegend = useCallback(async (): Promise<void> => {
    if (legendRef.current || !mapView) return;
    try {
      const [Legend] = await loadArcgisModules<readonly [LegendConstructor]>([
        'esri/widgets/Legend',
      ]);
      if (!mountedRef.current || legendRef.current) return;
      const nextLegend = new Legend({ view: mapView, container: 'legendDiv' });
      legendRef.current = nextLegend;
      setLegend(nextLegend);
    } catch (error) {
      globalThis.reportError?.(error);
      disposeLegend();
    }
  }, [disposeLegend, mapView]);

  const dynamicLayers = DynamicLayerManager
    .GetLayers()
    .map(readDynamicLayer)
    .filter((item): item is LayerDefinition => item !== null);

  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  return (
    <section
      className="common-query-window common-query-window-right"
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
        {layerGroups === null ? (
          <ContainerLoading message="Katmanlar hazırlanıyor…" />
        ) : minimized ? (
          <div aria-hidden="true" />
        ) : (
          <Tabs
            defaultActiveKey="layers"
            onSelect={(key) => {
              if (key === 'legend') {
                void refreshLegend();
              } else {
                disposeLegend();
              }
            }}
            aria-label="Katman yönetimi görünümleri"
          >
            <Tab eventKey="layers" title="Katmanlar">
              <div>
                {dynamicLayers.length > 0 ? (
                  <Accordion defaultActiveKey="dynamiclayers">
                    <Accordion.Item eventKey="dynamiclayers">
                      <Accordion.Header>
                        <span className="row w-100 align-items-center">
                          <span className="col-1">
                            <SharedGISIcon record={{ category: 'default' }} size={24} />
                          </span>
                          <span className="col-11 layer-list-group-title">
                            Özel Katmanlar
                          </span>
                        </span>
                      </Accordion.Header>
                      <Accordion.Body>
                        {dynamicLayers.map((layer, index) => {
                          const title = safeTitle(layer.title, 'Özel katman');
                          const key = layer.id ?? `${title}-${index}`;
                          return (
                            <div className="layer-list-item" key={String(key)}>
                              <div className="col-1">
                                <SharedGISIcon record={layer} size={24} />
                              </div>
                              <span className="col-8 layer-list-item-title" title={title}>
                                {title}
                              </span>
                              <div className="col-3" />
                            </div>
                          );
                        })}
                      </Accordion.Body>
                    </Accordion.Item>
                  </Accordion>
                ) : null}

                <Accordion
                  activeKey={activeGroup ?? undefined}
                  onSelect={(eventKey) => setActiveGroup(
                    typeof eventKey === 'string' ? eventKey : null,
                  )}
                >
                  {layerGroups.length === 0 ? (
                    <NoResultsFound message="Gösterilecek katman bulunmuyor" />
                  ) : layerGroups.map((group, groupIndex) => {
                    const groupKey = String(group.id ?? `group-${groupIndex}`);
                    const groupTitle = safeTitle(group.title, 'Katman grubu');
                    return (
                      <Accordion.Item
                        key={groupKey}
                        eventKey={groupKey}
                        className="layer-list-group-accordion-item"
                      >
                        <Accordion.Header className="layer-list-group-accordion-item-header">
                          <span className="layer-list-group-title">
                            <SharedGISIcon record={group} size={24} />
                            <span>{groupTitle}</span>
                          </span>
                        </Accordion.Header>

                        <Accordion.Body>
                          <div className="layer-list-group-actions">
                            <button
                              type="button"
                              className="kr-layer-toggle"
                              onClick={(event) => toggleGroupVisibility(event, groupIndex)}
                              aria-label={`${groupTitle} grubunu ${group.visible ? 'gizle' : 'göster'}`}
                              aria-pressed={Boolean(group.visible)}
                            >
                              {group.visible ? (
                                <BiCheckCircle aria-hidden="true" />
                              ) : group.semiVisible ? (
                                <BiMinusCircle aria-hidden="true" />
                              ) : (
                                <BiCircle aria-hidden="true" />
                              )}
                              <span>{group.visible ? 'Grubu gizle' : 'Grubu göster'}</span>
                            </button>
                          </div>

                          {(group.layers ?? []).map((layer, layerIndex) => {
                            const layerTitle = safeTitle(layer.title, 'Katman');
                            const layerKey = String(
                              layer.id ?? `${groupKey}-${layerIndex}`,
                            );
                            const opacity = Math.min(
                              100,
                              Math.max(0, Number(layer.opacity ?? 100) || 0),
                            );
                            const opacityId = `layer-opacity-${groupKey}-${layerKey}`;
                            return (
                              <div
                                className="layer-list-item row"
                                key={layerKey}
                                aria-disabled={!layer.layerObj}
                              >
                                <div className="col-1">
                                  <button
                                    type="button"
                                    className="kr-layer-toggle"
                                    onClick={(event) => toggleLayerVisibility(
                                      event,
                                      layer,
                                      groupIndex,
                                      layerIndex,
                                    )}
                                    aria-label={`${layerTitle} katmanını ${layer.visible ? 'gizle' : 'göster'}`}
                                    aria-pressed={Boolean(layer.visible)}
                                    disabled={!layer.layerObj}
                                  >
                                    {layer.visible ? (
                                      <BiCheckCircle aria-hidden="true" />
                                    ) : (
                                      <BiCircle aria-hidden="true" />
                                    )}
                                  </button>
                                </div>
                                <div className="col-1 kr-layer-item-icon">
                                  <SharedGISIcon record={layer} size={24} />
                                </div>
                                <button
                                  type="button"
                                  className="col-7 layer-list-item-title"
                                  onClick={(event) => toggleLayerVisibility(
                                    event,
                                    layer,
                                    groupIndex,
                                    layerIndex,
                                  )}
                                  title={layerTitle}
                                  disabled={!layer.layerObj}
                                >
                                  {layerTitle}
                                </button>
                                <div className="col-3">
                                  <label
                                    className="experience-sr-only"
                                    htmlFor={opacityId}
                                  >
                                    Katman opaklığı: {layerTitle}
                                  </label>
                                  <Form.Range
                                    id={opacityId}
                                    min={0}
                                    max={100}
                                    value={opacity}
                                    onChange={(event) => changeLayerOpacity(
                                      event,
                                      layer,
                                      groupIndex,
                                      layerIndex,
                                    )}
                                    aria-valuetext={`Yüzde ${opacity}`}
                                    disabled={!layer.layerObj}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </Accordion.Body>
                      </Accordion.Item>
                    );
                  })}
                </Accordion>
              </div>
            </Tab>

            <Tab eventKey="legend" title="Lejant">
              <div className="legend-container">
                <div id="legendDiv" aria-label="Harita lejantı" />
              </div>
            </Tab>
          </Tabs>
        )}
      </div>
    </section>
  );
});

LayerListWidget.displayName = 'LayerListWidget';
