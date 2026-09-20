import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { faSketch } from '@fortawesome/free-brands-svg-icons';
import { faChevronDown, faChevronUp, faTimes } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type {
  ManagedWindowHandle,
  WindowManagerApi,
} from '../../../Store/Managers/WindowManager';
import { AdvancedSketchWidgetMain } from './AdvancedSketchWidgetMain';

interface AdvancedSketchWidgetProps {
  readonly id: string;
  readonly windowManager: WindowManagerApi;
}

export const AdvancedSketchWidget = forwardRef<
  ManagedWindowHandle,
  AdvancedSketchWidgetProps
>(({ id, windowManager }, forwardedRef): ReactNode => {
  const registrationRef = useRef<ManagedWindowHandle | null>(null);
  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  const handle = useMemo<ManagedWindowHandle>(() => ({
    id,
    visible,
    minimized,
    OnShow: () => undefined,
    OnClose: () => undefined,
  }), [id, minimized, visible]);

  registrationRef.current = handle;
  useImperativeHandle(forwardedRef, () => handle, [handle]);

  useEffect(() => {
    windowManager.RegisterWindow(registrationRef);
    return () => {
      windowManager.UnregisterWindow(id, registrationRef);
    };
  }, [id, windowManager]);

  return (
    <section
      className="widget-window advanced-sketch-window"
      aria-label="Çizim araçları"
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden' }}
    >
      <header className="widget-window-title advanced-sketch-window__header">
        <div className="advanced-sketch-window__title">
          <FontAwesomeIcon icon={faSketch} size="lg" className="widget-window_Icon" aria-hidden="true" />
          <span>Çizim</span>
        </div>
        <div className="advanced-sketch-window__actions" aria-label="Çizim penceresi işlemleri">
          <button
            type="button"
            className="widget-window-toolbar-button"
            onClick={() => windowManager.ToggleMinimiseWindow(id)}
            aria-label={minimized ? 'Çizim penceresini genişlet' : 'Çizim penceresini küçült'}
            aria-expanded={!minimized}
          >
            <FontAwesomeIcon icon={minimized ? faChevronDown : faChevronUp} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="widget-window-toolbar-button"
            onClick={() => windowManager.HideWindow(id)}
            aria-label="Çizim penceresini kapat"
          >
            <FontAwesomeIcon icon={faTimes} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="widget-window-body" hidden={minimized}>
        <AdvancedSketchWidgetMain />
      </div>
    </section>
  );
});

AdvancedSketchWidget.displayName = 'AdvancedSketchWidget';
