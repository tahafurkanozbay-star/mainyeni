import { loadModules } from "esri-loader";
import { useEffect, useRef, useState } from "react"
import { Button } from "react-bootstrap";
import { AiOutlineDoubleLeft } from "react-icons/ai";
import "./Map.css";

export const Map = (props) => {

    const mapDiv = useRef();
    const [mapView, setMapView] = useState(null);

    useEffect(() => {
    
        if (mapView == null) {
            loadMap();
        }
        else {
            changeConfig();
        }


    }, [props]);


    const changeConfig = () => {

        if (props.config != null && mapView != null) {

            var _centerx = parseFloat(props.config.Centerx);
            var _centery = parseFloat(props.config.Centery);

            mapView.center = [_centerx, _centery];
            mapView.zoom = parseFloat(props.config.Zoom);
            mapView.map.basemap=props.config.DefaultBasemapTitle;
        }
    }

    const exportConfig=()=>{
        
        props.exportCallBack({
            Zoom: mapView.zoom,
            Center:mapView.center
        })
    }


    const loadMap = () => {

        var self = this;

        return loadModules(["esri/Map", "esri/views/MapView", "esri/config",
            "esri/core/urlUtils", "esri/core/watchUtils","esri/core/reactiveUtils"])
            .then(([Map, MapView, esriConfig, urlUtils, watchUtils, reactiveUtils]) => {

                const map = new Map({
                    basemap: props.config?.DefaultBasemapTitle ?? "topo",
                });

                var _centerx = parseFloat(props.config.Centerx);
                var _centery = parseFloat(props.config.Centery);

                const _mapView = new MapView({
                    container: mapDiv.current,
                    ui: {
                        components: []
                    },
                    map,
                    zoom: parseFloat(props.config.Zoom),
                    center: [_centerx, _centery],
                    padding: {
                        top: 0
                    },
                    constraints: {
                        rotationEnabled: false
                    }
                });


                watchUtils.whenTrue(_mapView, "updating", () => {
                    var mapProps={
                        Zoom: _mapView.zoom ?? props.config.Zoom,
                        Center:_mapView.center ?? props.config.Center
                        };

                });

                watchUtils.whenFalse(_mapView, "updating", () => {

                });

                reactiveUtils.when(() => _mapView.stationary === true, () => {
                    
                    /*
                    var mapProps={
                        Zoom: _mapView.zoom,
                        Center:_mapView.center
                        };

                        
                    //props.exportCallBack(mapProps);
                    */
                  });


                setMapView(_mapView);
                return _mapView;

            });
    }

    return (<>
        <div>
            <Button variant="outline-secondary" onClick={()=>exportConfig()}>
            <AiOutlineDoubleLeft></AiOutlineDoubleLeft>&nbsp;Bu koordinatları kullan
        </Button>
        </div>
        <div className="esri-map map-container" ref={mapDiv}>
        </div>

    </>);

}