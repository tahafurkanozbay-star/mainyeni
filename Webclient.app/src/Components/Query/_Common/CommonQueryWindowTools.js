import React, { useEffect, useImperativeHandle, useState } from "react";
import { Form } from "react-bootstrap";
import { BiChevronUp, BiInfoCircle, BiX } from "react-icons/bi";
import { RiCloseCircleFill } from "react-icons/ri";
import { Constants_MessageType, Constants_UserMesssages } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { TextHelper } from "../../../Toolbox/TextHelper";
import "./CommonQueryWindowTools.css";

export const CommonQueryWindowTools = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        OnClose: () => {
            setNearbyActive(false);
            setMapSelectActive(false);
            setBufferDistance(defaultBufferDistance);
        }
    }));

    useEffect(() => {

    }, [props]);


    const [x,setX]=useState(null);
    const toggleMinimiseWindow = (e) => {
        props.windowManager.ToggleMinimiseWindow(props.windowId);
        setX(TextHelper.CreateRandomNumber());
    }

    const closeWindow = (e) => {
        props.windowManager.HideWindow(props.windowId);
    }


    const defaultBufferDistance = 20;

    const [nearbyActive, setNearbyActive] = useState(false);
    const [mapSelectActive, setMapSelectActive] = useState(false);
    const changeSearchNearby = (_value) => {

        if (props.showNearbySearch) {

            setNearbyActive(_value);

            if (_value) { //show
                getUserLocation();
            }

            props.setQueryField("bufferDistance",defaultBufferDistance);
            props.setQueryField( "showNearby",_value);

            setBufferDistance(defaultBufferDistance);

            if (mapSelectActive) {
                setMapSelectActive(false);
                props.setQueryField("mapSelect", false);
            }
        }
    }


    const changeMapSelect = (_value) => {

        if (props.showMapSelect) {

            setMapSelectActive(_value);
            props.setQueryField("mapSelect", _value);

            if (nearbyActive) {
                setNearbyActive(false);
                props.setQueryField("showNearby", false);
            }
        }

    }



    const [location, setLocation] = useState(null);
    const getUserLocation = () => {

        const mapConfig = MapManager.GetMapConfiguration();
        //let location = { x: mapConfig.Centerx, y: mapConfig.Centery }; //TODO: Geçici olarak gölbaşı merkeze ayarlandı değiştirilecek
        let location = { x: 32.80409955978453, y: 39.94494728389463 };

        if (!navigator.geolocation) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
            createLocation(location);
        }
        else {
            props.windowManager.ShowMessage(Constants_MessageType.Success, Constants_UserMesssages.LOCATION_ALLOWED);

            navigator.geolocation.getCurrentPosition((_location) => {

                location = {
                    x: _location.coords.longitude,
                    y: _location.coords.latitude,
                };

                createLocation(location);

            }, (error) => {

                props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
                createLocation(location);
            });
        }
    }

    const createLocation = (_location) => {

        GisGraphicsHelper.CreatePoint(_location).then((_point) => {

            setLocation(location);
            props.setQueryField("showNearby", true);
            props.setQueryField("userLocation", _point);

            const mapView = MapManager.GetMapView();
            GisGraphicsHelper.CreateGraphicFromGeometry(_point, null).then((_graphic) => {
                MapManager.AddGraphics(_graphic, true);
                GisGraphicsHelper.ZoomToGeometry(mapView, _point, 12);

                setTimeout(() => {
                    MapManager.RemoveGraphics(_graphic);
                }, 30000);
            });
        });
    }



    const [bufferDistance, setBufferDistance] = useState(20);
    const bufferDistanceChange = (e) => {

        const value = parseInt(e.target.value);
        if (value >= 1) {
            setBufferDistance(value);
            props.setQueryField("bufferDistance", value);
        }

    }

    const bufferDistanceChangeRaw = (e) => {
            
            const value = parseInt(e.target.value);
            if (value >= 1) {
                setBufferDistance(value / 100);
                props.setQueryField("bufferDistance", value / 100);
            }
    }

    return (<>

        <div onClick={(e) => toggleMinimiseWindow(e)} title="pencereyi küçült">
            <BiChevronUp className="common-query-window-tool-minimise-button" />
        </div>

        <div onClick={(e) => closeWindow(e)} title="pencereyi kapat">
            <RiCloseCircleFill className="common-query-window-tool-close-button" />
        </div>

        {
            props.windowManager.IsMinimized(props.id) ? <div></div> :
            <div className="common-query-window-tools">
                {props.showNearbySearch &&
                    <>
                        {nearbyActive ?
                            <div className="common-query-window-tool danger" onClick={(e) => changeSearchNearby(false)}>
                                <BiX className="common-query-window-tool-icon" />
                                <span>İptal Et</span>
                            </div>
                            :
                            <div className="common-query-window-tool" onClick={(e) => changeSearchNearby(true)}>
                                <img src="images/icons/common/yakinimdaara.png"></img>
                                <span>Yakınımda Ara</span>
                            </div>
                        }</>
                }
                <div>

                </div>
                {false&&props.showMapSelect &&
                    <>
                        {mapSelectActive ?
                            <div className="common-query-window-tool danger" onClick={(e) => changeMapSelect(false)}>
                                <BiX className="common-query-window-tool-icon" />
                                <span>İptal Et</span>
                            </div>
                            :
                            <div className="common-query-window-tool" onClick={(e) => changeMapSelect(true)}>
                                <img src="images/icons/common/haritadansec.png"></img>
                                <span>Haritadan Seç</span>
                            </div>
                        }</>
                }
            </div>

        }


        {
            props.showNearbySearch && nearbyActive &&
            <div className="common-query-window-tools-body">
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                    <div style={{ flexShrink: '0', flexGrow: '1', flex:'9' }}>
                        <Form.Range value={bufferDistance}
                            onInput={(e) => { bufferDistanceChange(e) }} />
                    </div>
                    <div className="common-query-window-tools-buffer-distance-indicator">
                    <input type="number" 
                            className="form-control" min="1" max="10000" step="1" style={{ width: '75px' }}
                            value={bufferDistance*100} 
                            onChange={(e) => bufferDistanceChangeRaw(e)} /> <span>&nbsp;m</span>
                    </div>
                    </div>
                    <div>
                 
                </div>
            </div>
        }

        {
            props.showMapSelect && mapSelectActive &&
            <div className="common-query-window-tools-body">
                <div className="common-query-window-tools-mapselect-message">
                    <BiInfoCircle />
                    <span>Lütfen haritaya tıklayarak bir öğe seçin..</span>
                </div>
            </div>
        }

    </>);
});