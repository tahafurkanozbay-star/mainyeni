import Graphic from '@arcgis/core/Graphic.js';
import type Geometry from '@arcgis/core/geometry/Geometry.js';
import Polygon from '@arcgis/core/geometry/Polygon.js';
import PictureMarkerSymbol from '@arcgis/core/symbols/PictureMarkerSymbol.js';
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol.js';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol.js';
import type Symbol from '@arcgis/core/symbols/Symbol.js';
import type MapView from '@arcgis/core/views/MapView.js';

import {
  buildClosedPolygonRing,
  type XYPointInput,
} from '../../runtime/adminGeometryRuntime';

export type GraphicCallback = (graphic: Graphic | null) => void;
export type GraphicsCallback = (graphics: readonly Graphic[]) => void;

const createLineSymbol = (): SimpleLineSymbol => new SimpleLineSymbol({
  color: [78, 229, 255, 1],
  width: 4,
});

const createDefaultSymbol = (geometry: Geometry): Symbol | null => {
  switch (geometry.type) {
    case 'point':
    case 'multipoint':
      return new PictureMarkerSymbol({
        url: 'images/pictureMarker.png',
        width: 32,
        height: 32,
      });
    case 'polyline':
      return createLineSymbol();
    case 'polygon':
    case 'extent': {
      const fill = new SimpleFillSymbol({
        color: [0, 0, 0, 0],
      });
      fill.set('outline', createLineSymbol());
      return fill;
    }
    default:
      return null;
  }
};

const createGraphic = (
  geometry: Geometry | null | undefined,
  symbol?: Symbol | null,
): Graphic | null => {
  if (!geometry) return null;
  const resolvedSymbol = symbol ?? createDefaultSymbol(geometry);
  if (!resolvedSymbol) return null;

  const graphic = new Graphic();
  graphic.geometry = geometry;
  graphic.set('symbol', resolvedSymbol);
  return graphic;
};

const observeGoTo = (operation: Promise<void>): void => {
  void operation.catch(() => undefined);
};

export function RemoveGraphics(
  mapView: MapView,
  graphics: Graphic | readonly Graphic[] | null | undefined,
): void {
  if (!graphics) return;

  if (graphics instanceof Graphic) {
    mapView.graphics.remove(graphics);
    return;
  }

  mapView.graphics.removeMany([...graphics]);
}

export function AddGraphics(
  mapView: MapView,
  graphic: Graphic,
): Graphic {
  mapView.graphics.add(graphic);
  return graphic;
}

export function ZoomToGeometry(
  mapView: MapView,
  geometry: Geometry,
  zoomLevel: number | null | undefined,
  callback: GraphicCallback,
): void {
  const graphic = createGraphic(geometry);
  if (!graphic) {
    callback(null);
    return;
  }

  AddGraphics(mapView, graphic);
  if (zoomLevel != null) {
    mapView.zoom = zoomLevel;
  }
  observeGoTo(mapView.goTo(graphic));
  callback(graphic);
}

export function CreateGraphicFromPicture(
  geometry: Geometry | null | undefined,
  pictureUrl: string,
  width: number,
  height: number,
  angle: number,
  callback: GraphicCallback,
): void {
  if (!geometry || !pictureUrl) {
    callback(null);
    return;
  }

  const graphic = new Graphic();
  graphic.geometry = geometry;
  graphic.set('symbol', new PictureMarkerSymbol({
    url: pictureUrl,
    width,
    height,
    angle,
  }));
  callback(graphic);
}

export function CreateGraphicFromGeometry(
  geometry: Geometry | null | undefined,
  symbol: Symbol | null | undefined,
  callback: GraphicCallback,
): void {
  callback(createGraphic(geometry, symbol));
}

export function ZoomToGeometries(
  mapView: MapView,
  geometries: readonly Geometry[],
  zoomLevel: number | null | undefined,
  callback: GraphicsCallback,
): void {
  const graphics = geometries
    .map((geometry) => createGraphic(geometry))
    .filter((graphic): graphic is Graphic => graphic !== null);

  if (graphics.length === 0) {
    callback(Object.freeze([]));
    return;
  }

  mapView.graphics.addMany(graphics);
  if (zoomLevel != null) {
    mapView.zoom = zoomLevel;
  }
  observeGoTo(mapView.goTo(graphics));
  callback(Object.freeze([...graphics]));
}

export function CreatePolygonFromXYPoints(
  xyPoints: readonly XYPointInput[],
  callback: (polygon: Polygon | null) => void,
): void {
  const ring = buildClosedPolygonRing(xyPoints);
  if (!ring) {
    callback(null);
    return;
  }

  callback(new Polygon({
    rings: [ring.map(([x, y]) => [x, y])],
    spatialReference: {
      wkid: 4326,
    },
  }));
}
