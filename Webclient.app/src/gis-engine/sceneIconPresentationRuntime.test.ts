import { describe, expect, it, vi } from 'vitest';
import iconEntries from './iconRegistry.json';
import {
  createSceneIconRenderer,
  KENT_REHBERI_ICON_LAYER_ID,
  normalizeSceneIconHref,
  SCENE_ICON_GROUND_OFFSET_METERS,
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
  const items: Array<{ id?: string; renderer?: unknown; elevationInfo?: unknown }> = [];
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

  it('normalizes subpath-safe SVG URLs without altering absolute URLs', () => {
    expect(normalizeSceneIconHref('images/icons/map/ABB/parklar.svg')).toBe('./images/icons/map/ABB/parklar.svg');
    expect(normalizeSceneIconHref('/images/icons/map/ABB/parklar.svg')).toBe('./images/icons/map/ABB/parklar.svg');
    expect(normalizeSceneIconHref('./images/icons/map/ABB/parklar.svg')).toBe('./images/icons/map/ABB/parklar.svg');
    expect(normalizeSceneIconHref('https://example.test/icon.svg')).toBe('https://example.test/icon.svg');
  });

  it('switches the current layer renderer and restores the original renderer and elevation info', () => {
    const original = sourceRenderer();
    const layer = { id: KENT_REHBERI_ICON_LAYER_ID, renderer: original, elevationInfo: { mode: 'on-the-ground' } };
    const map = { layers: { items: [layer] } };
    const runtime = new SceneIconPresentationRuntime();

    runtime.activate(map);
    expect((layer.renderer as { uniqueValueInfos: Array<{ symbol: { type: string } }> }).uniqueValueInfos[0]?.symbol.type)
      .toBe('point-3d');
    expect(layer.elevationInfo).toEqual({ mode: 'relative-to-ground', offset: 0 });

    runtime.deactivate();
    expect(layer.renderer).toBe(original);
    expect(layer.elevationInfo).toEqual({ mode: 'on-the-ground' });

    runtime.activate(map);
    expect((layer.renderer as { uniqueValueInfos: Array<{ symbol: { type: string } }> }).uniqueValueInfos[0]?.symbol.type)
      .toBe('point-3d');
    runtime.dispose();
    expect(layer.renderer).toBe(original);
  });

  it('applies the 3D renderer when the POI layer is attached after the 3D scene activates', () => {
    const collection = createCollection();
    const map = { layers: collection };
    const runtime = new SceneIconPresentationRuntime();
    runtime.activate(map);
    const original = sourceRenderer();
    const layer = { id: KENT_REHBERI_ICON_LAYER_ID, renderer: original, elevationInfo: undefined };

    collection.items.push(layer);
    collection.emit('after-add', layer);

    expect((layer.renderer as { uniqueValueInfos: Array<{ symbol: { type: string } }> }).uniqueValueInfos[0]?.symbol.type)
      .toBe('point-3d');
    runtime.deactivate();
    expect(layer.renderer).toBe(original);
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
