import { loadArcgisModule } from './arcgisModuleRuntime';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export const ESRI_3D_BUILDINGS_SCENE_LAYER_URL =
  'https://basemaps3d.arcgis.com/arcgis/rest/services/Esri3D_Buildings_v1/SceneServer/layers/0';

export interface Esri3DBuildingsLayerLike {
  visible?: boolean;
  loaded?: boolean;
  load?: () => PromiseLike<unknown> | unknown;
  destroy?: () => void;
}
export interface Esri3DBuildingsMapLike {
  add?: (layer: Esri3DBuildingsLayerLike, index?: number) => unknown;
  remove?: (layer: Esri3DBuildingsLayerLike) => unknown;
}
export interface Esri3DBuildingsSceneViewLike {
  readonly map?: Esri3DBuildingsMapLike | null;
}
export type Esri3DBuildingsLayerConstructor =
  new (properties?: Record<string, unknown>) => Esri3DBuildingsLayerLike;
type LoadSceneLayer = () => Promise<Esri3DBuildingsLayerConstructor>;

export interface Esri3DBuildingsRuntimeOptions {
  readonly loadSceneLayer?: LoadSceneLayer;
  readonly onError?: (error: unknown, source: string) => void;
}

const defaultLoadSceneLayer: LoadSceneLayer = () =>
  loadArcgisModule<Esri3DBuildingsLayerConstructor>('esri/layers/SceneLayer');

/**
 * Attaches Esri's streamed 3D-object buildings only on demand in SceneView.
 * The layer is retained but hidden when the user returns to 2D, so switching
 * between modes does not repeatedly recreate the layer or reload its nodes.
 */
export class Esri3DBuildingsRuntime {
  readonly #loadSceneLayer: LoadSceneLayer;
  readonly #onError: (error: unknown, source: string) => void;
  #map: Esri3DBuildingsMapLike | null = null;
  #layer: Esri3DBuildingsLayerLike | null = null;
  #generation = 0;

  constructor(options: Esri3DBuildingsRuntimeOptions = {}) {
    this.#loadSceneLayer = options.loadSceneLayer ?? defaultLoadSceneLayer;
    this.#onError = options.onError ?? ((error, source) => {
      runtimeDiagnostics.captureError(error, { source }, 'warn');
    });
  }

  async activate(view: Esri3DBuildingsSceneViewLike): Promise<void> {
    const map = view.map;
    if (!map || typeof map.add !== 'function') {
      throw new Error('Esri 3B binaları için harita nesnesi hazır değil.');
    }

    if (this.#map === map && this.#layer) {
      this.#layer.visible = true;
      return;
    }

    this.#removeCurrentLayer();
    const generation = ++this.#generation;
    const SceneLayer = await this.#loadSceneLayer();
    if (generation !== this.#generation) return;

    const layer = new SceneLayer({
      id: 'kentrehberi-esri-3d-buildings',
      title: 'Esri 3D Buildings',
      url: ESRI_3D_BUILDINGS_SCENE_LAYER_URL,
      visible: true,
      listMode: 'hide',
      legendEnabled: false,
      popupEnabled: true,
      outFields: ['*'],
      popupTemplate: {
        title: '{name}',
        content: [{
          type: 'fields',
          fieldInfos: [
            { fieldName: 'building', label: 'Yapı türü' },
            { fieldName: 'height', label: 'Yükseklik (m)', format: { places: 1, digitSeparator: true } },
            { fieldName: 'building_levels', label: 'Kat sayısı', format: { places: 0, digitSeparator: true } },
            { fieldName: 'source', label: 'Veri kaynağı' },
          ],
        }],
      },
    });

    if (generation !== this.#generation) {
      try { layer.destroy?.(); } catch (error) { this.#report(error, 'gis.esri-3d-buildings.destroy-stale'); }
      return;
    }

    this.#map = map;
    this.#layer = layer;
    try {
      map.add(layer, 0);
    } catch (error) {
      this.#map = null;
      this.#layer = null;
      try { layer.destroy?.(); } catch (destroyError) {
        this.#report(destroyError, 'gis.esri-3d-buildings.destroy-after-add-failure');
      }
      throw error;
    }

    // Do not block the first 3D frame while the remote SceneServer is loading.
    // ArcGIS streams visible nodes progressively after the layer joins SceneView.
    if (typeof layer.load === 'function') {
      void Promise.resolve()
        .then(() => layer.load?.())
        .catch((error: unknown) => {
          if (this.#layer === layer && this.#map === map) this.#removeCurrentLayer();
          this.#report(error, 'gis.esri-3d-buildings.load');
        });
    }
  }

  deactivate(): void {
    if (this.#layer) this.#layer.visible = false;
  }

  dispose(): void {
    this.#generation += 1;
    this.#removeCurrentLayer();
  }

  #removeCurrentLayer(): void {
    const layer = this.#layer;
    const map = this.#map;
    this.#layer = null;
    this.#map = null;
    if (!layer) return;

    try {
      map?.remove?.(layer);
    } catch (error) {
      this.#report(error, 'gis.esri-3d-buildings.remove');
    }
    try {
      layer.destroy?.();
    } catch (error) {
      this.#report(error, 'gis.esri-3d-buildings.destroy');
    }
  }

  #report(error: unknown, source: string): void {
    try {
      this.#onError(error, source);
    } catch (observerError) {
      // Observer failures should not break cleanup; preserve them in central diagnostics.
      runtimeDiagnostics.captureError(observerError, {
        source: `${source}.observer-callback-failed`,
      }, 'warn');
    }
  }
}

export const createEsri3DBuildingsRuntime = (): Esri3DBuildingsRuntime =>
  new Esri3DBuildingsRuntime();
