import React, { Component } from 'react';
import { loadModules } from "esri-loader";
import { IsNull } from './ObjectHelper';

export function RemoveGraphics(_mapView, _graphics) {
  _mapView.graphics.remove(_graphics);
}

export function AddGraphics(_mapView, _graphic) {

  _mapView.graphics.add(_graphic);

  return _graphic;
}

export function ZoomToGeometry(_mapView, _geometry, _zoomLevel, _callback) {

  loadModules(["esri/Graphic",
    "esri/symbols/SimpleFillSymbol", "esri/symbols/SimpleLineSymbol", "esri/Color"]).
    then(([Graphic, SimpleFillSymbol, SimpleLineSymbol, Color]) => {

      CreateGraphicFromGeometry(_geometry, null, function (graphic) {

        if (graphic != null) {

          AddGraphics(_mapView, graphic);

          if (!IsNull(_zoomLevel)) {
            _mapView.goTo({
              target: graphic,
              zoom: _zoomLevel
            });
          }
          else {
            _mapView.goTo(_geometry);
          }

          _callback(graphic);

        }
        else {
          _callback(null);
        }

      });

    });
}


export function CreateGraphicFromPicture(_geometry, _pictureUrl, _width, _height, _angle, _callback) {

  loadModules(["esri/Graphic",
    "esri/symbols/SimpleFillSymbol", "esri/symbols/SimpleLineSymbol", "esri/symbols/PictureMarkerSymbol", "esri/Color"]).
    then(([Graphic, SimpleFillSymbol, SimpleLineSymbol, PictureMarkerSymbol, Color]) => {

      if (_geometry != null) {
        var pointSymbol = {
          type: "picture-marker",
          url: _pictureUrl,
          width: _width,
          height: _height,
          angle: _angle
        };

        var graphic = null;

        graphic = new Graphic({
          geometry: _geometry,
          symbol: pointSymbol
        });


        _callback(graphic);

      }
      else {
        _callback(null);
      }

    });
}


export function CreateGraphicFromGeometry(_geometry, _symbol, _callback) {

  loadModules(["esri/Graphic",
    "esri/symbols/SimpleFillSymbol", "esri/symbols/SimpleLineSymbol", "esri/symbols/PictureMarkerSymbol", "esri/Color"]).
    then(([Graphic, SimpleFillSymbol, SimpleLineSymbol, PictureMarkerSymbol, Color]) => {


      if (_geometry != null) {
        var pointSymbol = {
          type: "picture-marker",
          url: 'images/pictureMarker.png',
          width: "32px",
          height: "32px"
        };

        var polylineSymbol = {
          type: "simple-line",
          color: [78, 229, 255],
          width: 4
        };

        var polygonSymbol = {
          type: "simple-line",
          color: [78, 229, 255],
          width: 4
        };

        var graphic = null;


        if (_geometry.type == 'point') {
          graphic = new Graphic({
            geometry: _geometry,
            symbol: _symbol != null ? _symbol : pointSymbol
          });
        }

        if (_geometry.type == 'line' || _geometry.type == 'polyline') {
          graphic = new Graphic({
            geometry: _geometry,
            symbol: _symbol != null ? _symbol : polylineSymbol
          });
        }

        if (_geometry.type == 'polygon') {
          graphic = new Graphic({
            geometry: _geometry,
            symbol: _symbol != null ? _symbol : polygonSymbol
          });
        }

        _callback(graphic);

      }
      else {
        _callback(null);
      }

    });

}


export function ZoomToGeometries(_mapView, _geometries, _zoomLevel, _callback) {

  var graphicsArray = [];
  var counter = 0;

  _geometries.forEach(geometry => {

    CreateGraphicFromGeometry(geometry, null, function (graphic) {

      graphicsArray.push(graphic);
      AddGraphics(_mapView, graphic);

      counter++;

      if (counter === _geometries.length) {
        if (_zoomLevel != null) {
          _mapView.goTo({
            target: _geometries,
            zoom: _zoomLevel
          }).catch(function (error) {
            console.error(error);
          });

        }
        else {
          _mapView.goTo(_geometries).catch(function (error) {
            console.error(error);
          });

        }


        _callback(graphicsArray);
      }

    });
  });



}



//bu fonksiyon verilen X Y noktalarından polygon oluşturur
export function CreatePolygonFromXYPoints(_xyPoints, _callback) {

  loadModules(["esri/geometry/Polygon", "esri/geometry/Point", "esri/geometry/SpatialReference"]).
    then(([Polygon, Point, SpatialReference]) => {


      let _rings = []
      _xyPoints.forEach(_xyPoint => {

        let x = parseFloat(_xyPoint.X.replace(",", "."));
        let y = parseFloat(_xyPoint.Y.replace(",", "."));
        _rings.push([x, y]);

      });

      let _ringsWrapper = [];
      _ringsWrapper.push(_rings);


      let _polygon = new Polygon({
        rings: _rings,
        spatialReference: {
          wkid: 4326
        }
      });

      _callback(_polygon);

    });


}