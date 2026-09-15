import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Tab, Tabs } from "react-bootstrap";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { EgoQueryBusiness } from "../../../Business/EgoQueryBusiness";
import "./EgoQueryWindow.css";
import { EgoLinesQuery } from "./EgoLinesQuery";
import { EgoStopsQuery } from "./EgoStopsQuery";

const DEFAULT_QUERY = Object.freeze({ name: null, districtId: null, nbhoodId: null, showMapSelect: false, showNearby: false });

export const EgoQueryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "EGO / Otobüs Durakları";
    const windowLogo = "images/icons/sidebar/ulasimaglari.png";
    const commonToolsComponentRef = useRef();
    const [lineList, setLineList] = useState(null);
    const [stopList, setStopList] = useState(null);
    const [query, setQuery] = useState({ ...DEFAULT_QUERY });

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => DebugHelper.Log("show " + props.id),
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery({ ...DEFAULT_QUERY });
            commonToolsComponentRef.current?.OnClose?.();
            MapManager.RemoveAllGraphics();
        }
    }), [props.id]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        let active = true;

        const load = async () => {
            const [linesResponse, stopsResponse] = await Promise.allSettled([
                EgoQueryBusiness.GetActiveLines(),
                EgoQueryBusiness.GetActiveStops()
            ]);
            if (!active) return;
            setLineList(linesResponse.status === "fulfilled" && linesResponse.value?.type === Constants_ServiceResultType.Success ? linesResponse.value.data : []);
            setStopList(stopsResponse.status === "fulfilled" && stopsResponse.value?.type === Constants_ServiceResultType.Success ? stopsResponse.value.data : []);
        };
        load();

        return () => {
            active = false;
        };
    }, [props.windowManager, ref]);

    const setQueryField = (field, value) => setQuery(current => ({ ...current, [field]: value }));

    return (
        <div className="common-query-window" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo} alt="" aria-hidden="true" />
                <span>{windowTitle}</span>
                <CommonQueryWindowTools ref={commonToolsComponentRef} windowManager={props.windowManager} windowId={props.id} setQueryField={setQueryField} query={query} showNearbySearch={false} showMapSelect={false} />
            </div>
            <div className={`common-query-window-body ${props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : ""}`}>
                <Tabs defaultActiveKey="activeLines">
                    <Tab title="Hatlar" eventKey="activeLines"><EgoLinesQuery lines={lineList} showAll={false} /></Tab>
                    <Tab title="Duraklar" eventKey="activeStops"><EgoStopsQuery stops={stopList} showAll={false} /></Tab>
                </Tabs>
            </div>
        </div>
    );
});

EgoQueryWindow.displayName = "EgoQueryWindow";
