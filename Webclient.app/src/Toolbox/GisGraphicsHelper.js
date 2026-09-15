import { loadModules } from "esri-loader";
import { ArrayHelper } from "./ArrayHelper";
import { IsNull } from './ObjectHelper';
import { TextHelper } from "./TextHelper";

export const GisGraphicsHelper = {
  RemoveAllGraphics: (_mapView) => {
    _mapView?.graphics?.items?.forEach(graphic => _mapView?.graphics?.remove(graphic));
  },

  RemoveGraphics: (_mapView, _graphics) => {
    const graphics = Array.isArray(_graphics) ? [..._graphics] : [_graphics];
    graphics.forEach(graphic => {
      const target = ArrayHelper.Find(_mapView.graphics?.items, "id", graphic?.id);
      if (target) _mapView.graphics?.remove(target);
    });
  },

  AddGraphics: (_mapView, _graphics) => {
    const graphics = Array.isArray(_graphics) ? [..._graphics] : [_graphics];
    graphics.forEach(graphic => {
      if (!graphic) return;
      graphic.id = TextHelper.CreateGuid();
      _mapView?.graphics.add(graphic);
    });
  },

  CreatePoint: async props => {
    const [Point] = await loadModules(["esri/geometry/Point"]);
    return new Point(props);
  },

  ZoomToGeometry: (_mapView, _geometry, _zoomLevel) => {
    if (!IsNull(_zoomLevel)) return _mapView.goTo({ target: _geometry, zoom: _zoomLevel });
    return _mapView.goTo(_geometry);
  },

  ZoomToGeometryExtent: (_mapView, _geometry, _expand) => _mapView.goTo({
    target: _geometry,
    extent: _geometry.extent.expand(_expand)
  }),

  CreateCustomGraphicFromGeometry: async (_geometry, _symbol) => {
    if (_geometry == null) return Promise.reject(null);
    const [Graphic] = await loadModules(["esri/Graphic"]);
    return new Graphic({ geometry: _geometry, symbol: _symbol });
  },

  CreateGraphicFromGeometry: async (_geometry, _symbol) => {
    if (_geometry == null) return null;
    const [Graphic] = await loadModules(["esri/Graphic"]);
    const pointSymbol = { type: "picture-marker", url: "images/icons/map/pictureMarker.png", width: "48px", height: "48px" };
    const polylineSymbol = { type: "simple-line", color: [78, 229, 255], width: 4 };
    const polygonSymbol = { type: "simple-line", color: [78, 229, 255], width: 4 };

    let symbol = _symbol;
    if (!symbol && _geometry.type === 'point') symbol = pointSymbol;
    if (!symbol && (_geometry.type === 'line' || _geometry.type === 'polyline')) symbol = polylineSymbol;
    if (!symbol && _geometry.type === 'polygon') symbol = polygonSymbol;
    return new Graphic({ geometry: _geometry, symbol });
  },

  ZoomToGeometries: async (_mapView, _geometries, _zoomLevel) => {
    if (!_geometries?.length) return _geometries;
    try {
      if (_zoomLevel != null) await _mapView.goTo({ target: _geometries, zoom: _zoomLevel });
      else await _mapView.goTo(_geometries);
    } catch (error) {
      console.error(error);
    }
    return _geometries;
  },

  CreatePolygonFromXYPoints: async _points => {
    const [Polygon] = await loadModules(["esri/geometry/Polygon"]);
    const rings = (_points?.[0] || []).map(point => [point[0], point[1]]);
    return new Polygon({ rings, spatialReference: { wkid: 4326 } });
  },

  CreatePolylineFromXYPoints: async _points => {
    const [Polyline] = await loadModules(["esri/geometry/Polyline"]);
    const paths = (_points?.[0] || []).map(point => [point[0], point[1]]);
    return new Polyline({ paths, spatialReference: { wkid: 4326 } });
  },

  ProjectGeometry: async (_geometry, _wkid) => {
    const [projection, SpatialReference] = await loadModules(["esri/geometry/projection", "esri/geometry/SpatialReference"]);
    await projection.load();
    return projection.project(_geometry, new SpatialReference({ wkid: _wkid }));
  }
};
