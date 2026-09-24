import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  type PanelId,
  type PanelLayoutModel,
  type PanelLayoutSnapshot,
} from '../../experience/panelLayoutModel';
import './experience-panel-resize-handle.css';

export interface ExperiencePanelResizeHandleProps {
  readonly model: PanelLayoutModel;
  readonly panelId: PanelId;
  readonly label: string;
  readonly stepPx?: number;
  readonly largeStepPx?: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startCoordinate: number;
  readonly startSize: number;
}

const normalizeStep = (value: number | undefined, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(4, Math.min(128, Math.round(numeric)));
};

const directionSign = (panelId: PanelId, key: string): number => {
  if (panelId === 'details') {
    if (key === 'ArrowUp') return 1;
    if (key === 'ArrowDown') return -1;
    return 0;
  }
  if (panelId === 'navigation') {
    if (key === 'ArrowRight') return 1;
    if (key === 'ArrowLeft') return -1;
    return 0;
  }
  if (key === 'ArrowLeft') return 1;
  if (key === 'ArrowRight') return -1;
  return 0;
};

const pointerCoordinate = (panelId: PanelId, event: PointerEvent<HTMLElement>): number =>
  panelId === 'details' ? event.clientY : event.clientX;

const pointerDelta = (panelId: PanelId, current: number, start: number): number => {
  const raw = current - start;
  if (panelId === 'tools' || panelId === 'details') return -raw;
  return raw;
};

export const ExperiencePanelResizeHandle = ({
  model,
  panelId,
  label,
  stepPx = 16,
  largeStepPx = 48,
}: ExperiencePanelResizeHandleProps): ReactNode => {
  const [snapshot, setSnapshot] = useState<PanelLayoutSnapshot>(() => model.snapshot());
  const dragRef = useRef<DragState | null>(null);
  const smallStep = normalizeStep(stepPx, 16);
  const largeStep = normalizeStep(largeStepPx, 48);
  const panel = snapshot.panels[panelId];

  useEffect(() => model.subscribe(setSnapshot), [model]);

  if (!panel.resizable) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Home') {
      event.preventDefault();
      model.setSize(panelId, panel.minPx);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      model.setSize(panelId, panel.maxPx);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      model.resetSize(panelId);
      return;
    }
    const sign = directionSign(panelId, event.key);
    if (sign === 0) return;
    event.preventDefault();
    model.resize(panelId, sign * (event.shiftKey ? largeStep : smallStep));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startCoordinate: pointerCoordinate(panelId, event),
      startSize: panel.sizePx,
    };
    target.setPointerCapture(event.pointerId);
    target.dataset.dragging = 'true';
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = pointerDelta(panelId, pointerCoordinate(panelId, event), drag.startCoordinate);
    model.setSize(panelId, drag.startSize + delta);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const target = event.currentTarget;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    delete target.dataset.dragging;
  };

  return (
    <div
      className={`experience-panel-resize-handle experience-panel-resize-handle--${panelId}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={panel.separatorOrientation}
      aria-valuemin={panel.minPx}
      aria-valuemax={panel.maxPx}
      aria-valuenow={panel.sizePx}
      aria-valuetext={`${panel.sizePx} piksel`}
      data-panel={panelId}
      data-reduced-motion={String(snapshot.reducedMotion)}
      data-coarse-pointer={String(snapshot.coarsePointer)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span className="experience-panel-resize-handle__grip" aria-hidden="true" />
      <span className="experience-panel-resize-handle__hint">
        Ok tuşlarıyla yeniden boyutlandır. Shift daha büyük adım, Enter varsayılan boyut.
      </span>
    </div>
  );
};

export default ExperiencePanelResizeHandle;
