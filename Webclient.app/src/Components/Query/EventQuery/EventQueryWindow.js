import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { BiSearch } from "react-icons/bi";
import { FiMapPin } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import ReactDatePicker, { registerLocale } from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import tr from "date-fns/locale/tr";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { EventQueryBusiness } from "../../../Business/EventQueryBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { DatetimeHelper } from "../../../Toolbox/DatetimeHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { createPictureMarkerSymbol, resolveRecordIconUrl } from "../../../gis-engine/iconPresentation";
import { ButtonLoading } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";

registerLocale("tr", tr);

const WINDOW_TITLE = "Etkinlik";
const SERVICE_KEY = "EventQueryUrl";
const DEFAULT_QUERY = Object.freeze({
    name: "",
    districtId: "",
    districtName: "",
    nbhoodId: "",
    nbhoodName: "",
    startDate: null,
    endDate: null,
    mapSelect: false,
    showNearby: false,
    userLocation: null,
    bufferDistance: 20
});
const ICON_RECORD = Object.freeze({ type: SERVICE_KEY, category: "Etkinlikler", title: WINDOW_TITLE });
const WINDOW_LOGO = resolveRecordIconUrl(ICON_RECORD);
const MAP_SYMBOL = Object.freeze(createPictureMarkerSymbol(ICON_RECORD, 12, { minSize: 48, maxSize: 48 }));

const createDefaultQuery = () => ({ ...DEFAULT_QUERY });
const safeLog = (name, payload) => Promise.resolve(LoggingBusiness.CreateClientLog(name, payload)).catch(() => {});

const normalizeEvent = item => ({
    ObjectId: item?.attr?.objectid ?? item?.attr?.OBJECTID ?? null,
    Title: item?.attr?.adi ?? item?.attr?.ADI ?? "İsimsiz etkinlik",
    Address: item?.attr?.adres ?? item?.attr?.ADRES ?? "Adres bilgisi bulunmuyor",
    StartDate: DatetimeHelper.ConvertFromEsriDate(item?.attr?.baslangictarihi ?? item?.attr?.BASLANGICTARIHI),
    EndDate: DatetimeHelper.ConvertFromEsriDate(item?.attr?.bitistarihi ?? item?.attr?.BITISTARIHI)
});

export const EventQueryWindow = React.forwardRef((props, ref) => {
    const { id, windowManager } = props;
    const mapViewRef = useRef(null);
    const clusterLayerRef = useRef(null);
    const requestIdRef = useRef(0);

    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [query, setQuery] = useState(createDefaultQuery);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);

    const setQueryField = useCallback((field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    }, []);

    const removeLastClusterLayer = useCallback(() => {
        const layer = clusterLayerRef.current?.layerObj || clusterLayerRef.current;
        if (layer && mapViewRef.current?.map) mapViewRef.current.map.remove(layer);
        clusterLayerRef.current = null;
    }, []);

    const resetWindow = useCallback(() => {
        requestIdRef.current += 1;
        removeLastClusterLayer();
        setQuery(createDefaultQuery());
        setNbhoodList([]);
        setResultList(null);
        setActiveTab("form");
        setLoading(false);
    }, [removeLastClusterLayer]);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: resetWindow
    }), [id, resetWindow]);

    useEffect(() => {
        windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();
        let active = true;

        NumberingQueryBusiness.GetDistricts()
            .then(result => {
                if (active && result?.type === Constants_ServiceResultType.Success) setDistrictList(result.data || []);
            })
            .catch(() => {
                if (active) setDistrictList([]);
            });

        return () => {
            active = false;
            requestIdRef.current += 1;
            removeLastClusterLayer();
            mapViewRef.current = null;
        };
    }, [ref, removeLastClusterLayer, windowManager]);

    const onDistrictChange = async event => {
        const districtId = event.target.value;
        const districtName = districtId ? event.target.selectedOptions[0]?.text || "" : "";
        const requestId = ++requestIdRef.current;

        setQuery(current => ({ ...current, districtId, districtName, nbhoodId: "", nbhoodName: "" }));
        setNbhoodList([]);
        if (!districtId) return;

        try {
            const result = await NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId);
            if (requestId !== requestIdRef.current) return;
            if (result?.type === Constants_ServiceResultType.Success) setNbhoodList(result.data || []);
        } catch (error) {
            if (requestId === requestIdRef.current) setNbhoodList([]);
        }
    };

    const onNeighborhoodChange = event => {
        const nbhoodId = event.target.value;
        const nbhoodName = nbhoodId ? event.target.selectedOptions[0]?.text || "" : "";
        setQuery(current => ({ ...current, nbhoodId, nbhoodName }));
    };

    const submitQuery = async event => {
        event?.preventDefault();
        if (loading) return;

        const requestId = ++requestIdRef.current;
        setLoading(true);
        safeLog("Etkinlikler/Sorgu", `${query.districtName}/${query.nbhoodName}/${query.name}`);

        try {
            const result = await EventQueryBusiness.Query(query, false);
            if (requestId !== requestIdRef.current) return;
            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error(result?.message || "Etkinlik sorgusu tamamlanamadı.");
            }

            setResultList((result.data || []).map(normalizeEvent));
            setActiveTab("query");

            const nextClusterLayer = await CommonBusiness.Clustering.CreateClusterLayer(
                SERVICE_KEY,
                WINDOW_TITLE,
                query,
                MAP_SYMBOL,
                true,
                "EventQueryAttachmentUrl"
            );
            if (requestId !== requestIdRef.current) return;

            removeLastClusterLayer();
            if (nextClusterLayer?.layerObj && mapViewRef.current?.map) {
                clusterLayerRef.current = nextClusterLayer;
                mapViewRef.current.map.add(nextClusterLayer.layerObj);
            }
        } catch (error) {
            if (requestId === requestIdRef.current) {
                windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Etkinlik sorgusu sırasında bir hata oluştu.");
            }
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    };

    const getItemDetailsById = async item => {
        if (item?.ObjectId === null || item?.ObjectId === undefined) return null;
        const result = await EventQueryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data)) return null;
        return result.data[0] || null;
    };

    const showItemOnMap = async item => {
        try {
            safeLog("Etkinlikler/Detay Göster", `${item.ObjectId ?? ""}/${item.Title}`);
            const details = await getItemDetailsById(item);
            if (!details?.geometry) throw new Error("Etkinlik konumu bulunamadı.");
            GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, details.geometry, 18);
            if (window.matchMedia?.("(max-width: 959px)").matches) windowManager.ToggleMinimiseWindow(id);
        } catch (error) {
            windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Etkinlik konumu açılamadı.");
        }
    };

    const showRoute = async item => {
        try {
            const details = await getItemDetailsById(item);
            const latitude = Number(details?.geometry?.latitude ?? details?.geometry?.y);
            const longitude = Number(details?.geometry?.longitude ?? details?.geometry?.x);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            }
            const coordinates = encodeURIComponent(`${latitude},${longitude}`);
            const opened = window.open(
                `https://www.google.com.tr/maps?saddr=My+Location&daddr=${coordinates}`,
                "_blank",
                "noopener,noreferrer"
            );
            if (opened) opened.opener = null;
        } catch (error) {
            windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Yol tarifi alınamadı.");
        }
    };

    const backToForm = () => {
        requestIdRef.current += 1;
        removeLastClusterLayer();
        setActiveTab("form");
    };

    const isForm = activeTab === "form";
    const startDateId = `${id}-event-start-date`;
    const endDateId = `${id}-event-end-date`;
    const nameId = `${id}-event-name`;
    const districtId = `${id}-event-district`;
    const neighborhoodId = `${id}-event-neighborhood`;

    return (
        <section className="common-query-window" aria-label={WINDOW_TITLE} style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}>
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={WINDOW_LOGO} alt="" aria-hidden="true" />
                <span>{WINDOW_TITLE}</span>
                <CommonQueryWindowTools
                    windowManager={windowManager}
                    windowId={id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={isForm}
                    showMapSelect={isForm}
                />
            </header>

            <div className={`common-query-window-body ${windowManager.IsMinimized(id) ? "common-query-window-body-collapsed" : ""}`}>
                {isForm ? (
                    <Form onSubmit={submitQuery} aria-label="Etkinlik filtreleri">
                        {!query.mapSelect && (
                            <>
                                <Form.Group>
                                    <label className="form-label" htmlFor={nameId}>Adı</label>
                                    <input id={nameId} className="form-control" value={query.name} onChange={event => setQueryField("name", event.target.value)} />
                                </Form.Group>
                                <div className="horizontal-layout">
                                    <Form.Group className="vertical-layout">
                                        <label className="form-label" htmlFor={startDateId}>Başlangıç Tarihi</label>
                                        <ReactDatePicker id={startDateId} selected={query.startDate} locale="tr" dateFormat="dd.MM.yyyy" className="form-control" placeholderText="Seçiniz..." onChange={date => setQueryField("startDate", date)} />
                                    </Form.Group>
                                    <Form.Group className="vertical-layout">
                                        <label className="form-label" htmlFor={endDateId}>Bitiş Tarihi</label>
                                        <ReactDatePicker id={endDateId} selected={query.endDate} locale="tr" dateFormat="dd.MM.yyyy" className="form-control" placeholderText="Seçiniz..." onChange={date => setQueryField("endDate", date)} />
                                    </Form.Group>
                                </div>
                            </>
                        )}

                        {!query.showNearby && !query.mapSelect && (
                            <>
                                <Form.Group>
                                    <label className="form-label" htmlFor={districtId}>İlçe</label>
                                    <select id={districtId} className="form-select form-control" value={query.districtId} onChange={onDistrictChange}>
                                        <option value="">Seçiniz..</option>
                                        {districtList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}
                                    </select>
                                </Form.Group>
                                <Form.Group>
                                    <label className="form-label" htmlFor={neighborhoodId}>Mahalle</label>
                                    <select id={neighborhoodId} className="form-select" value={query.nbhoodId} onChange={onNeighborhoodChange} disabled={!query.districtId}>
                                        <option value="">Seçiniz..</option>
                                        {nbhoodList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}
                                    </select>
                                </Form.Group>
                            </>
                        )}

                        {!query.mapSelect && (
                            <Form.Group>
                                {loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span></Button>}
                            </Form.Group>
                        )}
                    </Form>
                ) : (
                    <div className="results-container">
                        <div className="results-container-toolbar">
                            <button type="button" className="results-container-back-button" onClick={backToForm}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön</button>
                            <div className="results-container-count" aria-live="polite"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div>
                        </div>
                        {resultList?.map(item => (
                            <article className="result-item-container" key={item.ObjectId ?? `${item.Title}-${item.StartDate}`}>
                                <button type="button" className="result-item-info" onClick={() => showItemOnMap(item)} aria-label={`${item.Title} konumunu haritada göster`}>
                                    <span className="result-item-info-title">{item.Title}</span>
                                    <span className="result-item-info-date">{item.StartDate === item.EndDate ? item.StartDate : `${item.StartDate} - ${item.EndDate}`}</span>
                                    <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</span>
                                </button>
                                <CommonQueryResultItemTools item={item} zoomCallback={() => showItemOnMap(item)} showRouteCallback={() => showRoute(item)} />
                            </article>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
});

EventQueryWindow.displayName = "EventQueryWindow";
