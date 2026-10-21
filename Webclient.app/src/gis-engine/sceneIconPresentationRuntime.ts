import { runtimeDiagnostics } from '../platform/runtime/runtimeDiagnostics';

export const KENT_REHBERI_ICON_LAYER_ID = 'kent-rehberi-postgis';
export const SCENE_ICON_GROUND_OFFSET_METERS = 50;

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
  elevationInfo?: unknown;
}
interface SceneIconLayerCollectionLike {
  readonly items?: readonly SceneIconLayerLike[];
  toArray?: () => readonly SceneIconLayerLike[];
  on?: (eventName: 'after-add' | 'after-remove', callback: (event: { item?: unknown }) => void) => RemovableHandle;
}
interface SceneIconMapLike {
  readonly layers?: SceneIconLayerCollectionLike;
  readonly allLayers?: SceneIconLayerCollectionLike;
  findLayerById?: (id: string) => SceneIconLayerLike | null | undefined;
}
interface LayerPresentationSnapshot {
  readonly layer: SceneIconLayerLike;
  readonly renderer: unknown;
  readonly elevationInfo: unknown;
  readonly sceneRenderer: JsonRecord;
}
export interface SceneIconPresentationRuntimeOptions {
  readonly onError?: (error: unknown, source: string) => void;
}

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
  if (!renderer || String(renderer.type ?? '').toLocaleLowerCase('en-US') !== 'unique-value') {
    return null;
  }

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
    uniqueValueInfos: infos,
  };
};

const collectionItems = (collection: SceneIconLayerCollectionLike | undefined): readonly SceneIconLayerLike[] =>
  collection ? readCollection(collection.items ?? collection.toArray?.()) as readonly SceneIconLayerLike[] : [];

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
 * Switches the existing Kent Rehberi SVG renderer in-place while SceneView is
 * active. It does not fetch or duplicate the GeoJSON layer. A collection
 * watcher handles cases where the data layer arrives after 3D activation.
 */
export class SceneIconPresentationRuntime {
  readonly #onError: (error: unknown, source: string) => void;
  #map: SceneIconMapLike | null = null;
  #active = false;
  #snapshot: LayerPresentationSnapshot | null = null;
  #handles: RemovableHandle[] = [];

  constructor(options: SceneIconPresentationRuntimeOptions = {}) {
    this.#onError = options.onError ?? ((error, source) => {
      runtimeDiagnostics.captureError(error, { source }, 'warn');
    });
  }

  activate(map: SceneIconMapLike): void {
    if (!map) return;
    if (this.#map && this.#map !== map) this.dispose();
    this.#map = map;
    this.#active = true;
    this.#attachCollectionWatchers();
    this.#apply(findLayer(map));
  }

  deactivate(): void {
    this.#active = false;
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
      this.#apply(item as SceneIconLayerLike);
    };

    for (const collection of [this.#map?.layers, this.#map?.allLayers]) {
      if (typeof collection?.on !== 'function') continue;
      for (const eventName of ['after-add', 'after-remove'] as const) {
        try {
          const handle = collection.on(eventName, (event) => {
            const item = asRecord(event?.item);
            if (eventName === 'after-remove' && this.#snapshot?.layer === item) {
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

  #apply(layer: SceneIconLayerLike | null): void {
    if (!this.#active || !layer || layer.id !== KENT_REHBERI_ICON_LAYER_ID) return;
    if (this.#snapshot?.layer !== layer) {
      this.#restoreSnapshot();
      const sceneRenderer = createSceneIconRenderer(layer.renderer);
      if (!sceneRenderer) return;
      this.#snapshot = {
        layer,
        renderer: layer.renderer,
        elevationInfo: layer.elevationInfo,
        sceneRenderer,
      };
    }

    const snapshot = this.#snapshot;
    if (!snapshot) return;
    try {
      layer.renderer = snapshot.sceneRenderer;
      layer.elevationInfo = { mode: 'relative-to-ground', offset: 0 };
    } catch (error) {
      this.#report(error, 'gis.scene-icons.apply-renderer');
      this.#restoreSnapshot();
    }
  }

  #restoreSnapshot(): void {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    try {
      snapshot.layer.renderer = snapshot.renderer;
      snapshot.layer.elevationInfo = snapshot.elevationInfo;
    } catch (error) {
      this.#report(error, 'gis.scene-icons.restore-renderer');
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
