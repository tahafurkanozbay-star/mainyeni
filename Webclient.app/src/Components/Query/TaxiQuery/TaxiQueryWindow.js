import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { TaxiQueryBusiness } from "../../../Business/TaxiQueryBusiness";
import { BiSearch } from "react-icons/bi";
import { FiMapPin } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

const DEFAULT_QUERY = Object.freeze({ name: "", districtId: "", districtName: "", nbhoodId: "", nbhoodName: "", showMapSelect: false, showNearby: false });
const TAXI_SYMBOL = Object.freeze({ type: "picture-marker", url: "images/icons/sidebar/taksi.png", width: "48px", height: "48px" });

const openRoute = geometry => {
    const latitude = Number(geometry?.latitude ?? geometry?.y);
    const longitude = Number(geometry?.longitude ?? geometry?.x);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    const opened = window.open(`https://www.google.com.tr/maps?saddr=My+Location&daddr=${latitude},${longitude}`, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
    return true;
};

export const TaxiQueryWindow = React.forwardRef((props, ref) => {
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState([]);
    const [nbhoodList, setNbhoodList] = useState([]);
    const [query, setQuery] = useState({ ...DEFAULT_QUERY });
    const [clusterLayer, setClusterLayer] = useState(null);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);

    const removeLastClusterLayer = () => {
        if (clusterLayer?.layerObj && mapView?.map) mapView.map.remove(clusterLayer.layerObj);
        setClusterLayer(null);
    };

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
        }
    }), [props.id, clusterLayer, mapView]);

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

    const submitQuery = async event => {
        event?.preventDefault();
        if (loading) return;
        setLoading(true);
        LoggingBusiness.CreateClientLog("Taksi/Sorgu", `${query.districtName}/${query.nbhoodName}/${query.name}`);
        try {
            const result = await TaxiQueryBusiness.Query(query, false);
            if (result?.type !== Constants_ServiceResultType.Success) throw new Error(result?.message || "Taksi durakları alınamadı");
            setResultList((result.data || []).map(item => ({
                ObjectId: item.attr?.objectid,
                Title: item.attr?.adi || "İsimsiz taksi durağı",
                Phone: item.attr?.telefon || "",
                Address: item.attr?.adres || "Adres bilgisi bulunmuyor"
            })));
            setActiveTab("query");

            const nextCluster = await CommonBusiness.Clustering.CreateClusterLayer("TaxiQueryUrl", props.windowTitle || "Taksi", query, TAXI_SYMBOL);
            removeLastClusterLayer();
            if (nextCluster?.layerObj && mapView?.map) {
                setClusterLayer(nextCluster);
                mapView.map.add(nextCluster.layerObj);
            }
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Taksi sorgusu tamamlanamadı");
        } finally {
            setLoading(false);
        }
    };

    const getItemDetails = async item => {
        const result = await TaxiQueryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type !== Constants_ServiceResultType.Success || !result.data?.length) return null;
        return result.data[0];
    };

    const showItem = async item => {
        LoggingBusiness.CreateClientLog("Taksi/Detay Göster", `${item.ObjectId || ""}/${item.Title}`);
        const details = await getItemDetails(item);
        if (!details?.geometry) return;
        GisGraphicsHelper.ZoomToGeometry(mapView, details.geometry, 18);
        if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
    };

    const showRoute = async item => {
        const details = await getItemDetails(item);
        if (!details?.geometry || !openRoute(details.geometry)) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı");
        }
    };

    const backToForm = () => {
        removeLastClusterLayer();
        setActiveTab("form");
    };

    const isForm = activeTab === "form";

    return (
        <div className="common-query-window" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/sidebar/taksi.png" alt="" aria-hidden="true" />
                <span>Taksi</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} setQueryField={setQueryField} query={query} showNearbySearch={isForm} showMapSelect={isForm} />
            </div>
            <div className={`common-query-window-body ${props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : ""}`}>
                {isForm ? (
                    <Form onSubmit={submitQuery}>
                        {!query.mapSelect && <Form.Group><label className="form-label" htmlFor={`${props.id}-name`}>Adı</label><input id={`${props.id}-name`} className="form-control" value={query.name} onChange={event => setQueryField("name", event.target.value)} /></Form.Group>}
                        {!query.showNearby && !query.mapSelect && <>
                            <Form.Group><label className="form-label" htmlFor={`${props.id}-district`}>İlçe</label><select id={`${props.id}-district`} className="form-select form-control" value={query.districtId} onChange={onDistrictChange}><option value="">Seçiniz..</option>{districtList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}</select></Form.Group>
                            <Form.Group><label className="form-label" htmlFor={`${props.id}-neighborhood`}>Mahalle</label><select id={`${props.id}-neighborhood`} className="form-select" value={query.nbhoodId} onChange={onNeighborhoodChange}><option value="">Seçiniz..</option>{nbhoodList.map(item => <option key={item.attr?.id} value={item.attr?.id}>{item.attr?.ad}</option>)}</select></Form.Group>
                        </>}
                        {!query.mapSelect && <Form.Group>{loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" aria-hidden="true" /><span>Sorgula</span></Button>}</Form.Group>}
                    </Form>
                ) : (
                    <div className="results-container">
                        <div className="results-container-toolbar"><button type="button" className="results-container-back-button" onClick={backToForm}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön</button><div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div></div>
                        {resultList?.map((item, index) => <article className="result-item-container" key={`${item.ObjectId ?? item.Title}-${index}`}><button type="button" className="result-item-info" onClick={() => showItem(item)}><span className="result-item-info-title">{item.Title}</span><span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</span></button><CommonQueryResultItemTools item={item} zoomCallback={() => showItem(item)} showRouteCallback={() => showRoute(item)} /></article>)}
                    </div>
                )}
            </div>
        </div>
    );
});

TaxiQueryWindow.displayName = "TaxiQueryWindow";
