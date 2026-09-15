import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { TkgmQueryBusiness } from "../../../Business/TkgmQueryBusiness";
import { AppConfig } from "../../../Core/AppConfig";
import MapManager from "../../../Store/Managers/MapManager";
import "./CityBlockParcelQueryWindow.css";
import { BiSearch } from "react-icons/bi";
import { Constants_MessageType } from "../../../Core/Constants";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { ButtonLoading } from "../../Common/Loading";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";

const INITIAL_QUERY = Object.freeze({
    district: "",
    districtName: "",
    nbhood: "",
    nbhoodName: "",
    cityblock: "",
    parcel: ""
});

export const CityBlockParcelQueryWindow = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [query, setQuery] = useState({ ...INITIAL_QUERY });
    const [loading, setLoading] = useState(false);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => props.windowManager.ShowWindow("sidebar"),
        OnClose: () => {
            setQuery({ ...INITIAL_QUERY });
            setNbhoodList([]);
        }
    }), [props.id, props.windowManager]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());
        let active = true;

        TkgmQueryBusiness.GetDistricts(AppConfig.Api.TkgmCityId).then(result => {
            if (!active) return;
            if (!Array.isArray(result)) {
                setDistrictList([]);
                props.windowManager.ShowMessage(Constants_MessageType.Error, "TKGM ilçe listesi alınamadı");
                return;
            }
            setDistrictList(result.map(item => ({
                id: item.properties.id,
                title: item.properties.text
            })));
        }).catch(error => {
            if (!active) return;
            setDistrictList([]);
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "TKGM ilçe listesi alınamadı");
        });

        return () => {
            active = false;
        };
    }, [props.windowManager, ref]);

    const setQueryField = (field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    };

    const onDistrictChange = async event => {
        const district = event.target.value;
        const districtName = event.target.selectedOptions[0]?.text || "";
        setQuery(current => ({ ...current, district, districtName, nbhood: "", nbhoodName: "" }));
        setNbhoodList([]);
        if (!district) return;

        try {
            const result = await TkgmQueryBusiness.GetNeighborhoodsOfDistrict(district);
            setNbhoodList(Array.isArray(result) ? result.map(item => ({
                id: item.properties.id,
                title: item.properties.text
            })) : []);
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "TKGM mahalle listesi alınamadı");
        }
    };

    const onNeighborhoodChange = event => {
        setQuery(current => ({
            ...current,
            nbhood: event.target.value,
            nbhoodName: event.target.selectedOptions[0]?.text || ""
        }));
    };

    const validateQuery = () => {
        let message = "";
        if (!String(query.district).trim()) message = "Lütfen ilçe seçiniz...";
        else if (!String(query.nbhood).trim()) message = "Lütfen mahalle seçiniz...";
        else if (!String(query.cityblock).trim() || String(query.cityblock).trim() === "0") message = "Lütfen ada no giriniz...";
        else if (!String(query.parcel).trim() || String(query.parcel).trim() === "0") message = "Lütfen parsel no giriniz...";

        if (message) props.windowManager.ShowMessage(Constants_MessageType.Error, message);
        return !message;
    };

    const gotoParcel = async item => {
        LoggingBusiness.CreateClientLog(
            "Ada Parsel/Detay Göster",
            `${query.districtName}/${query.nbhoodName}/${query.cityblock}/${query.parcel}`
        );
        const geometry = await GisGraphicsHelper.CreatePolygonFromXYPoints(item.geometry.coordinates);
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(geometry);
        GisGraphicsHelper.AddGraphics(mapView, graphic);
        GisGraphicsHelper.ZoomToGeometryExtent(mapView, geometry, 3);
    };

    const submitQuery = async event => {
        event?.preventDefault();
        if (!validateQuery() || loading) return;
        setLoading(true);
        LoggingBusiness.CreateClientLog(
            "Ada Parsel/Sorgu",
            `${query.districtName}/${query.nbhoodName}/${query.cityblock}/${query.parcel}`
        );

        try {
            const result = await TkgmQueryBusiness.GetParcels(query);
            if (!result?.geometry) {
                props.windowManager.ShowMessage(Constants_MessageType.Error, "Parsel bulunamadı");
                return;
            }
            await gotoParcel(result);
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Parsel sorgusu tamamlanamadı");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="common-query-window common-query-window-right" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/adaparsel.png" alt="" aria-hidden="true" />
                <span>Ada-Parsel Arama</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </div>

            <div className="common-query-window-body">
                <Form onSubmit={submitQuery}>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={`${props.id}-district`}>İlçe</label>
                        <select id={`${props.id}-district`} className="form-select" onChange={onDistrictChange} value={query.district}>
                            <option value="">Seçiniz..</option>
                            {districtList.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                        </select>
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={`${props.id}-neighborhood`}>Mahalle</label>
                        <select id={`${props.id}-neighborhood`} className="form-select" value={query.nbhood} onChange={onNeighborhoodChange}>
                            <option value="">Seçiniz..</option>
                            {nbhoodList.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                        </select>
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={`${props.id}-cityblock`}>Ada</label>
                        <input id={`${props.id}-cityblock`} type="text" inputMode="numeric" className="form-control" value={query.cityblock} onChange={event => setQueryField("cityblock", event.target.value)} />
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={`${props.id}-parcel`}>Parsel</label>
                        <input id={`${props.id}-parcel`} type="text" inputMode="numeric" className="form-control" value={query.parcel} onChange={event => setQueryField("parcel", event.target.value)} />
                    </Form.Group>
                    <Form.Group>
                        {loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span></Button>}
                    </Form.Group>
                </Form>
            </div>
        </div>
    );
});

CityBlockParcelQueryWindow.displayName = "CityBlockParcelQueryWindow";
