import { loadArcgisModules } from './arcgisModuleRuntime';
import { withTimeout } from '../platform/runtime/resilience';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export const FREE_SCENE_BASEMAP_ID = 'openstreetmap-3d';
export const FREE_SCENE_BASEMAP_TITLE = 'OpenStreetMap — ücretsiz 3B binalar';

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

type ArcgisConstructor<T = unknown> = new (properties?: Record<string, unknown>) => T;

const loadFreeOpenStreetMapBasemap = async (): Promise<SceneBasemapModule> => {
  const [Basemap, OpenStreetMapLayer] = await loadArcgisModules<
    readonly [ArcgisConstructor<SceneBasemapLike>, ArcgisConstructor<unknown>]
  >(['esri/Basemap', 'esri/layers/OpenStreetMapLayer']);

  return {
    fromId: (id: string) => {
      if (id !== FREE_SCENE_BASEMAP_ID) return null;
      return new Basemap({
        id: FREE_SCENE_BASEMAP_ID,
        title: FREE_SCENE_BASEMAP_TITLE,
        baseLayers: [new OpenStreetMapLayer()],
      });
    },
  };
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('3B altlık yüklemesi iptal edildi.', 'AbortError');
};

/**
 * Temporarily uses the API-key-free OpenStreetMap layer in SceneView.
 * It deliberately avoids the authenticated Esri streets-3d style and World
 * Elevation service; OSM3DBuildingsRuntime supplies the extruded building data.
 */
export class SceneBasemapRuntime {
  readonly #loadBasemap: () => Promise<SceneBasemapModule>;
  readonly #basemapId: string;
  #ownership: SceneBasemapOwnership | null = null;

  constructor(
    loadBasemap: () => Promise<SceneBasemapModule> = loadFreeOpenStreetMapBasemap,
    basemapId = FREE_SCENE_BASEMAP_ID,
  ) {
    this.#loadBasemap = loadBasemap;
    this.#basemapId = basemapId;
  }

  async activate(map: SceneBasemapMap, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    const existing = this.#ownership;
    if (existing?.map === map) {
      if (map.basemap !== existing.sceneBasemap) existing.previousBasemap = map.basemap;
      map.basemap = existing.sceneBasemap;
      return;
    }

    if (existing) this.dispose();
    const previousBasemap = map.basemap;

    const module = await this.#loadBasemap();
    throwIfAborted(signal);
    const sceneBasemap = module.fromId(this.#basemapId);
    if (!sceneBasemap) throw new Error(`Ücretsiz OpenStreetMap 3B altlığı kullanılamıyor: ${this.#basemapId}`);

    try {
      await withTimeout((timeoutSignal) => sceneBasemap.load?.({ signal: timeoutSignal }), 15_000, signal);
      throwIfAborted(signal);
      if (map.basemap !== previousBasemap) {
        throw new DOMException('Altlık yüklenirken harita altlığı değişti.', 'AbortError');
      }
      map.basemap = sceneBasemap;
      this.#ownership = { map, previousBasemap, sceneBasemap };
    } catch (error) {
      try { sceneBasemap.destroy?.(); } catch (cleanupError) {
        runtimeDiagnostics.captureError(cleanupError, { source: 'gis.scene-basemap.failed-load-cleanup' }, 'warn');
      }
      throw error;
    }
  }

  restore(map: SceneBasemapMap): boolean {
    const ownership = this.#ownership;
    if (!ownership || ownership.map !== map) return false;
    if (map.basemap !== ownership.sceneBasemap) ownership.previousBasemap = map.basemap;
    map.basemap = ownership.previousBasemap ?? null;
    return true;
  }

  dispose(): void {
    const ownership = this.#ownership;
    this.#ownership = null;
    if (!ownership) return;
    if (ownership.map.basemap !== ownership.sceneBasemap) ownership.previousBasemap = ownership.map.basemap;
    ownership.map.basemap = ownership.previousBasemap ?? null;
    try { ownership.sceneBasemap.destroy?.(); } catch (cleanupError) {
      runtimeDiagnostics.captureError(cleanupError, { source: 'gis.scene-basemap.teardown' }, 'warn');
    }
  }
}

export const createSceneBasemapRuntime = (): SceneBasemapRuntime => new SceneBasemapRuntime();
