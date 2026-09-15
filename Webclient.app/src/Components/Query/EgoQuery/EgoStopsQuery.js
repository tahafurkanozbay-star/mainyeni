import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InputGroup } from "react-bootstrap";
import { BiSearch } from "react-icons/bi";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import {
    createLatestRequestGate,
    createOwnedResourceRegistry,
    normalizeErrorMessage,
    safeClientLog
} from "../_Common/QueryInteractionRuntime";
import { filterEgoStops } from "../_Common/QuerySearchRuntime";

const RESULT_LIMIT = 100;

export const EgoStopsQuery = ({ stops, showAll = false }) => {
    const requestGateRef = useRef(createLatestRequestGate());
    const resourceRegistryRef = useRef(createOwnedResourceRegistry({
        removeGraphic: graphic => MapManager.RemoveGraphics(graphic)
    }));
    const mountedRef = useRef(true);

    const [searchText, setSearchText] = useState("");
    const [loadingStopKey, setLoadingStopKey] = useState(null);
    const [errorMessage, setErrorMessage] = useState("");

    const filteredList = useMemo(
        () => filterEgoStops(stops, searchText, showAll).slice(0, RESULT_LIMIT),
        [searchText, showAll, stops]
    );

    const clearOwnedGraphics = useCallback(() => {
        resourceRegistryRef.current.clearGraphics();
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        const requestGate = requestGateRef.current;
        return () => {
            mountedRef.current = false;
            requestGate.invalidate();
            clearOwnedGraphics();
        };
    }, [clearOwnedGraphics]);

    useEffect(() => {
        setSearchText("");
        setErrorMessage("");
        requestGateRef.current.invalidate();
    }, [stops]);

    const showDetails = useCallback(async stop => {
        if (!stop) return;
        const stopKey = `${stop.stopNo || "stop"}:${stop.stopName || ""}`;
        const requestId = requestGateRef.current.next();
        setLoadingStopKey(stopKey);
        setErrorMessage("");
        safeClientLog(LoggingBusiness, "EGO/Durak/Detay Göster", `${stop.stopNo}/${stop.stopName}`);

        try {
            if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) {
                throw new Error("Durak konum bilgisi geçersiz.");
            }

            const mapView = MapManager.GetMapView();
            if (!mapView) throw new Error("Harita görünümü hazır değil.");

            const point = await GisGraphicsHelper.CreatePoint({
                latitude: stop.latitude,
                longitude: stop.longitude
            });
            if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point);
            if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;

            clearOwnedGraphics();
            resourceRegistryRef.current.trackGraphic(graphic);
            MapManager.AddGraphics(graphic, true);
            GisGraphicsHelper.ZoomToGeometry(mapView, point, 17);
        } catch (error) {
            if (!mountedRef.current || !requestGateRef.current.isCurrent(requestId)) return;
            setErrorMessage(normalizeErrorMessage(error, "Durak haritada gösterilemedi."));
        } finally {
            if (mountedRef.current && requestGateRef.current.isCurrent(requestId)) setLoadingStopKey(null);
        }
    }, [clearOwnedGraphics]);

    if (stops === null || stops === undefined) return <ContainerLoading />;
    if (!Array.isArray(stops) || stops.length === 0) return <NoResultsFound message="Aktif durak bulunamadı." />;

    const visibleCount = filteredList.length;
    const totalCount = Array.isArray(stops) ? stops.length : 0;
    const searchActive = searchText.trim().length > 0;

    return (
        <section className="ego-query-window-items-container" aria-label="EGO durakları">
            <div className="ego-query-window-items-search">
                <InputGroup className="fulltextsearch-text-group ego-query-window-items-search-group">
                    <label className="visually-hidden" htmlFor="ego-stop-search">EGO durağı ara</label>
                    <input
                        id="ego-stop-search"
                        type="search"
                        className="fulltextsearch-text-input"
                        placeholder="Durak adıyla ya da numarasıyla arayın"
                        value={searchText}
                        onChange={event => setSearchText(event.target.value)}
                        aria-describedby="ego-stop-search-status"
                        autoComplete="off"
                    />
                    <InputGroup.Text className="fulltextsearch-text-icon"><BiSearch size="2rem" aria-hidden="true" /></InputGroup.Text>
                </InputGroup>
                <div id="ego-stop-search-status" className="ego-query-window-items-status" aria-live="polite">
                    {searchActive
                        ? `${visibleCount} durak eşleşti`
                        : showAll
                            ? `${Math.min(totalCount, RESULT_LIMIT)} durak gösteriliyor`
                            : "Aramak için durak adı veya numarası yazın"}
                </div>
            </div>

            {errorMessage && (
                <div className="kr-status-banner kr-status-banner--danger" role="alert">
                    {errorMessage}
                </div>
            )}

            {visibleCount === 0 ? (
                <NoResultsFound message={searchActive ? "Aramanızla eşleşen durak bulunamadı." : "Durak aramak için en az bir karakter yazın."} />
            ) : (
                <div className="ego-query-window-item-list" role="list" aria-label="Durak sonuçları">
                    {filteredList.map((stop, index) => {
                        const stopKey = `${stop.stopNo || "stop"}:${stop.stopName || ""}`;
                        const busy = loadingStopKey === stopKey;
                        return (
                            <button
                                type="button"
                                key={`${stopKey}:${index}`}
                                className="ego-query-window-item"
                                onClick={() => showDetails(stop)}
                                aria-label={`${stop.stopNo || ""} ${stop.stopName || "Durak"} konumunu haritada göster`}
                                aria-busy={busy}
                                disabled={busy}
                                role="listitem"
                            >
                                <span className="ego-query-window-item-no">{stop.stopNo || "—"}</span>
                                <span className="ego-query-window-item-name">{stop.stopName || "İsimsiz durak"}</span>
                                <span className="ego-query-window-item-type">{busy ? "Konum açılıyor…" : stop.lineType || "Durak"}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </section>
    );
};
