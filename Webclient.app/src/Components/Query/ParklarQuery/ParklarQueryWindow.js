import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { ParklarQeryBusiness } from "../../../Business/ParklarQeryBusiness";
import { FiMapPin } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { loadArcgisModules as loadModules } from "../../../gis-engine/arcgisModuleRuntime";
import { createDisposableBag, createLayerOwner } from "../../../gis-engine/layerOwnership";

const OWNER_ID = 'parklar-query-window';
const defaultQuery = { name: null, districtId: null, districtName: null, nbhoodId: null, nbhoodName: null, showMapSelect: false, showNearby: false };

export const ParklarQueryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "Parklar";
    const windowLogo = "images/Sidebar/ABB/park.png";
    const windowLogoIcon = "images/icons/map/ABB/parklar.svg";
    const [query, setQuery] = useState(defaultQuery);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);
    const mapViewRef = useRef(null);
    const extentHistoryRef = useRef([]);
    const addExtentRef = useRef(true);
    const clusterLayerRef = useRef(null);
    const ownerRef = useRef(null);
    const lifecycleRef = useRef(createDisposableBag());
    const queryVersionRef = useRef(0);
    const mountedRef = useRef(true);

    const getOwner = (view = mapViewRef.current || MapManager.GetMapView()) => {
        if (!view?.map) return null;
        if (!ownerRef.current) ownerRef.current = createLayerOwner(view, OWNER_ID);
        return ownerRef.current;
    };
    const removeLastClusterLayer = () => { getOwner()?.clear(); clusterLayerRef.current = null; };
    const getSymbolBasedOnZoom = (zoomLevel) => {
        const zoom = Number(zoomLevel);
        const size = Number.isFinite(zoom) && zoom > 10 ? { width: 30, height: 35 } : { width: 80, height: 80 };
        return { type: "picture-marker", url: windowLogoIcon, width: `${size.width}px`, height: `${size.height}px` };
    };
    const rememberExtent = () => {
        if (!addExtentRef.current) return;
        const view = mapViewRef.current;
        if (!view?.extent) return;
        const history = [...extentHistoryRef.current, view.extent];
        extentHistoryRef.current = history.length > 30 ? history.slice(history.length - 30) : history;
    };
    const installViewWatchers = async (view) => {
        if (!view) return;
        try {
            const [watchUtils] = await loadModules(["esri/core/watchUtils"]);
            if (!mountedRef.current || mapViewRef.current !== view) return;
            if (view.extent) extentHistoryRef.current = [view.extent];
            const readyHandle = watchUtils.when(view, "ready", () => {
                const extentHandle = watchUtils.whenOnce(view, "extent", () => {
                    const stationaryHandle = watchUtils.whenTrue(view, 'stationary', (stationary) => { if (stationary) rememberExtent(); });
                    lifecycleRef.current.add(stationaryHandle);
                });
                lifecycleRef.current.add(extentHandle);
            });
            lifecycleRef.current.add(readyHandle);
            if (typeof view.watch === 'function') {
                const zoomHandle = view.watch("zoom", (newZoomLevel) => {
                    const cluster = clusterLayerRef.current;
                    const renderer = cluster?.layerObj?.renderer;
                    if (!renderer) return;
                    renderer.symbol = getSymbolBasedOnZoom(newZoomLevel);
                    cluster.layerObj.refresh?.();
                });
                lifecycleRef.current.add(zoomHandle);
            }
        } catch (_) {}
    };

    useEffect(() => {
        mountedRef.current = true;
        props.windowManager.RegisterWindow(ref);
        const view = MapManager.GetMapView();
        mapViewRef.current = view;
        installViewWatchers(view);
        const lifecycle = lifecycleRef.current;
        return () => {
            mountedRef.current = false;
            queryVersionRef.current += 1;
            lifecycle.dispose();
            ownerRef.current?.clear();
            ownerRef.current = null;
            clusterLayerRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
        id: props.id, visible: false, minimized: false,
        OnShow: () => { DebugHelper.Log("show " + props.id); fetchQueryResults(); },
        OnClose: () => { DebugHelper.Log("closing " + props.id); queryVersionRef.current += 1; setQuery(defaultQuery); setActiveTab("form"); setResultList(null); removeLastClusterLayer(); },
    }));

    const fetchQueryResults = async () => {
        const view = mapViewRef.current || MapManager.GetMapView();
        if (!view?.map) return;
        mapViewRef.current = view;
        const requestVersion = ++queryVersionRef.current;
        setLoading(true);
        LoggingBusiness.CreateClientLog("Parklar/Sorgu", `${query.districtName || ''}/${query.nbhoodName || ''}/${query.name || ''}`);
        try {
            const result = await ParklarQeryBusiness.Query(query, false);
            if (!mountedRef.current || requestVersion !== queryVersionRef.current) return;
            if (result?.type !== Constants_ServiceResultType.Success) { setResultList([]); return; }
            setActiveTab("query");
            addExtentRef.current = false;
            const initialExtent = extentHistoryRef.current[0];
            if (initialExtent) { try { await view.goTo(initialExtent); } catch (_) {} }
            if (!mountedRef.current || requestVersion !== queryVersionRef.current) return;
            const clusterLayer = await CommonBusiness.Clustering.CreateLayerWithoutClustering("YeniParklarQeryUrl", props.windowTitle || windowTitle, query, getSymbolBasedOnZoom(view.zoom));
            if (!mountedRef.current || requestVersion !== queryVersionRef.current) { clusterLayer?.layerObj?.destroy?.(); return; }
            removeLastClusterLayer();
            clusterLayerRef.current = clusterLayer;
            getOwner(view)?.add(clusterLayer?.layerObj);
            try {
                const extentResponse = await clusterLayer?.layerObj?.queryExtent?.();
                const extent = extentResponse?.extent;
                if (extent && mountedRef.current && requestVersion === queryVersionRef.current) {
                    const expandFactorX = (extent.xmax - extent.xmin) * 0.05;
                    const expandFactorY = (extent.ymax - extent.ymin) * 0.1;
                    await view.goTo({ xmin: extent.xmin - expandFactorX, ymin: extent.ymin - expandFactorY, xmax: extent.xmax + expandFactorX, ymax: extent.ymax + expandFactorY, spatialReference: extent.spatialReference });
                }
            } catch (_) {}
            setResultList((Array.isArray(result.data) ? result.data : []).map((item) => ({ ObjectId: item?.attr?.objectid, Title: item?.attr?.adi, Phone: item?.attr?.telefon, Address: item?.attr?.adres, AddressDescription: "Adres tarifi bulunmuyor" })));
        } catch (error) {
            if (mountedRef.current && requestVersion === queryVersionRef.current) {
                props.windowManager.ShowMessage(Constants_MessageType.Error, error?.message || "Park sorgusu başarısız oldu");
                setResultList([]);
            }
        } finally { if (mountedRef.current && requestVersion === queryVersionRef.current) setLoading(false); }
    };

    const getItemDetailsById = async (item) => {
        const result = await ParklarQeryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result?.type !== Constants_ServiceResultType.Success || !Array.isArray(result.data) || !result.data.length) throw new Error("Öğe detayları bulunamadı");
        return result.data[0];
    };
    const item_OnClick = async (event, item) => {
        event?.stopPropagation?.();
        LoggingBusiness.CreateClientLog("Parklar/Detay Göster", `${item.ObjectId || ''}/${item.Address || ''}`);
        try {
            const itemDetails = await getItemDetailsById(item);
            const view = mapViewRef.current;
            if (view && itemDetails?.geometry) GisGraphicsHelper.ZoomToGeometry(view, itemDetails.geometry, 18);
            if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
        } catch (error) { props.windowManager.ShowMessage(Constants_MessageType.Error, error.message); }
    };
    const item_ShowRoute = async (event, item) => {
        event?.stopPropagation?.();
        try {
            const itemDetails = await getItemDetailsById(item);
            const lat = itemDetails?.geometry?.latitude;
            const lng = itemDetails?.geometry?.longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Koordinat bilgisi bulunamadı");
            window.open(`https://www.google.com.tr/maps?saddr=My+Location&daddr=${encodeURIComponent(`${lat},${lng}`)}`, "_blank", "noopener,noreferrer");
        } catch (_) { props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı"); }
    };
    const btnBack_OnClick = async () => {
        removeLastClusterLayer();
        addExtentRef.current = false;
        const targetExtent = extentHistoryRef.current[0];
        const view = mapViewRef.current;
        if (view && targetExtent) { try { await view.goTo(targetExtent); } catch (_) {} }
        props.windowManager.ShowWindow("sidebar");
        setActiveTab("form");
    };

    return <div className="sidebar-container" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }} data-active-tab={activeTab} data-loading={loading ? 'true' : 'false'}>
        <div className="common-query-window-header"><img className="common-query-window-header-icon" src={windowLogo} alt="" /><span>{windowTitle}</span></div>
        <div className="results-container" aria-busy={loading}>
            <div className="results-container-toolbar"><button type="button" className="results-container-back-button" onClick={btnBack_OnClick}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" aria-hidden="true" />&nbsp;Geri Dön</button><div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div></div>
            {resultList?.map((item, index) => <div className="result-item-container" onClick={(event) => item_OnClick(event, item)} key={item.ObjectId ?? `${item.Title || 'park'}-${index}`} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') item_OnClick(event, item); }}>
                <div className="result-item-info"><div className="result-item-info-title">{item.Title}</div><div className="result-item-info-address"><FiMapPin aria-hidden="true" />&nbsp;{item.Address}</div></div>
                <CommonQueryResultItemTools item={item} zoomCallback={(event) => item_OnClick(event, item)} showRouteCallback={(event) => item_ShowRoute(event, item)} />
            </div>)}
        </div>
    </div>;
});
