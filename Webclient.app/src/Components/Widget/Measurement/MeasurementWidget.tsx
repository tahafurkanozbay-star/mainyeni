import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { CommonQueryWindowTools } from '../../Query/_Common/CommonQueryWindowTools';
import { ExperienceStatus, type ExperienceStatusTone } from '../../Common/ExperienceStatus';
import MapManager from '../../../Store/Managers/MapManager';
import {
  createMeasurementController,
  MEASUREMENT_TOOLS,
  type MeasurementController,
  type MeasurementState,
  type MeasurementTool,
} from '../../../gis-engine/measurementRuntime';
import './MeasurementWidget.css';

interface WindowManagerLike {
  RegisterWindow: (ref: unknown) => void;
  ShowWindow: (id: string) => void;
  IsVisible: (id: string) => boolean;
}

interface MeasurementWidgetProps {
  readonly id: string;
  readonly windowManager: WindowManagerLike;
}

export interface MeasurementWidgetHandle {
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

const statusPresentation = (state: MeasurementState): { tone: ExperienceStatusTone; text: string } => {
  if (state.status === 'loading') return { tone: 'info', text: 'Ölçüm aracı hazırlanıyor…' };
  if (state.status === 'error') return { tone: 'danger', text: state.error?.message || 'Ölçüm aracı yüklenemedi.' };
  if (state.activeTool === MEASUREMENT_TOOLS.AREA) return { tone: 'success', text: 'Alan ölçümü etkin. Harita üzerinde ölçmek istediğiniz alanı çizin.' };
  if (state.activeTool === MEASUREMENT_TOOLS.DISTANCE) return { tone: 'success', text: 'Mesafe ölçümü etkin. Harita üzerinde ölçmek istediğiniz hattı çizin.' };
  return { tone: 'neutral', text: 'Alan veya mesafe ölçümünü seçin.' };
};

const AreaIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 18 8 7l8-2 3 12-7 2-7-1Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="m8 7 4 12M16 5l-4 14" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" />
  </svg>
);

const DistanceIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 17 9 7l6 9 4-9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="5" cy="17" r="1.7" fill="currentColor" /><circle cx="9" cy="7" r="1.7" fill="currentColor" /><circle cx="15" cy="16" r="1.7" fill="currentColor" /><circle cx="19" cy="7" r="1.7" fill="currentColor" />
  </svg>
);

export const MeasurementWidget = forwardRef<MeasurementWidgetHandle, MeasurementWidgetProps>(({ id, windowManager }, ref) => {
  const [state, setState] = useState<MeasurementState>(INITIAL_STATE);
  const controllerRef = useRef<MeasurementController | null>(null);
  const unsubscribeRef = useRef<(() => boolean) | null>(null);
  const firstToolRef = useRef<HTMLButtonElement | null>(null);

  const ensureController = useCallback((): MeasurementController | null => {
    const view = MapManager.GetMapView();
    if (!view) return null;
    const existing = controllerRef.current;
    if (existing && !existing.destroyed) {
      existing.setView(view);
      existing.setContainer('measurementDiv');
      return existing;
    }
    const controller = createMeasurementController({ view, container: 'measurementDiv' });
    unsubscribeRef.current?.();
    unsubscribeRef.current = controller.subscribe(setState);
    controllerRef.current = controller;
    return controller;
  }, []);

  const initialize = useCallback(async (): Promise<void> => {
    const controller = ensureController();
    if (!controller) {
      setState(current => ({ ...current, status: 'error', error: { code: 'MAP_VIEW_REQUIRED', message: 'Harita görünümü henüz hazır değil.' } }));
      return;
    }
    try {
      await controller.ensureWidget();
      requestAnimationFrame(() => firstToolRef.current?.focus({ preventScroll: true }));
    } catch {
      // Controller state carries the actionable error while keeping the shell available for retry.
    }
  }, [ensureController]);

  const setActiveTool = useCallback(async (tool: MeasurementTool): Promise<void> => {
    const controller = ensureController();
    if (!controller) return;
    if (state.activeTool === tool) {
      controller.clear();
      return;
    }
    try { await controller.setTool(tool); } catch { /* state subscription exposes the error */ }
  }, [ensureController, state.activeTool]);

  const clearMeasurement = useCallback((): void => { controllerRef.current?.clear(); }, []);

  useImperativeHandle(ref, () => ({
    id,
    visible: false,
    minimized: false,
    OnShow: () => { windowManager.ShowWindow('sidebar'); void initialize(); },
    OnClose: clearMeasurement,
  }), [clearMeasurement, id, initialize, windowManager]);

  useEffect(() => {
    windowManager.RegisterWindow(ref);
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [ref, windowManager]);

  const presentation = statusPresentation(state);
  const busy = state.status === 'loading';

  return (
    <section
      className="common-query-window common-query-window-right measurement-widget"
      style={{ visibility: windowManager.IsVisible(id) ? 'visible' : 'hidden' }}
      aria-labelledby={`${id}-title`}
      aria-busy={busy || undefined}
    >
      <div className="common-query-window-header">
        <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png" alt="" />
        <span id={`${id}-title`}>Ölçüm Araçları</span>
        <CommonQueryWindowTools windowManager={windowManager} windowId={id} showNearbySearch={false} showMapSelect={false} setQueryField={() => undefined} query={null} />
      </div>
      <div className="common-query-window-body layer-list-window-body measurement-widget__body">
        <ExperienceStatus tone={presentation.tone} live={state.status === 'error' ? 'assertive' : 'polite'} busy={busy}>{presentation.text}</ExperienceStatus>
        <div className="measurement-widget__toolbar" role="toolbar" aria-label="Ölçüm türü" aria-controls="measurementDiv">
          <button ref={firstToolRef} type="button" onClick={() => void setActiveTool(MEASUREMENT_TOOLS.AREA)} className="measurement-widget-tool-select-button" aria-pressed={state.activeTool === MEASUREMENT_TOOLS.AREA} disabled={busy}>
            <AreaIcon /><span>Alan</span>
          </button>
          <button type="button" onClick={() => void setActiveTool(MEASUREMENT_TOOLS.DISTANCE)} className="measurement-widget-tool-select-button" aria-pressed={state.activeTool === MEASUREMENT_TOOLS.DISTANCE} disabled={busy}>
            <DistanceIcon /><span>Mesafe</span>
          </button>
          <button type="button" onClick={clearMeasurement} className="measurement-widget__clear" disabled={busy || state.activeTool === MEASUREMENT_TOOLS.NONE}>Temizle</button>
        </div>
        {state.status === 'error' ? <button type="button" className="measurement-widget__retry" onClick={() => void initialize()}>Yeniden dene</button> : null}
        <div id="measurementDiv" className="measurement-widget__sdk" aria-live="polite" aria-label="Ölçüm sonucu" />
      </div>
    </section>
  );
});

MeasurementWidget.displayName = 'MeasurementWidget';
export default MeasurementWidget;
