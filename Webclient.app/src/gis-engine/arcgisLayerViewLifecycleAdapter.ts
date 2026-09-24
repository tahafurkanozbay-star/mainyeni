import type {
  GisViewMode,
  LayerViewPriority,
  LayerViewRegistration,
  LayerViewResource,
  LayerViewSnapshot,
} from './layerViewLifecycleCoordinator';
import type { ModernGisViewOrchestrationRuntime } from './modernGisViewOrchestrationRuntime';

export interface ArcgisLayerViewLike {
  suspended?: boolean;
  updating?: boolean;
  visible?: boolean;
  layer?: unknown;
  destroy?: () => void;
}

export interface ArcgisViewLayerViewSource {
  whenLayerView: (layer: unknown) => Promise<ArcgisLayerViewLike>;
}

export interface ArcgisLayerViewLifecycleAdapterOptions {
  readonly layerId: string;
  readonly mode: GisViewMode;
  readonly priority?: LayerViewPriority;
  readonly view: ArcgisViewLayerViewSource;
  readonly layer: unknown;
  readonly destroyLayerViewOnDispose?: boolean;
  readonly release?: (layerView: ArcgisLayerViewLike) => void | Promise<void>;
  readonly onSuspend?: (layerView: ArcgisLayerViewLike) => void | Promise<void>;
  readonly onResume?: (layerView: ArcgisLayerViewLike) => void | Promise<void>;
}

export interface ArcgisLayerViewLifecycleBinding {
  readonly registration: LayerViewRegistration;
  register: (runtime: ModernGisViewOrchestrationRuntime) => LayerViewSnapshot;
  ensure: (runtime: ModernGisViewOrchestrationRuntime) => Promise<LayerViewSnapshot>;
  suspend: (runtime: ModernGisViewOrchestrationRuntime) => Promise<boolean>;
  remove: (runtime: ModernGisViewOrchestrationRuntime) => Promise<boolean>;
}

const normalizeId = (value: string): string => {
  const id = value.trim();
  if (!id) throw new TypeError('ArcGIS layer-view layerId must not be empty');
  if (id.length > 256) throw new RangeError('ArcGIS layer-view layerId exceeds 256 characters');
  return id;
};

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => (
  value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && typeof (value as { then?: unknown }).then === 'function'
);

const awaitMaybe = async (value: void | Promise<void>): Promise<void> => {
  if (isPromiseLike(value)) await value;
};

const raceLayerViewWithAbort = async (
  promise: Promise<ArcgisLayerViewLike>,
  signal: AbortSignal,
): Promise<ArcgisLayerViewLike> => {
  if (signal.aborted) throw abortError('ArcGIS layer-view load aborted before start');
  return new Promise<ArcgisLayerViewLike>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: ArcgisLayerViewLike) => void, value: ArcgisLayerViewLike): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(reason);
    };
    const onAbort = (): void => fail(abortError('ArcGIS layer-view load aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), fail);
  });
};

/**
 * Converts ArcGIS View.whenLayerView() into the transport-neutral layer-view
 * lifecycle contract owned by ModernGisViewOrchestrationRuntime.
 *
 * ArcGIS normally owns the lifetime of LayerView instances. Therefore dispose
 * only suspends/release-notifies by default; explicit destroy requires
 * destroyLayerViewOnDispose=true.
 */
export const createArcgisLayerViewRegistration = (
  options: ArcgisLayerViewLifecycleAdapterOptions,
): LayerViewRegistration => {
  const layerId = normalizeId(options.layerId);
  if (!options.view || typeof options.view.whenLayerView !== 'function') {
    throw new TypeError('ArcGIS view must provide whenLayerView(layer)');
  }
  if (options.layer === null || options.layer === undefined) {
    throw new TypeError('ArcGIS layer is required for layer-view registration');
  }

  return Object.freeze({
    key: Object.freeze({ layerId, mode: options.mode }),
    priority: options.priority ?? 'normal',
    load: async ({ signal }): Promise<LayerViewResource> => {
      const layerView = await raceLayerViewWithAbort(
        Promise.resolve(options.view.whenLayerView(options.layer)),
        signal,
      );
      if (signal.aborted) throw abortError('ArcGIS layer-view load aborted after resolution');
      let disposed = false;

      const assertLive = (): void => {
        if (disposed) throw new Error(`ArcGIS layer-view resource is disposed: ${layerId}`);
      };

      return Object.freeze({
        suspend: async (): Promise<void> => {
          assertLive();
          layerView.suspended = true;
          await awaitMaybe(options.onSuspend?.(layerView));
        },
        resume: async (): Promise<void> => {
          assertLive();
          layerView.suspended = false;
          await awaitMaybe(options.onResume?.(layerView));
        },
        dispose: async (): Promise<void> => {
          if (disposed) return;
          disposed = true;
          layerView.suspended = true;
          try {
            await awaitMaybe(options.release?.(layerView));
          } finally {
            if (options.destroyLayerViewOnDispose === true) layerView.destroy?.();
          }
        },
      });
    },
  });
};

export const bindArcgisLayerViewLifecycle = (
  options: ArcgisLayerViewLifecycleAdapterOptions,
): ArcgisLayerViewLifecycleBinding => {
  const registration = createArcgisLayerViewRegistration(options);
  const key = registration.key;
  return Object.freeze({
    registration,
    register: (runtime: ModernGisViewOrchestrationRuntime): LayerViewSnapshot => (
      runtime.registerLayerView(registration)
    ),
    ensure: (runtime: ModernGisViewOrchestrationRuntime): Promise<LayerViewSnapshot> => (
      runtime.ensureLayerView(key)
    ),
    suspend: (runtime: ModernGisViewOrchestrationRuntime): Promise<boolean> => (
      runtime.suspendLayerView(key)
    ),
    remove: (runtime: ModernGisViewOrchestrationRuntime): Promise<boolean> => (
      runtime.removeLayerView(key)
    ),
  });
};
