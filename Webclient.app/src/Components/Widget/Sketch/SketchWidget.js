import React, { Component, useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTimes, faPenSquare, faChartArea, faChartLine } from '@fortawesome/free-solid-svg-icons'
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./SketchWidget.css";

export const SketchWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar")

            initialize();
        },
        OnClose: () => {
            

            sketch.cancel();
            sketchLayer.removeAll();
        }
    }));

    useEffect(()=>{
        props.windowManager.RegisterWindow(ref);
    });

    const [mapView, setMapView] = useState(null);
    const [sketch, setSketch] = useState(null);
    const [sketchLayer, setSketchLayer] = useState(null);

    const initialize = () => {

        const _mapView = MapManager.GetMapView();

        setMapView(_mapView);

        if (sketch == null) {

            loadModules(["esri/widgets/Sketch", "esri/layers/GraphicsLayer"])
                .then(([Sketch, GraphicsLayer]) => {

                    const layer = new GraphicsLayer();
                    _mapView.map.add(layer);
                    setSketchLayer(layer);

                    const _sketch = new Sketch({
                        layer: layer,
                        view: _mapView,
                        container: "sketchDiv",
                        activeTool: null,
                        iconClass:"sketch-icon"
                    });
                    setSketch(_sketch);
                });

        }
    }

    return (<div className="common-query-window common-query-window-right"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/cizimaraci.png"></img>
            <span>Çizim Araçları</span>
            <CommonQueryWindowTools
                windowManager={props.windowManager}
                windowId={props.id}
                showNearbySearch={false}
                showMapSelect={false}
                setQueryField={(e) => { }}
                query={null} />
        </div>
        <div className="common-query-window-body layer-list-window-body">
            <div id="sketchDiv"></div>
        </div>

    </div>);

});