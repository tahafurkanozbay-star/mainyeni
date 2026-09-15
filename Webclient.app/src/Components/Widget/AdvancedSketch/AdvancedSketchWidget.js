import { faSketch } from "@fortawesome/free-brands-svg-icons";
import { faChevronDown, faChevronUp, faDrawPolygon, faTimes } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import MapManager from "../../../Store/Managers/MapManager";
import React, { useState, useEffect } from "react";

import { AdvancedSketchWidgetMain } from "./AdvancedSketchWidgetMain";


export const AdvancedSketchWidget=(props)=>{

    const [mapView, setMapView] = useState(null);

    useEffect(() => {

        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

      //Window Manager register window
        ;
      

    }, []);

     return (
        <div className="widget-window"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="widget-window-title">
                <div className="row">
                    <div className="col-9">
                        <FontAwesomeIcon icon={faSketch} size="lg" className="widget-window_Icon" />
                        Çizim
                    </div>
                    <div className="col-3">
                        <div className="widget-window-toolbar-button"
                            onClick={(e) => { props.windowManager.HideWindow(props.id) }}>
                            <FontAwesomeIcon icon={faTimes}></FontAwesomeIcon>
                        </div>

                        <div className="widget-window-toolbar-button"
                            onClick={(e) => { window.Minimize(e) }}>
                            <FontAwesomeIcon icon={props.windowManager.IsMinimized(props.id) ? faChevronDown : faChevronUp}></FontAwesomeIcon>
                        </div>
                    </div>
                </div>
            </div>
            <div className="widget-window-body">
                <AdvancedSketchWidgetMain></AdvancedSketchWidgetMain>
            </div>
        </div>)

}