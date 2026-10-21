import { describe, expect, it, vi } from 'vitest';
import iconEntries from './iconRegistry.json';
import {
  createSceneIconRenderer,
  KENT_REHBERI_ICON_LAYER_ID,
  normalizeSceneIconHref,
  type SceneIconGraphicConstructor,
  type SceneIconGraphicsLayerConstructor,
  type LoadSceneIconGraphicsModules,
  SCENE_ICON_GROUND_OFFSET_METERS,
  SCENE_ICON_LAYER_OPACITY,
  SceneIconPresentationRuntime,
} from './sceneIconPresentationRuntime';

const sourceRenderer = () => ({
  type: 'unique-value',
  field: 'iconKey',
  uniqueValueInfos: [
    {
      value: 'kutuphane',
      label: 'Kütüphane',
      symbol: {
        type: 'picture-marker',
        url: 'images/icons/map/ABB/kutuphane.svg',
        width: '28px',
        height: '32px',
      },
    },
    {
      value: 'otobus',
      symbol: {
        type: 'picture-marker',
        url: '/images/icons/map/EGO/otobusduraklari.svg',
        width: '28px',
        height: '32px',
      },
    },
  ],
  defaultSymbol: { type: 'simple-marker', color: [0, 0, 0, 0], size: 1 },
});

const createCollection = () => {
  const listeners = new Map<string, Set<(event: { item?: unknown }) => void>>();
  const items: Array<Record<string, unknown>> = [];
  return {
    items,
    on: vi.fn((eventName: string, callback: (event: { item?: unknown }) => void) => {
      const handlers = listeners.get(eventName) ?? new Set();
      handlers.add(callback);
      listeners.set(eventName, handlers);
      return { remove: () => handlers.delete(callback) };
    }),
    emit: (eventName: string, item: unknown) => {
      for (const callback of listeners.get(eventName) ?? []) callback({ item });
    },
  };
};

class FakeGraphic {
  constructor(readonly properties: Record<string, unknown>) {}
}

class FakeGraphicsLayer {
  readonly destroy = vi.fn();
  constructor(readonly properties: Record<string, unknown>) {}
}

const loadGraphicsModules: LoadSceneIconGraphicsModules = async (): Promise<
  readonly [SceneIconGraphicConstructor, SceneIconGraphicsLayerConstructor]
> => [FakeGraphic, FakeGraphicsLayer];

describe('3D SVG icon pins', () => {
  it('converts every registered SVG unique-value marker to a 50m elevated 3D icon with a callout', () => {
    const renderer = createSceneIconRenderer(sourceRenderer());
    expect(renderer?.type).toBe('unique-value');

    const infos = renderer?.uniqueValueInfos as Array<{
      value: string;
      symbol: {
        type?: string;
        symbolLayers?: Array<{ type?: string; size?: number; anchor?: string; resource?: { href?: string }; outline?: unknown; occludedVisibility?: unknown }>;
        verticalOffset?: { minWorldLength?: number; maxWorldLength?: number; screenLength?: number };
        callout?: { type?: string };
      };
    }>;

    expect(infos).toHaveLength(2);
    for (const info of infos) {
      expect(info.symbol.type).toBe('point-3d');
      expect(info.symbol.verticalOffset).toEqual({
        screenLength: SCENE_ICON_GROUND_OFFSET_METERS,
        minWorldLength: SCENE_ICON_GROUND_OFFSET_METERS,
        maxWorldLength: SCENE_ICON_GROUND_OFFSET_METERS,
      });
      expect(info.symbol.callout?.type).toBe('line');
      expect(info.symbol.symbolLayers?.[0]).toMatchObject({
        type: 'icon',
        size: 36,
        anchor: 'bottom',
        occludedVisibility: { mode: 'visible' },
      });
      expect(info.symbol.symbolLayers?.[0]?.resource?.href).toMatch(/^\.\//u);
    }
    expect(infos[0]?.symbol.symbolLayers?.[0]?.resource?.href).toBe('./images/icons/map/ABB/kutuphane.svg');
    expect(infos[1]?.symbol.symbolLayers?.[0]?.resource?.href).toBe('./images/icons/map/EGO/otobusduraklari.svg');
    expect(renderer?.defaultSymbol).toEqual({ type: 'simple-marker', color: [0, 0, 0, 0], size: 1 });
    expect(sourceRenderer().uniqueValueInfos[0]?.symbol.type).toBe('picture-marker');
  });

  it('converts every SVG registered for Kent Rehberi map icons', () => {
    const svgEntries = (iconEntries as readonly { id?: string; icon?: string; url?: string; src?: string }[])
      .flatMap((entry) => {
        const url = [entry.icon, entry.url, entry.src].find(
          (candidate): candidate is string => typeof candidate === 'string' && /\.svg(?:[?#].*)?$/iu.test(candidate),
        );
        return entry.id && url ? [{ value: entry.id, symbol: { type: 'picture-marker', url, width: '28px', height: '32px' } }] : [];
      });
    const renderer = createSceneIconRenderer({
      type: 'unique-value',
      field: 'iconKey',
      uniqueValueInfos: svgEntries,
      defaultSymbol: { type: 'simple-marker', color: [0, 0, 0, 0], size: 1 },
    });
    const converted = renderer?.uniqueValueInfos as Array<{ value: string; symbol: { type: string; verticalOffset?: { minWorldLength?: number; maxWorldLength?: number } } }>;

    expect(converted).toHaveLength(svgEntries.length);
    expect(converted.every((entry) => entry.symbol.type === 'point-3d')).toBe(true);
    expect(converted.every((entry) =>
      entry.symbol.verticalOffset?.minWorldLength === 50
      && entry.symbol.verticalOffset.maxWorldLength === 50)).toBe(true);
  });

  it('accepts the ArcGIS web-map JSON uniqueValue spelling as well as the SDK unique-value spelling', () => {
    const serializedRenderer = { ...sourceRenderer(), type: 'uniqueValue' };
    const renderer = createSceneIconRenderer(serializedRenderer);
    const infos = renderer?.uniqueValueInfos as Array<{ symbol: { type?: string } }>;
    expect(renderer?.type).toBe('unique-value');
    expect(infos).toHaveLength(2);
    expect(infos.every((entry) => entry.symbol.type === 'point-3d')).toBe(true);
  });

  it('normalizes subpath-safe SVG URLs without altering absolute URLs', () => {
    expect(normalizeSceneIconHref('images/icons/map/ABB/parklar.svg')).toBe('./images/icons/map/ABB/parklar.svg');
    expect(normalizeSceneIconHref('/images/icons/map/ABB/parklar.svg')).toBe('./images/icons/map/ABB/parklar.svg');
    expect(normalizeSceneIconHref('./images/icons/map/ABB/parklar.svg')).toBe('./images/icons/map/ABB/parklar.svg');
    expect(normalizeSceneIconHref('https://example.test/icon.svg')).toBe('https://example.test/icon.svg');
  });

  it('adds elevated SVG graphics without mutating the 2D source layer and restores it on deactivation', async () => {
    const original = sourceRenderer();
    const layer = {
      id: KENT_REHBERI_ICON_LAYER_ID,
      renderer: original,
      visible: true,
      createQuery: vi.fn(() => ({})),
      queryFeatures: vi.fn(async () => ({
        features: [
          { geometry: { longitude: 32.85, latitude: 39.93 }, attributes: { iconKey: 'kutuphane' } },
          { geometry: { longitude: 32.86, latitude: 39.94 }, attributes: { iconKey: 'otobus' } },
        ],
      })),
    };
    const items: unknown[] = [layer];
    const map = {
      layers: { items },
      add: vi.fn((overlay: unknown) => { items.unshift(overlay); }),
      remove: vi.fn((overlay: unknown) => {
        const index = items.indexOf(overlay);
        if (index >= 0) items.splice(index, 1);
      }),
    };
    const runtime = new SceneIconPresentationRuntime({ loadGraphicsModules });

    await runtime.activate(map);
    const overlay = items[0] as FakeGraphicsLayer;
    const graphics = overlay.properties.graphics as FakeGraphic[];
    expect(layer.renderer).toBe(original);
    expect(layer.visible).toBe(false);
    expect(overlay.properties).toMatchObject({
      id: 'kent-rehberi-3d-icon-overlay',
      listMode: 'hide',
      opacity: SCENE_ICON_LAYER_OPACITY,
    });
    expect(graphics).toHaveLength(2);
    expect(graphics.map((graphic) =>
      (graphic.properties.symbol as { type?: string; verticalOffset?: { minWorldLength?: number } }).type))
      .toEqual(['point-3d', 'point-3d']);
    const firstGraphic = graphics[0];
    if (!firstGraphic) throw new Error('Expected an elevated 3D icon graphic.');
    expect((firstGraphic.properties.symbol as { verticalOffset?: { minWorldLength?: number } })
      .verticalOffset?.minWorldLength).toBe(SCENE_ICON_GROUND_OFFSET_METERS);

    runtime.deactivate();
    expect(layer.visible).toBe(true);
    expect(map.remove).toHaveBeenCalledWith(overlay);
    expect(overlay.destroy).toHaveBeenCalledTimes(1);
    expect(items).toEqual([layer]);

    await runtime.activate(map);
    expect(layer.visible).toBe(false);
    runtime.dispose();
    expect(layer.visible).toBe(true);
  });

  it('creates the overlay when the POI layer is attached after the 3D scene activates', async () => {
    const collection = createCollection();
    const map = {
      layers: collection,
      add: vi.fn((overlay: unknown) => { collection.items.unshift(overlay as Record<string, unknown>); }),
      remove: vi.fn((overlay: unknown) => {
        const index = collection.items.indexOf(overlay as Record<string, unknown>);
        if (index >= 0) collection.items.splice(index, 1);
      }),
    };
    const runtime = new SceneIconPresentationRuntime({ loadGraphicsModules });
    await runtime.activate(map);
    const original = sourceRenderer();
    const layer = {
      id: KENT_REHBERI_ICON_LAYER_ID,
      renderer: original,
      visible: true,
      createQuery: vi.fn(() => ({})),
      queryFeatures: vi.fn(async () => ({
        features: [{ geometry: { longitude: 32.85, latitude: 39.93 }, attributes: { iconKey: 'kutuphane' } }],
      })),
    };

    collection.items.push(layer);
    collection.emit('after-add', layer);

    await vi.waitFor(() => expect(map.add).toHaveBeenCalledTimes(1));
    expect(layer.renderer).toBe(original);
    expect(layer.visible).toBe(false);
    runtime.deactivate();
    expect(layer.visible).toBe(true);
    expect(map.remove).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('leaves non-unique-value renderers and non-SVG icon entries unchanged', () => {
    expect(createSceneIconRenderer({ type: 'simple', symbol: { type: 'simple-marker' } })).toBeNull();
    const renderer = createSceneIconRenderer({
      type: 'unique-value',
      field: 'iconKey',
      uniqueValueInfos: [{ value: 'point', symbol: { type: 'simple-marker', color: [255, 0, 0, 1] } }],
    });
    expect(renderer).toBeNull();
  });
});
