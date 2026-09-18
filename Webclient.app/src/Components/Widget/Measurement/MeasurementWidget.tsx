import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
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
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import {
  ExperienceToolbar,
  type ExperienceToolbarItem,
} from '../../Common/ExperienceToolbar';
import MapManager from '../../../Store/Managers/MapManager';
import {
  createMeasurementController,
  MEASUREMENT_TOOLS,
  type MeasurementController,
  type MeasurementState,
  type MeasurementTool,
} from '../../../gis-engine/measurementRuntime';
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

const INITIAL_STATE: MeasurementState = {
  status: 'idle',
  activeTool: MEASUREMENT_TOOLS.NONE,
  error: null,
  createdAt: null,
  clearedAt: null,
  destroyedAt: null,
};

const statusText = (state: MeasurementState): string => {
  if (state.error) return state.error.message;
  if (state.status === 'loading') return 'Ölçüm aracı hazırlanıyor.';
  if (state.status === 'destroyed') return 'Ölçüm aracı kapatıldı.';
  if (state.activeTool === MEASUREMENT_TOOLS.AREA) {
    return 'Alan ölçümü etkin. Harita üzerinde ölçmek istediğiniz alanı çizin.';
  }
  if (state.activeTool === MEASUREMENT_TOOLS.DISTANCE) {
    return 'Mesafe ölçümü etkin. Harita üzerinde ölçmek istediğiniz hattı çizin.';
  }
  return 'Alan veya mesafe aracını seçerek ölçüme başlayın.';
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Ölçüm aracı hazırlanırken beklenmeyen bir sorun oluştu.';
};

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
  const controllerRef = useRef<MeasurementController | null>(null);
  const unsubscribeRef = useRef<(() => boolean) | null>(null);
  const focusLifecycleRef = useRef<ManagedWindowFocusLifecycle | null>(null);
  const mapViewRef = useRef<unknown>(null);
  const [state, setState] = useState<MeasurementState>(INITIAL_STATE);
  const [actionError, setActionError] = useState<string | null>(null);

  const getFocusLifecycle = useCallback((): ManagedWindowFocusLifecycle | null => {
    if (typeof document === 'undefined') return null;
    focusLifecycleRef.current ??= createManagedWindowFocusLifecycle(document);
    return focusLifecycleRef.current;
  }, []);

  const ensureController = useCallback((): MeasurementController | null => {
    const view = MapManager.GetMapView?.() ?? mapViewRef.current;
    if (!view) {
      setActionError('Harita görünümü hazır değil. Harita yüklendikten sonra tekrar deneyin.');
      return null;
    }

    if (!controllerRef.current || controllerRef.current.destroyed) {
      const controller = createMeasurementController({
        view,
        container: 'measurementDiv',
        onDiagnostic: (diagnostic) => {
          if (diagnostic.phase === 'load' || diagnostic.phase === 'tool') {
            setActionError(diagnostic.message);
          }
        },
      });
      controllerRef.current = controller;
      unsubscribeRef.current?.();
      unsubscribeRef.current = controller.subscribe((nextState) => {
        setState(nextState);
        if (!nextState.error) setActionError(null);
      });
    } else {
      controllerRef.current.setView(view);
      controllerRef.current.setContainer('measurementDiv');
    }

    return controllerRef.current;
  }, []);

  const initialize = useCallback(async (): Promise<void> => {
    const view = MapManager.GetMapView?.() ?? null;
    mapViewRef.current = view;
    const controller = ensureController();
    if (!controller) return;

    try {
      await controller.ensureWidget();
      setActionError(null);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [ensureController]);

  const selectTool = useCallback(async (tool: MeasurementTool): Promise<void> => {
    const controller = ensureController();
    if (!controller) return;

    if (state.activeTool === tool) {
      controller.clear();
      setActionError(null);
      return;
    }

    try {
      await controller.setTool(tool);
      setActionError(null);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [ensureController, state.activeTool]);

  const clearMeasurement = useCallback((): void => {
    controllerRef.current?.clear();
    setActionError(null);
  }, []);

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
      void initialize();
    },
    OnClose: () => {
      controllerRef.current?.clear();
      getFocusLifecycle()?.close();
    },
  }), [getFocusLifecycle, id, initialize, windowManager]);

  useEffect(() => {
    windowManager.RegisterWindow(ref);
    mapViewRef.current = MapManager.GetMapView?.() ?? null;

    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      controllerRef.current?.destroy();
      controllerRef.current = null;
      focusLifecycleRef.current?.dispose();
      focusLifecycleRef.current = null;
    };
  }, [ref, windowManager]);

  const loading = state.status === 'loading';
  const message = actionError ?? statusText(state);
  const tone = actionError || state.error
    ? 'danger'
    : state.activeTool === MEASUREMENT_TOOLS.NONE
      ? 'info'
      : 'success';

  const toolbarItems: readonly ExperienceToolbarItem[] = [
    {
      id: MEASUREMENT_TOOLS.AREA,
      label: 'Alan ölç',
      icon: <ToolGlyph kind="area" />,
      pressed: state.activeTool === MEASUREMENT_TOOLS.AREA,
      disabled: loading,
      onActivate: () => void selectTool(MEASUREMENT_TOOLS.AREA),
    },
    {
      id: MEASUREMENT_TOOLS.DISTANCE,
      label: 'Mesafe ölç',
      icon: <ToolGlyph kind="distance" />,
      pressed: state.activeTool === MEASUREMENT_TOOLS.DISTANCE,
      disabled: loading,
      onActivate: () => void selectTool(MEASUREMENT_TOOLS.DISTANCE),
    },
    {
      id: 'clear',
      label: 'Ölçümü temizle',
      icon: <ToolGlyph kind="clear" />,
      disabled: loading || state.activeTool === MEASUREMENT_TOOLS.NONE,
      onActivate: clearMeasurement,
    },
  ];

  return (
    <section
      ref={rootRef}
      className="common-query-window common-query-window-right measurement-widget"
      style={{ visibility: windowManager.IsVisible(id) ? 'visible' : 'hidden' }}
      aria-labelledby={`${id}-title`}
      aria-busy={loading || undefined}
    >
      <div className="common-query-window-header">
        <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" aria-hidden="true" />
        <span id={`${id}-title`}>Ölçüm Araçları</span>
        <CommonQueryWindowTools windowManager={windowManager} windowId={id} showNearbySearch={false} showMapSelect={false} setQueryField={() => undefined} />
      </div>
      <div className="measurement-widget__body">
        <ExperienceToolbar ariaLabel="Ölçüm araçları" items={toolbarItems} orientation="horizontal" />
        <ExperienceStatus tone={tone} role={actionError || state.error ? 'alert' : 'status'}>{message}</ExperienceStatus>
        <div id="measurementDiv" className="measurement-widget__canvas" aria-label="ArcGIS ölçüm denetimi" />
      </div>
    </section>
  );
});

MeasurementWidget.displayName = 'MeasurementWidget';

export default MeasurementWidget;
