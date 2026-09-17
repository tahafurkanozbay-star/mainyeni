import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { CommonQueryWindowTools } from '../../Query/_Common/CommonQueryWindowTools';
import MapManager from '../../../Store/Managers/MapManager';
import {
  createMeasurementController,
  MEASUREMENT_TOOLS,
  type MeasurementController,
  type MeasurementError,
  type MeasurementStatus,
  type MeasurementTool,
} from '../../../gis-engine/measurementRuntime';
import type { ManagedWindowHandle, WindowManagerApi } from '../../../Store/Managers/WindowManager';
import { ExperienceStatus } from '../../Common/ExperienceStatus';
import { ExperienceToolbar, type ExperienceToolbarAction } from '../../Common/ExperienceToolbar';
import './MeasurementWidget.css';

interface MeasurementWidgetProps {
  readonly id: string;
  readonly windowManager: WindowManagerApi;
}

const AreaIcon = (): ReactNode => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 18 9 5l11 4-4 11-12-2Z" /><path d="m7 15 3-7 7 2-3 7-7-2Z" />
  </svg>
);

const DistanceIcon = (): ReactNode => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 18 18 4l2 2L6 20l-2-2Z" /><path d="m13 7 4 4M10 10l2 2M7 13l2 2" />
  </svg>
);

const describeMeasurementError = (error: MeasurementError | null): string => {
  if (!error) return 'Ölçüm aracı hazırlanamadı.';
  if (error.code === 'MAP_VIEW_REQUIRED') return 'Harita görünümü henüz hazır değil. Harita yüklendiğinde yeniden deneyin.';
  if (error.code === 'CONTAINER_REQUIRED') return 'Ölçüm paneli hazırlanamadı. Pencereyi kapatıp yeniden açın.';
  return 'Ölçüm aracı yüklenirken bir sorun oluştu. Yeniden deneyebilirsiniz.';
};

export const MeasurementWidget = forwardRef<ManagedWindowHandle, MeasurementWidgetProps>(({ id, windowManager }, ref) => {
  const [activeTool, setActiveTool] = useState<MeasurementTool>(MEASUREMENT_TOOLS.NONE);
  const [status, setStatus] = useState<MeasurementStatus>('idle');
  const [error, setError] = useState<MeasurementError | null>(null);
  const controllerRef = useRef<MeasurementController | null>(null);
  const unsubscribeRef = useRef<(() => boolean) | null>(null);
  const mountedRef = useRef(true);

  const releaseController = useCallback((): void => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    controllerRef.current?.destroy();
    controllerRef.current = null;
  }, []);

  const ensureController = useCallback((): MeasurementController | null => {
    const view = MapManager.GetMapView();
    if (!view) return null;
    const current = controllerRef.current;
    if (current && !current.destroyed) {
      current.setView(view);
      current.setContainer('measurementDiv');
      return current;
    }

    const controller = createMeasurementController({ view, container: 'measurementDiv' });
    controllerRef.current = controller;
    unsubscribeRef.current?.();
    unsubscribeRef.current = controller.subscribe((state) => {
      if (!mountedRef.current) return;
      setActiveTool(state.activeTool);
      setStatus(state.status);
      setError(state.error);
    });
    return controller;
  }, []);

  const initialize = useCallback(async (): Promise<void> => {
    const controller = ensureController();
    if (!controller) {
      setStatus('error');
      setError({ code: 'MAP_VIEW_REQUIRED', message: 'Map view is not ready.' });
      return;
    }
    try {
      await controller.ensureWidget();
    } catch {
      // Controller state is the single source of user-visible loading errors.
    }
  }, [ensureController]);

  const activate = useCallback((tool: MeasurementTool): void => {
    const controller = ensureController();
    if (!controller) {
      setStatus('error');
      setError({ code: 'MAP_VIEW_REQUIRED', message: 'Map view is not ready.' });
      return;
    }
    if (activeTool === tool) {
      controller.clear();
      return;
    }
    void controller.setTool(tool).catch(() => undefined);
  }, [activeTool, ensureController]);

  const retry = useCallback((): void => {
    releaseController();
    setStatus('idle');
    setError(null);
    void initialize();
  }, [initialize, releaseController]);

  const actions = useMemo<readonly ExperienceToolbarAction[]>(() => [
    {
      id: 'area',
      label: 'Alan ölç',
      icon: <AreaIcon />,
      pressed: activeTool === MEASUREMENT_TOOLS.AREA,
      disabled: status === 'loading',
      onActivate: () => activate(MEASUREMENT_TOOLS.AREA),
    },
    {
      id: 'distance',
      label: 'Mesafe ölç',
      icon: <DistanceIcon />,
      pressed: activeTool === MEASUREMENT_TOOLS.DISTANCE,
      disabled: status === 'loading',
      onActivate: () => activate(MEASUREMENT_TOOLS.DISTANCE),
    },
    {
      id: 'clear',
      label: 'Ölçümü temizle',
      disabled: status === 'loading' || activeTool === MEASUREMENT_TOOLS.NONE,
      onActivate: () => { controllerRef.current?.clear(); },
    },
  ], [activeTool, activate, status]);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => {
      windowManager.ShowWindow('sidebar');
      void initialize();
    },
    OnClose: () => {
      controllerRef.current?.clear();
    },
  }), [id, initialize, windowManager]);

  useEffect(() => {
    mountedRef.current = true;
    windowManager.RegisterWindow({ current: ref && typeof ref === 'object' ? ref.current : null });
    return () => {
      mountedRef.current = false;
      releaseController();
    };
  }, [ref, releaseController, windowManager]);

  const visible = windowManager.IsVisible(id);
  return (
    <section className="common-query-window common-query-window-right measurement-experience" style={{ visibility: visible ? 'visible' : 'hidden' }} aria-label="Ölçüm araçları" aria-busy={status === 'loading' || undefined}>
      <header className="common-query-window-header">
        <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" />
        <span>Ölçüm Araçları</span>
        <CommonQueryWindowTools windowManager={windowManager} windowId={id} showNearbySearch={false} showMapSelect={false} setQueryField={() => undefined} query={null} />
      </header>
      <div className="common-query-window-body layer-list-window-body measurement-experience__body">
        <ExperienceToolbar label="Ölçüm araçları" actions={actions} />
        {status === 'loading' ? <ExperienceStatus title="Ölçüm aracı hazırlanıyor" tone="info" live="polite" compact>Harita ölçüm bileşeni yükleniyor.</ExperienceStatus> : null}
        {status === 'error' ? (
          <ExperienceStatus
            title="Ölçüm aracı kullanılamıyor"
            tone="danger"
            live="assertive"
            actions={<button type="button" className="experience-button" onClick={retry}>Yeniden dene</button>}
          >{describeMeasurementError(error)}</ExperienceStatus>
        ) : null}
        <div id="measurementDiv" className="measurement-experience__sdk" aria-live="polite" aria-label="Ölçüm sonucu" />
      </div>
    </section>
  );
});
MeasurementWidget.displayName = 'MeasurementWidget';

export default MeasurementWidget;
