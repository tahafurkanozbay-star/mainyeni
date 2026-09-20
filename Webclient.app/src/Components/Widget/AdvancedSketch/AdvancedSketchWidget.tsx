import {
  BiChevronDown,
  BiChevronUp,
  BiShapePolygon,
  BiX,
} from 'react-icons/bi';
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
            <BiShapePolygon className="widget-window_Icon" aria-hidden="true" />
            <span className="ms-2">Çizim</span>
          </div>
          <div className="col-3 d-flex justify-content-end">
            <button
              type="button"
              className="widget-window-toolbar-button"
              onClick={() => windowManager.HideWindow(id)}
              aria-label="Çizim penceresini kapat"
            >
              <BiX aria-hidden="true" />
            </button>
            <button
              type="button"
              className="widget-window-toolbar-button"
              onClick={() => windowManager.ToggleMinimiseWindow(id)}
              aria-label={minimized ? 'Çizim penceresini genişlet' : 'Çizim penceresini küçült'}
              aria-expanded={!minimized}
            >
              {minimized
                ? <BiChevronDown aria-hidden="true" />
                : <BiChevronUp aria-hidden="true" />}
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
