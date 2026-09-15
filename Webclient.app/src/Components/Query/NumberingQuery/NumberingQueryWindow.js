import React, { useEffect, useImperativeHandle, useState } from "react";
import { Form } from "react-bootstrap";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import "./NumberingQueryWindow.css";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";

const INITIAL_QUERY = Object.freeze({ district: "", districtName: "", nbhood: "", nbhoodName: "", street: "", streetName: "", door: "" });

export const NumberingQueryWindow = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [streetList, setStreetList] = useState([]);
    const [doorList, setDoorList] = useState([]);
    const [highlightGraphic, setHighlightGraphic] = useState(null);
    const [query, setQuery] = useState({ ...INITIAL_QUERY });

    const clearHighlight = () => {
        if (highlightGraphic && mapView) {
            GisGraphicsHelper.RemoveGraphics(mapView, highlightGraphic);
            setHighlightGraphic(null);
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => props.windowManager.ShowWindow("sidebar"),
        OnClose: () => {
            clearHighlight();
            setQuery({ ...INITIAL_QUERY });
            setNbhoodList([]);
            setStreetList([]);
            setDoorList([]);
        }
    }), [props.id, props.windowManager, highlightGraphic, mapView]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());
        let active = true;
        NumberingQueryBusiness.GetDistricts().then(result => {
            if (active && result?.type === Constants_ServiceResultType.Success) setDistrictList(result.data || []);
        }).catch(() => {
            if (active) setDistrictList([]);
        });
        return () => {
            active = false;
        };
    }, [props.windowManager, ref]);

    const setQueryField = (field, value) => setQuery(current => ({ ...current, [field]: value }));

    const zoomToObject = async (geometries, zoomLevel) => {
        if (!mapView || !geometries?.length) return;
        clearHighlight();
        const projected = await Promise.all(geometries.map(geometry => GisGraphicsHelper.ProjectGeometry(geometry, "4326")));
        await GisGraphicsHelper.ZoomToGeometry(mapView, projected, zoomLevel);
        const graphics = await Promise.all(projected.map(geometry => GisGraphicsHelper.CreateGraphicFromGeometry(geometry)));
        setHighlightGraphic(graphics);
        GisGraphicsHelper.AddGraphics(mapView, graphics);
    };

    const onDistrictChange = async event => {
        const districtId = event.target.value;
        const districtName = event.target.selectedOptions[0]?.text || "";
        setQuery(current => ({ ...current, district: districtId, districtName, nbhood: "", nbhoodName: "", street: "", streetName: "", door: "" }));
        setNbhoodList([]);
        setStreetList([]);
        setDoorList([]);
        if (!districtId) return;

        const [districtResult, neighborhoodsResult] = await Promise.all([
            NumberingQueryBusiness.GetDistrictById(districtId),
            NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId)
        ]);
        if (districtResult?.type === Constants_ServiceResultType.Success && districtResult.data?.[0]?.geometry) {
            zoomToObject([districtResult.data[0].geometry], null);
        }
        if (neighborhoodsResult?.type === Constants_ServiceResultType.Success) setNbhoodList(neighborhoodsResult.data || []);
    };

    const onNeighborhoodChange = async event => {
        const nbhoodId = event.target.value;
        const nbhoodName = event.target.selectedOptions[0]?.text || "";
        setQuery(current => ({ ...current, nbhood: nbhoodId, nbhoodName, street: "", streetName: "", door: "" }));
        setStreetList([]);
        setDoorList([]);
        if (!nbhoodId) return;

        const [neighborhoodResult, streetsResult] = await Promise.all([
            NumberingQueryBusiness.GetNeighborhoodById(nbhoodId),
            NumberingQueryBusiness.GetStreets(nbhoodId)
        ]);
        if (neighborhoodResult?.type === Constants_ServiceResultType.Success && neighborhoodResult.data?.[0]?.geometry) {
            zoomToObject([neighborhoodResult.data[0].geometry], null);
        }
        setStreetList(streetsResult?.data || []);
    };

    const onStreetChange = async event => {
        const streetId = event.target.value;
        const streetName = event.target.selectedOptions[0]?.text || "";
        setQuery(current => ({ ...current, street: streetId, streetName, door: "" }));
        setDoorList([]);
        if (!streetId) return;

        const [centerLines, doorsResult] = await Promise.all([
            NumberingQueryBusiness.GetStreetCenterLines(streetId),
            NumberingQueryBusiness.GetDoors(streetId)
        ]);
        const geometries = (centerLines || []).map(item => item.geometry).filter(Boolean);
        if (geometries.length) zoomToObject(geometries, null);
        setDoorList(doorsResult?.data || []);
    };

    const onDoorChange = async event => {
        const doorId = event.target.value;
        setQueryField("door", doorId);
        if (!doorId) return;
        LoggingBusiness.CreateClientLog("Numarataj/Sorgu", `${query.districtName}/${query.nbhoodName}/${query.streetName}/${doorId}`);
        const result = await NumberingQueryBusiness.GetDoorById(doorId);
        if (result?.type === Constants_ServiceResultType.Success && result.data?.[0]?.geometry) zoomToObject([result.data[0].geometry], 18);
    };

    const select = (id, label, value, onChange, items, valueKey, labelKey) => (
        <Form.Group>
            <label className="form-label form-label-white" htmlFor={id}>{label}</label>
            <select id={id} className="form-select" value={value} onChange={onChange}>
                <option value="">Seçiniz..</option>
                {items.map(item => <option key={item.attr?.[valueKey]} value={item.attr?.[valueKey]}>{item.attr?.[labelKey]}</option>)}
            </select>
        </Form.Group>
    );

    return (
        <div className="common-query-window common-query-window-right" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/adresarama.png" alt="" aria-hidden="true" />
                <span>Adres Arama</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>
            <div className="common-query-window-body">
                <Form>
                    {select(`${props.id}-district`, "İlçe", query.district, onDistrictChange, districtList, "id", "ad")}
                    {select(`${props.id}-neighborhood`, "Mahalle", query.nbhood, onNeighborhoodChange, nbhoodList, "id", "ad")}
                    {select(`${props.id}-street`, "Cadde/Sokak", query.street, onStreetChange, streetList, "yolid", "ad")}
                    {select(`${props.id}-door`, "Bina No", query.door, onDoorChange, doorList, "id", "kapino")}
                </Form>
            </div>
        </div>
    );
});

NumberingQueryWindow.displayName = "NumberingQueryWindow";
