import type { ArcGisLayerDescriptor, ArcGisLayerMode } from './arcgisLayerAdapter';

export type RendererLayerPatch = Readonly<{
  visible?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
}>;

export type RendererLayerHandle = Readonly<{
  id: string;
  mode: ArcGisLayerMode;
  resourceUrl: string;
  apply(patch: RendererLayerPatch): void | Promise<void>;
  destroy(): void | Promise<void>;
}>;

export type RendererLayerFactory = (input: Readonly<{
  descriptor: ArcGisLayerDescriptor;
  signal: AbortSignal;
}>) => RendererLayerHandle | Promise<RendererLayerHandle>;

export type RendererBindingStatus = 'idle' | 'binding' | 'ready' | 'error';

export type RendererBindingSnapshot = Readonly<{
  id: string;
  revision: number;
  status: RendererBindingStatus;
  mode: ArcGisLayerMode;
  resourceUrl: string;
  visible: boolean;
  opacity: number;
  minScale: number;
  maxScale: number;
  error: string | null;
}>;

type OwnedBinding = {
  revision: number;
  descriptor: ArcGisLayerDescriptor;
  handle: RendererLayerHandle | null;
  controller: AbortController | null;
  snapshot: RendererBindingSnapshot;
};

export class RendererBindingCoordinatorError extends Error {
  readonly code: string;

  constructor(message: string, code = 'RENDERER_BINDING_ERROR') {
    super(message);
    this.name = 'RendererBindingCoordinatorError';
    this.code = code;
  }
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message.slice(0, 512);
  return 'Renderer binding failed.';
};

const aborted = (signal: AbortSignal, error: unknown): boolean => (
  signal.aborted || (error instanceof Error && error.name === 'AbortError')
);

const validateDescriptor = (descriptor: ArcGisLayerDescriptor): void => {
  if (!descriptor.id.trim() || descriptor.id.length > 256) {
    throw new RendererBindingCoordinatorError('Renderer binding requires a bounded layer id.', 'INVALID_LAYER_ID');
  }
  if (!descriptor.resourceUrl.trim()) {
    throw new RendererBindingCoordinatorError('Renderer binding requires a verified resource URL.', 'INVALID_RESOURCE_URL');
  }
  if (descriptor.mode !== '2d' && descriptor.mode !== '3d') {
    throw new RendererBindingCoordinatorError('Renderer binding mode must be 2d or 3d.', 'INVALID_MODE');
  }
};

const snapshotFor = (
  descriptor: ArcGisLayerDescriptor,
  revision: number,
  status: RendererBindingStatus,
  error: string | null = null,
): RendererBindingSnapshot => Object.freeze({
  id: descriptor.id,
  revision,
  status,
  mode: descriptor.mode,
  resourceUrl: descriptor.resourceUrl,
  visible: descriptor.visible,
  opacity: descriptor.opacity,
  minScale: descriptor.minScale,
  maxScale: descriptor.maxScale,
  error,
});

const sameResourceIdentity = (left: ArcGisLayerDescriptor, right: ArcGisLayerDescriptor): boolean => (
  left.id === right.id
  && left.mode === right.mode
  && left.resourceUrl === right.resourceUrl
  && left.kind === right.kind
);

const patchFor = (previous: ArcGisLayerDescriptor, next: ArcGisLayerDescriptor): RendererLayerPatch | null => {
  const patch: {
    visible?: boolean;
    opacity?: number;
    minScale?: number;
    maxScale?: number;
  } = {};
  if (previous.visible !== next.visible) patch.visible = next.visible;
  if (previous.opacity !== next.opacity) patch.opacity = next.opacity;
  if (previous.minScale !== next.minScale) patch.minScale = next.minScale;
  if (previous.maxScale !== next.maxScale) patch.maxScale = next.maxScale;
  return Object.keys(patch).length ? Object.freeze(patch) : null;
};

const destroyQuietly = async (handle: RendererLayerHandle | null): Promise<void> => {
  if (!handle) return;
  try {
    await handle.destroy();
  } catch {
    // Destruction is best-effort. Ownership is removed before awaiting so a
    // renderer teardown failure cannot resurrect a released layer.
  }
};

export type RendererBindingCoordinator = Readonly<{
  bind(descriptor: ArcGisLayerDescriptor): Promise<RendererBindingSnapshot>;
  bindAll(descriptors: readonly ArcGisLayerDescriptor[]): Promise<readonly RendererBindingSnapshot[]>;
  snapshot(id: string): RendererBindingSnapshot | null;
  snapshots(): readonly RendererBindingSnapshot[];
  release(id: string): Promise<boolean>;
  releaseMode(mode: ArcGisLayerMode): Promise<number>;
  reconcile(descriptors: readonly ArcGisLayerDescriptor[]): Promise<readonly RendererBindingSnapshot[]>;
  dispose(): Promise<void>;
}>;

export const createRendererBindingCoordinator = (input: Readonly<{
  factory: RendererLayerFactory;
  maximumBindings?: number;
}>): RendererBindingCoordinator => {
  if (typeof input.factory !== 'function') {
    throw new RendererBindingCoordinatorError('Renderer layer factory is required.', 'MISSING_FACTORY');
  }
  const maximumBindings = input.maximumBindings ?? 512;
  if (!Number.isSafeInteger(maximumBindings) || maximumBindings <= 0 || maximumBindings > 4096) {
    throw new RendererBindingCoordinatorError('Renderer binding budget must be between 1 and 4096.', 'INVALID_BINDING_BUDGET');
  }

  const owned = new Map<string, OwnedBinding>();
  let disposed = false;

  const assertLive = (): void => {
    if (disposed) throw new RendererBindingCoordinatorError('Renderer binding coordinator is disposed.', 'DISPOSED');
  };

  const currentSnapshot = (id: string): RendererBindingSnapshot | null => owned.get(id)?.snapshot ?? null;

  const bind = async (descriptor: ArcGisLayerDescriptor): Promise<RendererBindingSnapshot> => {
    assertLive();
    validateDescriptor(descriptor);
    const previous = owned.get(descriptor.id);

    if (previous?.handle && sameResourceIdentity(previous.descriptor, descriptor)) {
      const patch = patchFor(previous.descriptor, descriptor);
      const revision = previous.revision + 1;
      previous.revision = revision;
      previous.descriptor = descriptor;
      if (!patch) {
        previous.snapshot = snapshotFor(descriptor, revision, 'ready');
        return previous.snapshot;
      }
      try {
        await previous.handle.apply(patch);
        if (owned.get(descriptor.id) !== previous || previous.revision !== revision) {
          return currentSnapshot(descriptor.id) ?? snapshotFor(descriptor, revision, 'idle');
        }
        previous.snapshot = snapshotFor(descriptor, revision, 'ready');
        return previous.snapshot;
      } catch (error) {
        if (owned.get(descriptor.id) !== previous || previous.revision !== revision) {
          return currentSnapshot(descriptor.id) ?? snapshotFor(descriptor, revision, 'idle');
        }
        previous.snapshot = snapshotFor(descriptor, revision, 'error', errorMessage(error));
        throw error;
      }
    }

    if (!previous && owned.size >= maximumBindings) {
      throw new RendererBindingCoordinatorError('Renderer binding budget exceeded.', 'BINDING_BUDGET_EXCEEDED');
    }

    previous?.controller?.abort('renderer binding superseded');
    const revision = (previous?.revision ?? 0) + 1;
    const controller = new AbortController();
    const entry: OwnedBinding = {
      revision,
      descriptor,
      handle: null,
      controller,
      snapshot: snapshotFor(descriptor, revision, 'binding'),
    };
    owned.set(descriptor.id, entry);

    try {
      const handle = await input.factory({ descriptor, signal: controller.signal });
      if (disposed || controller.signal.aborted || owned.get(descriptor.id) !== entry || entry.revision !== revision) {
        await destroyQuietly(handle);
        return currentSnapshot(descriptor.id) ?? snapshotFor(descriptor, revision, 'idle');
      }
      if (handle.id !== descriptor.id || handle.mode !== descriptor.mode || handle.resourceUrl !== descriptor.resourceUrl) {
        await destroyQuietly(handle);
        const mismatch = new RendererBindingCoordinatorError('Renderer handle identity does not match its verified descriptor.', 'HANDLE_IDENTITY_MISMATCH');
        entry.controller = null;
        entry.snapshot = snapshotFor(descriptor, revision, 'error', mismatch.message);
        throw mismatch;
      }
      entry.handle = handle;
      entry.controller = null;
      entry.snapshot = snapshotFor(descriptor, revision, 'ready');
      if (previous?.handle) await destroyQuietly(previous.handle);
      return entry.snapshot;
    } catch (error) {
      if (aborted(controller.signal, error) || owned.get(descriptor.id) !== entry || entry.revision !== revision) {
        return currentSnapshot(descriptor.id) ?? snapshotFor(descriptor, revision, 'idle');
      }
      entry.controller = null;
      entry.snapshot = snapshotFor(descriptor, revision, 'error', errorMessage(error));
      throw error;
    }
  };

  const bindAll = async (descriptors: readonly ArcGisLayerDescriptor[]): Promise<readonly RendererBindingSnapshot[]> => {
    assertLive();
    if (descriptors.length > maximumBindings) {
      throw new RendererBindingCoordinatorError('Renderer binding batch exceeds budget.', 'BINDING_BUDGET_EXCEEDED');
    }
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      validateDescriptor(descriptor);
      if (seen.has(descriptor.id)) throw new RendererBindingCoordinatorError(`Duplicate renderer layer id: ${descriptor.id}`, 'DUPLICATE_LAYER_ID');
      seen.add(descriptor.id);
    }
    return Object.freeze(await Promise.all(descriptors.map((descriptor) => bind(descriptor))));
  };

  const release = async (id: string): Promise<boolean> => {
    const entry = owned.get(id);
    if (!entry) return false;
    owned.delete(id);
    entry.revision += 1;
    entry.controller?.abort('renderer binding released');
    entry.controller = null;
    await destroyQuietly(entry.handle);
    entry.handle = null;
    return true;
  };

  const releaseMode = async (mode: ArcGisLayerMode): Promise<number> => {
    const ids: string[] = [];
    for (const [id, entry] of owned) if (entry.descriptor.mode === mode) ids.push(id);
    await Promise.all(ids.map((id) => release(id)));
    return ids.length;
  };

  const reconcile = async (descriptors: readonly ArcGisLayerDescriptor[]): Promise<readonly RendererBindingSnapshot[]> => {
    assertLive();
    const desired = new Set<string>();
    for (const descriptor of descriptors) {
      if (desired.has(descriptor.id)) throw new RendererBindingCoordinatorError(`Duplicate renderer layer id: ${descriptor.id}`, 'DUPLICATE_LAYER_ID');
      desired.add(descriptor.id);
    }
    const removed: string[] = [];
    for (const id of owned.keys()) if (!desired.has(id)) removed.push(id);
    await Promise.all(removed.map((id) => release(id)));
    return bindAll(descriptors);
  };

  const snapshots = (): readonly RendererBindingSnapshot[] => Object.freeze(
    Array.from(owned.values(), (entry) => entry.snapshot),
  );

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const ids = Array.from(owned.keys());
    await Promise.all(ids.map((id) => release(id)));
  };

  return Object.freeze({ bind, bindAll, snapshot: currentSnapshot, snapshots, release, releaseMode, reconcile, dispose });
};
