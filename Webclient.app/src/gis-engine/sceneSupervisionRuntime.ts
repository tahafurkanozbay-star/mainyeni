import {
  createSceneExperienceRuntime,
  type SceneExperienceRuntime,
  type SceneExperienceRuntimeOptions,
  type SceneExperienceSnapshot,
  type SceneExperienceView,
} from './sceneExperienceRuntime';
import {
  createSceneNavigationRuntime,
  type SceneNavigationOptions,
  type SceneNavigationRuntime,
  type SceneNavigationSnapshot,
  type SceneNavigationView,
} from './sceneNavigationRuntime';

export interface SceneSupervisionView extends SceneExperienceView, SceneNavigationView {
  fatalError?: unknown;
  watch?: (
    property: string,
    callback: (value?: unknown, oldValue?: unknown) => void,
  ) => { remove?: () => void };
}

export interface SceneSupervisionSnapshot {
  disposed: boolean;
  active: boolean;
  recoveryPending: boolean;
  fatalError: unknown;
  lastError: unknown;
  experience: SceneExperienceSnapshot;
  navigation: SceneNavigationSnapshot;
}

export interface SceneSupervisionOptions {
  experience?: SceneExperienceRuntimeOptions;
  navigation?: SceneNavigationOptions;
  autoRecoverFatalErrors?: boolean;
  onSnapshot?: (snapshot: SceneSupervisionSnapshot, reason: string) => void;
  onError?: (error: unknown, context: string) => void;
}

export interface SceneSupervisionRuntime {
  readonly experience: SceneExperienceRuntime;
  readonly navigation: SceneNavigationRuntime;
  setActive: (active: boolean) => SceneSupervisionSnapshot;
  recoverFatalError: (reason?: string) => Promise<boolean>;
  getSnapshot: () => SceneSupervisionSnapshot;
  subscribe: (
    listener: (snapshot: SceneSupervisionSnapshot, reason: string) => void,
  ) => () => boolean;
  dispose: () => void;
}

const safeRemove = (handle: { remove?: () => void } | null | undefined): void => {
  try {
    handle?.remove?.();
  } catch {
    // SceneView watch handles are best-effort during partial teardown.
  }
};

export const createSceneSupervisionRuntime = (
  view: SceneSupervisionView,
  options: SceneSupervisionOptions = {},
): SceneSupervisionRuntime => {
  if (!view) throw new Error('Scene supervision requires a SceneView.');

  const listeners = new Set<(snapshot: SceneSupervisionSnapshot, reason: string) => void>();
  const handles: Array<{ remove?: () => void }> = [];
  const autoRecoverFatalErrors = options.autoRecoverFatalErrors !== false;

  let disposed = false;
  let active = false;
  let recoveryPending = false;
  let fatalError: unknown = view.fatalError ?? null;
  let lastError: unknown = null;
  let recoveryInFlight: Promise<boolean> | null = null;
  let initialized = false;

  const reportError = (error: unknown, context: string): void => {
    lastError = error;
    try {
      options.onError?.(error, context);
    } catch {
      // Observer failures must never destabilize the SceneView lifecycle.
    }
  };

  let experience!: SceneExperienceRuntime;
  let navigation!: SceneNavigationRuntime;

  const buildSnapshot = (): SceneSupervisionSnapshot => Object.freeze({
    disposed,
    active,
    recoveryPending,
    fatalError,
    lastError,
    experience: experience.getSnapshot(),
    navigation: navigation.getSnapshot(),
  });

  const emit = (reason: string): SceneSupervisionSnapshot => {
    const snapshot = buildSnapshot();
    listeners.forEach((listener) => {
      try {
        listener(snapshot, reason);
      } catch (error) {
        reportError(error, 'scene-supervision-listener');
      }
    });
    try {
      options.onSnapshot?.(snapshot, reason);
    } catch (error) {
      reportError(error, 'scene-supervision-snapshot');
    }
    return snapshot;
  };

  const experienceOptions: SceneExperienceRuntimeOptions = {
    ...options.experience,
    onError: (error, context) => {
      options.experience?.onError?.(error, context);
      reportError(error, `experience:${context}`);
    },
    onSnapshot: (snapshot, reason) => {
      options.experience?.onSnapshot?.(snapshot, reason);
      if (initialized && !disposed) emit(`experience:${reason}`);
    },
  };

  const navigationOptions: SceneNavigationOptions = {
    ...options.navigation,
    onError: (error, context) => {
      options.navigation?.onError?.(error, context);
      reportError(error, `navigation:${context}`);
    },
    onSnapshot: (snapshot, reason) => {
      options.navigation?.onSnapshot?.(snapshot, reason);
      if (initialized && !disposed) emit(`navigation:${reason}`);
    },
  };

  experience = createSceneExperienceRuntime(view, experienceOptions);
  navigation = createSceneNavigationRuntime(view, navigationOptions);
  initialized = true;

  const recoverFatalError = async (reason = 'manual'): Promise<boolean> => {
    if (disposed) return false;
    if (recoveryInFlight) return recoveryInFlight;

    recoveryPending = true;
    emit(`recovery:${reason}:start`);

    recoveryInFlight = experience.recoverFatalError()
      .then((recovered) => {
        fatalError = recovered ? null : (view.fatalError ?? fatalError);
        if (recovered) lastError = null;
        emit(recovered ? `recovery:${reason}:success` : `recovery:${reason}:failed`);
        return recovered;
      })
      .catch((error: unknown) => {
        fatalError = view.fatalError ?? fatalError;
        reportError(error, 'scene-supervision-recovery');
        emit(`recovery:${reason}:error`);
        return false;
      })
      .finally(() => {
        recoveryPending = false;
        recoveryInFlight = null;
        if (!disposed) emit(`recovery:${reason}:settled`);
      });

    return recoveryInFlight;
  };

  if (typeof view.watch === 'function') {
    const fatalHandle = view.watch('fatalError', (value) => {
      if (disposed) return;
      fatalError = value ?? view.fatalError ?? null;
      emit(fatalError ? 'fatal-error' : 'fatal-error-cleared');
      if (fatalError && autoRecoverFatalErrors) void recoverFatalError('fatal-error');
    });
    if (fatalHandle) handles.push(fatalHandle);
  }

  const setActive = (nextActive: boolean): SceneSupervisionSnapshot => {
    if (disposed) return buildSnapshot();
    active = nextActive;
    experience.setActive(nextActive);
    return emit(nextActive ? 'active' : 'inactive');
  };

  const subscribe = (
    listener: (snapshot: SceneSupervisionSnapshot, reason: string) => void,
  ): (() => boolean) => {
    if (disposed) return () => false;
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    active = false;
    handles.splice(0).forEach(safeRemove);
    experience.dispose();
    navigation.dispose();
    listeners.clear();
  };

  return Object.freeze({
    experience,
    navigation,
    setActive,
    recoverFatalError,
    getSnapshot: buildSnapshot,
    subscribe,
    dispose,
  });
};
