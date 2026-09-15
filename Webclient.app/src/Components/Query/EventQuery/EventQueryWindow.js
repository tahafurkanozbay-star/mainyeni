import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { EventQueryBusiness } from "../../../Business/EventQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import ReactDatePicker, { registerLocale } from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import tr from "date-fns/locale/tr";
import { DatetimeHelper } from "../../../Toolbox/DatetimeHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

registerLocale("tr", tr);

const DEFAULT_QUERY = Object.freeze({
    name: null,
    districtId: null,
    districtName: null,
    nbhoodId: null,
    nbhoodName: null,
    startDate: null,
    endDate: null,
    showMapSelect: false,
    showNearby: false
});

export const EventQueryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "Etkinlik";
    const windowLogo = "images/icons/sidebar/etkinlikler.png";

    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [query, setQuery] = useState({ ...DEFAULT_QUERY });
    const [clusterLayer, setClusterLayer] = useState(null);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);

    const setQueryField = (field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    };

    const removeLastClusterLayer = () => {
        if (clusterLayer?.layerObj && mapView?.map) {
            mapView.map.remove(clusterLayer.layerObj);
            setClusterLayer(null);
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => DebugHelper.Log("show " + props.id),
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery({ ...DEFAULT_QUERY });
            setActiveTab("form");
            setResultList(null);
            setNbhoodList([]);
            removeLastClusterLayer();
        }
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());

        let active = true;
        NumberingQueryBusiness.GetDistricts().then(result => {
            if (active && result?.type === Constants_ServiceResultType.Success) {
                setDistrictList(result.data || []);
            }
        }).catch(() => {
            if (active) setDistrictList([]);
        });

        return () => {
            active = false;
        };
    }, [props.windowManager, ref]);

    const onDistrictChange = event => {
        const districtId = event.target.value;
        const districtName = event.target.selectedOptions[0]?.text || "";
        setQuery(current => ({
            ...current,
            districtId,
            districtName,
            nbhoodId: null,
            nbhoodName: null
        }));
        setNbhoodList([]);

        if (!districtId) return;
        NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId).then(result => {
            if (result?.type === Constants_ServiceResultType.Success) setNbhoodList(result.data || []);
        }).catch(() => setNbhoodList([]));
    };

    const onNeighborhoodChange = event => {
        setQuery(current => ({
            ...current,
            nbhoodId: event.target.value,
            nbhoodName: event.target.selectedOptions[0]?.text || ""
        }));
    };

    const backToForm = () => {
        removeLastClusterLayer();
        setActiveTab("form");
    };

    const submitQuery = async event => {
        event?.preventDefault();
        if (loading) return;
        setLoading(true);

        LoggingBusiness.CreateClientLog(
            "Etkinlikler/Sorgu",
            `${query.districtName || ""}/${query.nbhoodName || ""}/${query.name || ""}`
        );

        try {
            const result = await EventQueryBusiness.Query(query, false);
            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error(result?.message || "Etkinlik sorgusu tamamlanamadı");
            }

            const records = (result.data || []).map(item => ({
                ObjectId: item.attr?.objectid,
                Title: item.attr?.adi || "İsimsiz etkinlik",
                Address: item.attr?.adres || "Adres bilgisi bulunmuyor",
                StartDate: DatetimeHelper.ConvertFromEsriDate(item.attr?.baslangictarihi),
                EndDate: DatetimeHelper.ConvertFromEsriDate(item.attr?.bitistarihi)
            }));
            setResultList(records);
            setActiveTab("query");

            if (mapView?.map) {
                const symbol = {
                    type: "picture-marker",
                    url: windowLogo,
                    width: "48px",
                    height: "48px"
                };
                const nextClusterLayer = await CommonBusiness.Clustering.CreateClusterLayer(
                    "EventQueryUrl",
                    windowTitle,
                    query,
                    symbol,
                    true,
                    "EventQueryAttachmentUrl"
                );
                removeLastClusterLayer();
                if (nextClusterLayer?.layerObj) {
                    setClusterLayer(nextClusterLayer);
                    mapView.map.add(nextClusterLayer.layerObj);
                }
            }
        } catch (error) {
            props.windowManager.ShowMessage(
                Constants_MessageType.Error,
                error?.message || "Etkinlik sorgusu sırasında bir hata oluştu"
            );
        } finally {
            setLoading(false);
        }
    };

    const getItemDetailsById = async item => {
        const result = await EventQueryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data)) return null;
        return result.data[0] || null;
    };

    const showItemOnMap = async item => {
        try {
            LoggingBusiness.CreateClientLog("Etkinlikler/Detay Göster", `${item.ObjectId || ""}/${item.Title}`);
            const details = await getItemDetailsById(item);
            if (!details?.geometry) throw new Error("Etkinlik konumu bulunamadı");
            GisGraphicsHelper.ZoomToGeometry(mapView, details.geometry, 18);
            if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Etkinlik konumu açılamadı");
        }
    };

    const showRoute = async item => {
        try {
            const details = await getItemDetailsById(item);
            const latitude = Number(details?.geometry?.latitude ?? details?.geometry?.y);
            const longitude = Number(details?.geometry?.longitude ?? details?.geometry?.x);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Yol tarifi için konum bilgisi bulunamadı");
            const url = `https://www.google.com.tr/maps?saddr=My+Location&daddr=${encodeURIComponent(`${latitude},${longitude}`)}`;
            const opened = window.open(url, "_blank", "noopener,noreferrer");
            if (opened) opened.opener = null;
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Yol tarifi alınamadı");
        }
    };

    const isForm = activeTab === "form";

    return (
        <div className="common-query-window" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo} alt="" aria-hidden="true" />
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={isForm}
                    showMapSelect={isForm}
                />
            </div>

            <div className={`common-query-window-body ${props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : ""}`}>
                {isForm ? (
                    <Form onSubmit={submitQuery}>
                        {!query.mapSelect && (
                            <div className="horizontal-layout">
                                <Form.Group className="vertical-layout">
                                    <label className="form-label" htmlFor={`${props.id}-start-date`}>Başlangıç Tarihi</label>
                                    <ReactDatePicker
                                        id={`${props.id}-start-date`}
                                        selected={query.startDate}
                                        locale="tr"
                                        dateFormat="dd.MM.yyyy"
                                        className="form-control"
                                        placeholderText="Seçiniz..."
                                        onChange={date => setQueryField("startDate", date)}
                                    />
                                </Form.Group>
                                <Form.Group className="vertical-layout">
                                    <label className="form-label" htmlFor={`${props.id}-end-date`}>Bitiş Tarihi</label>
                                    <ReactDatePicker
                                        id={`${props.id}-end-date`}
                                        selected={query.endDate}
                                        locale="tr"
                                        dateFormat="dd.MM.yyyy"
                                        className="form-control"
                                        placeholderText="Seçiniz..."
                                        onChange={date => setQueryField("endDate", date)}
                                    />
                                </Form.Group>
                            </div>
                        )}

                        {!query.showNearby && !query.mapSelect && (
                            <>
                                <Form.Group>
                                    <label className="form-label" htmlFor={`${props.id}-district`}>İlçe</label>
                                    <select id={`${props.id}-district`} className="form-select form-control" onChange={onDistrictChange} value={query.districtId || ""}>
                                        <option value="">Seçiniz..</option>
                                        {districtList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}
                                    </select>
                                </Form.Group>
                                <Form.Group>
                                    <label className="form-label" htmlFor={`${props.id}-neighborhood`}>Mahalle</label>
                                    <select id={`${props.id}-neighborhood`} className="form-select" onChange={onNeighborhoodChange} value={query.nbhoodId || ""}>
                                        <option value="">Seçiniz..</option>
                                        {nbhoodList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}
                                    </select>
                                </Form.Group>
                            </>
                        )}

                        {!query.mapSelect && <Form.Group>{loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span></Button>}</Form.Group>}
                    </Form>
                ) : (
                    <div className="results-container">
                        <div className="results-container-toolbar">
                            <button type="button" className="results-container-back-button" onClick={backToForm}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön</button>
                            <div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div>
                        </div>
                        {resultList?.map(item => (
                            <div
                                className="result-item-container"
                                key={item.ObjectId ?? `${item.Title}-${item.StartDate}`}
                                role="button"
                                tabIndex={0}
                                onClick={() => showItemOnMap(item)}
                                onKeyDown={event => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        showItemOnMap(item);
                                    }
                                }}
                            >
                                <div className="result-item-info">
                                    <div className="result-item-info-title">{item.Title}</div>
                                    <div className="result-item-info-date">{item.StartDate === item.EndDate ? item.StartDate : `${item.StartDate} - ${item.EndDate}`}</div>
                                    <div className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</div>
                                </div>
                                <CommonQueryResultItemTools item={item} zoomCallback={() => showItemOnMap(item)} showRouteCallback={() => showRoute(item)} />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

EventQueryWindow.displayName = "EventQueryWindow";
