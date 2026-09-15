import React, { useEffect, useImperativeHandle, useState } from "react";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import "./ReportQueryWindow.css";

export const ReportQueryWindow = React.forwardRef((props, ref) => {

    const windowTitle = "Rapor";
    const windowLogo = "images/icons/common/rapor.png";

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
        },
        OnClose: () => {
   
  
        }
    }));

    const [mapView, setMapView] = useState(null);
    useEffect(() => {


        props.windowManager.RegisterWindow(ref);
        
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);


    }, []);



    return (<>
        <div className="common-query-window"
            style={{ maxWidth:'100%',width:'calc(100vw - 140px)', height:'calc(100vh - 90px)',visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo}></img>
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false} />

            </div>
            <div className={"common-query-window-body "+ (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>
               <iframe src="https://cbsportal.shkbilisim.com/portal/apps/dashboards/18385387c4c94f418a0b80caa30225aa" className="report-frame"/>
            </div>
        </div>
    </>);
});