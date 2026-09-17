import React, { useEffect, useImperativeHandle, useState } from "react";
import "./Sidebar.css";
import MapManager from "../../Store/Managers/MapManager";

export const MapAna = React.forwardRef((props, ref) => {
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
            props.windowManager.ShowWindow("sidebar");
        }
    }, [mapView]);
    return null;
});
