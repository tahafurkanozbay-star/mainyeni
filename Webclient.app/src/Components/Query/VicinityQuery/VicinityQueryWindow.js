import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { loadArcgisModules as loadModules } from "../../../gis-engine/arcgisModuleRuntime";
import { Accordion, Button, Form } from "react-bootstrap";
import { BiLayer, BiSearch } from "react-icons/bi";
import { FiMapPin } from "react-icons/fi";
import { FulltextSearchQueryBusiness } from "../../../Business/FulltextSearchQueryBusiness";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { IsNull } from "../../../Toolbox/ObjectHelper";
import { ContainerLoading, NoResultsFound } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import "./VicinityQueryWindow.css";

const DEFAULT_BUFFER_DISTANCE = 20;
const MAX_RESULTS_PER_CATEGORY = 50;

const safeLog = (name, payload) => {
    Promise.resolve(LoggingBusiness.CreateClientLog(name, payload)).catch(() => {});
};

const getStableItemId = item => item?.Id ?? item?.attr?.id ?? item?.attr?.objectid ?? item?.attr?.ID;

export const VicinityQueryWindow = React.forwardRef((props, ref) => {
    const [loading, setLoading] = useState(false);
    const [neighborhoodList, setNeighborhoodList] = useState([]);
    const [filteredOptions, setFilteredOptions] = useState(null);
    const [bufferDistance, setBufferDistance] = useState(DEFAULT_BUFFER_DISTANCE);
    const [errorMessage, setErrorMessage] = useState("");

    const mapViewRef = useRef(null);
    const bufferGraphicRef = useRef(null);
    const selectedGraphicRef = useRef(null);
    const requestIdRef = useRef(0);

    const removeGraphic = useCallback(graphicRef => {
        if (!graphicRef.current) return;
        MapManager.RemoveGraphics(graphicRef.current);
        graphicRef.current = null;
    }, []);

    const clearOwnedGraphics = useCallback(() => {
        removeGraphic(bufferGraphicRef);
        removeGraphic(selectedGraphicRef);
    }, [removeGraphic]);

    const resetWindow = () => {
        requestIdRef.current += 1;
        clearOwnedGraphics();
        setFilteredOptions(null);
        setBufferDistance(DEFAULT_BUFFER_DISTANCE);
        setLoading(false);
        setErrorMessage("");
    };

    const drawBuffer = async distance => {
        const event = MapManager.GetMapClickEvent();
        if (!event?.mapPoint) return;

        try {
            const [Circle, Graphic] = await loadModules(["esri/geometry/Circle", "esri/Graphic"]);
            const circleGeometry = new Circle({
                center: event.mapPoint,
                geodesic: true,
                numberOfPoints: 100,
                radius: distance * 100,
                radiusUnit: "meters"
            });
            const graphic = new Graphic({
                geometry: circleGeometry,
                symbol: {
                    type: "simple-fill",
                    color: [255, 255, 255, 0.3],
                    outline: { width: 3, color: "#8f06e7" }
                }
            });

            removeGraphic(bufferGraphicRef);
            bufferGraphicRef.current = graphic;
            MapManager.AddGraphics(graphic, false);
        } catch (error) {
            setErrorMessage(error?.message || "Arama alanı haritada çizilemedi.");
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            setBufferDistance(DEFAULT_BUFFER_DISTANCE);
            drawBuffer(DEFAULT_BUFFER_DISTANCE);
        },
        OnClose: resetWindow
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();

        let active = true;
        NumberingQueryBusiness.GetAllNeighborhoods()
            .then(results => {
                if (active) setNeighborhoodList(results?.data || []);
            })
            .catch(() => {
                if (active) setNeighborhoodList([]);
            });

        return () => {
            active = false;
            requestIdRef.current += 1;
            clearOwnedGraphics();
        };
    }, [clearOwnedGraphics, props.windowManager, ref]);

    const bufferDistanceChange = event => {
        const value = Number.parseInt(event?.target?.value ?? DEFAULT_BUFFER_DISTANCE, 10);
        if (!Number.isFinite(value) || value < 1) return;
        setBufferDistance(value);
        drawBuffer(value);
    };

    const resolveNeighborhoodName = item => {
        if (!IsNull(item?.attr?.mahalle_adi)) return item.attr.mahalle_adi;
        const neighborhoodId = item?.attr?.mahalleid;
        return neighborhoodList.find(candidate => String(candidate?.attr?.id) === String(neighborhoodId))?.attr?.ad || "";
    };

    const createOption = (results, title, category, idField, titleField) => {
        const source = Array.isArray(results) ? results : [];
        return {
            Title: title,
            Count: source.length,
            Options: source.slice(0, MAX_RESULTS_PER_CATEGORY).map(item => ({
                ...item,
                Id: item?.attr?.[idField] ?? getStableItemId(item),
                Category: category,
                Title: item?.attr?.[titleField] ?? item?.attr?.adi ?? item?.attr?.ad ?? title,
                Geometry: item?.geometry,
                attr: {
                    ...(item?.attr || {}),
                    _MAHALLE_ADI: resolveNeighborhoodName(item)
                }
            }))
        };
    };

    const showItemOnMap = async (event, item) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        safeLog("Yakınımda Ara/Tıklama", `${item.Id}/${item.Title}`);

        try {
            const sourceGeometry = item?.geometry || item?.Geometry;
            if (!sourceGeometry) throw new Error("Sonuç konumu bulunamadı.");
            const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(sourceGeometry, "4326");
            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry);

            removeGraphic(selectedGraphicRef);
            selectedGraphicRef.current = graphic;
            GisGraphicsHelper.AddGraphics(mapViewRef.current, graphic);
            GisGraphicsHelper.ZoomToGeometry(mapViewRef.current, projectedGeometry, 15);

            if (window.screen.width < 768) {
                props.windowManager.ToggleMinimiseWindow(props.id);
            }
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Sonuç haritada gösterilemedi.");
        }
    };

    const showRoute = (event, item) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const geometry = item?.geometry || item?.Geometry;
        if (!geometry) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi için konum bilgisi bulunamadı.");
            return;
        }
        safeLog("Yakınımda Ara/Yol Tarifi", `${item.Id}/${item.Title}`);
        const url = GoogleMapsBusiness.CreateRoutesUrlFromPoint(geometry);
        window.open(url, "_blank", "noopener,noreferrer");
    };

    const runSearch = async event => {
        event?.preventDefault?.();
        const mapEvent = MapManager.GetMapClickEvent();
        if (!mapEvent?.mapPoint) {
            const message = "Yakın çevre araması için önce haritada bir konum seçin.";
            setErrorMessage(message);
            props.windowManager.ShowMessage(Constants_MessageType.Error, message);
            return;
        }

        const requestId = ++requestIdRef.current;
        setLoading(true);
        setErrorMessage("");
        safeLog(
            "Yakınımda Ara/Sorgu",
            `${mapEvent.mapPoint.latitude}/${mapEvent.mapPoint.longitude}/${bufferDistance}`
        );

        try {
            const services = (MapManager.GetConfigurationServices() || []).filter(service => service.showInSearch === true);
            const query = {
                showNearby: true,
                userLocation: mapEvent.mapPoint,
                bufferDistance
            };
            const settled = await Promise.allSettled(
                services.map(service => FulltextSearchQueryBusiness.QueryService(service, query, true))
            );
            if (requestId !== requestIdRef.current) return;

            const successfulResults = settled
                .filter(result => result.status === "fulfilled" && result.value)
                .map(result => result.value);

            const searchOptions = successfulResults
                .map(item => createOption(item.Data, item.Title, item.Title, "ID", "AD"))
                .filter(option => option.Count > 0);

            setFilteredOptions(searchOptions);
            if (!searchOptions.length && settled.some(result => result.status === "rejected")) {
                setErrorMessage("Bazı servisler yanıt vermedi; kullanılabilir servislerde sonuç bulunamadı.");
            }
        } catch (error) {
            if (requestId !== requestIdRef.current) return;
            const message = error?.message || "Yakın çevre araması tamamlanamadı.";
            setErrorMessage(message);
            props.windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    };

    return (
        <section
            className="common-query-window"
            aria-label="Yakınımda Ara"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/toolbar/bilgi.png" alt="" aria-hidden="true" />
                <span>Yakınımda Ara</span>
                <CommonQueryWindowTools
                    windowManager={props.windowManager}
                    windowId={props.id}
                    showNearbySearch={false}
                    showMapSelect={false}
                    setQueryField={() => {}}
                    query={null}
                />
            </header>

            <div className="common-query-window-body layer-list-window-body">
                {!loading && (
                    <form className="vicinity-query-controls" onSubmit={runSearch}>
                        <div className="vicinity-query-range-control">
                            <label htmlFor={`${props.id}-vicinity-distance`} className="visually-hidden">Arama mesafesi</label>
                            <Form.Range
                                id={`${props.id}-vicinity-distance`}
                                min={1}
                                max={100}
                                value={bufferDistance}
                                onChange={bufferDistanceChange}
                                aria-valuetext={`${bufferDistance * 100} metre`}
                            />
                        </div>
                        <output className="common-query-window-tools-buffer-distance-indicator" htmlFor={`${props.id}-vicinity-distance`}>
                            {bufferDistance * 100} m
                        </output>
                        <Button className="form-button" style={{ marginTop: 0 }} type="submit">
                            <BiSearch aria-hidden="true" />&nbsp;&nbsp;Ara
                        </Button>
                    </form>
                )}

                {errorMessage && <div className="kr-status-banner kr-status-banner--warning" role="status">{errorMessage}</div>}

                <div className="vicinity-query-results-container" aria-live="polite">
                    {loading ? <ContainerLoading /> : filteredOptions?.length === 0 ? <NoResultsFound /> : (
                        <Accordion defaultActiveKey={[]} alwaysOpen>
                            {filteredOptions?.map((optionGroup, groupIndex) => (
                                <Accordion.Item
                                    eventKey={String(groupIndex)}
                                    className="vicinity-query-results-accordion-item"
                                    key={`${optionGroup.Title}-${groupIndex}`}
                                >
                                    <Accordion.Header className="vicinity-query-results-accordion-item-header">
                                        <BiLayer aria-hidden="true" /> <span>{optionGroup.Title} ({optionGroup.Count})</span>
                                    </Accordion.Header>
                                    <Accordion.Body>
                                        <div className="vicinity-query-results-accordion-item-body">
                                            {optionGroup.Options.map((item, itemIndex) => (
                                                <article className="result-item-container" key={getStableItemId(item) ?? `${optionGroup.Title}-${itemIndex}`}>
                                                    <button
                                                        type="button"
                                                        className="result-item-info"
                                                        onClick={event => showItemOnMap(event, item)}
                                                        aria-label={`${item.Title} sonucunu haritada göster`}
                                                    >
                                                        <span className="result-item-info-title">{item.Title}</span>
                                                        {item.attr?._MAHALLE_ADI && (
                                                            <span className="result-item-info-address">
                                                                <FiMapPin aria-hidden="true" />&nbsp;{item.attr._MAHALLE_ADI}
                                                            </span>
                                                        )}
                                                        {item.attr?.adres && (
                                                            <span className="result-item-info-address-description">
                                                                <FiMapPin aria-hidden="true" />&nbsp;{item.attr.adres}
                                                            </span>
                                                        )}
                                                    </button>
                                                    <CommonQueryResultItemTools
                                                        item={item}
                                                        zoomCallback={event => showItemOnMap(event, item)}
                                                        showRouteCallback={event => showRoute(event, item)}
                                                    />
                                                </article>
                                            ))}
                                        </div>
                                    </Accordion.Body>
                                </Accordion.Item>
                            ))}
                        </Accordion>
                    )}
                </div>
            </div>
        </section>
    );
});

VicinityQueryWindow.displayName = "VicinityQueryWindow";
