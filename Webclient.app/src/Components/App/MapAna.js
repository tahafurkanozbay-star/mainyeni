import React, { useEffect, useRef,useImperativeHandle, useState, useCallback } from "react";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import "./Sidebar.css";
import MapManager from "../../Store/Managers/MapManager";
import { CommonBusiness } from "../../Business/CommonBusiness";
import { LayerBusiness } from "../../Business/LayerBusiness";
import { Constants_ServiceResultType } from "../../Core/Constants";
import { loadModules } from "esri-loader";




export const MapAna= React.forwardRef((props, ref ) => {
    const [mapView, setMapView] = useState(null);
  
    useImperativeHandle(ref, () => ({

        id: props.id, visible: true, minimized: false,
        OnShow: () => {
     
            
            
        },
        OnClose: () => {
 
          
        }
    }));

    useEffect(() => {

        props.windowManager.RegisterWindow(ref);    
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);      
          
        if (mapView?.map) {
        
            props.windowManager.ShowWindow("sidebar")
           
        }
    }, [mapView]);
    return null;
});