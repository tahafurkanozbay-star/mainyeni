import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { BiArea, BiSearch } from "react-icons/bi";
import { FiMapPin, FiUsers } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { AssemblyAreaQueryBusiness } from "../../../Business/AssemblyAreaQueryBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { createPictureMarkerSymbol, resolveRecordIconUrl } from "../../../gis-engine/iconPresentation";
import { ButtonLoading } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";

const WINDOW_TITLE = "Acil Toplanma Alanları";
const SERVICE_KEY = "AssemblyAreaQueryUrl";
const DEFAULT_QUERY = Object.freeze({
    name: "",
    districtId: "",
    districtName: "",
    nbhoodId: "",
    nbhoodName: "",
    mapSelect: false,
    showNearby: false,
    userLocation: null,
    bufferDistance: 20
});
const ICON_RECORD = Object.freeze({ type: SERVICE_KEY, category: WINDOW_TITLE, title: WINDOW_TITLE });
const WINDOW_LOGO = resolveRecordIconUrl(ICON_RECORD);
const MAP_SYMBOL = Object.freeze(createPictureMarkerSymbol(ICON_RECORD, 12, { minSize: 48, maxSize: 48 }));

const createDefaultQuery = () => ({ ...DEFAULT_QUERY });

const safeLog = (name, payload) => {
    Promise.resolve(LoggingBusiness.CreateClientLog(name, payload)).catch(() => {});
};

const normalizeResult = item => ({
    ObjectId: item?.attr?.objectid ?? item?.attr?.OBJECTID ?? null,
    Title: item?.attr?.adi ?? item?.attr?.ADI ?? "İsimsiz toplanma alanı",
    Address: item?.attr?.adres ?? item?.attr?.ADRES ?? "Adres bilgisi bulunmuyor",
    Capacity: item?.attr?.kapasite ?? item?.attr?.KAPASITE ?? null,
    Area: item?.attr?.alan ?? item?.attr?.ALAN ?? null
});

export const AssemblyAreaQueryWindow = React.forwardRef((props, ref) => {
    const { id, windowManager } = props;
    const commonToolsComponentRef = useRef(null);
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
        commonToolsComponentRef.current?.OnClose?.();
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
            removeLastClusterLayer();
            mapViewRef.current = null;
        };
    }, [ref, removeLastClusterLayer, windowManager]);

    const onDistrictChange = async event => {
        const districtId = event.target.value;
        const districtName = districtId ? event.target.selectedOptions[0]?.text || "" : "";
        const requestId = ++requestIdRef.current;

        setQuery(current => ({
            ...current,
            districtId,
            districtName,
            nbhoodId: "",
            nbhoodName: ""
        }));
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
        safeLog("Acil Toplanma Alanları/Sorgu", `${query.districtName}/${query.nbhoodName}/${query.name}`);

        try {
            const result = await AssemblyAreaQueryBusiness.Query(query, false);
            if (requestId !== requestIdRef.current) return;
            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error(result?.message || "Toplanma alanları alınamadı.");
            }

            const records = Array.isArray(result.data) ? result.data.map(normalizeResult) : [];
            setResultList(records);
            setActiveTab("query");

            const nextClusterLayer = await CommonBusiness.Clustering.CreateClusterLayer(
                SERVICE_KEY,
                WINDOW_TITLE,
                query,
                MAP_SYMBOL
            );
            if (requestId !== requestIdRef.current) {
                const staleLayer = nextClusterLayer?.layerObj;
                if (staleLayer && mapViewRef.current?.map) mapViewRef.current.map.remove(staleLayer);
                return;
            }

            removeLastClusterLayer();
            if (nextClusterLayer?.layerObj && mapViewRef.current?.map) {
                clusterLayerRef.current = nextClusterLayer;
                mapViewRef.current.map.add(nextClusterLayer.layerObj);
            }
        } catch (error) {
            if (requestId === requestIdRef.current) {
                windowManager.ShowMessage(
                    Constants_MessageType.Error,
                    error?.message || "Toplanma alanı sorgusu tamamlanamadı."
                );
            }
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    };

    const getItemDetailsById = async item => {
        if (item?.ObjectId === null || item?.ObjectId === undefined) return null;
        const result = await AssemblyAreaQueryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type === Constants_ServiceResultType.Success && Array.isArray(result.data)) {
            return result.data[0] || null;
        }
        return null;
    };

    const showItem = async item => {
        safeLog("Acil Toplanma Alanları/Detay Göster", `${item.ObjectId ?? ""}/${item.Address}`);
        try {
            const details = await getItemDetailsById(item);
            if (!details?.geometry) throw new Error("Konum bilgisi bulunamadı.");
            GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, details.geometry, 18);
            if (window.matchMedia?.("(max-width: 959px)").matches) windowManager.ToggleMinimiseWindow(id);
        } catch (error) {
            windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Konum gösterilemedi.");
        }
    };

    const showRoute = async item => {
        try {
            const details = await getItemDetailsById(item);
            const geometry = details?.geometry;
            const latitude = Number(geometry?.latitude ?? geometry?.y);
            const longitude = Number(geometry?.longitude ?? geometry?.x);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            }
            safeLog("Acil Toplanma Alanları/Yol Tarifi", `${item.ObjectId ?? ""}/${item.Address}`);
            const opened = window.open(
                `https://www.google.com.tr/maps?saddr=My+Location&daddr=${latitude},${longitude}`,
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
    const nameId = `${id}-assembly-name`;
    const districtId = `${id}-assembly-district`;
    const neighborhoodId = `${id}-assembly-neighborhood`;

    return (
        <section
            className="common-query-window"
            aria-label={WINDOW_TITLE}
            style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={WINDOW_LOGO} alt="" aria-hidden="true" />
                <span>{WINDOW_TITLE}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
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
                    <Form onSubmit={submitQuery} aria-label="Acil toplanma alanı filtreleri">
                        {!query.mapSelect && (
                            <Form.Group>
                                <label className="form-label" htmlFor={nameId}>Adı</label>
                                <input
                                    id={nameId}
                                    className="form-control"
                                    onChange={event => setQueryField("name", event.target.value)}
                                    value={query.name}
                                />
                            </Form.Group>
                        )}

                        {!query.showNearby && !query.mapSelect && (
                            <>
                                <Form.Group>
                                    <label className="form-label" htmlFor={districtId}>İlçe</label>
                                    <select
                                        id={districtId}
                                        className="form-select form-control"
                                        onChange={onDistrictChange}
                                        value={query.districtId}
                                    >
                                        <option value="">Seçiniz..</option>
                                        {districtList.map(item => (
                                            <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>
                                        ))}
                                    </select>
                                </Form.Group>
                                <Form.Group>
                                    <label className="form-label" htmlFor={neighborhoodId}>Mahalle</label>
                                    <select
                                        id={neighborhoodId}
                                        className="form-select"
                                        onChange={onNeighborhoodChange}
                                        value={query.nbhoodId}
                                        disabled={!query.districtId}
                                    >
                                        <option value="">Seçiniz..</option>
                                        {nbhoodList.map(item => (
                                            <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>
                                        ))}
                                    </select>
                                </Form.Group>
                            </>
                        )}

                        {!query.mapSelect && (
                            <Form.Group>
                                {loading ? (
                                    <ButtonLoading />
                                ) : (
                                    <Button type="submit" className="form-button">
                                        <BiSearch className="form-button-icon" aria-hidden="true" />
                                        <span>Sorgula</span>
                                    </Button>
                                )}
                            </Form.Group>
                        )}
                    </Form>
                ) : (
                    <div className="results-container">
                        <div className="results-container-toolbar">
                            <button type="button" className="results-container-back-button" onClick={backToForm}>
                                <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />
                                &nbsp;Geri Dön
                            </button>
                            <div className="results-container-count" aria-live="polite">
                                <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
                            </div>
                        </div>

                        {resultList?.map(item => (
                            <article className="result-item-container" key={item.ObjectId ?? `${item.Title}-${item.Address}`}>
                                <button
                                    type="button"
                                    className="result-item-info"
                                    onClick={() => showItem(item)}
                                    aria-label={`${item.Title} konumunu haritada göster`}
                                >
                                    <span className="result-item-info-title">{item.Title}</span>
                                    <span className="result-item-info-address">
                                        <FiMapPin aria-hidden="true" />&nbsp;{item.Address}
                                    </span>
                                    {(item.Capacity !== null || item.Area !== null) && (
                                        <span className="result-item-info-address-description">
                                            {item.Capacity !== null && <><FiUsers aria-hidden="true" />&nbsp;{item.Capacity} kişi</>}
                                            {item.Capacity !== null && item.Area !== null && <>&nbsp;&nbsp;</>}
                                            {item.Area !== null && <><BiArea aria-hidden="true" />&nbsp;{item.Area} m²</>}
                                        </span>
                                    )}
                                </button>
                                <CommonQueryResultItemTools
                                    item={item}
                                    zoomCallback={() => showItem(item)}
                                    showRouteCallback={() => showRoute(item)}
                                />
                            </article>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
});

AssemblyAreaQueryWindow.displayName = "AssemblyAreaQueryWindow";
