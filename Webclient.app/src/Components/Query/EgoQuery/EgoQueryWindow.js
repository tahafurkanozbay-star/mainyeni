import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form, InputGroup, Tab, Tabs } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { HalkEkmekQueryBusiness } from "../../../Business/HalkEkmekQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { useRef } from "react";
import { EgoQueryBusiness } from "../../../Business/EgoQueryBusiness";
import "./EgoQueryWindow.css";
import { EgoLinesQuery } from "./EgoLinesQuery";
import { EgoStopsQuery } from "./EgoStopsQuery";

export const EgoQueryWindow = React.forwardRef((props, ref) => {


    const windowTitle = "EGO / Otobüs Durakları";
    const windowLogo = "images/icons/sidebar/ulasimaglari.png";

    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            DebugHelper.Log("show " + props.id);
        },
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery(defaultQuery);

            commonToolsComponentRef.current.OnClose();
            MapManager.RemoveAllGraphics();
        }
    }));

    const commonToolsComponentRef = useRef();


    useEffect(() => {

        props.windowManager.RegisterWindow(ref);

        loadLineList();
        loadStopList();
    }, []);


    const [lineList, setLineList] = useState(null);
    const loadLineList = async () => {

        const response = await EgoQueryBusiness.GetActiveLines();
        if (response.type == Constants_ServiceResultType.Success) {
            setLineList(response.data);
        }
    }


    const [stopList, setStopList] = useState(null);
    const loadStopList = async () => {

        const response = await EgoQueryBusiness.GetActiveStops();
        if (response.type == Constants_ServiceResultType.Success) {
            setStopList(response.data);
        }
    }




    const defaultQuery = { name: null, districtId: null, nbhoodId: null, showMapSelect: false, showNearby: false };
    const [query, setQuery] = useState(defaultQuery);
    const setQueryField = (_field, _value) => {
        setQuery(query => {
            return { ...query, [_field]: _value }
        })
    }

    return (<>
        <div className="common-query-window"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo}></img>
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={false}
                    showMapSelect={false} />

            </div>
            <div className={"common-query-window-body " + (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>

                <Tabs defaultActiveKey="activeLines">
                    <Tab title="Hatlar" key="activeLines" eventKey="activeLines">
                        <EgoLinesQuery lines={lineList} showAll={false} />
                    </Tab>

                    <Tab title="Duraklar" key="activeStops" eventKey="activeStops">
                        <EgoStopsQuery stops={stopList} showAll={false} />
                    </Tab>
                </Tabs>
            </div>
        </div>
    </>);
});