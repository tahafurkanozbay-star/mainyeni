import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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

interface WindowManagerLike extends QueryWindowManagerLike {
  readonly RegisterWindow: (ref: unknown) => void;
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
  if (kind === 'area') {
    return <span className="measurement-widget__tool-glyph" aria-hidden="true">▱</span>;
  }
  if (kind === 'distance') {
    return <span className="measurement-widget__tool-glyph" aria-hidden="true">↔</span>;
  }
  return <span className="measurement-widget__tool-glyph" aria-hidden="true">⌫</span>;
};

export const MeasurementWidget = forwardRef<
  MeasurementWindowHandle,
  MeasurementWidgetProps
>(({ id, windowManager }, ref): ReactNode => {
  const rootRef = useRef<HTMLElement>(null);
  const focusLifecycleRef = useRef<ManagedWindowFocusLifecycle | null>(null);
  const controller = useMemo<MeasurementExperienceController>(() => createMeasurementExperienceController({
    getView: () => MapManager.GetMapView?.() ?? null,
    container: 'measurementDiv',
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
  }), []);
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
    void controller.retry();
  }, [controller]);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => {
      windowManager.ShowWindow('sidebar');
      const lifecycle = getFocusLifecycle();
      lifecycle?.open({
        root: rootRef.current,
        initialFocusSelector: '[data-roving-focus-id]',
        restorePolicy: 'if-focus-within',
      });
      void controller.open();
    },
    OnClose: () => {
      controller.close();
      getFocusLifecycle()?.close();
    },
  }), [controller, getFocusLifecycle, id, windowManager]);

  useEffect(() => {
    windowManager.RegisterWindow(ref);
    controller.refreshView();

    return () => {
      controller.dispose();
      focusLifecycleRef.current?.dispose();
      focusLifecycleRef.current = null;
    };
  }, [controller, ref, windowManager]);

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
      style={{ visibility: windowManager.IsVisible(id) ? 'visible' : 'hidden' }}
      aria-labelledby={`${id}-title`}
      aria-busy={snapshot.busy || undefined}
      data-measurement-phase={snapshot.phase}
      data-measurement-tool={snapshot.activeTool || 'none'}
      onKeyDownCapture={() => controller.recordInputModality('keyboard')}
      onPointerDownCapture={() => controller.recordInputModality('pointer')}
    >
      <div className="common-query-window-header">
        <img
          className="common-query-window-header-icon"
          src="images/icons/toolbar/olcumaraci.png"
          alt=""
          aria-hidden="true"
        />
        <span id={`${id}-title`}>Ölçüm Araçları</span>
        <CommonQueryWindowTools
          windowManager={windowManager}
          windowId={id}
          showNearbySearch={false}
          showMapSelect={false}
          setQueryField={() => undefined}
        />
      </div>

      <div className="measurement-widget__body">
        <p className="measurement-widget__intro">
          Harita üzerinde alan ve mesafe ölçün. Araç seçimi, yükleme ve hata durumu klavye ve ekran okuyucu kullanıcılarına canlı olarak bildirilir.
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
          id="measurementDiv"
          className="measurement-widget__canvas"
          aria-label="ArcGIS ölçüm denetimi"
          aria-busy={snapshot.busy || undefined}
          aria-describedby="measurement-widget-canvas-help"
        />
        <p id="measurement-widget-canvas-help" className="measurement-widget__canvas-help">
          Ölçüm aracını seçtikten sonra harita üzerinde gerekli noktaları işaretleyin. Sonuçlar ArcGIS ölçüm denetiminde gösterilir.
        </p>
      </div>
    </section>
  );
});

MeasurementWidget.displayName = 'MeasurementWidget';

export default MeasurementWidget;
