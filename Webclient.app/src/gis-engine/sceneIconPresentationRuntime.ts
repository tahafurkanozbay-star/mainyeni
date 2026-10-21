import { loadArcgisModules } from './arcgisModuleRuntime';
import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export const KENT_REHBERI_ICON_LAYER_ID = 'kent-rehberi-postgis';
export const SCENE_ICON_OVERLAY_LAYER_ID = 'kent-rehberi-3d-icon-overlay';
export const SCENE_ICON_GROUND_OFFSET_METERS = 50;
export const SCENE_ICON_LAYER_OPACITY = 0.78;

const SCENE_ICON_SIZE_PX = 36;
const SCENE_ICON_VERTICAL_OFFSET = Object.freeze({
  screenLength: SCENE_ICON_GROUND_OFFSET_METERS,
  minWorldLength: SCENE_ICON_GROUND_OFFSET_METERS,
  maxWorldLength: SCENE_ICON_GROUND_OFFSET_METERS,
});
const SCENE_ICON_CALLOUT = Object.freeze({
  type: 'line',
  color: [74, 219, 255, 0.98],
  size: 1.6,
  border: { color: [15, 37, 56, 0.95] },
});

type JsonRecord = Record<string, unknown>;
interface RemovableHandle { remove?: () => void; }
interface SceneIconFeatureLike {
  readonly geometry?: unknown;
  readonly attributes?: Readonly<Record<string, unknown>>;
}
interface SceneIconFeatureSetLike {
  readonly features?: readonly SceneIconFeatureLike[];
}
interface IconRendererSymbol {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  toJSON?: () => unknown;
  [key: string]: unknown;
}
interface IconRendererInfo {
  readonly value?: unknown;
  readonly symbol?: IconRendererSymbol | JsonRecord | null;
  readonly [key: string]: unknown;
}
interface SceneIconLayerLike {
  readonly id?: string;
  renderer?: unknown;
  visible?: boolean;
  popupTemplate?: unknown;
  createQuery?: () => unknown;
  queryFeatures?: (query: unknown) => PromiseLike<SceneIconFeatureSetLike>;
}
interface SceneIconLayerCollectionLike {
  readonly items?: readonly unknown[];
  toArray?: () => readonly unknown[];
  on?: (eventName: 'after-add' | 'after-remove', callback: (event: { item?: unknown }) => void) => RemovableHandle;
}
interface SceneIconGraphicsLayerLike {
  destroy?: () => void;
}
interface SceneIconMapLike {
  add?: (layer: SceneIconGraphicsLayerLike, index?: number) => unknown;
  remove?: (layer: SceneIconGraphicsLayerLike) => unknown;
  readonly layers?: SceneIconLayerCollectionLike;
  readonly allLayers?: SceneIconLayerCollectionLike;
  findLayerById?: (id: string) => SceneIconLayerLike | null | undefined;
}
interface LayerPresentationSnapshot {
  readonly layer: SceneIconLayerLike;
  readonly visible: boolean | undefined;
  readonly overlay: SceneIconGraphicsLayerLike;
}
export type SceneIconGraphicConstructor = new (properties: Record<string, unknown>) => unknown;
export type SceneIconGraphicsLayerConstructor = new (properties: Record<string, unknown>) => SceneIconGraphicsLayerLike;
export type LoadSceneIconGraphicsModules = () => Promise<
  readonly [SceneIconGraphicConstructor, SceneIconGraphicsLayerConstructor]
>;
export interface SceneIconPresentationRuntimeOptions {
  readonly loadGraphicsModules?: LoadSceneIconGraphicsModules;
  readonly onError?: (error: unknown, source: string) => void;
}

const defaultLoadGraphicsModules: LoadSceneIconGraphicsModules = () =>
  loadArcgisModules<readonly [SceneIconGraphicConstructor, SceneIconGraphicsLayerConstructor]>([
    'esri/Graphic',
    'esri/layers/GraphicsLayer',
  ]);

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;

const toJSONValue = (value: unknown): unknown => {
  const record = asRecord(value);
  const toJSON = record?.toJSON;
  if (typeof toJSON !== 'function') return value;
  try {
    return (toJSON as () => unknown).call(value);
  } catch {
    return value;
  }
};

const readCollection = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (typeof record?.toArray === 'function') {
    try {
      const array = (record.toArray as () => unknown).call(value);
      if (Array.isArray(array)) return array;
    } catch {
      return [];
    }
  }
  const iterable = value as { readonly [Symbol.iterator]?: () => Iterator<unknown> } | null;
  if (typeof iterable?.[Symbol.iterator] === 'function') {
    try {
      return Array.from(value as Iterable<unknown>);
    } catch {
      return [];
    }
  }
  return [];
};

/** ArcGIS IconSymbol3DLayer requires relative image paths to begin with "./". */
export const normalizeSceneIconHref = (input: string): string => {
  const href = input.trim();
  if (!href) return href;
  if (/^(?:data:|blob:|https?:|\/\/)/iu.test(href)) return href;
  return './' + href.replace(/^(?:\.\/)+/u, '').replace(/^\/+/u, '');
};

const parseSize = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(12, Math.min(64, parsed)) : null;
};

const iconSizeFrom = (symbol: JsonRecord): number => {
  const width = parseSize(symbol.width);
  const height = parseSize(symbol.height);
  return Math.max(width ?? 0, height ?? 0, SCENE_ICON_SIZE_PX);
};

const serializeSymbol = (value: unknown): JsonRecord | null => asRecord(toJSONValue(value));

const createSceneIconSymbol = (input: unknown): JsonRecord | null => {
  const symbol = serializeSymbol(input);
  if (!symbol) return null;

  const url = typeof symbol.url === 'string' ? symbol.url.trim() : '';
  if (url && /\.svg(?:[?#].*)?$/iu.test(url)) {
    return {
      type: 'point-3d',
      symbolLayers: [{
        type: 'icon',
        resource: { href: normalizeSceneIconHref(url) },
        size: iconSizeFrom(symbol),
        anchor: 'bottom',
        outline: { color: [255, 255, 255, 0.96], size: 1.25 },
        // Keep service icons recognizable even where the city model occludes them.
        occludedVisibility: { mode: 'visible' },
      }],
      verticalOffset: { ...SCENE_ICON_VERTICAL_OFFSET },
      callout: { ...SCENE_ICON_CALLOUT, border: { ...SCENE_ICON_CALLOUT.border } },
    };
  }

  return null;
};

/**
 * Rebuilds an SVG UniqueValueRenderer using native 3D icon layers. The source
 * renderer is not mutated, so it can be restored byte-for-byte in 2D mode.
 */
export const createSceneIconRenderer = (input: unknown): JsonRecord | null => {
  const renderer = asRecord(toJSONValue(input));
  const rendererType = String(renderer?.type ?? '').toLocaleLowerCase('en-US').replace(/[^a-z]/gu, '');
  // The SDK instance uses "unique-value"; its web-map JSON serialization can
  // use "uniqueValue". Normalize both contracts before converting symbols.
  if (!renderer || rendererType !== 'uniquevalue') return null;

  const infos = readCollection(renderer.uniqueValueInfos)
    .map((candidate): IconRendererInfo | null => {
      const record = asRecord(toJSONValue(candidate));
      if (!record) return null;
      const symbol = createSceneIconSymbol(record.symbol);
      return symbol ? { ...record, symbol } : null;
    })
    .filter((entry): entry is IconRendererInfo => entry !== null);

  if (infos.length === 0) return null;

  return {
    ...renderer,
    type: 'unique-value',
    uniqueValueInfos: infos,
  };
};

const collectionItems = (collection: SceneIconLayerCollectionLike | undefined): readonly SceneIconLayerLike[] =>
  collection
    ? readCollection(collection.items ?? collection.toArray?.())
      .map((item) => asRecord(item) as SceneIconLayerLike | null)
      .filter((item): item is SceneIconLayerLike => item !== null)
    : [];

const findLayer = (map: SceneIconMapLike): SceneIconLayerLike | null => {
  const found = map.findLayerById?.(KENT_REHBERI_ICON_LAYER_ID);
  if (found) return found;
  for (const collection of [map.allLayers, map.layers]) {
    const layer = collectionItems(collection).find((candidate) => candidate.id === KENT_REHBERI_ICON_LAYER_ID);
    if (layer) return layer;
  }
  return null;
};

/**
 * Keeps the existing GeoJSON layer's 2D renderer intact and adds a lightweight
 * GraphicsLayer of elevated 3D icons only while SceneView is active.
 */
export class SceneIconPresentationRuntime {
  readonly #onError: (error: unknown, source: string) => void;
  readonly #loadGraphicsModules: LoadSceneIconGraphicsModules;
  #map: SceneIconMapLike | null = null;
  #active = false;
  #snapshot: LayerPresentationSnapshot | null = null;
  #handles: RemovableHandle[] = [];
  #generation = 0;

  constructor(options: SceneIconPresentationRuntimeOptions = {}) {
    this.#loadGraphicsModules = options.loadGraphicsModules ?? defaultLoadGraphicsModules;
    this.#onError = options.onError ?? ((error, source) => {
      runtimeDiagnostics.captureError(error, { source }, 'warn');
    });
  }

  async activate(map: SceneIconMapLike): Promise<void> {
    if (!map || typeof map.add !== 'function' || typeof map.remove !== 'function') {
      throw new TypeError('3B Kent Rehberi ikonları için harita add/remove desteği gereklidir.');
    }
    if (this.#map && this.#map !== map) this.dispose();
    this.#map = map;
    this.#active = true;
    this.#attachCollectionWatchers();
    await this.#apply(findLayer(map));
  }

  deactivate(): void {
    this.#active = false;
    this.#generation += 1;
    this.#removeWatchers();
    this.#restoreSnapshot();
  }

  dispose(): void {
    this.deactivate();
    this.#map = null;
    this.#snapshot = null;
  }

  #attachCollectionWatchers(): void {
    if (this.#handles.length > 0) return;
    const handleLayerEvent = (event: { item?: unknown }): void => {
      const item = asRecord(event?.item);
      if (!this.#active || item?.id !== KENT_REHBERI_ICON_LAYER_ID) return;
      void this.#apply(item as SceneIconLayerLike);
    };

    for (const collection of [this.#map?.layers, this.#map?.allLayers]) {
      if (typeof collection?.on !== 'function') continue;
      for (const eventName of ['after-add', 'after-remove'] as const) {
        try {
          const handle = collection.on(eventName, (event) => {
            const item = asRecord(event?.item);
            if (eventName === 'after-remove' && this.#snapshot?.layer === item) {
              this.#generation += 1;
              this.#restoreSnapshot();
              return;
            }
            if (eventName === 'after-add') handleLayerEvent(event);
          });
          if (handle) this.#handles.push(handle);
        } catch (error) {
          this.#report(error, 'gis.scene-icons.collection-watch');
        }
      }
    }
  }

  #removeWatchers(): void {
    for (const handle of this.#handles.splice(0)) {
      try { handle.remove?.(); } catch (error) {
        this.#report(error, 'gis.scene-icons.remove-watch');
      }
    }
  }

  async #apply(layer: SceneIconLayerLike | null): Promise<void> {
    if (!this.#active || !layer || layer.id !== KENT_REHBERI_ICON_LAYER_ID) return;
    if (this.#snapshot?.layer === layer) return;
    this.#restoreSnapshot();
    const generation = ++this.#generation;
    try {
      const sceneRenderer = createSceneIconRenderer(layer.renderer);
      const rendererInfos = readCollection(sceneRenderer?.uniqueValueInfos)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonRecord => entry !== null);
      if (!sceneRenderer || rendererInfos.length === 0) return;
      if (typeof layer.queryFeatures !== 'function') {
        throw new TypeError('Kent Rehberi ikon katmanı özelliklerini sorgulayamıyor.');
      }

      const [Graphic, GraphicsLayer] = await this.#loadGraphicsModules();
      const query = asRecord(layer.createQuery?.()) ?? {};
      query.where = '1=1';
      query.outFields = ['*'];
      query.returnGeometry = true;
      const result = await layer.queryFeatures(query);
      if (generation !== this.#generation || !this.#active || this.#map === null) return;

      const symbols = new Map<unknown, unknown>(
        rendererInfos.map((info) => [info.value, info.symbol]),
      );
      const graphics = (result.features ?? []).flatMap((feature) => {
        const symbol = symbols.get(feature.attributes?.iconKey);
        if (!feature.geometry || !symbol) return [];
        const properties: Record<string, unknown> = {
          geometry: feature.geometry,
          attributes: feature.attributes,
          symbol,
        };
        if (layer.popupTemplate) properties.popupTemplate = layer.popupTemplate;
        return [new Graphic(properties)];
      });
      if (graphics.length === 0) return;

      const overlay = new GraphicsLayer({
        id: SCENE_ICON_OVERLAY_LAYER_ID,
        title: 'Kent Rehberi 3B ikonları',
        listMode: 'hide',
        opacity: SCENE_ICON_LAYER_OPACITY,
        graphics,
      });
      if (generation !== this.#generation || !this.#active || this.#map === null) {
        overlay.destroy?.();
        return;
      }

      try {
        const map = this.#map;
        if (!map || typeof map.add !== 'function') {
          throw new TypeError('3B Kent Rehberi ikon katmanı haritaya eklenemiyor.');
        }
        map.add(overlay, 0);
      } catch (error) {
        try { overlay.destroy?.(); } catch (destroyError) {
          this.#report(destroyError, 'gis.scene-icons.destroy-after-add-failure');
        }
        throw error;
      }
      this.#snapshot = { layer, visible: layer.visible, overlay };
      layer.visible = false;
    } catch (error) {
      if (generation === this.#generation) this.#report(error, 'gis.scene-icons.create-overlay');
    }
  }

  #restoreSnapshot(): void {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    this.#snapshot = null;
    try {
      this.#map?.remove?.(snapshot.overlay);
    } catch (error) {
      this.#report(error, 'gis.scene-icons.remove-overlay');
    }
    try {
      snapshot.layer.visible = snapshot.visible ?? true;
    } catch (error) {
      this.#report(error, 'gis.scene-icons.restore-visibility');
    }
    try {
      snapshot.overlay.destroy?.();
    } catch (error) {
      this.#report(error, 'gis.scene-icons.destroy-overlay');
    }
  }

  #report(error: unknown, source: string): void {
    try {
      this.#onError(error, source);
    } catch (observerError) {
      runtimeDiagnostics.captureError(observerError, { source: source + '.observer-failed' }, 'warn');
    }
  }
}

export const createSceneIconPresentationRuntime = (): SceneIconPresentationRuntime =>
  new SceneIconPresentationRuntime();
