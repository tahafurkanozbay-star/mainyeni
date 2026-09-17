import type { SceneViewLike } from './sceneRuntime';

export interface SceneCameraPoint {
  x?: number;
  y?: number;
  z?: number;
  longitude?: number;
  latitude?: number;
  spatialReference?: unknown;
  [key: string]: unknown;
}

export interface SceneCameraLike {
  position?: SceneCameraPoint | null;
  heading?: number;
  tilt?: number;
  clone?: () => SceneCameraLike;
  toJSON?: () => unknown;
  [key: string]: unknown;
}

export interface SceneNavigationView extends SceneViewLike {
  camera?: SceneCameraLike | null;
  scale?: number;
  zoom?: number;
  center?: unknown;
  stationary?: boolean;
  destroyed?: boolean;
  goTo?: (target: unknown, options?: unknown) => Promise<unknown>;
}

export interface SceneNavigationPose {
  center?: readonly [number, number] | null;
  position?: SceneCameraPoint | null;
  heading?: number | null;
  tilt?: number | null;
  scale?: number | null;
}

export interface SceneNavigationBookmark {
  id: string;
  title: string;
  pose: Readonly<SceneNavigationPose>;
  createdAt: number;
}

export interface SceneNavigationSnapshot {
  disposed: boolean;
  moving: boolean;
  sequence: number;
  pose: Readonly<SceneNavigationPose>;
  historyDepth: number;
  historyIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
  bookmarks: readonly SceneNavigationBookmark[];
  lastError: unknown;
}

export interface SceneNavigationOptions {
  historyLimit?: number;
  minimumScale?: number;
  maximumScale?: number;
  minimumTilt?: number;
  maximumTilt?: number;
  defaultDurationMs?: number;
  reducedMotion?: () => boolean;
  now?: () => number;
  onSnapshot?: (snapshot: SceneNavigationSnapshot, reason: string) => void;
  onError?: (error: unknown, context: string) => void;
}

export interface SceneNavigationRuntime {
  capture: () => Readonly<SceneNavigationPose>;
  navigate: (pose: SceneNavigationPose, options?: SceneNavigateOptions) => Promise<boolean>;
  zoomBy: (factor: unknown, options?: SceneNavigateOptions) => Promise<boolean>;
  rotateBy: (degrees: unknown, options?: SceneNavigateOptions) => Promise<boolean>;
  tiltBy: (degrees: unknown, options?: SceneNavigateOptions) => Promise<boolean>;
  resetNorth: (options?: SceneNavigateOptions) => Promise<boolean>;
  setHome: (pose?: SceneNavigationPose) => Readonly<SceneNavigationPose>;
  goHome: (options?: SceneNavigateOptions) => Promise<boolean>;
  back: (options?: SceneNavigateOptions) => Promise<boolean>;
  forward: (options?: SceneNavigateOptions) => Promise<boolean>;
  saveBookmark: (id: string, title?: string, pose?: SceneNavigationPose) => SceneNavigationBookmark;
  removeBookmark: (id: string) => boolean;
  goToBookmark: (id: string, options?: SceneNavigateOptions) => Promise<boolean>;
  getSnapshot: () => SceneNavigationSnapshot;
  subscribe: (listener: (snapshot: SceneNavigationSnapshot, reason: string) => void) => () => boolean;
  dispose: () => void;
}

export interface SceneNavigateOptions {
  durationMs?: number;
  animate?: boolean;
  recordHistory?: boolean;
  signal?: AbortSignal;
  reason?: string;
}

const finite = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const normalizeHeading = (value: unknown): number => {
  const numeric = finite(value, 0);
  const normalized = numeric % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const clonePoint = (point: SceneCameraPoint | null | undefined): SceneCameraPoint | null => {
  if (!point) return null;
  return { ...point };
};

const centerFromView = (view: SceneNavigationView): readonly [number, number] | null => {
  const position = view.camera?.position;
  if (!position) return null;
  const longitude = Number(position.longitude ?? position.x);
  const latitude = Number(position.latitude ?? position.y);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return Object.freeze([longitude, latitude] as const);
};

const sameNumber = (left: number | null | undefined, right: number | null | undefined, epsilon = 0.000001): boolean => {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return Math.abs(left - right) <= epsilon;
};

const sameCenter = (
  left: readonly [number, number] | null | undefined,
  right: readonly [number, number] | null | undefined,
): boolean => {
  if (!left || !right) return left === right;
  return sameNumber(left[0], right[0]) && sameNumber(left[1], right[1]);
};

const samePose = (left: SceneNavigationPose, right: SceneNavigationPose): boolean => (
  sameCenter(left.center, right.center)
  && sameNumber(left.heading, right.heading)
  && sameNumber(left.tilt, right.tilt)
  && sameNumber(left.scale, right.scale, 0.01)
);

export const createSceneNavigationRuntime = (
  view: SceneNavigationView,
  options: SceneNavigationOptions = {},
): SceneNavigationRuntime => {
  if (!view || typeof view.goTo !== 'function') throw new Error('Scene navigation requires a view with goTo().');

  const historyLimit = Math.max(2, Math.min(100, Math.floor(finite(options.historyLimit, 24))));
  const minimumScale = Math.max(1, finite(options.minimumScale, 25));
  const maximumScale = Math.max(minimumScale, finite(options.maximumScale, 250_000_000));
  const minimumTilt = clamp(finite(options.minimumTilt, 0), 0, 180);
  const maximumTilt = clamp(finite(options.maximumTilt, 85), minimumTilt, 180);
  const defaultDurationMs = Math.max(0, Math.min(10_000, finite(options.defaultDurationMs, 320)));
  const now = options.now ?? Date.now;
  const reducedMotion = options.reducedMotion ?? (() => false);
  const listeners = new Set<(snapshot: SceneNavigationSnapshot, reason: string) => void>();
  const bookmarks = new Map<string, SceneNavigationBookmark>();
  const history: Readonly<SceneNavigationPose>[] = [];

  let disposed = false;
  let moving = false;
  let sequence = 0;
  let activeSequence = 0;
  let historyIndex = -1;
  let homePose: Readonly<SceneNavigationPose> | null = null;
  let lastError: unknown = null;

  const normalizePose = (input: SceneNavigationPose): Readonly<SceneNavigationPose> => {
    const center = Array.isArray(input.center)
      && input.center.length >= 2
      && Number.isFinite(Number(input.center[0]))
      && Number.isFinite(Number(input.center[1]))
      ? Object.freeze([Number(input.center[0]), Number(input.center[1])] as const)
      : null;
    const scale = input.scale === null || input.scale === undefined
      ? null
      : clamp(finite(input.scale, minimumScale), minimumScale, maximumScale);
    const heading = input.heading === null || input.heading === undefined ? null : normalizeHeading(input.heading);
    const tilt = input.tilt === null || input.tilt === undefined
      ? null
      : clamp(finite(input.tilt, minimumTilt), minimumTilt, maximumTilt);
    return Object.freeze({
      center,
      position: clonePoint(input.position),
      heading,
      tilt,
      scale,
    });
  };

  const capture = (): Readonly<SceneNavigationPose> => normalizePose({
    center: centerFromView(view),
    position: clonePoint(view.camera?.position),
    heading: view.camera?.heading ?? 0,
    tilt: view.camera?.tilt ?? 0,
    scale: Number.isFinite(Number(view.scale)) ? Number(view.scale) : null,
  });

  const snapshot = (): SceneNavigationSnapshot => Object.freeze({
    disposed,
    moving,
    sequence,
    pose: capture(),
    historyDepth: history.length,
    historyIndex,
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex >= 0 && historyIndex < history.length - 1,
    bookmarks: Object.freeze([...bookmarks.values()].sort((left, right) => left.id.localeCompare(right.id))),
    lastError,
  });

  const emit = (reason: string): SceneNavigationSnapshot => {
    const next = snapshot();
    listeners.forEach((listener) => {
      try {
        listener(next, reason);
      } catch (error) {
        options.onError?.(error, 'scene-navigation-listener');
      }
    });
    options.onSnapshot?.(next, reason);
    return next;
  };

  const pushHistory = (pose: Readonly<SceneNavigationPose>): void => {
    const current = history[historyIndex];
    if (current && samePose(current, pose)) return;
    if (historyIndex < history.length - 1) history.splice(historyIndex + 1);
    history.push(pose);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    historyIndex = history.length - 1;
  };

  const ensureInitialHistory = (): void => {
    if (history.length > 0) return;
    pushHistory(capture());
  };

  const targetForPose = (pose: Readonly<SceneNavigationPose>): Record<string, unknown> => {
    const target: Record<string, unknown> = {};
    if (pose.position) {
      target.camera = {
        position: clonePoint(pose.position),
        ...(pose.heading !== null && pose.heading !== undefined ? { heading: pose.heading } : {}),
        ...(pose.tilt !== null && pose.tilt !== undefined ? { tilt: pose.tilt } : {}),
      };
    } else {
      if (pose.center) target.center = [...pose.center];
      if (pose.heading !== null && pose.heading !== undefined) target.heading = pose.heading;
      if (pose.tilt !== null && pose.tilt !== undefined) target.tilt = pose.tilt;
    }
    if (pose.scale !== null && pose.scale !== undefined) target.scale = pose.scale;
    return target;
  };

  const navigate = async (input: SceneNavigationPose, navigation: SceneNavigateOptions = {}): Promise<boolean> => {
    if (disposed || view.destroyed || navigation.signal?.aborted) return false;
    const pose = normalizePose(input);
    const target = targetForPose(pose);
    if (Object.keys(target).length === 0) return false;

    ensureInitialHistory();
    sequence += 1;
    const currentSequence = sequence;
    activeSequence = currentSequence;
    moving = true;
    lastError = null;
    emit(navigation.reason ?? 'navigate-start');

    const shouldAnimate = navigation.animate !== false && !reducedMotion();
    const duration = shouldAnimate
      ? Math.max(0, Math.min(10_000, finite(navigation.durationMs, defaultDurationMs)))
      : 0;

    const onAbort = (): void => {
      if (activeSequence === currentSequence) activeSequence += 1;
    };
    navigation.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await view.goTo?.(target, { animate: shouldAnimate, duration });
      if (disposed || navigation.signal?.aborted || activeSequence !== currentSequence) return false;
      if (navigation.recordHistory !== false) pushHistory(capture());
      moving = false;
      emit(navigation.reason ?? 'navigate-success');
      return true;
    } catch (error) {
      if (navigation.signal?.aborted || activeSequence !== currentSequence || (error as { name?: string })?.name === 'AbortError') {
        if (activeSequence === currentSequence) moving = false;
        return false;
      }
      moving = false;
      lastError = error;
      options.onError?.(error, 'scene-navigation-go-to');
      emit(navigation.reason ?? 'navigate-failure');
      return false;
    } finally {
      navigation.signal?.removeEventListener('abort', onAbort);
      if (activeSequence === currentSequence) moving = false;
    }
  };

  const zoomBy = async (factorInput: unknown, navigation: SceneNavigateOptions = {}): Promise<boolean> => {
    const factor = finite(factorInput, 1);
    if (factor <= 0 || factor === 1) return false;
    const currentScale = Number(view.scale);
    if (!Number.isFinite(currentScale) || currentScale <= 0) return false;
    return navigate({ ...capture(), scale: clamp(currentScale * factor, minimumScale, maximumScale) }, {
      ...navigation,
      reason: navigation.reason ?? 'zoom',
    });
  };

  const rotateBy = async (degrees: unknown, navigation: SceneNavigateOptions = {}): Promise<boolean> => {
    const delta = finite(degrees, 0);
    if (delta === 0) return false;
    const current = capture();
    return navigate({ ...current, heading: normalizeHeading((current.heading ?? 0) + delta) }, {
      ...navigation,
      reason: navigation.reason ?? 'rotate',
    });
  };

  const tiltBy = async (degrees: unknown, navigation: SceneNavigateOptions = {}): Promise<boolean> => {
    const delta = finite(degrees, 0);
    if (delta === 0) return false;
    const current = capture();
    return navigate({ ...current, tilt: clamp((current.tilt ?? 0) + delta, minimumTilt, maximumTilt) }, {
      ...navigation,
      reason: navigation.reason ?? 'tilt',
    });
  };

  const resetNorth = (navigation: SceneNavigateOptions = {}): Promise<boolean> => (
    navigate({ ...capture(), heading: 0 }, { ...navigation, reason: navigation.reason ?? 'north' })
  );

  const setHome = (pose: SceneNavigationPose = capture()): Readonly<SceneNavigationPose> => {
    homePose = normalizePose(pose);
    emit('home-set');
    return homePose;
  };

  const goHome = (navigation: SceneNavigateOptions = {}): Promise<boolean> => {
    const target = homePose ?? setHome(capture());
    return navigate(target, { ...navigation, reason: navigation.reason ?? 'home' });
  };

  const navigateHistory = async (direction: -1 | 1, navigation: SceneNavigateOptions): Promise<boolean> => {
    ensureInitialHistory();
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) return false;
    const target = history[nextIndex];
    if (!target) return false;
    const succeeded = await navigate(target, {
      ...navigation,
      recordHistory: false,
      reason: navigation.reason ?? (direction < 0 ? 'history-back' : 'history-forward'),
    });
    if (succeeded) {
      historyIndex = nextIndex;
      emit(direction < 0 ? 'history-back' : 'history-forward');
    }
    return succeeded;
  };

  const back = (navigation: SceneNavigateOptions = {}): Promise<boolean> => navigateHistory(-1, navigation);
  const forward = (navigation: SceneNavigateOptions = {}): Promise<boolean> => navigateHistory(1, navigation);

  const saveBookmark = (
    idInput: string,
    titleInput?: string,
    pose: SceneNavigationPose = capture(),
  ): SceneNavigationBookmark => {
    const id = String(idInput ?? '').trim();
    if (!id) throw new Error('Scene bookmark requires a non-empty id.');
    const bookmark = Object.freeze({
      id,
      title: String(titleInput || id),
      pose: normalizePose(pose),
      createdAt: now(),
    });
    bookmarks.set(id, bookmark);
    emit('bookmark-save');
    return bookmark;
  };

  const removeBookmark = (idInput: string): boolean => {
    const removed = bookmarks.delete(String(idInput ?? '').trim());
    if (removed) emit('bookmark-remove');
    return removed;
  };

  const goToBookmark = async (idInput: string, navigation: SceneNavigateOptions = {}): Promise<boolean> => {
    const bookmark = bookmarks.get(String(idInput ?? '').trim());
    if (!bookmark) return false;
    return navigate(bookmark.pose, { ...navigation, reason: navigation.reason ?? 'bookmark' });
  };

  const subscribe = (listener: (snapshot: SceneNavigationSnapshot, reason: string) => void): (() => boolean) => {
    if (disposed) return () => false;
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    moving = false;
    activeSequence += 1;
    bookmarks.clear();
    history.length = 0;
    historyIndex = -1;
    listeners.clear();
  };

  homePose = capture();
  pushHistory(homePose);

  return Object.freeze({
    capture,
    navigate,
    zoomBy,
    rotateBy,
    tiltBy,
    resetNorth,
    setHome,
    goHome,
    back,
    forward,
    saveBookmark,
    removeBookmark,
    goToBookmark,
    getSnapshot: snapshot,
    subscribe,
    dispose,
  });
};
