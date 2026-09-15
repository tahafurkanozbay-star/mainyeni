import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Form } from "react-bootstrap";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./NumberingQueryWindow.css";

const INITIAL_QUERY = Object.freeze({
    district: "",
    districtName: "",
    nbhood: "",
    nbhoodName: "",
    street: "",
    streetName: "",
    door: ""
});

const createInitialQuery = () => ({ ...INITIAL_QUERY });

const safeLog = (name, payload) => {
    Promise.resolve(LoggingBusiness.CreateClientLog(name, payload)).catch(() => {});
};

export const NumberingQueryWindow = React.forwardRef((props, ref) => {
    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [streetList, setStreetList] = useState([]);
    const [doorList, setDoorList] = useState([]);
    const [query, setQuery] = useState(createInitialQuery);

    const mapViewRef = useRef(null);
    const highlightGraphicRef = useRef(null);
    const requestIdRef = useRef(0);

    const clearHighlight = useCallback(() => {
        if (highlightGraphicRef.current && mapViewRef.current) {
            GisGraphicsHelper.RemoveGraphics(mapViewRef.current, highlightGraphicRef.current);
        }
        highlightGraphicRef.current = null;
    }, []);

    const resetDependentLists = useCallback((level = "district") => {
        if (level === "district") setNbhoodList([]);
        if (level === "district" || level === "neighborhood") setStreetList([]);
        setDoorList([]);
    }, []);

    const resetWindow = useCallback(() => {
        requestIdRef.current += 1;
        clearHighlight();
        setQuery(createInitialQuery());
        resetDependentLists();
    }, [clearHighlight, resetDependentLists]);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => props.windowManager.ShowWindow("sidebar"),
        OnClose: resetWindow
    }), [props.id, props.windowManager, resetWindow]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();
        let active = true;

        NumberingQueryBusiness.GetDistricts()
            .then(result => {
                if (active && result?.type === Constants_ServiceResultType.Success) {
                    setDistrictList(result.data || []);
                }
            })
            .catch(() => {
                if (active) setDistrictList([]);
            });

        return () => {
            active = false;
            requestIdRef.current += 1;
            clearHighlight();
            mapViewRef.current = null;
        };
    }, [clearHighlight, props.windowManager, ref]);

    const setQueryField = (field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    };

    const zoomToObject = useCallback(async (geometries, zoomLevel, requestId = requestIdRef.current) => {
        const mapView = mapViewRef.current;
        if (!mapView || !geometries?.length) return;

        const projected = await Promise.all(
            geometries.map(geometry => GisGraphicsHelper.ProjectGeometry(geometry, "4326"))
        );
        if (requestId !== requestIdRef.current) return;

        clearHighlight();
        await GisGraphicsHelper.ZoomToGeometry(mapView, projected, zoomLevel);
        if (requestId !== requestIdRef.current) return;

        const graphics = await Promise.all(
            projected.map(geometry => GisGraphicsHelper.CreateGraphicFromGeometry(geometry))
        );
        if (requestId !== requestIdRef.current) return;

        highlightGraphicRef.current = graphics;
        GisGraphicsHelper.AddGraphics(mapView, graphics);
    }, [clearHighlight]);

    const onDistrictChange = async event => {
        const districtId = event.target.value;
        const districtName = districtId ? event.target.selectedOptions[0]?.text || "" : "";
        const requestId = ++requestIdRef.current;

        setQuery(current => ({
            ...current,
            district: districtId,
            districtName,
            nbhood: "",
            nbhoodName: "",
            street: "",
            streetName: "",
            door: ""
        }));
        resetDependentLists("district");
        clearHighlight();
        if (!districtId) return;

        const [districtResult, neighborhoodsResult] = await Promise.all([
            NumberingQueryBusiness.GetDistrictById(districtId),
            NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId)
        ]);
        if (requestId !== requestIdRef.current) return;

        if (districtResult?.type === Constants_ServiceResultType.Success && districtResult.data?.[0]?.geometry) {
            zoomToObject([districtResult.data[0].geometry], null, requestId);
        }
        if (neighborhoodsResult?.type === Constants_ServiceResultType.Success) {
            setNbhoodList(neighborhoodsResult.data || []);
        }
    };

    const onNeighborhoodChange = async event => {
        const nbhoodId = event.target.value;
        const nbhoodName = nbhoodId ? event.target.selectedOptions[0]?.text || "" : "";
        const requestId = ++requestIdRef.current;

        setQuery(current => ({
            ...current,
            nbhood: nbhoodId,
            nbhoodName,
            street: "",
            streetName: "",
            door: ""
        }));
        resetDependentLists("neighborhood");
        clearHighlight();
        if (!nbhoodId) return;

        const [neighborhoodResult, streetsResult] = await Promise.all([
            NumberingQueryBusiness.GetNeighborhoodById(nbhoodId),
            NumberingQueryBusiness.GetStreets(nbhoodId)
        ]);
        if (requestId !== requestIdRef.current) return;

        if (neighborhoodResult?.type === Constants_ServiceResultType.Success && neighborhoodResult.data?.[0]?.geometry) {
            zoomToObject([neighborhoodResult.data[0].geometry], null, requestId);
        }
        setStreetList(streetsResult?.data || []);
    };

    const onStreetChange = async event => {
        const streetId = event.target.value;
        const streetName = streetId ? event.target.selectedOptions[0]?.text || "" : "";
        const requestId = ++requestIdRef.current;

        setQuery(current => ({ ...current, street: streetId, streetName, door: "" }));
        resetDependentLists("street");
        clearHighlight();
        if (!streetId) return;

        const [centerLines, doorsResult] = await Promise.all([
            NumberingQueryBusiness.GetStreetCenterLines(streetId),
            NumberingQueryBusiness.GetDoors(streetId)
        ]);
        if (requestId !== requestIdRef.current) return;

        const geometries = (centerLines || []).map(item => item.geometry).filter(Boolean);
        if (geometries.length) zoomToObject(geometries, null, requestId);
        setDoorList(doorsResult?.data || []);
    };

    const onDoorChange = async event => {
        const doorId = event.target.value;
        const requestId = ++requestIdRef.current;
        setQueryField("door", doorId);
        clearHighlight();
        if (!doorId) return;

        safeLog("Numarataj/Sorgu", `${query.districtName}/${query.nbhoodName}/${query.streetName}/${doorId}`);
        const result = await NumberingQueryBusiness.GetDoorById(doorId);
        if (requestId !== requestIdRef.current) return;

        if (result?.type === Constants_ServiceResultType.Success && result.data?.[0]?.geometry) {
            zoomToObject([result.data[0].geometry], 18, requestId);
        }
    };

    const renderSelect = (id, label, value, onChange, items, valueKey, labelKey, disabled = false) => (
        <Form.Group>
            <label className="form-label form-label-white" htmlFor={id}>{label}</label>
            <select
                id={id}
                className="form-select"
                value={value}
                onChange={onChange}
                disabled={disabled}
            >
                <option value="">Seçiniz..</option>
                {items.map(item => (
                    <option key={item.attr?.[valueKey]} value={item.attr?.[valueKey]}>
                        {item.attr?.[labelKey]}
                    </option>
                ))}
            </select>
        </Form.Group>
    );

    return (
        <section
            className="common-query-window common-query-window-right"
            aria-label="Adres Arama"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/adresarama.png" alt="" aria-hidden="true" />
                <span>Adres Arama</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </header>
            <div className="common-query-window-body">
                <Form aria-label="Adres bileşenleri">
                    {renderSelect(`${props.id}-district`, "İlçe", query.district, onDistrictChange, districtList, "id", "ad")}
                    {renderSelect(`${props.id}-neighborhood`, "Mahalle", query.nbhood, onNeighborhoodChange, nbhoodList, "id", "ad", !query.district)}
                    {renderSelect(`${props.id}-street`, "Cadde/Sokak", query.street, onStreetChange, streetList, "yolid", "ad", !query.nbhood)}
                    {renderSelect(`${props.id}-door`, "Bina No", query.door, onDoorChange, doorList, "id", "kapino", !query.street)}
                </Form>
            </div>
        </section>
    );
});

NumberingQueryWindow.displayName = "NumberingQueryWindow";
