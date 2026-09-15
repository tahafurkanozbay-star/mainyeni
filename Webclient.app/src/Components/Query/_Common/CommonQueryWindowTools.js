import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import { BiChevronUp, BiInfoCircle, BiX } from "react-icons/bi";
import { RiCloseCircleFill } from "react-icons/ri";
import { Constants_MessageType, Constants_UserMesssages } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import {
    DEFAULT_BUFFER_UNITS,
    MAX_BUFFER_UNITS,
    MIN_BUFFER_UNITS,
    bufferUnitsToMeters,
    createGeolocationRequest,
    metersToBufferUnits,
    normalizeBufferUnits
} from "./QueryInteractionRuntime";
import "./CommonQueryWindowTools.css";

const LOCATION_GRAPHIC_LIFETIME_MS = 30000;

export const CommonQueryWindowTools = React.forwardRef((props, ref) => {
    const [nearbyActive, setNearbyActive] = useState(false);
    const [mapSelectActive, setMapSelectActive] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(DEFAULT_BUFFER_UNITS);
    const [locating, setLocating] = useState(false);

    const locationGraphicRef = useRef(null);
    const locationTimerRef = useRef(null);
    const mountedRef = useRef(true);

    const setQueryField = (field, value) => props.setQueryField?.(field, value);

    const clearLocationTimer = () => {
        if (locationTimerRef.current) {
            window.clearTimeout(locationTimerRef.current);
            locationTimerRef.current = null;
        }
    };

    const clearLocationGraphic = () => {
        clearLocationTimer();
        if (locationGraphicRef.current) {
            MapManager.RemoveGraphics(locationGraphicRef.current);
            locationGraphicRef.current = null;
        }
    };

    const resetTools = () => {
        clearLocationGraphic();
        setNearbyActive(false);
        setMapSelectActive(false);
        setBufferDistance(DEFAULT_BUFFER_UNITS);
        setLocating(false);
        setQueryField("showNearby", false);
        setQueryField("mapSelect", false);
        setQueryField("userLocation", null);
        setQueryField("bufferDistance", DEFAULT_BUFFER_UNITS);
    };

    useImperativeHandle(ref, () => ({ OnClose: resetTools }));

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            clearLocationGraphic();
        };
    }, []);

    const createLocationGraphic = async coordinates => {
        const point = await GisGraphicsHelper.CreatePoint({
            x: coordinates.longitude,
            y: coordinates.latitude
        });
        if (!mountedRef.current) return null;

        const mapView = MapManager.GetMapView();
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, null);
        if (!mountedRef.current) return null;

        clearLocationGraphic();
        locationGraphicRef.current = graphic;
        MapManager.AddGraphics(graphic, true);
        GisGraphicsHelper.ZoomToGeometry(mapView, point, 12);
        locationTimerRef.current = window.setTimeout(() => {
            if (locationGraphicRef.current === graphic) clearLocationGraphic();
        }, LOCATION_GRAPHIC_LIFETIME_MS);

        return point;
    };

    const disableNearby = () => {
        clearLocationGraphic();
        setNearbyActive(false);
        setLocating(false);
        setQueryField("showNearby", false);
        setQueryField("userLocation", null);
    };

    const enableNearby = async () => {
        if (!props.showNearbySearch || locating) return;

        setLocating(true);
        setNearbyActive(true);
        setMapSelectActive(false);
        setBufferDistance(DEFAULT_BUFFER_UNITS);
        setQueryField("bufferDistance", DEFAULT_BUFFER_UNITS);
        setQueryField("mapSelect", false);

        try {
            const coordinates = await createGeolocationRequest();
            if (!mountedRef.current) return;
            const point = await createLocationGraphic(coordinates);
            if (!mountedRef.current || !point) return;

            setQueryField("showNearby", true);
            setQueryField("userLocation", point);
            props.windowManager.ShowMessage(
                Constants_MessageType.Success,
                Constants_UserMesssages.LOCATION_ALLOWED
            );
        } catch (error) {
            if (!mountedRef.current) return;
            disableNearby();
            props.windowManager.ShowMessage(
                Constants_MessageType.Error,
                error?.message || Constants_UserMesssages.LOCATION_REJECTED
            );
        } finally {
            if (mountedRef.current) setLocating(false);
        }
    };

    const changeSearchNearby = value => {
        if (value) {
            enableNearby();
        } else {
            disableNearby();
        }
    };

    const changeMapSelect = value => {
        if (!props.showMapSelect) return;
        setMapSelectActive(value);
        setQueryField("mapSelect", value);
        if (value) {
            disableNearby();
        }
    };

    const updateBufferUnits = value => {
        const next = normalizeBufferUnits(value);
        setBufferDistance(next);
        setQueryField("bufferDistance", next);
    };

    const updateBufferMeters = value => {
        const next = metersToBufferUnits(value);
        setBufferDistance(next);
        setQueryField("bufferDistance", next);
    };

    const minimized = props.windowManager.IsMinimized(props.windowId);
    const bufferMeters = bufferUnitsToMeters(bufferDistance);
    const distanceId = `${props.windowId}-nearby-distance`;
    const meterId = `${props.windowId}-nearby-distance-meters`;

    return (
        <>
            <button
                type="button"
                className="common-query-window-tool-button"
                onClick={() => props.windowManager.ToggleMinimiseWindow(props.windowId)}
                title="Pencereyi küçült"
                aria-label="Pencereyi küçült"
                aria-expanded={!minimized}
            >
                <BiChevronUp className="common-query-window-tool-minimise-button" aria-hidden="true" />
            </button>
            <button
                type="button"
                className="common-query-window-tool-button"
                onClick={() => props.windowManager.HideWindow(props.windowId)}
                title="Pencereyi kapat"
                aria-label="Pencereyi kapat"
            >
                <RiCloseCircleFill className="common-query-window-tool-close-button" aria-hidden="true" />
            </button>

            {!minimized && (
                <div className="common-query-window-tools" aria-label="Sorgu araçları">
                    {props.showNearbySearch && (
                        nearbyActive ? (
                            <button
                                type="button"
                                className="common-query-window-tool danger"
                                onClick={() => changeSearchNearby(false)}
                                disabled={locating}
                            >
                                <BiX className="common-query-window-tool-icon" aria-hidden="true" />
                                <span>{locating ? "Konum alınıyor…" : "İptal Et"}</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="common-query-window-tool"
                                onClick={() => changeSearchNearby(true)}
                                disabled={locating}
                            >
                                <img src="images/icons/common/yakinimdaara.png" alt="" aria-hidden="true" />
                                <span>{locating ? "Konum alınıyor…" : "Yakınımda Ara"}</span>
                            </button>
                        )
                    )}

                    {props.showMapSelect && (
                        mapSelectActive ? (
                            <button
                                type="button"
                                className="common-query-window-tool danger"
                                onClick={() => changeMapSelect(false)}
                            >
                                <BiX className="common-query-window-tool-icon" aria-hidden="true" />
                                <span>Harita seçimini iptal et</span>
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="common-query-window-tool"
                                onClick={() => changeMapSelect(true)}
                            >
                                <img src="images/icons/common/haritadansec.png" alt="" aria-hidden="true" />
                                <span>Haritadan Seç</span>
                            </button>
                        )
                    )}
                </div>
            )}

            {props.showNearbySearch && nearbyActive && !locating && (
                <div className="common-query-window-tools-body">
                    <div className="common-query-window-tools-distance-row">
                        <div className="common-query-window-tools-distance-range">
                            <label htmlFor={distanceId} className="visually-hidden">Yakınlık mesafesi</label>
                            <Form.Range
                                id={distanceId}
                                min={MIN_BUFFER_UNITS}
                                max={MAX_BUFFER_UNITS}
                                value={bufferDistance}
                                onChange={event => updateBufferUnits(event.target.value)}
                                aria-valuetext={`${bufferMeters} metre`}
                            />
                        </div>
                        <div className="common-query-window-tools-buffer-distance-indicator">
                            <label htmlFor={meterId} className="visually-hidden">Yakınlık mesafesi metre</label>
                            <input
                                id={meterId}
                                type="number"
                                className="form-control"
                                min={MIN_BUFFER_UNITS * 100}
                                max={MAX_BUFFER_UNITS * 100}
                                step="100"
                                value={bufferMeters}
                                onChange={event => updateBufferMeters(event.target.value)}
                            />
                            <span>&nbsp;m</span>
                        </div>
                    </div>
                    <p className="common-query-window-tools-distance-help">
                        Seçilen konumun {bufferMeters.toLocaleString("tr-TR")} metre çevresindeki kayıtlar sorgulanır.
                    </p>
                </div>
            )}

            {props.showMapSelect && mapSelectActive && (
                <div className="common-query-window-tools-body">
                    <div className="common-query-window-tools-mapselect-message" role="status">
                        <BiInfoCircle aria-hidden="true" />
                        <span>Lütfen haritaya tıklayarak bir öğe seçin.</span>
                    </div>
                </div>
            )}
        </>
    );
});

CommonQueryWindowTools.displayName = "CommonQueryWindowTools";
