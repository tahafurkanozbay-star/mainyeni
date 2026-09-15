import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { createPictureMarkerSymbol } from "../../../gis-engine/iconPresentation";
import { SharedGISIcon } from "../../Common/SharedGISIcon";
import "./ManagedFastAccessQueryWindow.css";

const DEFAULT_PAGE_SIZE = 60;
const DEFAULT_QUERY = Object.freeze({});

const ATTRIBUTE_CANDIDATES = Object.freeze({
    objectId: ["objectid", "object_id", "id", "fid"],
    title: ["adi", "ad", "name", "isim", "baslik", "başlık", "tesis_adi", "unvan"],
    address: ["adres", "address", "adres_tarifi", "acik_adres", "açık_adres", "lokasyon"],
    phone: ["telefon", "phone", "tel", "telefon_no", "iletisim", "iletişim"]
});

const toSearchableEntries = attributes => Object.entries(attributes || {}).map(([key, value]) => [
    String(key).trim().toLocaleLowerCase("tr-TR"),
    value
]);

const readAttribute = (attributes, candidates) => {
    const entries = toSearchableEntries(attributes);
    for (const candidate of candidates) {
        const normalizedCandidate = candidate.toLocaleLowerCase("tr-TR");
        const entry = entries.find(([key]) => key === normalizedCandidate);
        if (entry && entry[1] !== null && entry[1] !== undefined && String(entry[1]).trim() !== "") return entry[1];
    }
    return null;
};

export const normalizeFastAccessRecord = (feature, index = 0) => {
    const attributes = feature?.attr || feature?.attributes || {};
    const objectId = readAttribute(attributes, ATTRIBUTE_CANDIDATES.objectId);
    const title = readAttribute(attributes, ATTRIBUTE_CANDIDATES.title);
    const address = readAttribute(attributes, ATTRIBUTE_CANDIDATES.address);
    const phone = readAttribute(attributes, ATTRIBUTE_CANDIDATES.phone);

    return {
        objectId,
        title: title ? String(title) : `Kayıt ${index + 1}`,
        address: address ? String(address) : "Adres bilgisi bulunmuyor",
        phone: phone ? String(phone) : "",
        raw: feature
    };
};

const normalizeText = value => String(value || "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

export const filterFastAccessRecords = (records, query) => {
    const needle = normalizeText(query);
    if (!needle) return records;
    return records.filter(record => normalizeText(`${record.title} ${record.address} ${record.phone}`).includes(needle));
};

export const buildGoogleRouteUrl = geometry => {
    const latitude = Number(geometry?.latitude ?? geometry?.y);
    const longitude = Number(geometry?.longitude ?? geometry?.x);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return `https://www.google.com.tr/maps?saddr=My+Location&daddr=${encodeURIComponent(`${latitude},${longitude}`)}`;
};

const safeOpenExternal = url => {
    if (!url) return false;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
    return Boolean(opened);
};

const safeRemoveLayer = (mapView, layer) => {
    try {
        if (mapView?.map && layer) mapView.map.remove(layer);
    } catch (error) {
        DebugHelper.Log(error);
    }
};

const getFeatureGeometry = feature => feature?.geometry || feature?.raw?.geometry || null;

export function createManagedFastAccessQueryWindow({
    title,
    serviceKey,
    iconType,
    business,
    logName = title,
    pageSize = DEFAULT_PAGE_SIZE
}) {
    const ManagedFastAccessQueryWindow = React.forwardRef(({ id, windowManager }, ref) => {
        const mountedRef = useRef(false);
        const mapViewRef = useRef(null);
        const layerRef = useRef(null);
        const requestSequenceRef = useRef(0);
        const initialExtentRef = useRef(null);

        const [records, setRecords] = useState([]);
        const [filterText, setFilterText] = useState("");
        const [visibleCount, setVisibleCount] = useState(pageSize);
        const [loading, setLoading] = useState(false);
        const [errorMessage, setErrorMessage] = useState("");

        const clearOwnedLayer = useCallback(() => {
            const layer = layerRef.current?.layerObj || layerRef.current || null;
            safeRemoveLayer(mapViewRef.current, layer);
            layerRef.current = null;
        }, []);

        const resetSurface = useCallback(() => {
            requestSequenceRef.current += 1;
            clearOwnedLayer();
            setRecords([]);
            setFilterText("");
            setVisibleCount(pageSize);
            setLoading(false);
            setErrorMessage("");
        }, [clearOwnedLayer, pageSize]);

        const showError = useCallback(message => {
            const safeMessage = message || "Sorgu tamamlanamadı. Lütfen tekrar deneyin.";
            setErrorMessage(safeMessage);
            windowManager?.ShowMessage?.(Constants_MessageType.Error, safeMessage);
        }, [windowManager]);

        const renderLayer = useCallback(async query => {
            const mapView = mapViewRef.current;
            if (!mapView?.map) return;

            const symbol = createPictureMarkerSymbol(
                { type: iconType || serviceKey, title, category: title },
                mapView.zoom,
                { minSize: 28, maxSize: 44 }
            );

            const nextLayer = await CommonBusiness.Clustering.CreateLayerWithoutClustering(
                serviceKey,
                title,
                query,
                symbol
            );

            if (!mountedRef.current || !nextLayer?.layerObj) return;

            clearOwnedLayer();
            layerRef.current = nextLayer;
            mapView.map.add(nextLayer.layerObj);

            try {
                const extentResult = await nextLayer.layerObj.queryExtent?.();
                const extent = extentResult?.extent;
                if (extent && mountedRef.current) {
                    const target = typeof extent.expand === "function" ? extent.expand(1.12) : extent;
                    await mapView.goTo(target, { animate: false });
                }
            } catch (error) {
                DebugHelper.Log(error);
            }
        }, [clearOwnedLayer, iconType, serviceKey, title]);

        const fetchQueryResults = useCallback(async () => {
            const requestId = ++requestSequenceRef.current;
            const query = windowManager?.GetQueryParams?.(id) || DEFAULT_QUERY;
            setLoading(true);
            setErrorMessage("");
            setVisibleCount(pageSize);

            try {
                LoggingBusiness.CreateClientLog(`${logName}/Sorgu`, JSON.stringify(query));
                const result = await business.Query(query, false);
                if (!mountedRef.current || requestId !== requestSequenceRef.current) return;

                if (result?.type !== Constants_ServiceResultType.Success) {
                    showError(result?.message || result?.errorMessage);
                    return;
                }

                const nextRecords = Array.isArray(result.data)
                    ? result.data.map(normalizeFastAccessRecord)
                    : [];
                setRecords(nextRecords);
                await renderLayer(query);
            } catch (error) {
                if (mountedRef.current && requestId === requestSequenceRef.current) showError(error?.message);
            } finally {
                if (mountedRef.current && requestId === requestSequenceRef.current) setLoading(false);
            }
        }, [business, id, logName, pageSize, renderLayer, showError, windowManager]);

        const getItemDetails = useCallback(async item => {
            if (item?.objectId === null || item?.objectId === undefined) return item?.raw || null;
            const result = await business.Query({ ObjectId: item.objectId }, true);
            if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data)) return null;
            return result.data[0] || null;
        }, [business]);

        const zoomToItem = useCallback(async item => {
            try {
                const detail = await getItemDetails(item);
                const geometry = getFeatureGeometry(detail);
                if (!geometry) {
                    showError("Konum bilgisi bulunamadı.");
                    return;
                }
                GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, geometry, 18);
                LoggingBusiness.CreateClientLog(`${logName}/Detay Göster`, `${item.objectId ?? ""}/${item.address}`);
                if (window.matchMedia?.("(max-width: 959px)").matches) windowManager?.ToggleMinimiseWindow?.(id);
            } catch (error) {
                showError(error?.message || "Kayıt konumu açılamadı.");
            }
        }, [getItemDetails, id, logName, showError, windowManager]);

        const showRoute = useCallback(async item => {
            try {
                const detail = await getItemDetails(item);
                const routeUrl = buildGoogleRouteUrl(getFeatureGeometry(detail));
                if (!routeUrl || !safeOpenExternal(routeUrl)) showError("Yol tarifi açılamadı.");
            } catch (error) {
                showError(error?.message || "Yol tarifi alınamadı.");
            }
        }, [getItemDetails, showError]);

        useImperativeHandle(ref, () => ({
            id,
            visible: false,
            minimized: false,
            OnShow: fetchQueryResults,
            OnClose: resetSurface
        }), [fetchQueryResults, id, resetSurface]);

        useEffect(() => {
            mountedRef.current = true;
            const mapView = MapManager.GetMapView();
            mapViewRef.current = mapView;
            initialExtentRef.current = mapView?.extent?.clone?.() || mapView?.extent || null;
            windowManager?.RegisterWindow?.(ref);

            return () => {
                mountedRef.current = false;
                requestSequenceRef.current += 1;
                clearOwnedLayer();
            };
        }, [clearOwnedLayer, ref, windowManager]);

        const filteredRecords = useMemo(
            () => filterFastAccessRecords(records, filterText),
            [filterText, records]
        );
        const visibleRecords = useMemo(
            () => filteredRecords.slice(0, visibleCount),
            [filteredRecords, visibleCount]
        );

        const returnToServices = () => {
            clearOwnedLayer();
            const initialExtent = initialExtentRef.current;
            if (initialExtent && mapViewRef.current?.goTo) {
                mapViewRef.current.goTo(initialExtent, { animate: false }).catch(DebugHelper.Log);
            }
            windowManager?.ShowWindow?.("sidebar");
        };

        return (
            <section
                className="sidebar-container kr-fast-query"
                aria-labelledby={`${id}-title`}
                aria-busy={loading}
            >
                <header className="common-query-window-header kr-fast-query__header">
                    <SharedGISIcon
                        record={{ type: iconType || serviceKey, title, category: title }}
                        size={34}
                        className="common-query-window-header-icon"
                    />
                    <h2 id={`${id}-title`}>{title}</h2>
                    <button
                        type="button"
                        className="kr-fast-query__close"
                        onClick={returnToServices}
                        aria-label={`${title} penceresini kapat`}
                    >
                        ×
                    </button>
                </header>

                <div className="kr-fast-query__toolbar">
                    <button type="button" className="kr-fast-query__back" onClick={returnToServices}>
                        <span aria-hidden="true">←</span>
                        <span>Hizmetlere dön</span>
                    </button>
                    <span className="kr-fast-query__count" aria-live="polite">
                        <strong>{filteredRecords.length}</strong> sonuç
                    </span>
                </div>

                {records.length > 12 && (
                    <div className="kr-fast-query__filter">
                        <label htmlFor={`${id}-filter`}>Sonuçlarda filtrele</label>
                        <input
                            id={`${id}-filter`}
                            type="search"
                            value={filterText}
                            onChange={event => {
                                setFilterText(event.target.value);
                                setVisibleCount(pageSize);
                            }}
                            placeholder="Ad, adres veya telefon…"
                            autoComplete="off"
                        />
                    </div>
                )}

                <div className="kr-fast-query__status" role="status" aria-live="polite">
                    {loading && <span>Sonuçlar ve harita katmanı yükleniyor…</span>}
                    {!loading && errorMessage && <span className="kr-fast-query__error">{errorMessage}</span>}
                    {!loading && !errorMessage && records.length === 0 && <span>Gösterilecek kayıt bulunamadı.</span>}
                </div>

                <ul className="results-container kr-fast-query__results" aria-label={`${title} sonuçları`}>
                    {visibleRecords.map((item, index) => (
                        <li className="result-item-container kr-fast-query__item" key={`${item.objectId ?? "item"}-${index}`}>
                            <SharedGISIcon
                                record={{ type: iconType || serviceKey, title: item.title, category: title }}
                                size={30}
                                className="kr-fast-query__item-icon"
                            />
                            <div className="result-item-info kr-fast-query__copy">
                                <h3 className="result-item-info-title">{item.title}</h3>
                                <p className="result-item-info-address">{item.address}</p>
                                {item.phone && <a href={`tel:${item.phone.replace(/[^+\d]/g, "")}`}>{item.phone}</a>}
                            </div>
                            <div className="kr-fast-query__actions" aria-label={`${item.title} işlemleri`}>
                                <button type="button" onClick={() => zoomToItem(item)}>Haritada göster</button>
                                <button type="button" onClick={() => showRoute(item)}>Yol tarifi</button>
                            </div>
                        </li>
                    ))}
                </ul>

                {visibleCount < filteredRecords.length && (
                    <button
                        type="button"
                        className="kr-fast-query__more"
                        onClick={() => setVisibleCount(count => Math.min(count + pageSize, filteredRecords.length))}
                    >
                        Daha fazla sonuç göster
                    </button>
                )}
            </section>
        );
    });

    ManagedFastAccessQueryWindow.displayName = `ManagedFastAccessQueryWindow(${title})`;
    return ManagedFastAccessQueryWindow;
}
