import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  CommonQueryWindowTools,
  type QueryWindowManagerLike,
} from '../../Query/_Common/CommonQueryWindowTools';
import {
  createManagedWindowFocusLifecycle,
  type ManagedWindowFocusLifecycle,
} from '../../Query/_Common/ManagedWindowFocus';
import {
  ExperienceToolbar,
  type ExperienceToolbarItem,
} from '../../Common/ExperienceToolbar';
import MapManager from '../../../Store/Managers/MapManager';
import Store from '../../../Store/Store';
import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import type { ArcgisAccessorWatch, ArcgisReactiveHandle } from '../../../gis-engine/arcgisReactiveRuntime';
import {
  MEASUREMENT_TOOLS,
  type MeasurementTool,
} from '../../../gis-engine/measurementRuntime';
import { runtimeDiagnostics } from '../../../platform/runtime/runtimeDiagnostics';
import { MeasurementExperiencePanel } from './MeasurementExperiencePanel';
import {
  createMeasurementExperienceController,
  type MeasurementExperienceController,
} from './measurementExperienceController';
import './MeasurementWidget.css';
import { createArcgisWidgetHost, type OwnedArcgisWidgetHost } from '../../../gis-engine/arcgisWidgetHost';

interface WindowManagerLike extends QueryWindowManagerLike {
  readonly RegisterWindow: (ref: unknown) => void;
  readonly UnregisterWindow?: (id: string, ref: unknown) => void;
  readonly ShowWindow: (id: string) => void;
  readonly IsVisible: (id: string) => boolean;
}

export interface MeasurementWidgetProps {
  readonly id: string;
  readonly windowManager: WindowManagerLike;
}

export interface MeasurementWindowHandle {
  readonly id: string;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly OnShow: () => void;
  readonly OnClose: () => void;
}

const ToolGlyph = ({ kind }: { readonly kind: 'area' | 'distance' | 'clear' }): ReactNode => {
  const path = kind === 'area'
    ? 'm4 17 4-11 12 3-3 11-13-3Z M8 6l9 14'
    : kind === 'distance'
      ? 'M4 12h16 M8 8l-4 4 4 4 M16 8l4 4-4 4'
      : 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v5 M14 11v5';
  return (
    <span className="measurement-widget__tool-glyph" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <path d={path} />
      </svg>
    </span>
  );
};

export const MeasurementWidget = forwardRef<
  MeasurementWindowHandle,
  MeasurementWidgetProps
>(({ id, windowManager }, ref): ReactNode => {
  const visible = windowManager.IsVisible(id);
  const rootRef = useRef<HTMLElement>(null);
  const sdkHostParentRef = useRef<HTMLDivElement | null>(null);
  const sdkHostRef = useRef<OwnedArcgisWidgetHost | null>(null);
  const mountedRef = useRef(false);
  const retryFocusRef = useRef(false);
  const focusLifecycleRef = useRef<ManagedWindowFocusLifecycle | null>(null);
  const ensureSdkHost = useCallback((): void => {
    const parent = sdkHostParentRef.current;
    if (!parent) return;
    const host = sdkHostRef.current;
    if (host?.container.id === `${id}-measurement-sdk` && host.container.parentElement === parent) return;
    host?.dispose();
    sdkHostRef.current = createArcgisWidgetHost(parent, `${id}-measurement-sdk`);
  }, [id]);
  const controller = useMemo<MeasurementExperienceController>(() => createMeasurementExperienceController({
    getView: () => MapManager.GetMapView?.() ?? null,
    container: `${id}-measurement-sdk`,
    onRuntimeDetached: () => {
      if (mountedRef.current && currentControllerRef.current === controller) ensureSdkHost();
    },
    modelOptions: {
      maxRetries: 3,
      historyLimit: 12,
      onObserverError(error) {
        runtimeDiagnostics.captureError(error, {
          source: 'experience.measurement.observer',
        }, 'warn');
      },
    },
    onDiagnostic(diagnostic) {
      runtimeDiagnostics.record('experience.measurement.diagnostic', {
        phase: diagnostic.phase,
        code: diagnostic.code,
        failureKind: diagnostic.failureKind,
      });
    },
  }), [ensureSdkHost, id]);
  const currentControllerRef = useRef(controller);
  currentControllerRef.current = controller;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const getFocusLifecycle = useCallback((): ManagedWindowFocusLifecycle | null => {
    if (typeof document === 'undefined') return null;
    focusLifecycleRef.current ??= createManagedWindowFocusLifecycle(document);
    return focusLifecycleRef.current;
  }, []);

  const selectTool = useCallback((tool: MeasurementTool): void => {
    void controller.selectTool(tool);
  }, [controller]);

  const clearMeasurement = useCallback((): void => {
    controller.clear();
  }, [controller]);

  const retryMeasurement = useCallback((): void => {
    const active = document.activeElement;
    retryFocusRef.current = active instanceof HTMLElement && Boolean(rootRef.current?.contains(active))
      && active.matches('.measurement-experience__retry');
    void controller.retry();
  }, [controller]);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => {
      const lifecycle = getFocusLifecycle();
      lifecycle?.open({
        root: rootRef.current,
        initialFocusSelector: '[data-roving-focus-id]',
        restorePolicy: 'if-focus-within',
      });
      void controller.open();
    },
    OnClose: () => {
      retryFocusRef.current = false;
      controller.close();
      getFocusLifecycle()?.close();
    },
  }), [controller, getFocusLifecycle, id, windowManager]);

  useEffect(() => {
    mountedRef.current = true;
    ensureSdkHost();
    windowManager.RegisterWindow(ref);
    controller.refreshView();
    const host = sdkHostRef.current;

    return () => {
      mountedRef.current = false;
      controller.close();
      windowManager.UnregisterWindow?.(id, ref);
      focusLifecycleRef.current?.dispose();
      focusLifecycleRef.current = null;
      // Effect replay must not permanently retire the shared observable model
      // or replace the SDK host underneath an existing measurement instance.
      queueMicrotask(() => {
        if (mountedRef.current && currentControllerRef.current === controller) return;
        controller.dispose();
        const ownedHost = currentControllerRef.current === controller ? sdkHostRef.current : host;
        ownedHost?.dispose();
        if (sdkHostRef.current === ownedHost) sdkHostRef.current = null;
      });
    };
  }, [controller, ensureSdkHost, id, ref, windowManager]);

  useEffect(() => {
    if (!visible) return undefined;
    let disposed = false;
    let observedView: unknown;
    let watcher: ArcgisAccessorWatch | null = null;
    let handles: ArcgisReactiveHandle[] = [];
    const release = (): void => { handles.forEach(handle => handle.remove?.()); handles = []; };
    const synchronize = (): void => {
      if (disposed) return;
      const view = MapManager.GetMapView?.() ?? null;
      if (view !== observedView) {
        release(); observedView = view;
        if (view && watcher) {
          handles.push(watcher(view, 'ready', synchronize), watcher(view, 'destroyed', synchronize));
        }
      }
      controller.refreshView();
    };
    const unsubscribe = Store.subscribe(synchronize);
    void loadArcgisModules<readonly [{ watch: ArcgisAccessorWatch }]>(['esri/core/watchUtils']).then(([reactive]) => {
      if (disposed) return;
      watcher = reactive.watch; observedView = undefined; synchronize();
    }).catch(() => {
      if (disposed) return;
      // Store-based view replacement still works if the optional watcher fails.
      try { runtimeDiagnostics.record('experience.measurement.diagnostic', { phase: 'view', code: 'MEASUREMENT_VIEW_WATCH_UNAVAILABLE', failureKind: 'LoadError' }); }
      catch { console.warn('Ölçüm görünüm izleyicisi raporlanamadı.'); }
    });
    return () => { disposed = true; unsubscribe(); release(); };
  }, [controller, visible]);

  useLayoutEffect(() => {
    if (!retryFocusRef.current || snapshot.busy) return;
    retryFocusRef.current = false;
    if (!visible || windowManager.IsMinimized(id)) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    const target = rootRef.current?.querySelector<HTMLButtonElement>(
      snapshot.phase === 'error' ? '.measurement-experience__retry' : '[data-roving-focus-id]:not(:disabled)',
    );
    (target ?? rootRef.current)?.focus();
  }, [id, snapshot.busy, snapshot.phase, visible, windowManager]);

  const unavailable = snapshot.busy || !snapshot.viewReady || snapshot.phase === 'destroyed';
  const toolbarItems: readonly ExperienceToolbarItem[] = [
    {
      id: MEASUREMENT_TOOLS.AREA,
      label: 'Alan ölç',
      icon: <ToolGlyph kind="area" />,
      pressed: snapshot.activeTool === MEASUREMENT_TOOLS.AREA,
      disabled: unavailable,
      onActivate: () => selectTool(MEASUREMENT_TOOLS.AREA),
    },
    {
      id: MEASUREMENT_TOOLS.DISTANCE,
      label: 'Mesafe ölç',
      icon: <ToolGlyph kind="distance" />,
      pressed: snapshot.activeTool === MEASUREMENT_TOOLS.DISTANCE,
      disabled: unavailable,
      onActivate: () => selectTool(MEASUREMENT_TOOLS.DISTANCE),
    },
    {
      id: 'clear',
      label: 'Ölçümü temizle',
      icon: <ToolGlyph kind="clear" />,
      disabled: unavailable || !snapshot.canClear,
      onActivate: clearMeasurement,
    },
  ];

  return (
    <section
      ref={rootRef}
      className="common-query-window common-query-window-right measurement-widget"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      aria-hidden={!visible}
      aria-labelledby={`${id}-title`}
      role="region"
      tabIndex={-1}
      aria-busy={snapshot.busy || undefined}
      data-measurement-phase={snapshot.phase}
      data-measurement-tool={snapshot.activeTool || 'none'}
      data-measurement-minimized={String(windowManager.IsMinimized(id))}
      onKeyDownCapture={() => controller.recordInputModality('keyboard')}
      onPointerDownCapture={() => controller.recordInputModality('pointer')}
    >
      <header className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src="images/icons/toolbar/olcumaraci.png"
          alt=""
          aria-hidden="true"
        />
        <span id={`${id}-title`}>Ölçüm Araçları</span>
        <div className="measurement-widget__window-tools"><CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
          setQueryField={() => undefined}
        /></div>
      </header>

      <div className="measurement-widget__body" hidden={windowManager.IsMinimized(id)}>
        <p className="measurement-widget__intro">
          Alan veya mesafe aracını seçin, ardından haritada ölçmek istediğiniz noktaları işaretleyin.
        </p>

        <ExperienceToolbar
          label="Ölçüm araçları"
          items={toolbarItems}
          orientation="horizontal"
        />

        <MeasurementExperiencePanel
          snapshot={snapshot}
          onRetry={retryMeasurement}
        />

        <div
          ref={sdkHostParentRef}
          className="measurement-widget__canvas"
          aria-label="Ölçüm sonucu ve birimler"
          aria-busy={snapshot.busy || undefined}
          aria-describedby={`${id}-canvas-help`}
        />
        <p id={`${id}-canvas-help`} className="measurement-widget__canvas-help">
          Ölçüm aracını seçtikten sonra harita üzerinde gerekli noktaları işaretleyin. Sonucu ve ölçü birimini ölçüm alanından takip edebilirsiniz.
        </p>
      </div>
    </section>
  );
});

MeasurementWidget.displayName = 'MeasurementWidget';

export default MeasurementWidget;
