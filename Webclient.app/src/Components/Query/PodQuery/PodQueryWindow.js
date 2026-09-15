import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_LayerType, Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { PodQueryBusiness } from "../../../Business/PodQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { ButtonLoading } from "../../Common/Loading";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { TextHelper } from "../../../Toolbox/TextHelper";
import { createPictureMarkerSymbol } from "../../../gis-engine/iconPresentation";

const DEFAULT_QUERY = Object.freeze({ name: "", districtId: "", districtName: "", nbhoodId: "", nbhoodName: "", showPodOnDuty: false, showMapSelect: false, showNearby: false });
const PHARMACY_ICON_RECORD = Object.freeze({ type: "PharmacyQueryUrl", category: "Eczaneler", title: "Eczane" });
const PHARMACY_SYMBOL = Object.freeze(createPictureMarkerSymbol(PHARMACY_ICON_RECORD, 12, { minSize: 48, maxSize: 48 }));

const normalizePharmacy = (item, onDuty = false) => {
    const attributes = item?.attr || item?.attributes || item || {};
    return {
        ObjectId: attributes.objectid ?? attributes.ObjectId ?? attributes.id ?? null,
        Title: attributes.adi ?? attributes.title ?? attributes.name ?? "İsimsiz eczane",
        Phone: attributes.telefon ?? attributes.phone ?? "",
        Address: attributes.adres ?? attributes.address ?? "Adres bilgisi bulunmuyor",
        AddressDescription: "Adres tarifi bulunmuyor",
        Lat: Number(attributes.lat ?? attributes.latitude ?? item?.lat),
        Lng: Number(attributes.lng ?? attributes.longitude ?? item?.lng),
        onDuty,
        raw: item
    };
};

const openExternal = url => {
    if (!url) return;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
};

export const PodQueryWindow = React.forwardRef((props, ref) => {
    const commonToolsComponentRef = useRef();
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [query, setQuery] = useState({ ...DEFAULT_QUERY });
    const [clusterLayer, setClusterLayer] = useState(null);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);

    const removeLastClusterLayer = useCallback(() => {
        if (clusterLayer && mapView?.map) mapView.map.remove(clusterLayer);
        setClusterLayer(null);
    }, [clusterLayer, mapView]);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {},
        OnClose: () => {
            setQuery({ ...DEFAULT_QUERY });
            setActiveTab("form");
            setResultList(null);
            removeLastClusterLayer();
            commonToolsComponentRef.current?.OnClose?.();
        }
    }), [props.id, removeLastClusterLayer]);

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        setMapView(MapManager.GetMapView());
        let active = true;
        NumberingQueryBusiness.GetDistricts().then(result => {
            if (active && result?.type === Constants_ServiceResultType.Success) setDistrictList(result.data || []);
        }).catch(() => {
            if (active) setDistrictList([]);
        });
        return () => {
            active = false;
        };
    }, [props.windowManager, ref]);

    const setQueryField = (field, value) => setQuery(current => ({ ...current, [field]: value }));

    const onDistrictChange = async event => {
        const districtId = event.target.value;
        const districtName = event.target.selectedOptions[0]?.text || "";
        setQuery(current => ({ ...current, districtId, districtName, nbhoodId: "", nbhoodName: "" }));
        setNbhoodList([]);
        if (!districtId) return;
        const result = await NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId);
        if (result?.type === Constants_ServiceResultType.Success) setNbhoodList(result.data || []);
    };

    const onNeighborhoodChange = event => setQuery(current => ({ ...current, nbhoodId: event.target.value, nbhoodName: event.target.selectedOptions[0]?.text || "" }));

    const showOnDutyLayer = async rawItems => {
        const validItems = rawItems.map(item => normalizePharmacy(item, true)).filter(item => Number.isFinite(item.Lat) && Number.isFinite(item.Lng));
        const points = await Promise.all(validItems.map(item => GisGraphicsHelper.CreatePoint({ latitude: item.Lat, longitude: item.Lng })));
        const geoJson = {
            type: "FeatureCollection",
            features: points.map((point, index) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [point.x, point.y] },
                id: TextHelper.CreateGuid(),
                properties: validItems[index].raw
            })),
            layerType: Constants_LayerType.GeoJSONLayer
        };
        const layer = await CommonBusiness.Clustering.CreateGeoJsonClusterLayer(geoJson, "Nöbetçi Eczaneler", PHARMACY_SYMBOL);
        removeLastClusterLayer();
        if (layer && mapView?.map) {
            setClusterLayer(layer);
            mapView.map.add(layer);
        }
    };

    const submitQuery = async event => {
        event?.preventDefault();
        if (loading) return;
        setLoading(true);
        try {
            if (query.showPodOnDuty) {
                LoggingBusiness.CreateClientLog("Eczaneler/Sorgu (Nöbetçi)", query.name);
                const result = await PodQueryBusiness.QueryPodOnDuty(query);
                if (result?.type !== Constants_ServiceResultType.Success) throw new Error(result?.message || "Nöbetçi eczaneler alınamadı");
                const rawItems = Array.isArray(result.data) ? result.data : [];
                setResultList(rawItems.map(item => normalizePharmacy(item, true)));
                setActiveTab("query");
                await showOnDutyLayer(rawItems);
            } else {
                LoggingBusiness.CreateClientLog("Eczaneler/Sorgu (Tüm)", `${query.districtName}/${query.nbhoodName}/${query.name}`);
                const result = await PodQueryBusiness.Query(query, false);
                if (result?.type !== Constants_ServiceResultType.Success) throw new Error(result?.message || "Eczaneler alınamadı");
                setResultList((result.data || []).map(item => normalizePharmacy(item, false)));
                setActiveTab("query");
                const nextCluster = await CommonBusiness.Clustering.CreateClusterLayer("PharmacyQueryUrl", "eczaneler", query, PHARMACY_SYMBOL);
                removeLastClusterLayer();
                if (nextCluster?.layerObj && mapView?.map) {
                    setClusterLayer(nextCluster.layerObj);
                    mapView.map.add(nextCluster.layerObj);
                }
            }
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Eczane sorgusu tamamlanamadı");
        } finally {
            setLoading(false);
        }
    };

    const getItemDetails = async item => {
        if (item.onDuty) return item;
        const result = await PodQueryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type !== Constants_ServiceResultType.Success || !result.data?.length) return null;
        return result.data[0];
    };

    const showItem = async item => {
        LoggingBusiness.CreateClientLog("Eczaneler/Detay Göster", `${item.ObjectId || ""}/${item.Title}`);
        if (item.onDuty) {
            if (!Number.isFinite(item.Lat) || !Number.isFinite(item.Lng)) return;
            const point = await GisGraphicsHelper.CreatePoint({ latitude: item.Lat, longitude: item.Lng });
            const graphic = await GisGraphicsHelper.CreateGraphicFromGeometry(point, PHARMACY_SYMBOL);
            MapManager.AddGraphics(graphic, true);
            GisGraphicsHelper.ZoomToGeometry(mapView, point, 16);
        } else {
            const details = await getItemDetails(item);
            if (details?.geometry) GisGraphicsHelper.ZoomToGeometry(mapView, details.geometry, 18);
        }
        if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
    };

    const showRoute = async item => {
        LoggingBusiness.CreateClientLog("Eczaneler/Yol Tarifi", `${item.ObjectId || ""}/${item.Title}`);
        if (item.onDuty) {
            if (!Number.isFinite(item.Lat) || !Number.isFinite(item.Lng)) return;
            const point = await GisGraphicsHelper.CreatePoint({ latitude: item.Lat, longitude: item.Lng });
            openExternal(GoogleMapsBusiness.CreateRoutesUrlFromPoint(point));
            return;
        }
        const details = await getItemDetails(item);
        if (!details?.geometry) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı");
            return;
        }
        openExternal(GoogleMapsBusiness.CreateRoutesUrlFromPoint(details.geometry));
    };

    const backToForm = () => {
        removeLastClusterLayer();
        setActiveTab("form");
    };

    const isForm = activeTab === "form";

    return (
        <section className="common-query-window" aria-label="Eczane" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/sidebar/eczane.png" alt="" aria-hidden="true" />
                <span>Eczane</span>
                <CommonQueryWindowTools ref={commonToolsComponentRef} windowManager={props.windowManager} windowId={props.id} setQueryField={setQueryField} query={query} showNearbySearch={isForm} showMapSelect={isForm} />
            </header>
            <div className={`common-query-window-body ${props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : ""}`}>
                {isForm ? (
                    <Form onSubmit={submitQuery}>
                        <Form.Group>
                            <label className="form-checkbox"><span>Nöbetçi Eczane Ara</span><input type="checkbox" checked={query.showPodOnDuty} onChange={event => setQueryField("showPodOnDuty", event.target.checked)} /></label>
                        </Form.Group>
                        {!query.mapSelect && <Form.Group><label className="form-label" htmlFor={`${props.id}-name`}>Adı</label><input id={`${props.id}-name`} className="form-control" value={query.name} onChange={event => setQueryField("name", event.target.value)} /></Form.Group>}
                        {!query.showPodOnDuty && !query.showNearby && !query.mapSelect && <>
                            <Form.Group><label className="form-label" htmlFor={`${props.id}-district`}>İlçe</label><select id={`${props.id}-district`} className="form-select form-control" value={query.districtId} onChange={onDistrictChange}><option value="">Seçiniz..</option>{districtList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}</select></Form.Group>
                            <Form.Group><label className="form-label" htmlFor={`${props.id}-neighborhood`}>Mahalle</label><select id={`${props.id}-neighborhood`} className="form-select" value={query.nbhoodId} onChange={onNeighborhoodChange} disabled={!query.districtId}><option value="">Seçiniz..</option>{nbhoodList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}</select></Form.Group>
                        </>}
                        {!query.mapSelect && <Form.Group>{loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span></Button>}</Form.Group>}
                    </Form>
                ) : (
                    <div className="results-container">
                        <div className="results-container-toolbar"><button type="button" className="results-container-back-button" onClick={backToForm}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön</button><div className="results-container-count" aria-live="polite"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div></div>
                        {resultList?.map((item, index) => <article className="result-item-container" key={`${item.ObjectId ?? item.Title}-${index}`}><button type="button" className="result-item-info" onClick={() => showItem(item)} aria-label={`${item.Title} konumunu haritada göster`}><span className="result-item-info-title">{item.Title}</span><span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</span><span className="result-item-info-address-description"><FiMapPin aria-hidden="true" />&nbsp;{item.AddressDescription}</span></button><CommonQueryResultItemTools item={item} zoomCallback={() => showItem(item)} showRouteCallback={() => showRoute(item)} /></article>)}
                    </div>
                )}
            </div>
        </section>
    );
});

PodQueryWindow.displayName = "PodQueryWindow";
