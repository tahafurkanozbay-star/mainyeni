import React, { useEffect, useImperativeHandle, useState } from "react";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading, NoResultsFound } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { GenelAramaQeryBusiness } from "../../../Business/GenelAramaQeryBusiness";

const EMPTY_QUERY = { name: "" };

export const GenelAramaQeryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "ARAMA SONUÇLARI";
    const windowLogo = "images/search.svg";
    const [query, setQuery] = useState(EMPTY_QUERY);
    const [loading, setLoading] = useState(false);
    const [resultList, setResultList] = useState(null);
    const [errorMessage, setErrorMessage] = useState("");

    const writeClientLog = (type, payload) => {
        LoggingBusiness.CreateClientLog(type, payload).catch(error => {
            DebugHelper.Log(`Client log failed: ${error?.message || "unknown error"}`);
        });
    };

    const fetchQueryResults = async () => {
        setLoading(true);
        setErrorMessage("");
        setResultList(null);

        const searchQuery = props.windowManager.GetQueryParams(props.id) || query || EMPTY_QUERY;
        setQuery(searchQuery);
        writeClientLog("Genel Arama/Sorgu", searchQuery);

        try {
            const result = await GenelAramaQeryBusiness.Query(searchQuery, false);
            if (result?.type !== Constants_ServiceResultType.Success) {
                const message = "Arama sonuçları alınamadı. Lütfen tekrar deneyin.";
                setErrorMessage(message);
                props.windowManager.ShowMessage(Constants_MessageType.Error, message);
                return;
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

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => {
            DebugHelper.Log(`show ${props.id}`);
            fetchQueryResults();
        },
        OnClose: () => {
            DebugHelper.Log(`closing ${props.id}`);
            setQuery(EMPTY_QUERY);
            setResultList(null);
            setErrorMessage("");
        }
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
    }, [props.windowManager, ref]);

    const btnBack_OnClick = () => {
        props.windowManager.ShowWindow("sidebar");
    };

    const getItemDetailsById = async item => {
        const result = await GenelAramaQeryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type === Constants_ServiceResultType.Success && result.data?.length) {
            return result.data[0];
        }
        throw new Error("Kayıt ayrıntıları bulunamadı.");
    };

    const item_OnClick = async (event, item) => {
        event?.preventDefault?.();
        writeClientLog("Genel Arama/Detay Göster", `${item.ObjectId || ""}/${item.Address || ""}`);

        try {
            const itemDetails = await getItemDetailsById(item);
            const mapView = MapManager.GetMapView();
            if (!mapView || !itemDetails?.geometry) {
                throw new Error("Kayıt konumu bulunamadı.");
            }
            GisGraphicsHelper.ZoomToGeometry(mapView, itemDetails.geometry, 18);
            if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
        }
    };

    const item_ShowRoute = async (event, item) => {
        event?.preventDefault?.();

        try {
            const itemDetails = await getItemDetailsById(item);
            const latitude = itemDetails?.geometry?.latitude;
            const longitude = itemDetails?.geometry?.longitude;
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
                throw new Error("Yol tarifi alınamadı - konum bilgisi bulunamadı");
            }
            window.open(
                `https://www.google.com.tr/maps?saddr=My+Location&daddr=${latitude},${longitude}`,
                "_blank",
                "noopener,noreferrer"
            );
        } catch (error) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
        }
    };

    const resultContent = loading ? (
        <div className="experience-search-state" role="status" aria-live="polite" aria-busy="true">
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
    ) : resultList?.map(item => (
        <article className="result-item-container" key={item.ObjectId || `${item.Title}-${item.Address}`}>
            <button
                type="button"
                className="result-item-info"
                onClick={event => item_OnClick(event, item)}
                aria-label={`${item.Title} kaydını haritada göster`}
            >
                <span className="result-item-info-title">{item.Title}</span>
                <span className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</span>
                {item.Phone && <span className="result-item-info-phone"><FiPhone aria-hidden="true" />&nbsp;{item.Phone}</span>}
            </button>
            <CommonQueryResultItemTools
                item={item}
                zoomCallback={event => item_OnClick(event, item)}
                showRouteCallback={event => item_ShowRoute(event, item)}
            />
        </article>
    ));

    return (
        <section
            className="sidebar-container"
            aria-label="Genel arama sonuçları"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? "visible" : "hidden" }}
        >
            <header className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo} alt="" aria-hidden="true" />
                <span>{windowTitle}</span>
            </header>
            <div className="results-container" aria-live="polite">
                <div className="results-container-toolbar">
                    <button className="results-container-back-button" type="button" onClick={btnBack_OnClick}>
                        <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön
                    </button>
                    <div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div>
                </div>
                {resultContent}
            </div>
        </section>
    );
});

GenelAramaQeryWindow.displayName = "GenelAramaQeryWindow";
