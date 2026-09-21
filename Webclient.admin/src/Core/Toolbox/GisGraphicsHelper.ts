import Graphic from '@arcgis/core/Graphic.js';
import Polygon from '@arcgis/core/geometry/Polygon.js';
import type Geometry from '@arcgis/core/geometry/Geometry.js';
import type MapView from '@arcgis/core/views/MapView.js';

type GraphicCallback = (graphic: Graphic | null) => void;
type GraphicsCallback = (graphics: readonly Graphic[]) => void;

export interface XYPoint {
  readonly X: string | number;
  readonly Y: string | number;
}

const pictureMarkerSymbol = Object.freeze({
  type: 'picture-marker' as const,
  url: 'images/pictureMarker.png',
  width: '32px',
  height: '32px',
});

const polylineSymbol = Object.freeze({
  type: 'simple-line' as const,
  color: [78, 229, 255, 1] as const,
  width: 4,
});

const polygonSymbol = Object.freeze({
  type: 'simple-fill' as const,
  color: [78, 229, 255, 0.12] as const,
  outline: {
    type: 'simple-line' as const,
    color: [78, 229, 255, 1] as const,
    width: 2,
  },
});

const parseCoordinate = (value: string | number): number => {
  const normalized = typeof value === 'number'
    ? value
    : Number.parseFloat(value.replace(',', '.'));

  if (!Number.isFinite(normalized)) {
    throw new RangeError('Coordinate must be a finite number.');
  }
  return normalized;
};

const goToWithoutAbortNoise = (
  view: MapView,
  target: Parameters<MapView['goTo']>[0],
): void => {
  void view.goTo(target).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') return;
    throw error;
  });
};

export function RemoveGraphics(view: MapView, graphics: Graphic | readonly Graphic[]): void {
  if (Array.isArray(graphics)) {
    view.graphics.removeMany([...graphics]);
    return;
  }
  view.graphics.remove(graphics as Graphic);
}

export function AddGraphics(view: MapView, graphic: Graphic): Graphic {
  view.graphics.add(graphic);
  return graphic;
}

export function CreateGraphicFromPicture(
  geometry: Geometry | null | undefined,
  pictureUrl: string,
  width: number | string,
  height: number | string,
  angle: number,
  callback: GraphicCallback,
): void {
  if (!geometry) {
    callback(null);
    return;
  }

  callback(new Graphic({
    geometry,
    symbol: {
      type: 'picture-marker',
      url: pictureUrl,
      width,
      height,
      angle,
    },
  }));
}

export function CreateGraphicFromGeometry(
  geometry: Geometry | null | undefined,
  symbol: Graphic['symbol'] | null | undefined,
  callback: GraphicCallback,
): void {
  if (!geometry) {
    callback(null);
    return;
  }

  let resolvedSymbol: Graphic['symbol'];
  switch (geometry.type) {
    case 'point':
    case 'multipoint':
      resolvedSymbol = symbol ?? pictureMarkerSymbol;
      break;
    case 'polyline':
      resolvedSymbol = symbol ?? polylineSymbol;
      break;
    case 'polygon':
    case 'extent':
      resolvedSymbol = symbol ?? polygonSymbol;
      break;
    default:
      resolvedSymbol = symbol ?? null;
      break;
  }

  callback(new Graphic({ geometry, symbol: resolvedSymbol }));
}

export function ZoomToGeometry(
  view: MapView,
  geometry: Geometry,
  zoomLevel: number | null | undefined,
  callback: GraphicCallback,
): void {
  CreateGraphicFromGeometry(geometry, null, (graphic) => {
    if (!graphic) {
      callback(null);
      return;
    }

    AddGraphics(view, graphic);
    goToWithoutAbortNoise(
      view,
      zoomLevel == null
        ? geometry
        : { target: graphic, zoom: zoomLevel },
    );
    callback(graphic);
  });
}

export function ZoomToGeometries(
  view: MapView,
  geometries: readonly Geometry[],
  zoomLevel: number | null | undefined,
  callback: GraphicsCallback,
): void {
  const graphics = geometries.map((geometry) => {
    const graphic = new Graphic({
      geometry,
      symbol: geometry.type === 'polygon'
        ? polygonSymbol
        : geometry.type === 'polyline'
          ? polylineSymbol
          : pictureMarkerSymbol,
    });
    AddGraphics(view, graphic);
    return graphic;
  });

  if (geometries.length > 0) {
    goToWithoutAbortNoise(
      view,
      zoomLevel == null
        ? [...geometries]
        : { target: [...geometries], zoom: zoomLevel },
    );
  }

  callback(Object.freeze(graphics));
}

export function CreatePolygonFromXYPoints(
  xyPoints: readonly XYPoint[],
  callback: (polygon: Polygon | null) => void,
): void {
  if (xyPoints.length < 3) {
    callback(null);
    return;
  }

  try {
    const ring = xyPoints.map(({ X, Y }) => [
      parseCoordinate(X),
      parseCoordinate(Y),
    ]);

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
      ring.push([...first]);
    }

    callback(new Polygon({
      rings: [ring],
      spatialReference: { wkid: 4326 },
    }));
  } catch {
    callback(null);
  }
}
