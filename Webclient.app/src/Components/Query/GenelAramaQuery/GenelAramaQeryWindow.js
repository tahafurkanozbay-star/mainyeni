import React, { useEffect, useImperativeHandle, useState, useRef } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import { MapManager } from "../../../Store/Managers/MapManager";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, NoResultsFound } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { LayerBusiness } from "../../../Business/LayerBusiness";
import { GenelAramaQeryBusiness } from "../../../Business/GenelAramaQeryBusiness";

export const GenelAramaQeryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "ARAMA SONUÇLARI";
    const windowLogo = "images/search.svg";
    const [query, setQuery] = useState({ name: "" });
    const defaultQuery = props.windowManager.GetQueryParams(props.id);
    const commonToolsComponentRef = useRef();
    const [mapView, setMapView] = useState(null);
    const [loading, setLoading] = useState(false);
    const [resultList, setResultList] = useState(null);
    const [errorMessage, setErrorMessage] = useState("");
    const [clusterLayer, setClusterLayer] = useState(null);
    const [activeTab, setActiveTab] = useState("form");

    useImperativeHandle(ref, () => ({
        id: props.id, visible: false, minimized: false,
        OnShow: () => { DebugHelper.Log("show " + props.id); fetchQueryResults(); },
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery(defaultQuery || { name: "" });
            setActiveTab("form");
            setResultList(null);
            setErrorMessage("");
            removeLastClusterLayer();
            commonToolsComponentRef.current?.OnClose?.();
        }
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);
        if (_mapView) fetchQueryResults();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapView]);

    const removeLastClusterLayer = () => {
        if (clusterLayer != null && mapView?.map) {
            mapView.map.remove(clusterLayer.layerObj);
            setClusterLayer(null);
        }
    };

    const fetchQueryResults = async () => {
        setLoading(true);
        setErrorMessage("");
        setResultList(null);
        const searchQuery = props.windowManager.GetQueryParams(props.id) || { name: "" };
        setQuery(searchQuery);
        LoggingBusiness.CreateClientLog("Genel Arama/Sorgu", searchQuery);
        try {
            const result = await GenelAramaQeryBusiness.Query(searchQuery, false);
            if (result?.type !== Constants_ServiceResultType.Success) {
                const message = "Arama sonuçları alınamadı. Lütfen tekrar deneyin.";
                setErrorMessage(message);
                props.windowManager.ShowMessage(Constants_MessageType.Error, message);
                return;
            }
            const list = (result.data || []).map((_item) => ({
                ObjectId: _item?.attr?.objectid,
                Title: _item?.attr?.adi || "İsimsiz kayıt",
                Phone: _item?.attr?.telefon || "",
                Address: _item?.attr?.adres || "Adres bilgisi bulunmuyor"
            }));
            setResultList(list);
        } catch (error) {
            const message = error?.message || "Arama sırasında beklenmeyen bir hata oluştu.";
            setErrorMessage(message);
            props.windowManager.ShowMessage(Constants_MessageType.Error, message);
        } finally {
            setLoading(false);
        }
    };

    const getItemDetailsById = async (_item) => {
        const result = await GenelAramaQeryBusiness.Query({ ObjectId: _item.ObjectId }, true);
        if (result?.type === Constants_ServiceResultType.Success && result.data != null) return result.data[0];
        throw new Error("Kayıt ayrıntıları bulunamadı.");
    };

    const item_OnClick = (e, _item) => {
        e?.preventDefault?.();
        LoggingBusiness.CreateClientLog("Parklar/Detay Göster", `${_item.ObjectId || ""}/${_item.Address || ""}`);
        getItemDetailsById(_item).then(_itemDetails => {
            GisGraphicsHelper.ZoomToGeometry(mapView, _itemDetails?.geometry, 18);
            if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
        }).catch(error => props.windowManager.ShowMessage(Constants_MessageType.Error, error.message));
    };

    const item_ShowRoute = (e, _item) => {
        e?.preventDefault?.();
        getItemDetailsById(_item).then(_itemDetails => {
            if (_itemDetails?.geometry) {
                const lat = _itemDetails.geometry.latitude;
                const lng = _itemDetails.geometry.longitude;
                if (Number.isFinite(lat) && Number.isFinite(lng)) window.open(`https://www.google.com.tr/maps?saddr=My+Location&daddr=${lat},${lng}`, "_blank");
                else props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - konum bilgisi bulunamadı");
            } else props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı");
        }).catch(error => props.windowManager.ShowMessage(Constants_MessageType.Error, error.message));
    };

    const resultContent = loading ? (
        <div className="experience-search-state" role="status" aria-live="polite" aria-busy="true"><ButtonLoading message="Aranıyor…" /><div className="experience-search-state__hint">Sonuçlar getiriliyor, lütfen bekleyin.</div></div>
    ) : errorMessage ? (
        <div className="kr-status-banner kr-status-banner--danger" role="alert"><div><strong>Arama tamamlanamadı.</strong><div>{errorMessage}</div><button className="kr-btn kr-btn--secondary" type="button" onClick={fetchQueryResults}>Tekrar dene</button></div></div>
    ) : resultList?.length === 0 ? (
        <NoResultsFound message="Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin." />
    ) : resultList?.map(_item => (
        <article className="result-item-container" key={_item.ObjectId || `${_item.Title}-${_item.Address}`}>
            <button type="button" className="result-item-info" onClick={(e) => item_OnClick(e, _item)} aria-label={`${_item.Title} kaydını haritada göster`}>
                <span className="result-item-info-title">{_item.Title}</span>
                <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{_item.Address}</span>
                {_item.Phone && <span className="result-item-info-phone"><FiPhone aria-hidden="true" />&nbsp;{_item.Phone}</span>}
            </button>
            <CommonQueryResultItemTools item={_item} zoomCallback={(e) => item_OnClick(e, _item)} showRouteCallback={(e) => item_ShowRoute(e, _item)} />
        </article>
    ));

    return (
        <section className="sidebar-container" aria-label="Genel arama sonuçları" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <header className="common-query-window-header"><img className="common-query-window-header-icon" src={windowLogo} alt="" /><span>{windowTitle}</span><CommonQueryResultItemTools /></header>
            <div className="results-container" aria-live="polite">
                <div className="results-container-toolbar">
                    <button className="results-container-back-button" type="button" onClick={() => { removeLastClusterLayer(); props.windowManager.ShowWindow("sidebar"); }}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön</button>
                    <div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div>
                </div>
                {resultContent}
            </div>
        </section>
    );
});
