import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { BiSearch } from "react-icons/bi";
import { TkgmQueryBusiness } from "../../../Business/TkgmQueryBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { AppConfig } from "../../../Core/AppConfig";
import { Constants_MessageType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { CommonQueryWindowTools } from "../../Query/_Common/CommonQueryWindowTools";
import "./CityBlockParcelQueryWindow.css";

const INITIAL_QUERY = Object.freeze({
    district: "",
    districtName: "",
    nbhood: "",
    nbhoodName: "",
    cityblock: "",
    parcel: ""
});

const createInitialQuery = () => ({ ...INITIAL_QUERY });
const normalizeAdministrativeItem = item => ({ id: item?.properties?.id, title: item?.properties?.text || "" });
const safeLog = (type, description) => Promise.resolve(LoggingBusiness.CreateClientLog(type, description)).catch(() => {});

export const CityBlockParcelQueryWindow = React.forwardRef((props, ref) => {
    const { id, windowManager } = props;
    const mapViewRef = useRef(null);
    const parcelGraphicRef = useRef(null);
    const requestIdRef = useRef(0);

    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [query, setQuery] = useState(createInitialQuery);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    const clearParcelGraphic = useCallback(() => {
        if (parcelGraphicRef.current) {
            GisGraphicsHelper.RemoveGraphics(mapViewRef.current, parcelGraphicRef.current);
            parcelGraphicRef.current = null;
        }
    }, []);

    const resetWindow = useCallback(() => {
        requestIdRef.current += 1;
        clearParcelGraphic();
        setQuery(createInitialQuery());
        setNbhoodList([]);
        setLoading(false);
        setErrorMessage("");
    }, [clearParcelGraphic]);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: () => windowManager.ShowWindow("sidebar"),
        OnClose: resetWindow
    }), [id, resetWindow, windowManager]);

    useEffect(() => {
        windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();
        let active = true;

        TkgmQueryBusiness.GetDistricts(AppConfig.Api.TkgmCityId)
            .then(result => {
                if (!active) return;
                if (!Array.isArray(result)) throw new Error("TKGM ilçe listesi alınamadı.");
                setDistrictList(result.map(normalizeAdministrativeItem).filter(item => item.id !== undefined && item.id !== null));
            })
            .catch(error => {
                if (!active) return;
                setDistrictList([]);
                const message = error?.message || "TKGM ilçe listesi alınamadı.";
                setErrorMessage(message);
                windowManager.ShowMessage(Constants_MessageType.Error, message);
            });

        return () => {
            active = false;
            requestIdRef.current += 1;
            clearParcelGraphic();
            mapViewRef.current = null;
        };
    }, [clearParcelGraphic, ref, windowManager]);

    const setQueryField = (field, value) => setQuery(current => ({ ...current, [field]: value }));

    const onDistrictChange = async event => {
        const district = event.target.value;
        const districtName = district ? event.target.selectedOptions[0]?.text || "" : "";
        const requestId = ++requestIdRef.current;
        setQuery(current => ({ ...current, district, districtName, nbhood: "", nbhoodName: "" }));
        setNbhoodList([]);
        setErrorMessage("");
        if (!district) return;

        try {
            const result = await TkgmQueryBusiness.GetNeighborhoodsOfDistrict(district);
            if (requestId !== requestIdRef.current) return;
            setNbhoodList(Array.isArray(result)
                ? result.map(normalizeAdministrativeItem).filter(item => item.id !== undefined && item.id !== null)
                : []);
        } catch (error) {
            if (requestId !== requestIdRef.current) return;
            const message = error?.message || "TKGM mahalle listesi alınamadı.";
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        }
    };

    const onNeighborhoodChange = event => {
        const nbhood = event.target.value;
        const nbhoodName = nbhood ? event.target.selectedOptions[0]?.text || "" : "";
        setQuery(current => ({ ...current, nbhood, nbhoodName }));
    };

    const getValidationMessage = () => {
        if (!String(query.district).trim()) return "Lütfen ilçe seçiniz.";
        if (!String(query.nbhood).trim()) return "Lütfen mahalle seçiniz.";
        if (!String(query.cityblock).trim() || String(query.cityblock).trim() === "0") return "Lütfen geçerli bir ada no giriniz.";
        if (!String(query.parcel).trim() || String(query.parcel).trim() === "0") return "Lütfen geçerli bir parsel no giriniz.";
        return "";
    };

    const showParcel = async item => {
        const geometry = await GisGraphicsHelper.CreatePolygonFromXYPoints(item.geometry.coordinates);
        const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(geometry);
        clearParcelGraphic();
        parcelGraphicRef.current = graphic;
        GisGraphicsHelper.AddGraphics(mapViewRef.current, graphic);
        GisGraphicsHelper.ZoomToGeometryExtent(mapViewRef.current, geometry, 3);
    };

    const submitQuery = async event => {
        event?.preventDefault();
        if (loading) return;

        const validationMessage = getValidationMessage();
        if (validationMessage) {
            setErrorMessage(validationMessage);
            windowManager.ShowMessage(Constants_MessageType.Error, validationMessage);
            return;
        }

        const requestId = ++requestIdRef.current;
        const logPayload = `${query.districtName}/${query.nbhoodName}/${query.cityblock}/${query.parcel}`;
        setLoading(true);
        setErrorMessage("");
        safeLog("Ada Parsel/Sorgu", logPayload);

        try {
            const result = await TkgmQueryBusiness.GetParcels(query);
            if (requestId !== requestIdRef.current) return;
            if (!result?.geometry?.coordinates) throw new Error("Parsel bulunamadı.");
            safeLog("Ada Parsel/Detay Göster", logPayload);
            await showParcel(result);
        } catch (error) {
            if (requestId !== requestIdRef.current) return;
            const message = error?.message || "Parsel sorgusu tamamlanamadı.";
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    };

    const districtId = `${id}-district`;
    const neighborhoodId = `${id}-neighborhood`;
    const cityBlockId = `${id}-cityblock`;
    const parcelId = `${id}-parcel`;

    return (
        <section
            className="common-query-window common-query-window-right"
            aria-label="Ada-Parsel Arama"
            style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/adaparsel.png" alt="" aria-hidden="true" />
                <span>Ada-Parsel Arama</span>
                <CommonQueryWindowTools windowManager={windowManager} windowId={id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={null} />
            </header>

            <div className="common-query-window-body">
                <Form onSubmit={submitQuery} aria-label="Ada parsel filtreleri" noValidate>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={districtId}>İlçe</label>
                        <select id={districtId} className="form-select" onChange={onDistrictChange} value={query.district} aria-invalid={!query.district && Boolean(errorMessage)}>
                            <option value="">Seçiniz..</option>
                            {districtList.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                        </select>
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={neighborhoodId}>Mahalle</label>
                        <select id={neighborhoodId} className="form-select" value={query.nbhood} onChange={onNeighborhoodChange} disabled={!query.district}>
                            <option value="">Seçiniz..</option>
                            {nbhoodList.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
                        </select>
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={cityBlockId}>Ada</label>
                        <input id={cityBlockId} type="text" inputMode="numeric" autoComplete="off" className="form-control" value={query.cityblock} onChange={event => setQueryField("cityblock", event.target.value)} />
                    </Form.Group>
                    <Form.Group>
                        <label className="form-label form-label-white" htmlFor={parcelId}>Parsel</label>
                        <input id={parcelId} type="text" inputMode="numeric" autoComplete="off" className="form-control" value={query.parcel} onChange={event => setQueryField("parcel", event.target.value)} />
                    </Form.Group>
                    {errorMessage && <div className="kr-status-banner kr-status-banner--danger" role="alert">{errorMessage}</div>}
                    <Form.Group>
                        {loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span></Button>}
                    </Form.Group>
                </Form>
            </div>
        </section>
    );
});

CityBlockParcelQueryWindow.displayName = "CityBlockParcelQueryWindow";
