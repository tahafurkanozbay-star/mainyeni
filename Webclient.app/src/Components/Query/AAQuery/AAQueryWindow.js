import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { AssemblyAreaQueryBusiness } from "../../../Business/AssemblyAreaQueryBusiness";
import { BiArea, BiSearch } from "react-icons/bi";
import { FiMapPin, FiUsers } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { useRef } from "react";
import { TextHelper } from "../../../Toolbox/TextHelper";

export const AssemblyAreaQueryWindow = React.forwardRef((props, ref) => {
    const windowTitle = "Acil Toplanma Alanları";
    const windowLogo = "images/icons/sidebar/aciltoplanmaalani.png";
    const commonToolsComponentRef = useRef();
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState(null);
    const [nbhoodList, setNbhoodList] = useState(null);
    const defaultQuery = { name: "", districtId: "", nbhoodId: "", showMapSelect: false, showNearby: false };
    const [query, setQuery] = useState(defaultQuery);
    const [clusterLayer, setClusterLayer] = useState(null);
    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const [loading, setLoading] = useState(false);

    const setQueryField = (_field, _value) => {
        setQuery(currentQuery => ({ ...currentQuery, [_field]: _value }));
    };

    const removeLastClusterLayer = () => {
        if (clusterLayer != null && mapView?.map) {
            mapView.map.remove(clusterLayer.layerObj);
            setClusterLayer(null);
        }
    };

    useImperativeHandle(ref, () => ({
        id: props.id,
        visible: false,
        minimized: false,
        OnShow: () => DebugHelper.Log("show " + props.id),
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery(defaultQuery);
            setActiveTab("form");
            setResultList(null);
            removeLastClusterLayer();
            commonToolsComponentRef.current?.OnClose?.();
        }
    }));

    useEffect(() => {
        props.windowManager.RegisterWindow(ref);
        const currentMapView = MapManager.GetMapView();
        setMapView(currentMapView);

        NumberingQueryBusiness.GetDistricts().then(result => {
            if (result.type === Constants_ServiceResultType.Success) setDistrictList(result.data);
        });
    }, [props.windowManager, ref]);

    const cmbName_OnChange = event => setQueryField("name", event.target.value);

    const cmbDistrict_OnChange = event => {
        const districtId = event.target.value;
        setQueryField("districtId", districtId);
        setQueryField("districtName", event.target.selectedOptions[0].text);
        setNbhoodList(null);
        NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId).then(result => {
            if (result.type === Constants_ServiceResultType.Success) setNbhoodList(result.data);
        });
    };

    const cmbNbhood_OnChange = event => {
        setQueryField("nbhoodId", event.target.value);
        setQueryField("nbhoodName", event.target.selectedOptions[0].text);
    };

    const btnBack_OnClick = () => {
        removeLastClusterLayer();
        setActiveTab("form");
    };

    const btnSubmit_OnClick = event => {
        event?.preventDefault();
        setLoading(true);
        LoggingBusiness.CreateClientLog("Acil Toplanma Alanları/Sorgu", `${query.districtName}/${query.nbhoodName}/${query.name}`);

        AssemblyAreaQueryBusiness.Query(query, false).then(result => {
            if (result.type !== Constants_ServiceResultType.Success) return;
            setActiveTab("query");
            const symbol = { type: "picture-marker", url: windowLogo, width: "48px", height: "48px" };
            CommonBusiness.Clustering.CreateClusterLayer("AssemblyAreaQueryUrl", props.windowTitle, query, symbol).then(nextClusterLayer => {
                removeLastClusterLayer();
                setClusterLayer(nextClusterLayer);
                mapView?.map?.add(nextClusterLayer.layerObj);
            });

            setResultList(result.data.map(item => ({
                ObjectId: item.attr.objectid,
                Title: item.attr.adi ?? item.attr.ADI,
                Address: item.attr.adres ?? item.attr.ADRES,
                Capacity: item.attr.kapasite ?? item.attr.KAPASITE,
                Area: item.attr.alan ?? item.attr.ALAN,
                AddressDescription: "Adres tarifi bulunmuyor"
            })));
        }).catch(error => {
            props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
        }).finally(() => setLoading(false));
    };

    const getItemDetailsById = async item => {
        const result = await AssemblyAreaQueryBusiness.Query({ ObjectId: item.ObjectId }, true);
        if (result.type === Constants_ServiceResultType.Success && result.data != null) return result.data[0];
        return null;
    };

    const item_OnClick = (event, item) => {
        LoggingBusiness.CreateClientLog("Acil Toplanma Alanları/Detay Göster", `${item.Id}/${item.Address}`);
        getItemDetailsById(item).then(details => {
            if (details?.geometry) GisGraphicsHelper.ZoomToGeometry(mapView, details.geometry, 18);
            if (window.screen.width < 960) props.windowManager.ToggleMinimiseWindow(props.id);
        });
    };

    const item_ShowRoute = (event, item) => {
        getItemDetailsById(item).then(details => {
            if (!details?.geometry) {
                props.windowManager.ShowMessage(Constants_MessageType.Error, "Yol tarifi alınamadı - öğe detayları bulunamadı");
                return;
            }
            const lat = details.geometry.latitude;
            const lng = details.geometry.longitude;
            window.open(`https://www.google.com.tr/maps?saddr=My+Location&daddr=${lat},${lng}`, "_blank", "noopener,noreferrer");
        });
    };

    return (
        <div className="common-query-window" style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo} alt="" />
                <span>{windowTitle}</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField}
                    showNearbySearch={activeTab === "form"}
                    showMapSelect={activeTab === "form"}
                />
            </div>
            <div className={"common-query-window-body " + (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>
                {activeTab === "form" ? (
                    <Form onSubmit={btnSubmit_OnClick}>
                        {!query.mapSelect && <Form.Group><label className="form-label">Adı</label><input className="form-control" onChange={cmbName_OnChange} value={query.name} /></Form.Group>}
                        {!query.showNearby && !query.mapSelect && <>
                            <Form.Group><label className="form-label">İlçe</label><select className="form-select form-control" onChange={cmbDistrict_OnChange} value={query.districtId}><option value="">Seçiniz..</option>{districtList?.map(item => <option key={item.attr.id ?? TextHelper.CreateRandomNumber()} value={item.attr.id}>{item.attr.ad}</option>)}</select></Form.Group>
                            <Form.Group><label className="form-label">Mahalle</label><select className="form-select" onChange={cmbNbhood_OnChange} value={query.nbhoodId}><option value="">Seçiniz..</option>{nbhoodList?.map(item => <option key={item.attr.id ?? TextHelper.CreateRandomNumber()} value={item.attr.id}>{item.attr.ad}</option>)}</select></Form.Group>
                        </>}
                        {!query.mapSelect && <Form.Group>{loading ? <ButtonLoading /> : <Button type="submit" className="form-button"><BiSearch className="form-button-icon" /><span>Sorgula</span></Button>}</Form.Group>}
                    </Form>
                ) : (
                    <div className="results-container">
                        <div className="results-container-toolbar">
                            <button type="button" className="results-container-back-button" onClick={btnBack_OnClick}><HiOutlineArrowNarrowLeft className="results-container-back-button-icon" />&nbsp;Geri Dön</button>
                            <div className="results-container-count"><strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu</div>
                        </div>
                        {resultList?.map(item => <div className="result-item-container" key={item.ObjectId} onClick={event => item_OnClick(event, item)} role="button" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") item_OnClick(event, item); }}>
                            <div className="result-item-info"><div className="result-item-info-title">{item.Title}</div><div className="result-item-info"><FiMapPin />&nbsp; {item.Address}</div><div className="result-item-info"><FiUsers />&nbsp; {item.Capacity} Kişi &nbsp;&nbsp;<BiArea />&nbsp; {item.Area} m<sup>2</sup></div></div>
                            <CommonQueryResultItemTools item={item} zoomCallback={event => item_OnClick(event, item)} showRouteCallback={event => item_ShowRoute(event, item)} />
                        </div>)}
                    </div>
                )}
            </div>
        </div>
    );
});
