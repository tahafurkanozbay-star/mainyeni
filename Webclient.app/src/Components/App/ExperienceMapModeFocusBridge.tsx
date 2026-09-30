import { useEffect, useRef, type ReactNode } from 'react';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
} from '../../experience/experienceRuntime';
import {
  createMapModeFocusRestorationModel,
  type MapModeFocusableTarget,
} from './mapModeFocusRestorationModel';

interface CommandDetail {
  readonly name?: unknown;
}

const CONTROL_SELECTOR = '.map-mode-transition-control';
const FALLBACK_SELECTOR = `${CONTROL_SELECTOR} button[aria-pressed="true"], ${CONTROL_SELECTOR} button:not(:disabled)`;

const asFocusable = (value: Element | null): MapModeFocusableTarget | null => (
  value instanceof HTMLElement && typeof value.focus === 'function' ? value : null
);

const activeModeControl = (): MapModeFocusableTarget | null => {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.closest(CONTROL_SELECTOR)) return null;
  return asFocusable(active);
};

const fallbackModeControl = (): MapModeFocusableTarget | null => {
  if (typeof document === 'undefined') return null;
  return asFocusable(document.querySelector(FALLBACK_SELECTOR));
};

/**
 * Bridges the existing mode-command/runtime events to deterministic focus
 * restoration. GIS mode switching remains owned by the existing runtime.
 */
export const ExperienceMapModeFocusBridge = (): ReactNode => {
  const modelRef = useRef(createMapModeFocusRestorationModel());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const model = modelRef.current;
    let frameId: number | null = null;

    const cancelPendingRestore = (): void => {
      if (frameId === null) return;
      window.cancelAnimationFrame(frameId);
      frameId = null;
    };

    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<CommandDetail>).detail;
      if (detail?.name !== 'map-mode') return;
      const target = activeModeControl();
      if (target) model.capture(target);
    };

    const onModeChanged = (): void => {
      cancelPendingRestore();
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        model.restore(fallbackModeControl());
      });
    };

    window.addEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
    window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChanged as EventListener);

    return () => {
      cancelPendingRestore();
      window.removeEventListener(EXPERIENCE_COMMAND_EVENT, onCommand as EventListener);
      window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChanged as EventListener);
      model.dispose();
    };
  }, []);

  return null;
};

export default ExperienceMapModeFocusBridge;
