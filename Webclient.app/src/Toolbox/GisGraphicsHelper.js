import { loadModules } from "esri-loader";
import { ArrayHelper } from "./ArrayHelper";
import { IsNull } from './ObjectHelper';
import { TextHelper } from "./TextHelper";

export const GisGraphicsHelper = {

  RemoveAllGraphics: (_mapView) => {
  
    _mapView?.graphics?.items?.forEach(gf => {
      _mapView?.graphics?.remove(gf);
    });
  },

  
  RemoveGraphics: (_mapView, _graphics) => {
    
    var gfList=[];
    if(Array.isArray(_graphics)){
      gfList=[..._graphics];
    }
    else{
      gfList.push(_graphics);
    }

    gfList.forEach(gf => {
      
      var g=ArrayHelper.Find(_mapView.graphics?.items, "id", gf?.id);
      _mapView.graphics?.remove(g);
    });
  },

  AddGraphics: (_mapView, _graphics) => {

    var gfList=[];
    if(Array.isArray(_graphics)){
      gfList=[..._graphics];
    }
    else{
      gfList.push(_graphics);
    }

    gfList.forEach(gf => {
      gf.id=TextHelper.CreateGuid();
      _mapView?.graphics.add(gf);
    });


    return;
  },

  CreatePoint: async (props) => {

    return loadModules(["esri/geometry/Point",]).
      then(([Point]) => {

        return new Point(props);

      });
  },

  ZoomToGeometry: (_mapView, _geometry, _zoomLevel) => {

    if (!IsNull(_zoomLevel)) {
      _mapView.goTo({
        target: _geometry,
        zoom: _zoomLevel
      });
    }
    else {
      _mapView.goTo(_geometry);
    }

  },

  
  ZoomToGeometryExtent:(_mapView, _geometry, _expand)=>{
  
    _mapView.goTo({
      target: _geometry,
      extent: _geometry.extent.expand(_expand)
    });
},


  CreateCustomGraphicFromGeometry: async (_geometry, _symbol) => {

    return new Promise((resolve, reject) => {

      loadModules(["esri/Graphic",]).then(([Graphic]) => {

        if (_geometry != null) {

          let graphic = new Graphic({
            geometry: _geometry,
            symbol: _symbol
          });

          resolve(graphic);

        }
        else {
          reject(null);
        }

      });
    });
  },


  CreateGraphicFromGeometry: (_geometry, _symbol) => {

    return new Promise((resolve, reject) => {

      loadModules(["esri/Graphic",]).then(([Graphic]) => {
        if (_geometry != null) {
          let pointSymbol = {
            type: "picture-marker",
            url: "images/icons/map/pictureMarker.png",
            width: "48px",
            height: "48px"
          };

          let polylineSymbol = {
            type: "simple-line",
            color: [78, 229, 255],
            width: 4
          };

          let polygonSymbol = {
            type: "simple-line",
            color: [78, 229, 255],
            width: 4
          };

          let graphic = null;


          if (_geometry.type == 'point') {
            graphic = new Graphic({
              geometry: _geometry,
              symbol: _symbol ?? pointSymbol
            });
          }

          if (_geometry.type == 'line' || _geometry.type == 'polyline') {
            graphic = new Graphic({
              geometry: _geometry,
              symbol: _symbol ?? polylineSymbol
            });
          }

          if (_geometry.type == 'polygon') {
            graphic = new Graphic({
              geometry: _geometry,
              symbol: _symbol ?? polygonSymbol
            });
          }

          resolve(graphic);

        }
        else {
          resolve(null);
        }

      });

    });
  },

  ZoomToGeometries: (_mapView, _geometries, _zoomLevel) => {

    return new Promise((resolve, reject)=>{

      let counter = 0;

      _geometries.forEach(geometry => {
  
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
          resolve(_geometries);
        }
  
  
      });

    });
   
  },


  //bu fonksiyon verilen X Y noktalarından polygon oluştur,
  CreatePolygonFromXYPoints: async(_points) => {

    return new Promise((resolve,reject)=>{

      loadModules(["esri/geometry/Polygon"]).then(([Polygon]) => {

        let _rings = []
        let xyPoints = _points[0];
  
        xyPoints.forEach(_xyPoint => {
          _rings.push([_xyPoint[0], _xyPoint[1]]);
        });
  
        let _ringsWrapper = [];
        _ringsWrapper.push(_rings);
        let _polygon = new Polygon({
          rings: _rings,
          spatialReference: {
            wkid: 4326
          }
        });
  
        resolve(_polygon);
  
      });


    });
   
  },


  CreatePolylineFromXYPoints: async(_points) => {

    return new Promise((resolve,reject)=>{

      loadModules(["esri/geometry/Polyline"]).then(([Polyline]) => {

        let _paths = []
        let xyPoints = _points[0];
  
        xyPoints.forEach(_xyPoint => {
          _paths.push([_xyPoint[0], _xyPoint[1]]);
        });

        let _polyline = new Polyline({
          paths: _paths,
          spatialReference: {
            wkid: 4326
          }
        });
  
        resolve(_polyline);
  
      });


    });
   
  },



  ProjectGeometry: async(_geometry, _wkid) => {

    return new Promise((resolve,reject)=>{

      loadModules(["esri/geometry/projection", "esri/geometry/SpatialReference"]).then(([projection, SpatialReference]) => {


        projection.load().then(() => {
  
          let outSpatialReference = new SpatialReference({
            wkid: _wkid
          });
  
          let _geom = projection.project(_geometry, outSpatialReference);
          resolve(_geom);
  
        });
  
      });
    });
   

  }


}

