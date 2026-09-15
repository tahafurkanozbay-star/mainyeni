import React, { useImperativeHandle, useState } from "react";
import { Form } from "react-bootstrap";
import { BiChevronUp, BiInfoCircle, BiX } from "react-icons/bi";
import { RiCloseCircleFill } from "react-icons/ri";
import { Constants_MessageType, Constants_UserMesssages } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import "./CommonQueryWindowTools.css";

const DEFAULT_BUFFER_DISTANCE = 20;
const FALLBACK_LOCATION = { x: 32.80409955978453, y: 39.94494728389463 };

export const CommonQueryWindowTools = React.forwardRef((props, ref) => {
    const [nearbyActive, setNearbyActive] = useState(false);
    const [mapSelectActive, setMapSelectActive] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(DEFAULT_BUFFER_DISTANCE);

    useImperativeHandle(ref, () => ({
        OnClose: () => {
            setNearbyActive(false);
            setMapSelectActive(false);
            setBufferDistance(DEFAULT_BUFFER_DISTANCE);
        }
    }));

    const setQueryField = (field, value) => props.setQueryField?.(field, value);

    const createLocation = async location => {
        const point = await GisGraphicsHelper.CreatePoint(location);
        setQueryField("showNearby", true);
        setQueryField("userLocation", point);
        const mapView = MapManager.GetMapView();
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
        MapManager.AddGraphics(graphic, true);
        GisGraphicsHelper.ZoomToGeometry(mapView, point, 12);
        window.setTimeout(() => MapManager.RemoveGraphics(graphic), 30000);
    };

    const getUserLocation = () => {
        if (!navigator.geolocation) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
            createLocation(FALLBACK_LOCATION);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            position => {
                props.windowManager.ShowMessage(Constants_MessageType.Success, Constants_UserMesssages.LOCATION_ALLOWED);
                createLocation({ x: position.coords.longitude, y: position.coords.latitude });
            },
            () => {
                props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
                createLocation(FALLBACK_LOCATION);
            }
        );
    };

    const changeSearchNearby = value => {
        if (!props.showNearbySearch) return;
        setNearbyActive(value);
        setQueryField("bufferDistance", DEFAULT_BUFFER_DISTANCE);
        setQueryField("showNearby", value);
        setBufferDistance(DEFAULT_BUFFER_DISTANCE);
        if (value) getUserLocation();
        if (mapSelectActive) {
            setMapSelectActive(false);
            setQueryField("mapSelect", false);
        }
    };

    const changeMapSelect = value => {
        if (!props.showMapSelect) return;
        setMapSelectActive(value);
        setQueryField("mapSelect", value);
        if (nearbyActive) {
            setNearbyActive(false);
            setQueryField("showNearby", false);
        }
    };

    const updateBufferDistance = meters => {
        if (!Number.isFinite(meters) || meters < 1) return;
        const hundredMeters = meters / 100;
        setBufferDistance(hundredMeters);
        setQueryField("bufferDistance", hundredMeters);
    };

    const minimized = props.windowManager.IsMinimized(props.windowId);

    return <>
        <button type="button" className="common-query-window-tool-button" onClick={() => props.windowManager.ToggleMinimiseWindow(props.windowId)} title="Pencereyi küçült" aria-label="Pencereyi küçült">
            <BiChevronUp className="common-query-window-tool-minimise-button" aria-hidden="true" />
        </button>
        <button type="button" className="common-query-window-tool-button" onClick={() => props.windowManager.HideWindow(props.windowId)} title="Pencereyi kapat" aria-label="Pencereyi kapat">
            <RiCloseCircleFill className="common-query-window-tool-close-button" aria-hidden="true" />
        </button>

        {!minimized && <div className="common-query-window-tools">
            {props.showNearbySearch && (nearbyActive ?
                <button type="button" className="common-query-window-tool danger" onClick={() => changeSearchNearby(false)}><BiX className="common-query-window-tool-icon" aria-hidden="true" /><span>İptal Et</span></button> :
                <button type="button" className="common-query-window-tool" onClick={() => changeSearchNearby(true)}><img src="images/icons/common/yakinimdaara.png" alt="" aria-hidden="true" /><span>Yakınımda Ara</span></button>
            )}
            {false && props.showMapSelect && (mapSelectActive ?
                <button type="button" className="common-query-window-tool danger" onClick={() => changeMapSelect(false)}><BiX className="common-query-window-tool-icon" aria-hidden="true" /><span>İptal Et</span></button> :
                <button type="button" className="common-query-window-tool" onClick={() => changeMapSelect(true)}><img src="images/icons/common/haritadansec.png" alt="" aria-hidden="true" /><span>Haritadan Seç</span></button>
            )}
        </div>}

        {props.showNearbySearch && nearbyActive && <div className="common-query-window-tools-body">
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                <div style={{ flexShrink: '0', flexGrow: '1', flex: '9' }}>
                    <Form.Range value={bufferDistance} onInput={event => { const value = Number.parseInt(event.target.value, 10); if (value >= 1) { setBufferDistance(value); setQueryField("bufferDistance", value); } }} aria-label="Yakınlık mesafesi" />
                </div>
                <div className="common-query-window-tools-buffer-distance-indicator">
                    <input type="number" className="form-control" min="1" max="10000" step="1" style={{ width: '75px' }} value={bufferDistance * 100} onChange={event => updateBufferDistance(Number.parseInt(event.target.value, 10))} aria-label="Yakınlık mesafesi metre" /> <span>&nbsp;m</span>
                </div>
            </div>
        </div>}

        {props.showMapSelect && mapSelectActive && <div className="common-query-window-tools-body"><div className="common-query-window-tools-mapselect-message"><BiInfoCircle aria-hidden="true" /><span>Lütfen haritaya tıklayarak bir öğe seçin.</span></div></div>}
    </>;
});

CommonQueryWindowTools.displayName = "CommonQueryWindowTools";
