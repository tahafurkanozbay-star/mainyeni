import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Button, Form, Tab, Tabs } from "react-bootstrap";
import { BiBus, BiCar, BiCycling, BiMap, BiPlus, BiSearch, BiSort, BiTargetLock, BiWalk, BiX } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { TransitRouteQueryBusiness } from "../../../Business/TransitRouteQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, NoResultsFound } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import {
    buildGoogleDirectionsUrl,
    createLatestRequestGate,
    createOwnedResourceRegistry,
    isSmallViewport,
    normalizeErrorMessage,
    openExternalSafely,
    safeClientLog
} from "../_Common/QueryInteractionRuntime";
import { normalizeSearchCollection } from "../_Common/QuerySearchRuntime";
import "./TransitRouteQueryWindow.css";

const WINDOW_TITLE = "Ulaşım Ağları";
const WINDOW_LOGO = "images/icons/sidebar/ulasimaglari.png";
const MIN_STOP_COUNT = 2;
const MAX_STOP_COUNT = 6;

const TRANSIT_FILTERS = Object.freeze([
    { field: "showBusLines", label: "Otobüs Hatları" },
    { field: "showDolmusLines", label: "Dolmuş Hatları" },
    { field: "showMetroLines", label: "Metro Hatları" },
    { field: "showCablecarLines", label: "Teleferik Hatları" }
]);

const ROUTE_MODES = Object.freeze([
    { key: "masstransit", title: "Toplu Taşıma", Icon: BiBus },
    { key: "car", title: "Araç", Icon: BiCar },
    { key: "bicycle", title: "Bisiklet", Icon: BiCycling },
    { key: "walk", title: "Yürüme", Icon: BiWalk }
]);

const createStop = () => ({ address: "", coordinates: "" });
const createDefaultQuery = () => ({
    type: "masstransit",
    showBusLines: true,
    showDolmusLines: true,
    showMetroLines: true,
    showCablecarLines: true,
    mapSelect: false,
    showNearby: false,
    userLocation: null,
    bufferDistance: 20,
    stops: [createStop(), createStop()]
});

export const TransitRouteQueryWindow = React.forwardRef((props, ref) => {
    const { id, queryServiceTitle, windowManager } = props;
    const mapViewRef = useRef(null);
    const commonToolsRef = useRef(null);
    const queryGateRef = useRef(createLatestRequestGate());
    const detailGateRef = useRef(createLatestRequestGate());
    const mountedRef = useRef(true);
    const resourceRegistryRef = useRef(createOwnedResourceRegistry({
        removeLayer: resource => {
            const layer = resource?.layerObj || resource;
            if (layer && mapViewRef.current?.map) mapViewRef.current.map.remove(layer);
        }
    }));

    const [query, setQuery] = useState(createDefaultQuery);
    const [resultList, setResultList] = useState([]);
    const [activeView, setActiveView] = useState("form");
    const [loading, setLoading] = useState(false);
    const [detailLoadingKey, setDetailLoadingKey] = useState(null);
    const [errorMessage, setErrorMessage] = useState("");

    const setQueryField = useCallback((field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    }, []);

    const clearOwnedLayers = useCallback(() => {
        resourceRegistryRef.current.clearLayers();
    }, []);

    const resetWindow = useCallback(() => {
        queryGateRef.current.invalidate();
        detailGateRef.current.invalidate();
        clearOwnedLayers();
        commonToolsRef.current?.OnClose?.();
        setQuery(createDefaultQuery());
        setResultList([]);
        setActiveView("form");
        setLoading(false);
        setDetailLoadingKey(null);
        setErrorMessage("");
    }, [clearOwnedLayers]);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: resetWindow
    }), [id, resetWindow]);

    useEffect(() => {
        mountedRef.current = true;
        windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();

        return () => {
            mountedRef.current = false;
            queryGateRef.current.invalidate();
            detailGateRef.current.invalidate();
            clearOwnedLayers();
            commonToolsRef.current?.OnClose?.();
            mapViewRef.current = null;
        };
    }, [clearOwnedLayers, ref, windowManager]);

    const activeMode = useMemo(
        () => ROUTE_MODES.find(mode => mode.key === query.type) || ROUTE_MODES[0],
        [query.type]
    );

    const updateStop = useCallback((index, field, value) => {
        setQuery(current => ({
            ...current,
            stops: current.stops.map((stop, stopIndex) => (
                stopIndex === index ? { ...stop, [field]: value } : stop
            ))
        }));
    }, []);

    const addStop = useCallback(() => {
        setQuery(current => {
            if (current.stops.length >= MAX_STOP_COUNT) return current;
            return { ...current, stops: [...current.stops, createStop()] };
        });
    }, []);

    const removeStop = useCallback(index => {
        setQuery(current => {
            if (current.stops.length <= MIN_STOP_COUNT) return current;
            return { ...current, stops: current.stops.filter((_, stopIndex) => stopIndex !== index) };
        });
    }, []);

    const swapStops = useCallback(index => {
        setQuery(current => {
            if (index < 0 || index >= current.stops.length - 1) return current;
            const stops = current.stops.map(stop => ({ ...stop }));
            [stops[index], stops[index + 1]] = [stops[index + 1], stops[index]];
            return { ...current, stops };
        });
    }, []);

    const validateQuery = useCallback(() => {
        if (!queryServiceTitle) return "Ulaşım ağı servisi tanımlı değil.";
        if (!ROUTE_MODES.some(mode => mode.key === query.type)) return "Geçerli bir ulaşım türü seçin.";
        if (query.type === "masstransit" && !TRANSIT_FILTERS.some(filter => query[filter.field])) {
            return "En az bir toplu taşıma ağı seçin.";
        }
        return "";
    }, [query, queryServiceTitle]);

    const submitQuery = useCallback(async event => {
        event?.preventDefault?.();
        if (loading) return;

        const validationMessage = validateQuery();
        if (validationMessage) {
            setErrorMessage(validationMessage);
            windowManager.ShowMessage(Constants_MessageType.Error, validationMessage);
            return;
        }

        const requestId = queryGateRef.current.next();
        setLoading(true);
        setErrorMessage("");
        safeClientLog(LoggingBusiness, "Ulaşım Ağları/Sorgu", {
            type: query.type,
            stopCount: query.stops.length,
            filters: TRANSIT_FILTERS.filter(filter => query[filter.field]).map(filter => filter.field)
        });

        try {
            const result = await TransitRouteQueryBusiness.Query(query, false);
            if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error(result?.message || "Ulaşım ağı sorgusu tamamlanamadı.");
            }

            const nextResults = normalizeSearchCollection(result.data || []);
            setResultList(nextResults);
            setActiveView("results");

            const clusterLayer = await CommonBusiness.Clustering.CreateClusterLayer(
                queryServiceTitle,
                WINDOW_TITLE,
                query,
                null
            );
            if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;

            clearOwnedLayers();
            if (clusterLayer?.layerObj && mapViewRef.current?.map) {
                resourceRegistryRef.current.trackLayer(clusterLayer);
                mapViewRef.current.map.add(clusterLayer.layerObj);
            }
        } catch (error) {
            if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
            const message = normalizeErrorMessage(error, "Ulaşım ağı sorgusu sırasında bir hata oluştu.");
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            if (mountedRef.current && queryGateRef.current.isCurrent(requestId)) setLoading(false);
        }
    }, [clearOwnedLayers, loading, query, queryServiceTitle, validateQuery, windowManager]);

    const getItemDetails = useCallback(async item => {
        if (item?.id === null || item?.id === undefined) throw new Error("Kayıt kimliği bulunamadı.");
        const requestId = detailGateRef.current.next();
        const result = await TransitRouteQueryBusiness.Query({ Id: item.id }, true);
        if (!mountedRef.current || !detailGateRef.current.isCurrent(requestId)) return null;
        if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data) || !result.data[0]) {
            throw new Error(result?.message || "Ulaşım ağı ayrıntıları bulunamadı.");
        }
        return result.data[0];
    }, []);

    const showItemOnMap = useCallback(async item => {
        if (!item) return;
        const itemKey = item.key;
        setDetailLoadingKey(itemKey);
        setErrorMessage("");
        safeClientLog(LoggingBusiness, "Ulaşım Ağları/Detay Göster", `${item.id ?? ""}/${item.title}`);

        try {
            const detail = await getItemDetails(item);
            if (!detail?.geometry) return;
            const mapView = mapViewRef.current || MapManager.GetMapView();
            if (!mapView) throw new Error("Harita görünümü hazır değil.");
            GisGraphicsHelper.ZoomToGeometry(mapView, detail.geometry, 18);
            if (isSmallViewport()) windowManager.ToggleMinimiseWindow(id);
        } catch (error) {
            const message = normalizeErrorMessage(error, "Ulaşım ağı konumu açılamadı.");
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            if (mountedRef.current) setDetailLoadingKey(null);
        }
    }, [getItemDetails, id, windowManager]);

    const showRoute = useCallback(async (event, item) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (!item) return;

        safeClientLog(LoggingBusiness, "Ulaşım Ağları/Yol Tarifi", `${item.id ?? ""}/${item.title}`);
        try {
            const detail = await getItemDetails(item);
            if (!detail?.geometry) return;
            const url = buildGoogleDirectionsUrl(detail.geometry);
            if (!url) throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            if (!openExternalSafely(url)) throw new Error("Tarayıcı yol tarifi penceresini açmayı engelledi.");
        } catch (error) {
            const message = normalizeErrorMessage(error, "Yol tarifi alınamadı.");
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        }
    }, [getItemDetails, windowManager]);

    const backToForm = useCallback(() => {
        queryGateRef.current.invalidate();
        detailGateRef.current.invalidate();
        clearOwnedLayers();
        setResultList([]);
        setActiveView("form");
        setLoading(false);
        setDetailLoadingKey(null);
        setErrorMessage("");
    }, [clearOwnedLayers]);

    return (
        <section
            className="common-query-window transit-route-query-window"
            aria-label={WINDOW_TITLE}
            style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={WINDOW_LOGO} alt="" aria-hidden="true" />
                <span>{WINDOW_TITLE}</span>
                <CommonQueryWindowTools
                    ref={commonToolsRef}
                    windowManager={windowManager}
                    windowId={id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={activeView === "form"}
                    showMapSelect={activeView === "form"}
                />
            </header>

            <div className={`common-query-window-body ${windowManager.IsMinimized(id) ? "common-query-window-body-collapsed" : ""}`}>
                {activeView === "form" ? (
                    <Form onSubmit={submitQuery} aria-label="Ulaşım ağı filtreleri">
                        <Tabs
                            activeKey={query.type}
                            onSelect={key => key && setQueryField("type", key)}
                            className="transit-route-query-tabs"
                            aria-label="Ulaşım türü"
                        >
                            {ROUTE_MODES.map(({ key, title, Icon }) => (
                                <Tab
                                    key={key}
                                    eventKey={key}
                                    title={<span className="transit-route-query-tab-label"><Icon aria-hidden="true" /><span>{title}</span></span>}
                                >
                                    {key === "masstransit" && (
                                        <fieldset className="transit-route-query-network-options">
                                            <legend>Gösterilecek ağlar</legend>
                                            {TRANSIT_FILTERS.map(filter => (
                                                <label className="transit-route-query-network-toggle" key={filter.field}>
                                                    <input
                                                        type="checkbox"
                                                        checked={Boolean(query[filter.field])}
                                                        onChange={event => setQueryField(filter.field, event.target.checked)}
                                                    />
                                                    <span>{filter.label}</span>
                                                </label>
                                            ))}
                                        </fieldset>
                                    )}
                                </Tab>
                            ))}
                        </Tabs>

                        {!query.mapSelect && (
                            <div className="transit-route-query-stops-select-container" aria-label="Rota noktaları">
                                <div className="transit-route-query-mode-summary" aria-live="polite">
                                    <activeMode.Icon aria-hidden="true" />
                                    <span>{activeMode.title} modu · {query.stops.length} nokta</span>
                                </div>

                                <ol className="transit-route-query-stop-list">
                                    {query.stops.map((stop, index) => {
                                        const stopInputId = `${id}-route-stop-${index}`;
                                        const canRemove = query.stops.length > MIN_STOP_COUNT;
                                        return (
                                            <li className="transit-route-query-stop-row" key={`route-stop-${index}`}>
                                                <BiTargetLock className="transit-route-query-stop-icon" aria-hidden="true" />
                                                <label className="visually-hidden" htmlFor={stopInputId}>
                                                    {index === 0 ? "Başlangıç noktası" : index === query.stops.length - 1 ? "Varış noktası" : `${index + 1}. ara nokta`}
                                                </label>
                                                <input
                                                    id={stopInputId}
                                                    className="transit-route-query-stop-textbox"
                                                    value={stop.address}
                                                    onChange={event => updateStop(index, "address", event.target.value)}
                                                    placeholder={index === 0 ? "Başlangıç noktası" : index === query.stops.length - 1 ? "Varış noktası" : "Ara nokta"}
                                                    autoComplete="off"
                                                />
                                                <button
                                                    type="button"
                                                    className="transit-route-query-stop-action"
                                                    title="Haritadan nokta seç"
                                                    aria-label={`${index + 1}. noktayı haritadan seç`}
                                                    onClick={() => setQueryField("mapSelect", true)}
                                                >
                                                    <BiMap aria-hidden="true" />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="transit-route-query-stop-action transit-route-query-stop-action--danger"
                                                    onClick={() => removeStop(index)}
                                                    disabled={!canRemove}
                                                    aria-label={`${index + 1}. noktayı kaldır`}
                                                    title={canRemove ? "Noktayı kaldır" : "En az iki nokta gerekli"}
                                                >
                                                    <BiX aria-hidden="true" />
                                                </button>
                                                {index < query.stops.length - 1 && (
                                                    <button
                                                        type="button"
                                                        className="transit-route-query-swap-button"
                                                        onClick={() => swapStops(index)}
                                                        aria-label={`${index + 1}. ve ${index + 2}. noktaların sırasını değiştir`}
                                                        title="Noktaların sırasını değiştir"
                                                    >
                                                        <BiSort aria-hidden="true" />
                                                    </button>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ol>

                                <Button
                                    type="button"
                                    className="transit-route-query-add-stop-button"
                                    onClick={addStop}
                                    disabled={query.stops.length >= MAX_STOP_COUNT}
                                >
                                    <BiPlus aria-hidden="true" />
                                    <span>{query.stops.length >= MAX_STOP_COUNT ? "En fazla 6 nokta" : "Ara Nokta Ekle"}</span>
                                </Button>
                            </div>
                        )}

                        {errorMessage && <div className="kr-status-banner kr-status-banner--danger" role="alert">{errorMessage}</div>}

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
                                <span>Geri Dön</span>
                            </button>
                            <div className="results-container-count" aria-live="polite">
                                <strong>{resultList.length}</strong> adet sonuç bulundu
                            </div>
                        </div>

                        {errorMessage && <div className="kr-status-banner kr-status-banner--danger" role="alert">{errorMessage}</div>}
                        {resultList.length === 0 ? (
                            <NoResultsFound message="Bu filtrelerle ulaşım ağı kaydı bulunamadı." />
                        ) : (
                            resultList.map(item => {
                                const busy = detailLoadingKey === item.key;
                                return (
                                    <article className="result-item-container" key={item.key} aria-busy={busy}>
                                        <button
                                            type="button"
                                            className="result-item-info"
                                            onClick={() => showItemOnMap(item)}
                                            disabled={busy}
                                            aria-label={`${item.title} konumunu haritada göster`}
                                        >
                                            <span className="result-item-info-title">{item.title}</span>
                                            {item.address && <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.address}</span>}
                                            {item.phone && <span className="result-item-info-phone"><FiPhone aria-hidden="true" />&nbsp;{item.phone}</span>}
                                            {busy && <span className="transit-route-query-result-status">Konum açılıyor…</span>}
                                        </button>
                                        <CommonQueryResultItemTools
                                            item={item}
                                            zoomCallback={() => showItemOnMap(item)}
                                            showTransitRouteCallback={event => showRoute(event, item)}
                                            showRouteCallback={event => showRoute(event, item)}
                                        />
                                    </article>
                                );
                            })
                        )}
                    </div>
                )}
            </div>
        </section>
    );
});

TransitRouteQueryWindow.displayName = "TransitRouteQueryWindow";
