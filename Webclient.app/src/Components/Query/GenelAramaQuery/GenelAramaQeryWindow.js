import React, { useEffect, useImperativeHandle, useState, useRef } from "react";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { GenelAramaQeryBusiness } from "../../../Business/GenelAramaQeryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, NoResultsFound } from "../../Common/Loading";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";

export const GenelAramaQeryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "ARAMA SONUÇLARI";
    const windowLogo = "images/search.svg";
    const [query, setQuery] = useState({ name: "" });
    const [mapView, setMapView] = useState(null);
    const [loading, setLoading] = useState(false);
    const [resultList, setResultList] = useState(null);
    const [errorMessage, setErrorMessage] = useState("");
    const [clusterLayer, setClusterLayer] = useState(null);
    const commonToolsComponentRef = useRef();
    const defaultQuery = props.windowManager.GetQueryParams(props.id);

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => fetchQueryResults(),
        OnClose: () => {
            setQuery(defaultQuery || { name: "" });
            setResultList(null);
            setErrorMessage("");
            setLoading(false);
            removeLastClusterLayer();
            commonToolsComponentRef.current?.OnClose?.();
        }
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        const view = MapManager.GetMapView();
        setMapView(view);
        // Initial data fetch is deferred until a map view is available.
        if (view) fetchQueryResults();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const removeLastClusterLayer = () => {
        if (clusterLayer?.layerObj && mapView?.map) {
            mapView.map.remove(clusterLayer.layerObj);
            setClusterLayer(null);
        }
    };

    const fetchQueryResults = async () => {
        const searchQuery = props.windowManager.GetQueryParams(props.id) || { name: "" };
        setQuery(searchQuery);
        setLoading(true);
        setErrorMessage("");
        setResultList(null);
        LoggingBusiness.CreateClientLog("Genel Arama/Sorgu", searchQuery);

        try {
            const result = await GenelAramaQeryBusiness.Query(searchQuery, false);
            if (result?.type !== Constants_ServiceResultType.Success) {
                throw new Error("Arama sonuçları alınamadı. Lütfen tekrar deneyin.");
            }

            const list = (result.data || []).map(item => ({
                ObjectId: item?.attr?.objectid,
                Title: item?.attr?.adi || "İsimsiz kayıt",
                Phone: item?.attr?.telefon || "",
                Address: item?.attr?.adres || "Adres bilgisi bulunmuyor"
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

    const getItemDetailsById = async item => {
        const result = await GenelAramaQeryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type !== Constants_ServiceResultType.Success || !result.data?.length) throw new Error("Kayıt ayrıntıları bulunamadı.");
        return result.data[0];
    };

    const item_OnClick = async (event, item) => {
        event?.preventDefault?.();
        try {
            const details = await getItemDetailsById(item);
            GisGraphicsHelper.ZoomToGeometry(mapView, details?.geometry, 18);
            if (window.innerWidth < 960) props.windowManager.ToggleMinimiseWindow(props.id);
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
        }
    };

    const item_ShowRoute = async (event, item) => {
        event?.preventDefault?.();
        try {
            const details = await getItemDetailsById(item);
            const lat = details?.geometry?.latitude;
            const lng = details?.geometry?.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Yol tarifi için konum bilgisi bulunamadı.");
            window.open(`https://www.google.com.tr/maps?saddr=My+Location&daddr=${lat},${lng}`, "_blank", "noopener,noreferrer");
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
        }
    };

    const resultContent = loading ? (
        <div className="experience-search-state" aria-live="polite" aria-busy="true">
            <ButtonLoading message="Aranıyor…" />
            <div className="experience-search-state__hint">Sonuçlar getiriliyor, lütfen bekleyin.</div>
        </div>
    ) : errorMessage ? (
        <div className="kr-status-banner kr-status-banner--danger" role="alert">
            <div>
                <strong>Arama tamamlanamadı.</strong>
                <div>{errorMessage}</div>
                <button className="kr-btn kr-btn--secondary" type="button" onClick={fetchQueryResults}>Tekrar dene</button>
            </div>
        </div>
    ) : resultList?.length === 0 ? (
        <NoResultsFound message="Bu arama için kayıt bulunamadı. Daha genel bir ifade deneyin." />
    ) : (
        resultList?.map(item => (
            <article className="result-item-container" key={item.ObjectId || `${item.Title}-${item.Address}`}>
                <button type="button" className="result-item-info" onClick={event => item_OnClick(event, item)} aria-label={`${item.Title} kaydını haritada göster`}>
                    <span className="result-item-info-title">{item.Title}</span>
                    <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</span>
                    {item.Phone && <span className="result-item-info-phone"><FiPhone aria-hidden="true" />&nbsp;{item.Phone}</span>}
                </button>
                <CommonQueryResultItemTools item={item} zoomCallback={event => item_OnClick(event, item)} showRouteCallback={event => item_ShowRoute(event, item)} />
            </article>
        ))
    );

    return (
        <section className="sidebar-container" aria-label="Genel arama sonuçları" style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}>
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo} alt="" />
                <span>{windowTitle}</span>
                <CommonQueryWindowTools windowManager={props.windowManager} windowId={props.id} showNearbySearch={false} showMapSelect={false} setQueryField={() => {}} query={query} ref={commonToolsComponentRef} />
            </header>
            <div className="results-container" aria-live="polite">
                <div className="results-container-toolbar">
                    <button className="results-container-back-button" type="button" onClick={() => { removeLastClusterLayer(); props.windowManager.ShowWindow("sidebar"); }}>
                        <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön
                    </button>
                    <div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div>
                </div>
                {resultContent}
            </div>
        </section>
    );
});
