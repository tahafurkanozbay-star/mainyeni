import { useEffect, useRef, type ReactNode } from 'react';
import {
  EXPERIENCE_COMMAND_EVENT,
  EXPERIENCE_MAP_MODE_EVENT,
  EXPERIENCE_PREFERENCE_EVENT,
  normalizeExperiencePreferences,
  type ExperienceMapMode,
  type ExperiencePreferences,
  type StorageLike,
} from '../../experience/experienceRuntime';
import { runtimeDiagnostics } from '../../platform/runtime/runtimeDiagnostics';
import { createMapModePreferenceModel } from './mapModePreferenceModel';

interface ModeChangeDetail {
  readonly mode?: unknown;
  readonly source?: unknown;
}

const isMode = (value: unknown): value is ExperienceMapMode => value === '2d' || value === '3d';

const resolveStorage = (): StorageLike | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch (error) {
    runtimeDiagnostics.captureError(error, { source: 'experience.map-mode-preference.storage' }, 'warn');
    return null;
  }
};

const dispatchModeRequest = (mode: ExperienceMapMode, source: string): boolean => {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  return window.dispatchEvent(new CustomEvent(EXPERIENCE_COMMAND_EVENT, {
    detail: Object.freeze({ name: 'map-mode', mode, source, timestamp: Date.now() }),
  }));
};

export const ExperienceMapModePreferenceBridge = (): ReactNode => {
  const runtimeModeRef = useRef<ExperienceMapMode | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const storage = resolveStorage();
    const model = createMapModePreferenceModel();
    model.hydrate(storage);

    const onModeChange = (event: Event): void => {
      const detail = (event as CustomEvent<ModeChangeDetail>).detail;
      if (!isMode(detail?.mode)) return;
      runtimeModeRef.current = detail.mode;
      const source = typeof detail.source === 'string' ? detail.source : null;
      const restore = model.observeRuntimeMode(detail.mode, source, storage);
      if (restore) {
        queueMicrotask(() => {
          if (!dispatchModeRequest(restore, 'experience-preference-restore')) {
            runtimeDiagnostics.record('experience.map-mode-preference.restore-dispatch-failed', { mode: restore });
          }
        });
      }
    };

    const onPreferences = (event: Event): void => {
      const candidate = (event as CustomEvent<ExperiencePreferences>).detail;
      if (!candidate) return;
      const preferences = normalizeExperiencePreferences(candidate);
      const currentMode = runtimeModeRef.current;
      if (!currentMode || currentMode === preferences.lastMapMode) return;
      model.markRestoreRequested(preferences.lastMapMode);
      if (!dispatchModeRequest(preferences.lastMapMode, 'experience-preference-change')) {
        runtimeDiagnostics.record('experience.map-mode-preference.change-dispatch-failed', { mode: preferences.lastMapMode });
      }
    };

    window.addEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
    window.addEventListener(EXPERIENCE_PREFERENCE_EVENT, onPreferences as EventListener);
    return () => {
      window.removeEventListener(EXPERIENCE_MAP_MODE_EVENT, onModeChange as EventListener);
      window.removeEventListener(EXPERIENCE_PREFERENCE_EVENT, onPreferences as EventListener);
      model.dispose();
    };
  }, []);

  return null;
};

export default ExperienceMapModePreferenceBridge;
