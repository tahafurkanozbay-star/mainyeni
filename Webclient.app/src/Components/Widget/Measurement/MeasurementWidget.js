import React, { Component, useEffect, useImperativeHandle, useState } from "react";
import { loadModules } from "esri-loader";
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChartArea, faChartLine, faTimes, faRuler } from '@fortawesome/free-solid-svg-icons'
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import MapManager from "../../../Store/Managers/MapManager";
import "./MeasurementWidget.css";
import { useForceUpdate } from "../../../Toolbox/ReactHelper";

export const MeasurementWidget = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            props.windowManager.ShowWindow("sidebar")

            initialize();
        },
        OnClose: () => {
            
            measurement?.clear();
        }
    }));

    useEffect(()=>{

        props.windowManager.RegisterWindow(ref);

    },[]);


    const [mapView, setMapView] = useState(null);
    const [measurement, setMeasurement] = useState(null);

    const initialize = () => {

        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

        if (measurement == null) {

            loadModules(["esri/widgets/Measurement"])
                .then(([Measurement]) => {

                    const _measurement = new Measurement({
                        view: _mapView,
                        container: "measurementDiv",
                        activeTool: ""
                    });
                    setMeasurement(_measurement);
                });
        }

    }


    const setActiveTool = (toolName) => {
        if (measurement != null) {
            measurement.activeTool = toolName;
        }
    }

    return (<div className="common-query-window common-query-window-right"
        style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
        <div className="common-query-window-header">
            <img className="common-query-window-header-icon" src="images/icons/toolbar/olcumaraci.png"></img>
            <span>Ölçüm Araçları</span>
            <CommonQueryWindowTools
                windowManager={props.windowManager}
                windowId={props.id}
                showNearbySearch={false}
                showMapSelect={false}
                setQueryField={(e) => { }}
                query={null} />
        </div>
        <div className="common-query-window-body layer-list-window-body">
            <div>
                <div onClick={() => setActiveTool("area")} className="measurement-widget-tool-select-button">
                    <FontAwesomeIcon icon={faChartArea} size="2x"></FontAwesomeIcon>
                </div>
                <div onClick={() => setActiveTool("distance")} className="measurement-widget-tool-select-button">
                    <FontAwesomeIcon icon={faChartLine} size="2x"></FontAwesomeIcon>
                </div>
            </div>
            <div id="measurementDiv"></div>
        </div>

    </div>);

});