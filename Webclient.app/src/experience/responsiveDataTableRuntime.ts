import type { ResponsiveDataTableEnvironment } from './responsiveDataTableProjection';

export interface ResponsiveDataTableRuntimeTarget {
  readonly clientWidth: number;
  getBoundingClientRect(): Pick<DOMRectReadOnly, 'width'>;
}

export interface ResponsiveDataTableRuntimeOptions {
  readonly target: ResponsiveDataTableRuntimeTarget;
  readonly onEnvironment: (environment: ResponsiveDataTableEnvironment) => void;
  readonly windowObject?: Pick<Window, 'innerWidth' | 'addEventListener' | 'removeEventListener' | 'matchMedia'>;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => Pick<ResizeObserver, 'observe' | 'disconnect'>;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface ResponsiveDataTableRuntimeDiagnostics {
  readonly revision: number;
  readonly scheduledCount: number;
  readonly emittedCount: number;
  readonly duplicateCount: number;
  readonly disposed: boolean;
}

export interface ResponsiveDataTableRuntime {
  readonly snapshot: () => ResponsiveDataTableEnvironment;
  readonly diagnostics: () => ResponsiveDataTableRuntimeDiagnostics;
  readonly refresh: () => void;
  readonly dispose: () => void;
}

const DEFAULT_WIDTH = 1024;
const MEDIA_COARSE = '(pointer: coarse)';
const MEDIA_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const MEDIA_FORCED_COLORS = '(forced-colors: active)';

const safeWidth = (value: number, fallback = DEFAULT_WIDTH): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100_000, Math.round(value)));
};

const sameEnvironment = (
  left: ResponsiveDataTableEnvironment,
  right: ResponsiveDataTableEnvironment,
): boolean => (
  left.containerWidth === right.containerWidth
  && left.viewportWidth === right.viewportWidth
  && left.coarsePointer === right.coarsePointer
  && left.reducedMotion === right.reducedMotion
  && left.forcedColors === right.forcedColors
);

const readTargetWidth = (
  target: ResponsiveDataTableRuntimeTarget,
  fallbackWidth: number,
): number => {
  const clientWidth = safeWidth(target.clientWidth, 0);
  if (clientWidth > 0) return clientWidth;
  const boundingWidth = safeWidth(target.getBoundingClientRect().width, 0);
  if (boundingWidth > 0) return boundingWidth;
  return safeWidth(fallbackWidth, DEFAULT_WIDTH) || DEFAULT_WIDTH;
};

const readMedia = (
  windowObject: ResponsiveDataTableRuntimeOptions['windowObject'],
  query: string,
): boolean => {
  if (!windowObject) return false;
  try {
    return windowObject.matchMedia(query).matches;
  } catch (error) {
    void error;
    return false;
  }
};

const readEnvironment = (
  target: ResponsiveDataTableRuntimeTarget,
  windowObject: ResponsiveDataTableRuntimeOptions['windowObject'],
): ResponsiveDataTableEnvironment => {
  const viewportWidth = safeWidth(windowObject?.innerWidth ?? DEFAULT_WIDTH) || DEFAULT_WIDTH;
  return Object.freeze({
    containerWidth: readTargetWidth(target, viewportWidth),
    viewportWidth,
    coarsePointer: readMedia(windowObject, MEDIA_COARSE),
    reducedMotion: readMedia(windowObject, MEDIA_REDUCED_MOTION),
    forcedColors: readMedia(windowObject, MEDIA_FORCED_COLORS),
  });
};

const defaultResizeObserver = (
  callback: ResizeObserverCallback,
): Pick<ResizeObserver, 'observe' | 'disconnect'> | null => {
  if (typeof ResizeObserver !== 'function') return null;
  return new ResizeObserver(callback);
};

const defaultRequestFrame = (callback: FrameRequestCallback): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(performance.now()), 0) as unknown as number;
};

const defaultCancelFrame = (handle: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

interface MediaSubscription {
  readonly media: MediaQueryList;
  readonly listener: () => void;
}

const subscribeMedia = (
  windowObject: ResponsiveDataTableRuntimeOptions['windowObject'],
  query: string,
  listener: () => void,
): MediaSubscription | null => {
  if (!windowObject) return null;
  let media: MediaQueryList;
  try {
    media = windowObject.matchMedia(query);
  } catch (error) {
    void error;
    return null;
  }
  if (typeof media.addEventListener === 'function') media.addEventListener('change', listener);
  else if (typeof media.addListener === 'function') media.addListener(listener);
  return { media, listener };
};

const unsubscribeMedia = (subscription: MediaSubscription | null): void => {
  if (!subscription) return;
  const { media, listener } = subscription;
  if (typeof media.removeEventListener === 'function') media.removeEventListener('change', listener);
  else if (typeof media.removeListener === 'function') media.removeListener(listener);
};

export const createResponsiveDataTableRuntime = (
  options: ResponsiveDataTableRuntimeOptions,
): ResponsiveDataTableRuntime => {
  const windowObject = options.windowObject ?? (typeof window !== 'undefined' ? window : undefined);
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  let environment = readEnvironment(options.target, windowObject);
  let frame: number | null = null;
  let disposed = false;
  let diagnostics: ResponsiveDataTableRuntimeDiagnostics = Object.freeze({
    revision: 0,
    scheduledCount: 0,
    emittedCount: 0,
    duplicateCount: 0,
    disposed: false,
  });

  const emit = (): void => {
    if (disposed) return;
    const next = readEnvironment(options.target, windowObject);
    if (sameEnvironment(next, environment)) {
      diagnostics = Object.freeze({
        ...diagnostics,
        duplicateCount: diagnostics.duplicateCount + 1,
      });
      return;
    }
    environment = next;
    diagnostics = Object.freeze({
      ...diagnostics,
      revision: diagnostics.revision + 1,
      emittedCount: diagnostics.emittedCount + 1,
    });
    options.onEnvironment(environment);
  };

  const schedule = (): void => {
    if (disposed || frame !== null) return;
    diagnostics = Object.freeze({
      ...diagnostics,
      scheduledCount: diagnostics.scheduledCount + 1,
    });
    frame = requestFrame(() => {
      frame = null;
      emit();
    });
  };

  const resizeObserver = (options.createResizeObserver
    ? options.createResizeObserver(() => schedule())
    : defaultResizeObserver(() => schedule()));
  resizeObserver?.observe(options.target as Element);

  windowObject?.addEventListener('resize', schedule, { passive: true });
  const coarseSubscription = subscribeMedia(windowObject, MEDIA_COARSE, schedule);
  const motionSubscription = subscribeMedia(windowObject, MEDIA_REDUCED_MOTION, schedule);
  const colorsSubscription = subscribeMedia(windowObject, MEDIA_FORCED_COLORS, schedule);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    windowObject?.removeEventListener('resize', schedule);
    unsubscribeMedia(coarseSubscription);
    unsubscribeMedia(motionSubscription);
    unsubscribeMedia(colorsSubscription);
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    diagnostics = Object.freeze({ ...diagnostics, disposed: true });
  };

  return Object.freeze({
    snapshot: () => environment,
    diagnostics: () => diagnostics,
    refresh: schedule,
    dispose,
  });
};
