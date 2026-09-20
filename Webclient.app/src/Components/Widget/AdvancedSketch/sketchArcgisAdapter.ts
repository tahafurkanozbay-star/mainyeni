import { loadArcgisModules } from '../../../gis-engine/arcgisModuleRuntime';
import type {
  SketchGraphicSnapshot,
  SketchStyleState,
  SketchTool,
  SketchViewAdapter,
} from './sketchContracts';
import { createGraphicSnapshot } from './sketchGeometryRuntime';

interface ArcgisMapLike {
  readonly add?: (layer: unknown) => void;
  readonly remove?: (layer: unknown) => void;
}

interface ArcgisViewLike {
  readonly map?: ArcgisMapLike;
}

interface ArcgisCollectionLike {
  readonly toArray?: () => readonly unknown[];
  readonly find?: (callback: (item: unknown) => boolean) => unknown;
}

interface GraphicsLayerLike {
  readonly id?: string;
  readonly graphics?: ArcgisCollectionLike;
  readonly add?: (graphic: unknown) => void;
  readonly addMany?: (graphics: readonly unknown[]) => void;
  readonly remove?: (graphic: unknown) => void;
  readonly removeAll?: () => void;
  readonly destroy?: () => void;
}

interface SketchEventHandle {
  readonly remove?: () => void;
}

interface SketchViewModelLike {
  pointSymbol?: unknown;
  polylineSymbol?: unknown;
  polygonSymbol?: unknown;
  readonly create?: (tool: string, options?: Readonly<Record<string, unknown>>) => void;
  readonly cancel?: () => void;
  readonly destroy?: () => void;
  readonly on?: (name: string, callback: (event: unknown) => void) => SketchEventHandle;
}

interface Constructor<T> {
  new (options?: Readonly<Record<string, unknown>>): T;
}

export interface ArcgisSketchAdapterOptions {
  readonly layerId?: string;
  readonly onGraphicCreated?: (graphic: SketchGraphicSnapshot) => void;
  readonly onGraphicsUpdated?: (graphics: readonly SketchGraphicSnapshot[]) => void;
  readonly createGraphicId?: () => string;
}

export interface ArcgisSketchAdapterHandle {
  readonly adapter: SketchViewAdapter;
  readonly layerId: string;
  readonly destroy: () => Promise<void>;
}

const toRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : Object.freeze({});

const readView = (value: unknown): ArcgisViewLike => toRecord(value) as ArcgisViewLike;

const readGraphicParts = (value: unknown): {
  readonly id: string;
  readonly geometry: unknown;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly symbol: unknown;
} => {
  const record = toRecord(value);
  const attributes = toRecord(record.attributes);
  const fallbackId = typeof attributes.__sketchId === 'string' ? attributes.__sketchId : '';
  return Object.freeze({
    id: typeof record.id === 'string' ? record.id : fallbackId,
    geometry: record.geometry,
    attributes,
    symbol: record.symbol,
  });
};

const toGraphicsArray = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const collection = toRecord(value) as ArcgisCollectionLike;
  const array = collection.toArray?.();
  return Array.isArray(array) ? array : Object.freeze([]);
};

const uniqueIdFactory = (): (() => string) => {
  let sequence = 0;
  return () => `advanced-sketch-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
};

const makeSnapshot = (
  graphic: unknown,
  createId: () => string,
): SketchGraphicSnapshot => {
  const parts = readGraphicParts(graphic);
  return createGraphicSnapshot({
    id: parts.id || createId(),
    geometry: parts.geometry,
    attributes: parts.attributes,
    symbol: parts.symbol,
  });
};

const setSymbols = (
  sketchViewModel: SketchViewModelLike,
  style: SketchStyleState,
): void => {
  sketchViewModel.pointSymbol = style.point;
  sketchViewModel.polylineSymbol = style.line;
  sketchViewModel.polygonSymbol = style.polygon;
};

export const createArcgisSketchAdapter = async (
  viewInput: unknown,
  options: ArcgisSketchAdapterOptions = {},
): Promise<ArcgisSketchAdapterHandle> => {
  const view = readView(viewInput);
  if (!view.map?.add || !view.map.remove) {
    throw new TypeError('Advanced Sketch requires an initialized ArcGIS map view.');
  }

  const [SketchViewModelModule, GraphicsLayerModule, GraphicModule] = await loadArcgisModules<readonly [
    Constructor<SketchViewModelLike>,
    Constructor<GraphicsLayerLike>,
    Constructor<object>,
  ]>([
    'esri/widgets/Sketch/SketchViewModel',
    'esri/layers/GraphicsLayer',
    'esri/Graphic',
  ]);

  const layerId = String(options.layerId ?? 'advanced-sketch-runtime').trim() || 'advanced-sketch-runtime';
  const createId = options.createGraphicId ?? uniqueIdFactory();
  const layer = new GraphicsLayerModule({ id: layerId });
  view.map.add(layer);

  const sketchViewModel = new SketchViewModelModule({
    layer,
    view: viewInput,
  });

  const handles: SketchEventHandle[] = [];
  let destroyed = false;

  const toArcgisGraphic = (graphic: SketchGraphicSnapshot): object => new GraphicModule({
    geometry: graphic.geometry.payload,
    attributes: {
      ...graphic.attributes,
      __sketchId: graphic.id,
      __sketchCreatedAt: graphic.createdAt,
      __sketchUpdatedAt: graphic.updatedAt,
    },
    ...(graphic.symbol ? { symbol: graphic.symbol } : {}),
  });

  const createdHandle = sketchViewModel.on?.('create', (eventInput) => {
    if (destroyed) return;
    const event = toRecord(eventInput);
    if (event.state !== 'complete' || !event.graphic) return;
    try {
      options.onGraphicCreated?.(makeSnapshot(event.graphic, createId));
    } catch (error) {
      globalThis.reportError?.(error);
    }
  });
  if (createdHandle) handles.push(createdHandle);

  const updatedHandle = sketchViewModel.on?.('update', (eventInput) => {
    if (destroyed) return;
    const event = toRecord(eventInput);
    if (event.state !== 'complete') return;
    try {
      const allGraphics = layer.graphics ?? event.graphics;
      const snapshots = toGraphicsArray(allGraphics).map((graphic) => makeSnapshot(graphic, createId));
      options.onGraphicsUpdated?.(Object.freeze(snapshots));
    } catch (error) {
      globalThis.reportError?.(error);
    }
  });
  if (updatedHandle) handles.push(updatedHandle);

  const adapter: SketchViewAdapter = Object.freeze({
    addGraphic: (graphic) => {
      if (destroyed) throw new Error('ArcGIS sketch adapter is destroyed.');
      layer.add?.(toArcgisGraphic(graphic));
    },

    replaceGraphics: (graphics) => {
      if (destroyed) throw new Error('ArcGIS sketch adapter is destroyed.');
      layer.removeAll?.();
      const converted = graphics.map(toArcgisGraphic);
      if (converted.length > 0) layer.addMany?.(converted);
    },

    removeGraphic: (id) => {
      if (destroyed) throw new Error('ArcGIS sketch adapter is destroyed.');
      const graphic = layer.graphics?.find?.((item) => {
        const parts = readGraphicParts(item);
        return parts.id === id || parts.attributes.__sketchId === id;
      });
      if (graphic) layer.remove?.(graphic);
    },

    clearGraphics: () => {
      if (destroyed) throw new Error('ArcGIS sketch adapter is destroyed.');
      layer.removeAll?.();
    },

    beginCreate: (tool: Exclude<SketchTool, 'move' | 'clear'>, style) => {
      if (destroyed) throw new Error('ArcGIS sketch adapter is destroyed.');
      setSymbols(sketchViewModel, style);
      sketchViewModel.create?.(tool, { mode: tool === 'freehand' ? 'freehand' : 'click' });
    },

    cancelCreate: () => {
      if (destroyed) return;
      sketchViewModel.cancel?.();
    },

    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      for (const handle of handles.splice(0, handles.length)) handle.remove?.();
      sketchViewModel.cancel?.();
      sketchViewModel.destroy?.();
      layer.removeAll?.();
      view.map?.remove?.(layer);
      layer.destroy?.();
    },
  });

  return Object.freeze({
    adapter,
    layerId,
    destroy: adapter.destroy,
  });
};
