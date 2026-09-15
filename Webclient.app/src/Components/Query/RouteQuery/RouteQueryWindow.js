import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { BiRadioCircle, BiRadioCircleMarked, BiSearch } from "react-icons/bi";
import { BsToggleOff, BsToggleOn } from "react-icons/bs";
import { FiArrowUp, FiMapPin } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { RiRouteFill } from "react-icons/ri";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { RouteQueryBusiness } from "../../../Business/RouteQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, NoResultsFound } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";

const WINDOW_TITLE = "Rotalar";
const WINDOW_LOGO = "images/icons/sidebar/rotalar.png";
const DEFAULT_QUERY = Object.freeze({
    name: "",
    districtId: "",
    districtName: "",
    showMapSelect: false,
    showNearby: false,
    routeLevel: 3,
    showCultureWalkingRoute: true,
    showNatureWalkingRoute: true
});

const createDefaultQuery = () => ({ ...DEFAULT_QUERY });

const getResultValue = (attributes, lower, upper) => attributes?.[lower] ?? attributes?.[upper];

const normalizeRoute = item => {
    const attributes = item?.attr || {};
    return {
        Id: attributes.id ?? attributes.objectid,
        Title: getResultValue(attributes, "adi", "ADI") || "İsimsiz rota",
        Description: getResultValue(attributes, "aciklama", "ACIKLAMA") || "Açıklama bulunmuyor",
        RouteLevel: getResultValue(attributes, "zorlukderecesi", "ZORLUKDERECESI") ?? "-",
        District: getResultValue(attributes, "ilce", "ILCE") || "İlçe bilgisi bulunmuyor",
        RouteType: getResultValue(attributes, "tip", "TIP")
    };
};

const getRouteTypeLabel = routeType => Number(routeType) === 1
    ? "Kültürel Yürüyüş Rotası"
    : "Doğa Yürüyüş Rotası";

export const RouteQueryWindow = React.forwardRef((props, ref) => {
    const [districtList, setDistrictList] = useState(null);
    const [query, setQuery] = useState(createDefaultQuery);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    const commonToolsComponentRef = useRef(null);
    const mapViewRef = useRef(null);
    const clusterLayerRef = useRef(null);
    const requestIdRef = useRef(0);

    const showMessage = message => {
        props.windowManager.ShowMessage(Constants_MessageType.Error, message);
    };

    const logClientEvent = (eventName, payload) => {
        Promise.resolve(LoggingBusiness.CreateClientLog(eventName, payload)).catch(() => {});
    };

    const removeLastClusterLayer = () => {
        const mapView = mapViewRef.current;
        const layer = clusterLayerRef.current?.layerObj || clusterLayerRef.current;
        if (mapView?.map && layer) {
            mapView.map.remove(layer);
        }
        clusterLayerRef.current = null;
    };

    const resetWindow = () => {
        requestIdRef.current += 1;
        removeLastClusterLayer();
        MapManager.RemoveAllGraphics();
        setQuery(createDefaultQuery());
        setResultList(null);
        setActiveTab("form");
        setLoading(false);
        setErrorMessage("");
        commonToolsComponentRef.current?.OnClose?.();
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: resetWindow
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        mapViewRef.current = MapManager.GetMapView();

        let active = true;
        NumberingQueryBusiness.GetDistricts()
            .then(result => {
                if (active && result?.type === Constants_ServiceResultType.Success) {
                    setDistrictList(result.data || []);
                }
            })
            .catch(error => {
                if (active) setErrorMessage(error?.message || "İlçe listesi alınamadı.");
            });

        return () => {
            active = false;
            requestIdRef.current += 1;
            removeLastClusterLayer();
        };
    }, [props.windowManager, ref]);

    const setQueryField = (field, value) => {
        setQuery(current => ({ ...current, [field]: value }));
    };

    const districtOnChange = event => {
        const districtId = event.target.value;
        const districtName = districtId ? event.target.selectedOptions[0]?.text || "" : "";
        setQuery(current => ({ ...current, districtId, districtName }));
    };

    const setRouteType = field => {
        setQuery(current => ({ ...current, [field]: !current[field] }));
    };

    const loadRouteLayer = async () => {
        const mapView = mapViewRef.current;
        if (!mapView?.map) return;

        try {
            const clusterLayer = await CommonBusiness.Clustering.CreateClusterLayer(
                props.queryServiceTitle,
                WINDOW_TITLE,
                null,
                null
            );
            removeLastClusterLayer();
            if (clusterLayer?.layerObj) {
                clusterLayerRef.current = clusterLayer;
                mapView.map.add(clusterLayer.layerObj);
            }
        } catch (error) {
            // Results remain useful even if the optional overview layer fails.
        }
    };

    const submitQuery = async event => {
        event?.preventDefault?.();
        const requestId = ++requestIdRef.current;
        setLoading(true);
        setErrorMessage("");

        logClientEvent(
            "Rota/Sorgu",
            `${query.districtName}/${query.routeLevel}/${query.showCultureWalkingRoute}/${query.showNatureWalkingRoute}`
        );

        try {
            const result = await RouteQueryBusiness.Query(query, false);
            if (requestId !== requestIdRef.current) return;

            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error("Rota sonuçları alınamadı.");
            }

            setResultList((result.data || []).map(normalizeRoute));
            setActiveTab("query");
            loadRouteLayer();
        } catch (error) {
            if (requestId !== requestIdRef.current) return;
            const message = error?.message || "Rota sorgusu sırasında bir hata oluştu.";
            setErrorMessage(message);
            showMessage(message);
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    };

    const getItemDetailsById = async item => {
        const result = await RouteQueryBusiness.Query({ Id: item.Id }, true);
        if (result?.type === Constants_ServiceResultType.Success && result.data?.length) {
            return result.data[0];
        }
        throw new Error("Rota ayrıntıları bulunamadı.");
    };

    const showRouteOnMap = async (event, item) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        logClientEvent("Rota/Detay Göster", `${item.Id}/${item.Title}`);

        try {
            const itemDetails = await getItemDetailsById(item);
            if (!itemDetails?.geometry) throw new Error("Rota geometrisi bulunamadı.");

            const projectedGeometry = await GisGraphicsHelper.ProjectGeometry(itemDetails.geometry, "4326");
            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(projectedGeometry, null);
            MapManager.AddGraphics(graphic, true);
            GisGraphicsHelper.ZoomToGeometryExtent(mapViewRef.current, projectedGeometry, 1.5);

            if (window.screen.width < 960) {
                props.windowManager.ToggleMinimiseWindow(props.id);
            }
        } catch (error) {
            showMessage(error?.message || "Rota haritada gösterilemedi.");
        }
    };

    const showDirections = async (event, item) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();

        try {
            const itemDetails = await getItemDetailsById(item);
            const geometry = itemDetails?.geometry;
            const destination = geometry?.extent?.center || geometry?.centroid || geometry;
            const latitude = destination?.latitude ?? destination?.y;
            const longitude = destination?.longitude ?? destination?.x;
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                throw new Error("Yol tarifi için rota konumu bulunamadı.");
            }

            logClientEvent("Rota/Yol Tarifi", `${item.Id}/${item.Title}`);
            window.open(
                `https://www.google.com.tr/maps?saddr=My+Location&daddr=${latitude},${longitude}`,
                "_blank",
                "noopener,noreferrer"
            );
        } catch (error) {
            showMessage(error?.message || "Yol tarifi alınamadı.");
        }
    };

    const backToForm = () => {
        removeLastClusterLayer();
        MapManager.RemoveAllGraphics();
        setActiveTab("form");
    };

    const renderForm = () => (
        <Form onSubmit={submitQuery}>
            <fieldset className="horizontal-layout">
                <legend className="visually-hidden">Rota türleri</legend>
                <button
                    type="button"
                    className="form-checkbox form-checkbox-vertical"
                    aria-pressed={query.showCultureWalkingRoute}
                    onClick={() => setRouteType("showCultureWalkingRoute")}
                >
                    <span>Kültürel Rotalar</span>
                    {query.showCultureWalkingRoute ? <BsToggleOn aria-hidden="true" /> : <BsToggleOff aria-hidden="true" />}
                </button>
                <button
                    type="button"
                    className="form-checkbox form-checkbox-vertical"
                    aria-pressed={query.showNatureWalkingRoute}
                    onClick={() => setRouteType("showNatureWalkingRoute")}
                >
                    <span>Doğal Yürüyüş Rotaları</span>
                    {query.showNatureWalkingRoute ? <BsToggleOn aria-hidden="true" /> : <BsToggleOff aria-hidden="true" />}
                </button>
            </fieldset>

            {!query.showNearby && !query.mapSelect && (
                <Form.Group>
                    <label className="form-label" htmlFor={`${props.id}-route-district`}>İlçe</label>
                    <select
                        id={`${props.id}-route-district`}
                        className="form-select form-control"
                        onChange={districtOnChange}
                        value={query.districtId}
                    >
                        <option value="">Seçiniz..</option>
                        {districtList?.map(item => (
                            <option key={item.attr.id} value={item.attr.id}>{item.attr.ad}</option>
                        ))}
                    </select>
                </Form.Group>
            )}

            <Form.Group>
                <fieldset className="route-level-fieldset">
                    <legend className="form-label">Zorluk Derecesi</legend>
                    <div className="radio-group" role="radiogroup" aria-label="Zorluk derecesi">
                        {[1, 2, 3, 4, 5].map(level => (
                            <button
                                type="button"
                                role="radio"
                                aria-checked={query.routeLevel === level}
                                className="radio-group-item"
                                key={level}
                                onClick={() => setQueryField("routeLevel", level)}
                            >
                                {query.routeLevel === level
                                    ? <BiRadioCircleMarked className="radio-group-item-icon" aria-hidden="true" />
                                    : <BiRadioCircle className="radio-group-item-icon" aria-hidden="true" />}
                                <span>{level}</span>
                            </button>
                        ))}
                    </div>
                </fieldset>
            </Form.Group>

            {!query.mapSelect && (
                <Form.Group>
                    {loading
                        ? <ButtonLoading />
                        : (
                            <Button type="submit" className="form-button">
                                <BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span>
                            </Button>
                        )}
                </Form.Group>
            )}
            {errorMessage && <div className="kr-status-banner kr-status-banner--danger" role="alert">{errorMessage}</div>}
        </Form>
    );

    const renderResults = () => (
        <div className="results-container">
            <div className="results-container-toolbar">
                <button className="results-container-back-button" type="button" onClick={backToForm}>
                    <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />
                    &nbsp;Geri Dön
                </button>
                <div className="results-container-count" aria-live="polite">
                    <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
                </div>
            </div>

            {resultList?.length === 0 ? <NoResultsFound /> : resultList?.map(item => (
                <article className="result-item-container" key={item.Id ?? `${item.Title}-${item.District}`}>
                    <button
                        type="button"
                        className="result-item-info"
                        onClick={event => showRouteOnMap(event, item)}
                        aria-label={`${item.Title} rotasını haritada göster`}
                    >
                        <span className="result-item-info-title">{item.Title}</span>
                        <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.District}</span>
                        <span className="result-item-info-address-description"><FiMapPin aria-hidden="true" />&nbsp;{item.Description}</span>
                        <span className="result-item-info-phone">
                            <FiArrowUp aria-hidden="true" />&nbsp;{item.RouteLevel}
                            &nbsp;&nbsp;&nbsp;&nbsp;
                            <RiRouteFill aria-hidden="true" />&nbsp;{getRouteTypeLabel(item.RouteType)}
                        </span>
                    </button>
                    <CommonQueryResultItemTools
                        item={item}
                        zoomCallback={event => showRouteOnMap(event, item)}
                        showRouteCallback={event => showDirections(event, item)}
                    />
                </article>
            ))}
        </div>
    );

    return (
        <section
            className="common-query-window"
            aria-label={WINDOW_TITLE}
            style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={WINDOW_LOGO} alt="" aria-hidden="true" />
                <span>{WINDOW_TITLE}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    query={query}
                    showNearbySearch={activeTab === "form"}
                    showMapSelect={activeTab === "form"}
                />
            </header>
            <div className={`common-query-window-body ${props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : ""}`}>
                {activeTab === "form" ? renderForm() : renderResults()}
            </div>
        </section>
    );
});

RouteQueryWindow.displayName = "RouteQueryWindow";
