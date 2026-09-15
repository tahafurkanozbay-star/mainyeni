import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { GenelAramaQeryBusiness } from "../../../Business/GenelAramaQeryBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, NoResultsFound } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import {
    buildGoogleDirectionsUrl,
    createLatestRequestGate,
    isSmallViewport,
    normalizeErrorMessage,
    openExternalSafely,
    safeClientLog
} from "../_Common/QueryInteractionRuntime";
import { normalizeSearchCollection } from "../_Common/QuerySearchRuntime";
import "./GenelAramaQeryWindow.css";

const WINDOW_TITLE = "ARAMA SONUÇLARI";
const WINDOW_LOGO = "images/search.svg";
const EMPTY_QUERY = Object.freeze({ name: "" });

const createEmptyQuery = () => ({ ...EMPTY_QUERY });

export const GenelAramaQeryWindow = React.forwardRef((props, ref) => {
    const { id, windowManager } = props;
    const queryGateRef = useRef(createLatestRequestGate());
    const detailGateRef = useRef(createLatestRequestGate());
    const mountedRef = useRef(true);

    const [query, setQuery] = useState(createEmptyQuery);
    const [loading, setLoading] = useState(false);
    const [resultList, setResultList] = useState(null);
    const [detailLoadingKey, setDetailLoadingKey] = useState(null);
    const [errorMessage, setErrorMessage] = useState("");

    const resetWindow = useCallback(() => {
        queryGateRef.current.invalidate();
        detailGateRef.current.invalidate();
        setQuery(createEmptyQuery());
        setResultList(null);
        setLoading(false);
        setDetailLoadingKey(null);
        setErrorMessage("");
    }, []);

    const fetchQueryResults = useCallback(async () => {
        const requestId = queryGateRef.current.next();
        const searchQuery = windowManager.GetQueryParams(id) || query || createEmptyQuery();
        setQuery(searchQuery);
        setLoading(true);
        setErrorMessage("");
        setResultList(null);
        setDetailLoadingKey(null);
        safeClientLog(LoggingBusiness, "Genel Arama/Sorgu", searchQuery);

        try {
            const result = await GenelAramaQeryBusiness.Query(searchQuery, false);
            if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error(result?.message || "Arama sonuçları alınamadı. Lütfen tekrar deneyin.");
            }

            setResultList(normalizeSearchCollection(result.data || []));
        } catch (error) {
            if (!mountedRef.current || !queryGateRef.current.isCurrent(requestId)) return;
            const message = normalizeErrorMessage(error, "Arama sırasında beklenmeyen bir hata oluştu.");
            setResultList([]);
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            if (mountedRef.current && queryGateRef.current.isCurrent(requestId)) setLoading(false);
        }
    }, [id, query, windowManager]);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: fetchQueryResults,
        OnClose: resetWindow
    }), [fetchQueryResults, id, resetWindow]);

    useEffect(() => {
        mountedRef.current = true;
        windowManager.RegisterWindow(ref);
        const queryGate = queryGateRef.current;
        const detailGate = detailGateRef.current;
        return () => {
            mountedRef.current = false;
            queryGate.invalidate();
            detailGate.invalidate();
        };
    }, [ref, windowManager]);

    const getItemDetails = useCallback(async item => {
        if (item?.id === null || item?.id === undefined || String(item.id).trim() === "") {
            throw new Error("Kayıt kimliği bulunamadı.");
        }

        const requestId = detailGateRef.current.next();
        const result = await GenelAramaQeryBusiness.Query({ ObjectId: item.id }, true);
        if (!mountedRef.current || !detailGateRef.current.isCurrent(requestId)) return null;
        if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data) || !result.data[0]) {
            throw new Error(result?.message || "Kayıt ayrıntıları bulunamadı.");
        }
        return result.data[0];
    }, []);

    const showItemOnMap = useCallback(async item => {
        if (!item) return;
        setDetailLoadingKey(item.key);
        setErrorMessage("");
        safeClientLog(LoggingBusiness, "Genel Arama/Detay Göster", `${item.id ?? ""}/${item.address || item.title}`);

        try {
            const itemDetails = await getItemDetails(item);
            if (!itemDetails?.geometry) return;

            const mapView = MapManager.GetMapView();
            if (!mapView) throw new Error("Harita görünümü hazır değil.");
            GisGraphicsHelper.ZoomToGeometry(mapView, itemDetails.geometry, 18);
            if (isSmallViewport()) windowManager.ToggleMinimiseWindow(id);
        } catch (error) {
            const message = normalizeErrorMessage(error, "Kayıt konumu gösterilemedi.");
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

        setDetailLoadingKey(item.key);
        setErrorMessage("");
        safeClientLog(LoggingBusiness, "Genel Arama/Yol Tarifi", `${item.id ?? ""}/${item.title}`);

        try {
            const itemDetails = await getItemDetails(item);
            if (!itemDetails?.geometry) return;
            const url = buildGoogleDirectionsUrl(itemDetails.geometry);
            if (!url) throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            if (!openExternalSafely(url)) throw new Error("Tarayıcı yol tarifi penceresini açmayı engelledi.");
        } catch (error) {
            const message = normalizeErrorMessage(error, "Yol tarifi alınamadı.");
            setErrorMessage(message);
            windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            if (mountedRef.current) setDetailLoadingKey(null);
        }
    }, [getItemDetails, windowManager]);

    const backToSidebar = useCallback(() => {
        queryGateRef.current.invalidate();
        detailGateRef.current.invalidate();
        setDetailLoadingKey(null);
        setErrorMessage("");
        windowManager.ShowWindow("sidebar");
    }, [windowManager]);

    const resultContent = loading ? (
        <div className="experience-search-state genel-arama-state" role="status" aria-live="polite" aria-busy="true">
            <ButtonLoading message="Aranıyor…" />
            <div className="experience-search-state__hint">Sonuçlar getiriliyor.</div>
        </div>
    ) : errorMessage && resultList === null ? (
        <div className="kr-status-banner kr-status-banner--danger genel-arama-error" role="alert">
            <div>
                <strong>Arama tamamlanamadı.</strong>
                <div>{errorMessage}</div>
                <button className="kr-btn kr-btn--secondary" type="button" onClick={fetchQueryResults}>Tekrar dene</button>
            </div>
        </div>
    ) : resultList?.length === 0 ? (
        <NoResultsFound message="Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin." />
    ) : resultList?.map(item => {
        const busy = detailLoadingKey === item.key;
        return (
            <article className="result-item-container genel-arama-result" key={item.key} aria-busy={busy}>
                <button
                    type="button"
                    className="result-item-info"
                    onClick={() => showItemOnMap(item)}
                    aria-label={`${item.title} kaydını haritada göster`}
                    disabled={busy}
                >
                    <span className="result-item-info-title">{item.title}</span>
                    {item.category && item.category !== "Diğer" && (
                        <span className="genel-arama-result-category">{item.category}</span>
                    )}
                    {item.address && (
                        <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.address}</span>
                    )}
                    {item.phone && (
                        <span className="result-item-info-phone"><FiPhone aria-hidden="true" />&nbsp;{item.phone}</span>
                    )}
                    {busy && <span className="genel-arama-result-status">İşlem sürüyor…</span>}
                </button>
                <CommonQueryResultItemTools
                    item={item}
                    zoomCallback={() => showItemOnMap(item)}
                    showRouteCallback={event => showRoute(event, item)}
                />
            </article>
        );
    });

    const queryLabel = String(query?.name || query?.searchText || "").trim();

    return (
        <section
            className="sidebar-container genel-arama-window"
            aria-label="Genel arama sonuçları"
            style={{ visibility: windowManager.IsVisible(id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={WINDOW_LOGO} alt="" aria-hidden="true" />
                <span>{WINDOW_TITLE}</span>
            </header>

            <div className="results-container genel-arama-results" aria-live="polite" aria-busy={loading}>
                <div className="results-container-toolbar genel-arama-toolbar">
                    <button className="results-container-back-button" type="button" onClick={backToSidebar}>
                        <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />
                        <span>Geri Dön</span>
                    </button>
                    <div className="results-container-count">
                        <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
                    </div>
                </div>

                {queryLabel && (
                    <div className="genel-arama-query-summary" role="status">
                        <span>Aranan ifade</span>
                        <strong>{queryLabel}</strong>
                    </div>
                )}

                {errorMessage && resultList !== null && (
                    <div className="kr-status-banner kr-status-banner--danger genel-arama-inline-error" role="alert">
                        {errorMessage}
                    </div>
                )}

                <div className="genel-arama-result-list">
                    {resultContent}
                </div>
            </div>
        </section>
    );
});

GenelAramaQeryWindow.displayName = "GenelAramaQeryWindow";
