import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { InputGroup } from "react-bootstrap";
import { BiNavigation, BiSearch, BiXCircle } from "react-icons/bi";
import { useDebounce } from "use-debounce";
import { FulltextSearchQueryBusiness } from "../../../Business/FulltextSearchQueryBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { MiniLoading } from "../../Common/Loading";
import {
    buildGoogleDirectionsUrl,
    createLatestRequestGate,
    createOwnedResourceRegistry,
    normalizeErrorMessage,
    openExternalSafely,
    safeClientLog
} from "../_Common/QueryInteractionRuntime";
import {
    createAriaOptionId,
    groupSearchResults,
    moveActiveIndex
} from "../_Common/QuerySearchRuntime";
import "./FulltextSearchQuery.css";

const MIN_SEARCH_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 400;
const LOCATION_GRAPHIC_LIFETIME_MS = 20000;
const EMPTY_GROUPED_RESULTS = Object.freeze({ groups: [], flatItems: [], totalCount: 0, visibleCount: 0 });

const createEmptyResults = () => ({ ...EMPTY_GROUPED_RESULTS, groups: [], flatItems: [] });

export const FulltextSearchQuery = React.forwardRef((props, ref) => {
    const { id = "fulltext-search", windowManager } = props;
    const searchGateRef = useRef(createLatestRequestGate());
    const detailGateRef = useRef(createLatestRequestGate());
    const resultListRef = useRef(null);
    const graphicTimerRef = useRef(null);
    const mountedRef = useRef(true);
    const resourceRegistryRef = useRef(createOwnedResourceRegistry({
        removeGraphic: graphic => MapManager.RemoveGraphics(graphic)
    }));

    const [userInput, setUserInput] = useState("");
    const [searchText] = useDebounce(userInput, SEARCH_DEBOUNCE_MS);
    const [groupedResults, setGroupedResults] = useState(createEmptyResults);
    const [activeOption, setActiveOption] = useState(-1);
    const [showOptions, setShowOptions] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [selectedLabel, setSelectedLabel] = useState("");

    const clearGraphicTimer = useCallback(() => {
        if (graphicTimerRef.current) {
            window.clearTimeout(graphicTimerRef.current);
            graphicTimerRef.current = null;
        }
    }, []);

    const clearOwnedGraphics = useCallback(() => {
        clearGraphicTimer();
        resourceRegistryRef.current.clearGraphics();
    }, [clearGraphicTimer]);

    const resetSearch = useCallback(({ keepSelection = false } = {}) => {
        searchGateRef.current.invalidate();
        detailGateRef.current.invalidate();
        setUserInput("");
        setGroupedResults(createEmptyResults());
        setActiveOption(-1);
        setShowOptions(false);
        setLoading(false);
        setErrorMessage("");
        if (!keepSelection) setSelectedLabel("");
    }, []);

    useImperativeHandle(ref, () => ({
        id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: () => {
            resetSearch();
            clearOwnedGraphics();
        }
    }), [clearOwnedGraphics, id, resetSearch]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            searchGateRef.current.invalidate();
            detailGateRef.current.invalidate();
            clearOwnedGraphics();
        };
    }, [clearOwnedGraphics]);

    useEffect(() => {
        const normalizedSearchText = String(searchText || "").trim();
        if (normalizedSearchText.length < MIN_SEARCH_LENGTH) {
            searchGateRef.current.invalidate();
            setGroupedResults(createEmptyResults());
            setActiveOption(-1);
            setShowOptions(false);
            setLoading(false);
            setErrorMessage("");
            return undefined;
        }

        const requestId = searchGateRef.current.next();
        setLoading(true);
        setErrorMessage("");

        FulltextSearchQueryBusiness.Search({ searchText: normalizedSearchText }, false)
            .then(result => {
                if (!mountedRef.current || !searchGateRef.current.isCurrent(requestId)) return;
                if (result?.type !== Constants_ServiceResultType.Success) {
                    throw new Error(result?.message || "Arama sonuçları alınamadı.");
                }

                const nextResults = groupSearchResults(result.data || []);
                setGroupedResults(nextResults);
                setActiveOption(nextResults.visibleCount > 0 ? 0 : -1);
                setShowOptions(true);
            })
            .catch(error => {
                if (!mountedRef.current || !searchGateRef.current.isCurrent(requestId)) return;
                const message = normalizeErrorMessage(error, "Arama sonuçları alınamadı. Lütfen tekrar deneyin.");
                setGroupedResults(createEmptyResults());
                setActiveOption(-1);
                setShowOptions(true);
                setErrorMessage(message);
            })
            .finally(() => {
                if (mountedRef.current && searchGateRef.current.isCurrent(requestId)) setLoading(false);
            });

        return undefined;
    }, [searchText]);

    const activeRecord = activeOption >= 0 ? groupedResults.flatItems[activeOption] : null;
    const activeDescendant = activeRecord ? createAriaOptionId(id, activeRecord.key) : undefined;

    const getItemDetails = useCallback(async record => {
        const source = record?.raw || record;
        const sourceId = record?.id ?? source?.attr?.id ?? source?.attr?.objectid ?? source?.id;
        if (sourceId === null || sourceId === undefined || String(sourceId).trim() === "") {
            throw new Error("Kayıt kimliği bulunamadı.");
        }

        const requestId = detailGateRef.current.next();
        const result = await FulltextSearchQueryBusiness.Search({ Id: sourceId }, true);
        if (!mountedRef.current || !detailGateRef.current.isCurrent(requestId)) return null;
        if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data) || !result.data[0]) {
            throw new Error(result?.message || "Kayıt ayrıntıları bulunamadı.");
        }
        return result.data[0];
    }, []);

    const showRecordOnMap = useCallback(async record => {
        if (!record) return;
        const source = record.raw || record;
        safeClientLog(LoggingBusiness, "Genel Arama/Detay Göster", record.title || source?.attr?.ADI || source?.attr?.adi || "");

        try {
            const detail = await getItemDetails(record);
            if (!detail?.geometry) return;

            const mapView = MapManager.GetMapView();
            if (!mapView) throw new Error("Harita görünümü hazır değil.");

            const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(detail.geometry, "4326");
            if (!mountedRef.current || !projectedGeometry) return;
            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry, null);
            if (!mountedRef.current || !graphic) return;

            clearOwnedGraphics();
            resourceRegistryRef.current.trackGraphic(graphic);
            MapManager.AddGraphics(graphic, true);
            GisGraphicsHelper.ZoomToGeometry(mapView, projectedGeometry, 15);
            windowManager?.ShowMessage(Constants_MessageType.Info, record.title || "Kayıt haritada gösteriliyor.");

            graphicTimerRef.current = window.setTimeout(() => {
                resourceRegistryRef.current.removeGraphic(graphic);
                graphicTimerRef.current = null;
            }, LOCATION_GRAPHIC_LIFETIME_MS);
        } catch (error) {
            const message = normalizeErrorMessage(error, "Kayıt haritada gösterilemedi.");
            windowManager?.ShowMessage(Constants_MessageType.Error, message);
        }
    }, [clearOwnedGraphics, getItemDetails, windowManager]);

    const showRoute = useCallback(async (event, record) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (!record) return;

        safeClientLog(LoggingBusiness, "Genel Arama/Yol Tarifi", record.title || "");
        try {
            const detail = await getItemDetails(record);
            if (!detail?.geometry) return;
            const url = buildGoogleDirectionsUrl(detail.geometry);
            if (!url) throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            if (!openExternalSafely(url)) throw new Error("Tarayıcı yol tarifi penceresini açmayı engelledi.");
        } catch (error) {
            const message = normalizeErrorMessage(error, "Yol tarifi alınamadı.");
            windowManager?.ShowMessage(Constants_MessageType.Error, message);
        }
    }, [getItemDetails, windowManager]);

    const selectRecord = useCallback(record => {
        if (!record) return;
        setSelectedLabel(record.title);
        setUserInput("");
        setGroupedResults(createEmptyResults());
        setActiveOption(-1);
        setShowOptions(false);
        setErrorMessage("");
        showRecordOnMap(record);
    }, [showRecordOnMap]);

    const cancelSearch = useCallback(() => {
        resetSearch();
        resultListRef.current?.scrollTo?.({ top: 0 });
    }, [resetSearch]);

    const onChange = event => {
        setUserInput(event.target.value);
        setSelectedLabel("");
        setActiveOption(-1);
        setErrorMessage("");
    };

    const onKeyDown = event => {
        const count = groupedResults.visibleCount;
        if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveOption(current => moveActiveIndex(current, "previous", count));
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setShowOptions(count > 0 || Boolean(errorMessage));
            setActiveOption(current => moveActiveIndex(current < 0 ? 0 : current, "next", count));
            return;
        }
        if (event.key === "Home" && showOptions) {
            event.preventDefault();
            setActiveOption(moveActiveIndex(activeOption, "first", count));
            return;
        }
        if (event.key === "End" && showOptions) {
            event.preventDefault();
            setActiveOption(moveActiveIndex(activeOption, "last", count));
            return;
        }
        if (event.key === "Enter" && activeRecord) {
            event.preventDefault();
            selectRecord(activeRecord);
            return;
        }
        if (event.key === "Escape") {
            event.preventDefault();
            cancelSearch();
        }
    };

    useEffect(() => {
        if (activeOption < 0) return;
        const activeElement = resultListRef.current?.querySelector?.(`[data-option-index="${activeOption}"]`);
        activeElement?.scrollIntoView?.({ block: "nearest" });
    }, [activeOption]);

    const resultContent = useMemo(() => {
        if (!showOptions) return null;
        if (errorMessage) {
            return (
                <div className="fulltextsearch-state fulltextsearch-state--error" role="alert">
                    <strong>Arama tamamlanamadı.</strong>
                    <span>{errorMessage}</span>
                </div>
            );
        }
        if (groupedResults.totalCount === 0) {
            return (
                <div className="fulltextsearch-state" role="status">
                    Bu arama için sonuç bulunamadı.
                </div>
            );
        }

        let optionIndex = 0;
        return groupedResults.groups.map(group => (
            <section className="fulltextsearch-group" key={group.category} aria-label={`${group.category} sonuçları`}>
                <div className="options-title">
                    <span>{group.category}</span>
                    <span className="fulltextsearch-group-count">{group.totalCount}</span>
                </div>
                <ul className="options-container" role="group" aria-label={group.category}>
                    {group.items.map(record => {
                        const currentIndex = optionIndex;
                        optionIndex += 1;
                        const selected = currentIndex === activeOption;
                        const optionId = createAriaOptionId(id, record.key);
                        const zoningAction = record.category === "cityblockparcel" || (record.category === "address" && record.type === "door");
                        return (
                            <li
                                id={optionId}
                                key={record.key}
                                role="option"
                                aria-selected={selected}
                                className={selected ? "option-active" : ""}
                                data-option-index={currentIndex}
                            >
                                <button
                                    type="button"
                                    className="fulltextsearch-option-select"
                                    onClick={() => selectRecord(record)}
                                    onMouseEnter={() => setActiveOption(currentIndex)}
                                >
                                    <span className="fulltextsearch-option-details">
                                        <span className="fulltextsearch-option-title">{record.title}</span>
                                        {record.address && <span className="fulltextsearch-option-description">{record.address}</span>}
                                        {zoningAction && <span className="fulltextsearch-option-meta">İmar durum belgesi için konumu aç</span>}
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className="fulltextsearch-option-route"
                                    onClick={event => showRoute(event, record)}
                                    aria-label={`${record.title} için yol tarifi al`}
                                    title="Yol tarifi al"
                                >
                                    <BiNavigation aria-hidden="true" />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </section>
        ));
    }, [activeOption, errorMessage, groupedResults, id, selectRecord, showOptions, showRoute]);

    return (
        <div className="fulltextsearch-container">
            <InputGroup className="fulltextsearch-text-group">
                <label htmlFor={`${id}-input`} className="visually-hidden">Ankara genelinde ara</label>
                <input
                    id={`${id}-input`}
                    type="search"
                    className="fulltextsearch-text-input"
                    placeholder={selectedLabel || "Ankara'da arayın"}
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    value={userInput}
                    autoComplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showOptions}
                    aria-controls={`${id}-results`}
                    aria-activedescendant={activeDescendant}
                    aria-describedby={`${id}-status`}
                />
                {loading && (
                    <InputGroup.Text className="fulltextsearch-text-icon" aria-hidden="true">
                        <MiniLoading />
                    </InputGroup.Text>
                )}
                <InputGroup.Text className="fulltextsearch-text-icon">
                    {userInput || showOptions || selectedLabel ? (
                        <button type="button" className="fulltextsearch-icon-button" onClick={cancelSearch} aria-label="Aramayı temizle" title="Aramayı temizle">
                            <BiXCircle size="2rem" aria-hidden="true" />
                        </button>
                    ) : (
                        <BiSearch size="2rem" aria-hidden="true" />
                    )}
                </InputGroup.Text>
            </InputGroup>

            <div id={`${id}-status`} className="visually-hidden" aria-live="polite">
                {loading
                    ? "Aranıyor"
                    : showOptions
                        ? `${groupedResults.totalCount} sonuç bulundu`
                        : selectedLabel
                            ? `${selectedLabel} seçildi`
                            : "En az iki karakter yazarak arama yapabilirsiniz"}
            </div>

            {showOptions && (
                <div
                    id={`${id}-results`}
                    className="fulltextsearch-results"
                    role="listbox"
                    aria-label="Arama sonuçları"
                    ref={resultListRef}
                >
                    {resultContent}
                </div>
            )}
        </div>
    );
});

FulltextSearchQuery.displayName = "FulltextSearchQuery";
