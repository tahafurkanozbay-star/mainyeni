import { faSketch } from '@fortawesome/free-brands-svg-icons';
import { faChevronDown, faChevronUp, faTimes } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { WindowManagerApi } from '../../../Store/Managers/WindowManager';
import { AdvancedSketchWidgetMain } from './AdvancedSketchWidgetMain';

export interface AdvancedSketchWidgetProps {
  readonly id: string;
  readonly windowManager: WindowManagerApi;
}

export const AdvancedSketchWidget = ({
  id,
  windowManager,
}: AdvancedSketchWidgetProps) => {
  const visible = windowManager.IsVisible(id);
  const minimized = windowManager.IsMinimized(id);

  return (
    <section
      className="widget-window"
      style={{ visibility: visible ? 'visible' : 'hidden' }}
      aria-hidden={!visible}
      aria-label="Gelişmiş çizim araçları"
    >
      <header className="widget-window-title">
        <div className="row align-items-center">
          <div className="col-9">
            <FontAwesomeIcon icon={faSketch} size="lg" className="widget-window_Icon" />
            <span className="ms-2">Çizim</span>
          </div>
          <div className="col-3 d-flex justify-content-end">
            <button
              type="button"
              className="widget-window-toolbar-button"
              onClick={() => windowManager.HideWindow(id)}
              aria-label="Çizim penceresini kapat"
            >
              <FontAwesomeIcon icon={faTimes} />
            </button>
            <button
              type="button"
              className="widget-window-toolbar-button"
              onClick={() => windowManager.ToggleMinimiseWindow(id)}
              aria-label={minimized ? 'Çizim penceresini genişlet' : 'Çizim penceresini küçült'}
              aria-expanded={!minimized}
            >
              <FontAwesomeIcon icon={minimized ? faChevronDown : faChevronUp} />
            </button>
          </div>
        </div>
      </header>
      {!minimized ? (
        <div className="widget-window-body">
          <AdvancedSketchWidgetMain active={visible} />
        </div>
      ) : null}
    </section>
  );
};

export default AdvancedSketchWidget;
