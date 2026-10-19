import { loadArcgisModule } from './arcgisModuleRuntime';
import { withTimeout } from '../platform/runtime/resilience';

export interface SceneBasemapLike {
  readonly id?: string;
  readonly portalItem?: { readonly id?: string } | null;
  readonly title?: string;
  load?: (options?: { readonly signal?: AbortSignal }) => Promise<unknown> | unknown;
  destroy?: () => void;
}

export interface SceneBasemapModule {
  fromId: (id: string) => SceneBasemapLike | null | undefined;
}

export interface SceneBasemapMap {
  basemap?: SceneBasemapLike | string | null;
}

interface SceneBasemapOwnership {
  readonly map: SceneBasemapMap;
  previousBasemap: SceneBasemapLike | string | null | undefined;
  readonly sceneBasemap: SceneBasemapLike;
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('3B altlık yüklemesi iptal edildi.', 'AbortError');
};

/**
 * Temporarily switches a shared Map to a 3D-capable basemap while a SceneView
 * is active. The user's current 2D basemap is retained and restored on return.
 */
export class SceneBasemapRuntime {
  readonly #loadBasemap: () => Promise<SceneBasemapModule>;
  readonly #basemapId: string;
  #ownership: SceneBasemapOwnership | null = null;

  constructor(
    loadBasemap: () => Promise<SceneBasemapModule> = () => loadArcgisModule<SceneBasemapModule>('esri/Basemap'),
    basemapId = 'streets-3d',
  ) {
    this.#loadBasemap = loadBasemap;
    this.#basemapId = basemapId;
  }

  async activate(map: SceneBasemapMap, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    const existing = this.#ownership;
    if (existing?.map === map) {
      // A basemap chosen in the gallery becomes the next 2D basemap to restore.
      if (map.basemap !== existing.sceneBasemap) existing.previousBasemap = map.basemap;
      map.basemap = existing.sceneBasemap;
      return;
    }

    if (existing) this.dispose();
    const previousBasemap = map.basemap;

    const module = await this.#loadBasemap();
    throwIfAborted(signal);
    const sceneBasemap = module.fromId(this.#basemapId);
    if (!sceneBasemap) throw new Error(`ArcGIS 3D altlığı kullanılamıyor: ${this.#basemapId}`);

    try {
      await withTimeout((timeoutSignal) => sceneBasemap.load?.({ signal: timeoutSignal }), 15_000, signal);
      throwIfAborted(signal);
      if (map.basemap !== previousBasemap) {
        throw new DOMException('Altlık yüklenirken harita altlığı değişti.', 'AbortError');
      }
      map.basemap = sceneBasemap;
      this.#ownership = { map, previousBasemap, sceneBasemap };
    } catch (error) {
      try { sceneBasemap.destroy?.(); } catch { /* keep the original load error */ }
      throw error;
    }
  }

  restore(map: SceneBasemapMap): boolean {
    const ownership = this.#ownership;
    if (!ownership || ownership.map !== map) return false;

    if (map.basemap !== ownership.sceneBasemap) {
      ownership.previousBasemap = map.basemap;
    }
    map.basemap = ownership.previousBasemap ?? null;
    return true;
  }

  dispose(): void {
    const ownership = this.#ownership;
    this.#ownership = null;
    if (!ownership) return;

    if (ownership.map.basemap !== ownership.sceneBasemap) {
      ownership.previousBasemap = ownership.map.basemap;
    }
    ownership.map.basemap = ownership.previousBasemap ?? null;
    try { ownership.sceneBasemap.destroy?.(); } catch { /* teardown must be best-effort */ }
  }
}

export const createSceneBasemapRuntime = (): SceneBasemapRuntime => new SceneBasemapRuntime();
