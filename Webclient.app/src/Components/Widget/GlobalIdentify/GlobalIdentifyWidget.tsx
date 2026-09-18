import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { BiZoomIn } from 'react-icons/bi';
import MapManager from '../../../Store/Managers/MapManager';
import { GisGraphicsHelper } from '../../../Toolbox/GisGraphicsHelper';
import { LoggingBusiness } from '../../../Business/LoggingBusiness';
import { createIdentifySession } from '../../../gis-engine/identifyRuntime';
import type { ManagedWindowHandle } from '../../../experience/contracts';
import {
  MapWidgetEmptyState,
  MapWidgetSection,
  MapWidgetSkeleton,
  MapWidgetSurface,
  type MapWidgetManagerLike,
} from '../_shared/MapWidgetSurface';
import {
  isAbortLikeError,
  isCompactWidgetViewport,
  normalizeWidgetError,
  objectIdFromIdentifyResult,
  safeRecordEntries,
} from '../_shared/MapWidgetRuntime';
import './GlobalIdentifyWidget.css';

interface IdentifyFeatureResult {
  readonly layerId?: string | number;
  readonly geometry?: unknown;
  readonly attributes?: Record<string, unknown>;
  readonly feature?: {
    readonly geometry?: unknown;
    readonly attributes?: Record<string, unknown>;
  };
}

interface IdentifyGroup {
  readonly layerId?: string | number;
  readonly layerName?: string;
  readonly features?: readonly IdentifyFeatureResult[];
}

interface IdentifyResponse {
  readonly groups: readonly IdentifyGroup[];
}

interface IdentifySessionLike {
  readonly run: (
    view: unknown,
    event: unknown,
    options: Readonly<{
      tolerance: number;
      concurrency: number;
      returnGeometry: boolean;
    }>,
  ) => Promise<IdentifyResponse>;
  readonly cancel: () => void;
}

export interface GlobalIdentifyWidgetProps {
  readonly id: string;
  readonly windowManager: MapWidgetManagerLike;
}

const geometryOf = (item: IdentifyFeatureResult): unknown => (
  item.geometry ?? item.feature?.geometry ?? null
);

const attributesOf = (item: IdentifyFeatureResult): Record<string, unknown> => (
  item.attributes ?? item.feature?.attributes ?? {}
);

export const GlobalIdentifyWidget = forwardRef<ManagedWindowHandle, GlobalIdentifyWidgetProps>(
  ({ id, windowManager }, ref): ReactNode => {
    const [mapView, setMapView] = useState<unknown>(null);
    const [results, setResults] = useState<readonly IdentifyGroup[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedByGroup, setSelectedByGroup] = useState<Record<string, number>>({});
    const sessionRef = useRef(createIdentifySession() as unknown as IdentifySessionLike);
    const mountedRef = useRef(true);
    const highlightGraphicRef = useRef<unknown>(null);

    const clearHighlight = useCallback((): void => {
      const view = MapManager.GetMapView() ?? mapView;
      if (view && highlightGraphicRef.current) {
        GisGraphicsHelper.RemoveGraphics(view, highlightGraphicRef.current);
        highlightGraphicRef.current = null;
      }
    }, [mapView]);

    const cancelIdentify = useCallback((): void => {
      sessionRef.current.cancel();
      if (mountedRef.current) setLoading(false);
    }, []);

    const executeIdentify = useCallback(async (event: unknown): Promise<void> => {
      const view = MapManager.GetMapView() ?? mapView;
      const eventWithPoint = event as { mapPoint?: unknown } | null;
      if (!view || !eventWithPoint?.mapPoint) {
        if (mountedRef.current) {
          setResults([]);
          setError('Bilgi almak için haritada geçerli bir konum seçin.');
          setLoading(false);
        }
        return;
      }

      sessionRef.current.cancel();
      setLoading(true);
      setResults(null);
      setError(null);
      setSelectedByGroup({});

      try {
        const response = await sessionRef.current.run(view, event, {
          tolerance: 3,
          concurrency: 4,
          returnGeometry: true,
        });
        if (!mountedRef.current) return;
        setResults(Array.isArray(response.groups) ? response.groups : []);
      } catch (caught) {
        if (!mountedRef.current || isAbortLikeError(caught)) return;
        setResults([]);
        setError(normalizeWidgetError(caught, 'Seçilen konum için bilgi alınamadı.'));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    }, [mapView]);

    useImperativeHandle(ref, () => ({
      id,
      visible: false,
      minimized: false,
      OnShow: () => {
        windowManager.ShowWindow('sidebar');
        void executeIdentify(MapManager.GetMapClickEvent());
      },
      OnClose: () => {
        cancelIdentify();
        clearHighlight();
        setResults(null);
        setError(null);
        setSelectedByGroup({});
      },
    }), [cancelIdentify, clearHighlight, executeIdentify, id, windowManager]);

    useEffect(() => {
      mountedRef.current = true;
      windowManager.RegisterWindow(ref as RefObject<ManagedWindowHandle | null>);
      setMapView(MapManager.GetMapView());
      const session = sessionRef.current;

      return () => {
        mountedRef.current = false;
        session.cancel();
        const view = MapManager.GetMapView();
        if (view && highlightGraphicRef.current) {
          GisGraphicsHelper.RemoveGraphics(view, highlightGraphicRef.current);
          highlightGraphicRef.current = null;
        }
        windowManager.UnregisterWindow?.(id, ref as RefObject<ManagedWindowHandle | null>);
      };
    }, [id, ref, windowManager]);

    const goToItem = useCallback(async (item: IdentifyFeatureResult): Promise<void> => {
      const view = MapManager.GetMapView() ?? mapView;
      const geometry = geometryOf(item);
      if (!view || !geometry) return;

      LoggingBusiness.CreateClientLog('Bilgi al/zoom', {
        layerId: item.layerId,
        objectId: objectIdFromIdentifyResult(item, 'unknown'),
      });

      try {
        const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(geometry, '4326');
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry);
        if (!graphic) throw new Error('Vurgu geometrisi oluşturulamadı.');
        clearHighlight();
        GisGraphicsHelper.AddGraphics(view, graphic);
        highlightGraphicRef.current = graphic;
        await Promise.resolve(GisGraphicsHelper.ZoomToGeometry(view, graphic, null));
        if (isCompactWidgetViewport()) windowManager.ToggleMinimiseWindow(id);
      } catch (caught) {
        setError(normalizeWidgetError(caught, 'Kayıt haritada gösterilemedi.'));
      }
    }, [clearHighlight, id, mapView, windowManager]);

    const resultCount = results?.reduce(
      (total, group) => total + (group.features?.length ?? 0),
      0,
    ) ?? 0;

    return (
      <MapWidgetSurface
        id={id}
        title="Bilgi Al"
        iconSrc="images/icons/toolbar/bilgi.png"
        windowManager={windowManager}
        busy={loading}
        error={error}
        status={!loading && results ? `${resultCount} kayıt, ${results.length} katman` : null}
        statusTone={resultCount > 0 ? 'success' : 'info'}
        bodyClassName="layer-list-window-body"
      >
        {loading ? <MapWidgetSkeleton rows={8} label="Harita nesneleri sorgulanıyor" /> : null}

        {!loading && results?.length === 0 ? (
          <MapWidgetEmptyState
            title="Bu konumda kayıt bulunamadı"
            description="Başka bir noktayı seçip Bilgi Al aracını yeniden çalıştırabilirsiniz."
          />
        ) : null}

        {!loading && results && results.length > 0 ? (
          <div className="identify-modern-groups">
            {results.map((group, groupIndex) => {
              const groupKey = String(group.layerId ?? groupIndex);
              const features = group.features ?? [];
              const selectedIndex = Math.min(
                selectedByGroup[groupKey] ?? 0,
                Math.max(0, features.length - 1),
              );
              const selected = features[selectedIndex];

              return (
                <details
                  key={groupKey}
                  className="identify-modern-group"
                  open={groupIndex === 0}
                >
                  <summary className="identify-modern-group__summary">
                    <span>{group.layerName || 'İsimsiz katman'}</span>
                    <span className="map-widget-chip">{features.length} kayıt</span>
                  </summary>

                  {features.length > 0 ? (
                    <MapWidgetSection
                      description="Kayıtlar arasında ok tuşlarıyla da gezinebilirsiniz."
                    >
                      <div
                        className="identify-modern-tabs"
                        role="tablist"
                        aria-label={`${group.layerName || 'Katman'} kayıtları`}
                      >
                        {features.map((feature, featureIndex) => {
                          const objectId = objectIdFromIdentifyResult(feature, featureIndex + 1);
                          const selectedTab = selectedIndex === featureIndex;
                          return (
                            <button
                              key={`${groupKey}-${objectId}-${featureIndex}`}
                              id={`${id}-${groupKey}-tab-${featureIndex}`}
                              type="button"
                              role="tab"
                              className="identify-modern-tab"
                              aria-selected={selectedTab}
                              tabIndex={selectedTab ? 0 : -1}
                              onClick={() => setSelectedByGroup((current) => ({
                                ...current,
                                [groupKey]: featureIndex,
                              }))}
                              onKeyDown={(event) => {
                                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                                event.preventDefault();
                                let next = selectedIndex;
                                if (event.key === 'ArrowLeft') next = (selectedIndex - 1 + features.length) % features.length;
                                if (event.key === 'ArrowRight') next = (selectedIndex + 1) % features.length;
                                if (event.key === 'Home') next = 0;
                                if (event.key === 'End') next = features.length - 1;
                                setSelectedByGroup((current) => ({ ...current, [groupKey]: next }));
                                queueMicrotask(() => {
                                  document.getElementById(`${id}-${groupKey}-tab-${next}`)?.focus();
                                });
                              }}
                            >
                              {String(objectId)}
                            </button>
                          );
                        })}
                      </div>

                      {selected ? (
                        <div
                          className="identify-modern-panel"
                          role="tabpanel"
                          aria-labelledby={`${id}-${groupKey}-tab-${selectedIndex}`}
                        >
                          <button
                            type="button"
                            className="map-widget-action map-widget-action--primary"
                            onClick={() => void goToItem(selected)}
                            disabled={!geometryOf(selected)}
                          >
                            <BiZoomIn aria-hidden="true" />
                            <span>Haritada göster</span>
                          </button>

                          <dl className="identify-modern-attributes">
                            {safeRecordEntries(attributesOf(selected)).map((entry) => (
                              <div className="identify-modern-attribute" key={entry.key}>
                                <dt>{entry.key}</dt>
                                <dd>{entry.value || '—'}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      ) : null}
                    </MapWidgetSection>
                  ) : (
                    <MapWidgetEmptyState title="Bu katmanda kayıt yok" />
                  )}
                </details>
              );
            })}
          </div>
        ) : null}
      </MapWidgetSurface>
    );
  },
);

GlobalIdentifyWidget.displayName = 'GlobalIdentifyWidget';
