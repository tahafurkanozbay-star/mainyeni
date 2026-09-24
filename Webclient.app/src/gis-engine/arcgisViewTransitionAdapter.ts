import type { ModernGisViewOrchestrationRuntime } from './modernGisViewOrchestrationRuntime';
import type {
  SpatialReferenceState,
  UnifiedViewState,
  ViewPointState,
  ViewTransitionExecutor,
  ViewTransitionRequest,
  ViewTransitionResult,
} from './viewStateTransitionCoordinator';

export interface ArcgisSpatialReferenceLike {
  readonly wkid?: number;
  readonly latestWkid?: number;
}

export interface ArcgisPointLike {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly longitude?: number;
  readonly latitude?: number;
  readonly spatialReference?: ArcgisSpatialReferenceLike;
}

export interface ArcgisCameraLike {
  readonly position?: ArcgisPointLike;
  readonly heading?: number;
  readonly tilt?: number;
}

export interface ArcgisTransitionViewLike {
  readonly center?: ArcgisPointLike;
  readonly camera?: ArcgisCameraLike;
  readonly spatialReference?: ArcgisSpatialReferenceLike;
  readonly scale?: number;
  readonly rotation?: number;
  readonly destroyed?: boolean;
  readonly goTo?: (target: unknown, options?: Record<string, unknown>) => Promise<unknown>;
}

export type ArcgisTransitionViewResolver = (
  mode: '2d' | '3d',
) => ArcgisTransitionViewLike | null | undefined;

export interface ArcgisViewTransitionAdapterOptions {
  readonly resolveView: ArcgisTransitionViewResolver;
  readonly targetFactory?: (state: UnifiedViewState) => unknown;
  readonly goToOptions?: Readonly<Record<string, unknown>>;
  readonly onBeforeGoTo?: (
    view: ArcgisTransitionViewLike,
    state: UnifiedViewState,
  ) => void | Promise<void>;
  readonly onAfterGoTo?: (
    view: ArcgisTransitionViewLike,
    state: UnifiedViewState,
  ) => void | Promise<void>;
}

const finite = (value: unknown, field: string): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${field} must be finite`);
  return numeric;
};

const positive = (value: unknown, field: string): number => {
  const numeric = finite(value, field);
  if (numeric <= 0) throw new RangeError(`${field} must be positive`);
  return numeric;
};

const normalizeSpatialReference = (
  input: ArcgisSpatialReferenceLike | undefined,
): SpatialReferenceState => {
  const wkid = input?.wkid;
  const latestWkid = input?.latestWkid;
  if (wkid === undefined && latestWkid === undefined) {
    throw new TypeError('ArcGIS view state requires a WKID');
  }
  const normalizedWkid = wkid === undefined ? undefined : positive(wkid, 'wkid');
  const normalizedLatestWkid = latestWkid === undefined
    ? undefined
    : positive(latestWkid, 'latestWkid');
  return Object.freeze({
    ...(normalizedWkid === undefined ? {} : { wkid: Math.floor(normalizedWkid) }),
    ...(normalizedLatestWkid === undefined ? {} : { latestWkid: Math.floor(normalizedLatestWkid) }),
  });
};

const pointCoordinate = (
  point: ArcgisPointLike,
  axis: 'x' | 'y',
): number => {
  const primary = axis === 'x' ? point.x : point.y;
  const geographic = axis === 'x' ? point.longitude : point.latitude;
  return finite(primary ?? geographic, `point.${axis}`);
};

const capturePoint = (
  point: ArcgisPointLike | undefined,
  fallbackSpatialReference: ArcgisSpatialReferenceLike | undefined,
): ViewPointState => {
  if (!point) throw new TypeError('ArcGIS view point is required');
  const spatialReference = normalizeSpatialReference(point.spatialReference ?? fallbackSpatialReference);
  const z = point.z === undefined ? undefined : finite(point.z, 'point.z');
  return Object.freeze({
    x: pointCoordinate(point, 'x'),
    y: pointCoordinate(point, 'y'),
    ...(z === undefined ? {} : { z }),
    spatialReference,
  });
};

export const captureArcgisUnifiedViewState = (
  view: ArcgisTransitionViewLike,
  mode: '2d' | '3d',
): UnifiedViewState => {
  if (!view || view.destroyed === true) throw new Error(`ArcGIS ${mode} view is not available`);
  const scale = positive(view.scale, 'view.scale');
  if (mode === '2d') {
    return Object.freeze({
      mode: '2d' as const,
      center: capturePoint(view.center, view.spatialReference),
      scale,
      rotation: finite(view.rotation ?? 0, 'view.rotation'),
    });
  }
  if (!view.camera) throw new TypeError('ArcGIS SceneView camera is required');
  return Object.freeze({
    mode: '3d' as const,
    camera: Object.freeze({
      position: capturePoint(view.camera.position, view.spatialReference),
      heading: finite(view.camera.heading ?? 0, 'camera.heading'),
      tilt: finite(view.camera.tilt ?? 0, 'camera.tilt'),
    }),
    scale,
  });
};

export const createArcgisTransitionTarget = (state: UnifiedViewState): Readonly<Record<string, unknown>> => {
  if (state.mode === '2d') {
    return Object.freeze({
      center: Object.freeze({
        x: state.center.x,
        y: state.center.y,
        ...(state.center.z === undefined ? {} : { z: state.center.z }),
        spatialReference: state.center.spatialReference,
      }),
      scale: state.scale,
      rotation: state.rotation,
    });
  }
  return Object.freeze({
    position: Object.freeze({
      x: state.camera.position.x,
      y: state.camera.position.y,
      ...(state.camera.position.z === undefined ? {} : { z: state.camera.position.z }),
      spatialReference: state.camera.position.spatialReference,
    }),
    heading: state.camera.heading,
    tilt: state.camera.tilt,
    scale: state.scale,
  });
};

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

const isAbort = (error: unknown): boolean => (
  error instanceof Error && error.name === 'AbortError'
);

const awaitMaybe = async (value: void | Promise<void>): Promise<void> => {
  await Promise.resolve(value);
};

/**
 * Builds an executor suitable for ViewStateTransitionCoordinator. A resolver is
 * used instead of directly owning MapView/SceneView so 2D and 3D instances can
 * be mounted/unmounted independently by React while the transition policy stays
 * stable and testable.
 */
export const createArcgisViewTransitionExecutor = (
  options: ArcgisViewTransitionAdapterOptions,
): ViewTransitionExecutor => async (context) => {
  const view = options.resolveView(context.target.mode);
  if (!view || view.destroyed === true || typeof view.goTo !== 'function') {
    throw new Error(`ArcGIS ${context.target.mode} view is not available for transition`);
  }
  if (context.signal.aborted) throw abortError('ArcGIS view transition aborted before goTo');

  await awaitMaybe(options.onBeforeGoTo?.(view, context.target));
  const target = options.targetFactory?.(context.target) ?? createArcgisTransitionTarget(context.target);
  const goToOptions: Record<string, unknown> = {
    ...options.goToOptions,
    duration: context.durationMs,
    animate: context.durationMs > 0,
    signal: context.signal,
  };
  try {
    await view.goTo(target, goToOptions);
  } catch (error) {
    if (context.signal.aborted || isAbort(error)) throw abortError('ArcGIS view transition aborted during goTo');
    throw error;
  }
  if (context.signal.aborted) throw abortError('ArcGIS view transition aborted after goTo');
  await awaitMaybe(options.onAfterGoTo?.(view, context.target));

  try {
    return captureArcgisUnifiedViewState(view, context.target.mode);
  } catch {
    // Some thin test/adapter views intentionally do not mirror goTo state back
    // into view properties. The coordinator already validated the target, so it
    // is safe to use the target as the authoritative completed state in that case.
    return context.target;
  }
};

export const seedOrchestrationFromArcgisView = (
  runtime: ModernGisViewOrchestrationRuntime,
  view: ArcgisTransitionViewLike,
  mode: '2d' | '3d',
): UnifiedViewState => runtime.seedViewTransition(captureArcgisUnifiedViewState(view, mode));

export const transitionArcgisView = (
  runtime: ModernGisViewOrchestrationRuntime,
  request: ViewTransitionRequest,
  options: ArcgisViewTransitionAdapterOptions,
): Promise<ViewTransitionResult> => runtime.transitionView(
  request,
  createArcgisViewTransitionExecutor(options),
);
