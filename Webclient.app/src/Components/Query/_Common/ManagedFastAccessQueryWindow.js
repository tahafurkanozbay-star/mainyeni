import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { createPictureMarkerSymbol } from "../../../gis-engine/iconPresentation";
import { SharedGISIcon } from "../../Common/SharedGISIcon";
import {
    buildGoogleDirectionsUrl,
    normalizeErrorMessage,
    openExternalSafely,
    safeClientLog
} from "./QueryInteractionRuntime";
import "./ManagedFastAccessQueryWindow.css";

const DEFAULT_PAGE_SIZE = 60;
const DEFAULT_QUERY = Object.freeze({});

const ATTRIBUTE_CANDIDATES = Object.freeze({
    objectId: ["objectid", "object_id", "id", "fid", "globalid"],
    title: ["adi", "ad", "name", "isim", "baslik", "başlık", "tesis_adi", "unvan"],
    address: ["adres", "address", "adres_tarifi", "acik_adres", "açık_adres", "lokasyon"],
    phone: ["telefon", "phone", "tel", "telefon_no", "iletisim", "iletişim"]
});

const normalizeAttributeKey = value => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

const toSearchableEntries = attributes => Object.entries(attributes || {}).map(([key, value]) => [
    normalizeAttributeKey(key),
    value
]);

const readAttribute = (attributes, candidates) => {
    const entries = toSearchableEntries(attributes);
    for (const candidate of candidates) {
        const normalizedCandidate = normalizeAttributeKey(candidate);
        const entry = entries.find(([key]) => key === normalizedCandidate);
        if (entry && entry[1] !== null && entry[1] !== undefined && String(entry[1]).trim() !== "") {
            return entry[1];
        }
    }
    return null;
};

const normalizeText = value => String(value || "")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

const getFeatureGeometry = feature => feature?.geometry || feature?.raw?.geometry || null;

const getRawAttributes = feature => feature?.attr || feature?.attributes || {};

export const normalizeFastAccessRecord = (feature, index = 0) => {
    const attributes = getRawAttributes(feature);
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

export const filterFastAccessRecords = (records, query) => {
    const needle = normalizeText(query);
    if (!needle) return records;
    return records.filter(record => normalizeText(
        `${record.title} ${record.address} ${record.phone}`
    ).includes(needle));
};

export const buildGoogleRouteUrl = geometry => buildGoogleDirectionsUrl(geometry);

export const getFastAccessRecordKey = (record, index = 0) => {
    if (record?.objectId !== null && record?.objectId !== undefined && record?.objectId !== "") {
        return String(record.objectId);
    }
    const attributes = getRawAttributes(record?.raw);
    const globalId = attributes.globalid ?? attributes.GLOBALID ?? attributes.GlobalID;
    if (globalId) return String(globalId);
    return `${normalizeText(record?.title)}-${normalizeText(record?.address)}-${index}`;
};

const safeRemoveLayer = (mapView, layer) => {
    try {
        if (mapView?.map && layer) mapView.map.remove(layer);
    } catch (error) {
        DebugHelper.Log(error);
    }
};

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
        const queryRef = useRef(DEFAULT_QUERY);

        const [records, setRecords] = useState([]);
        const [filterText, setFilterText] = useState("");
        const [visibleCount, setVisibleCount] = useState(pageSize);
        const [loading, setLoading] = useState(false);
        const [errorMessage, setErrorMessage] = useState("");
        const [activeActionKey, setActiveActionKey] = useState("");

        const clearOwnedLayer = useCallback(() => {
            const layer = layerRef.current?.layerObj || layerRef.current || null;
            safeRemoveLayer(mapViewRef.current, layer);
            layerRef.current = null;
        }, []);

        const resetSurface = useCallback(() => {
            requestSequenceRef.current += 1;
            queryRef.current = DEFAULT_QUERY;
            clearOwnedLayer();
            setRecords([]);
            setFilterText("");
            setVisibleCount(pageSize);
            setLoading(false);
            setErrorMessage("");
            setActiveActionKey("");
        }, [clearOwnedLayer, pageSize]);

        const showError = useCallback(error => {
            const message = normalizeErrorMessage(error, "Sorgu tamamlanamadı. Lütfen tekrar deneyin.");
            setErrorMessage(message);
            windowManager?.ShowMessage?.(Constants_MessageType.Error, message);
            return message;
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
            queryRef.current = query;
            setLoading(true);
            setErrorMessage("");
            setFilterText("");
            setVisibleCount(pageSize);

            await safeClientLog(LoggingBusiness, `${logName}/Sorgu`, JSON.stringify(query));

            try {
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
                if (mountedRef.current && requestId === requestSequenceRef.current) showError(error);
            } finally {
                if (mountedRef.current && requestId === requestSequenceRef.current) setLoading(false);
            }
        }, [business, id, logName, pageSize, renderLayer, showError, windowManager]);

        const getItemDetails = useCallback(async item => {
            if (item?.objectId === null || item?.objectId === undefined || item?.objectId === "") {
                return item?.raw || null;
            }
            const result = await business.Query({ ObjectId: item.objectId }, true);
            if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data)) return null;
            return result.data[0] || null;
        }, [business]);

        const runItemAction = useCallback(async (item, action, callback) => {
            const key = `${getFastAccessRecordKey(item)}-${action}`;
            setActiveActionKey(key);
            setErrorMessage("");
            try {
                return await callback();
            } catch (error) {
                showError(error);
                return null;
            } finally {
                if (mountedRef.current) setActiveActionKey(current => current === key ? "" : current);
            }
        }, [showError]);

        const zoomToItem = useCallback(item => runItemAction(item, "zoom", async () => {
            const detail = await getItemDetails(item);
            const geometry = getFeatureGeometry(detail);
            if (!geometry) throw new Error("Konum bilgisi bulunamadı.");

            GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, geometry, 18);
            await safeClientLog(
                LoggingBusiness,
                `${logName}/Detay Göster`,
                `${item.objectId ?? ""}/${item.address}`
            );
            if (window.matchMedia?.("(max-width: 959px)").matches) {
                windowManager?.ToggleMinimiseWindow?.(id);
            }
            return detail;
        }), [getItemDetails, id, logName, runItemAction, windowManager]);

        const showRoute = useCallback(item => runItemAction(item, "route", async () => {
            const detail = await getItemDetails(item);
            const routeUrl = buildGoogleDirectionsUrl(getFeatureGeometry(detail));
            if (!routeUrl) throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            if (!openExternalSafely(routeUrl)) throw new Error("Yol tarifi penceresi açılamadı.");
            await safeClientLog(
                LoggingBusiness,
                `${logName}/Yol Tarifi`,
                `${item.objectId ?? ""}/${item.address}`
            );
            return true;
        }), [getItemDetails, logName, runItemAction]);

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
            requestSequenceRef.current += 1;
            clearOwnedLayer();
            const initialExtent = initialExtentRef.current;
            if (initialExtent && mapViewRef.current?.goTo) {
                Promise.resolve(mapViewRef.current.goTo(initialExtent, { animate: false })).catch(DebugHelper.Log);
            }
            windowManager?.ShowWindow?.("sidebar");
        };

        const retry = () => {
            if (!loading) fetchQueryResults();
        };

        return (
            <section className="sidebar-container kr-fast-query" aria-labelledby={`${id}-title`} aria-busy={loading}>
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
                    >×</button>
                </header>

                <div className="kr-fast-query__toolbar">
                    <button type="button" className="kr-fast-query__back" onClick={returnToServices}>
                        <span aria-hidden="true">←</span><span>Hizmetlere dön</span>
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
                    {!loading && errorMessage && (
                        <div className="kr-fast-query__error">
                            <span>{errorMessage}</span>
                            <button type="button" onClick={retry}>Tekrar dene</button>
                        </div>
                    )}
                    {!loading && !errorMessage && records.length === 0 && <span>Gösterilecek kayıt bulunamadı.</span>}
                </div>

                <ul className="results-container kr-fast-query__results" aria-label={`${title} sonuçları`}>
                    {visibleRecords.map((item, index) => {
                        const recordKey = getFastAccessRecordKey(item, index);
                        const zoomKey = `${recordKey}-zoom`;
                        const routeKey = `${recordKey}-route`;
                        return (
                            <li className="result-item-container kr-fast-query__item" key={recordKey}>
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
                                    <button
                                        type="button"
                                        onClick={() => zoomToItem(item)}
                                        disabled={activeActionKey === zoomKey}
                                    >
                                        {activeActionKey === zoomKey ? "Açılıyor…" : "Haritada göster"}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => showRoute(item)}
                                        disabled={activeActionKey === routeKey}
                                    >
                                        {activeActionKey === routeKey ? "Açılıyor…" : "Yol tarifi"}
                                    </button>
                                </div>
                            </li>
                        );
                    })}
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
