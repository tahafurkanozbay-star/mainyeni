import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_LayerType, Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { CommonQueryWindowTools } from "../_Common/CommonQueryWindowTools";
import { BsToggleOff, BsToggleOn } from "react-icons/bs";
import { PodQueryBusiness } from "../../../Business/PodQueryBusiness";
import { BiCaretRightCircle, BiSearch } from "react-icons/bi";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import {ButtonLoading} from "../../../Components/Common/Loading";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { GoogleMapsBusiness } from "../../../Business/GoogleMapsBusiness";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { loadModules } from "esri-loader";
import { useRef } from "react";
import DynamicLayerManager from "../../../Store/Managers/DynamicLayerManager";
import { TextHelper } from "../../../Toolbox/TextHelper";

export const PodQueryWindow = React.forwardRef((props, ref) => {

    useImperativeHandle(ref, () => ({
        
        id: props.id,visible:false, minimized:false,
        OnShow:()=>{
            
        },
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);
            setQuery(defaultQuery);
            setActiveTab("form");
            setResultList(null);
            removeLastClusterLayer();
            commonToolsComponentRef.current.OnClose();
        }
    }));

    const commonToolsComponentRef=useRef();
    const [mapView, setMapView] = useState(null);
    const [districtList, setDistrictList] = useState(null);

    useEffect(() => {


        props.windowManager.RegisterWindow(ref);
        
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);

        NumberingQueryBusiness.GetDistricts().then(_result => {

            if (_result.type == Constants_ServiceResultType.Success) {
                setDistrictList(_result.data);
            }
        });

    }, []);



    const cmbName_OnChange = (e) => {
        const name = e.target.value;
        setQueryField("name", name);
    }

    const [nbhoodList, setNbhoodList] = useState(null);
    const cmbDistrict_OnChange = (e) => {

        const districtId = e.target.value;
        setQueryField("districtId", districtId);
        setQueryField("districtName", e.target.selectedOptions[0].text);


        setNbhoodList(null);

        NumberingQueryBusiness.GetNeighborhoodsOfDistrict(districtId).then((_result) => {

            if (_result.type == Constants_ServiceResultType.Success) {
                setNbhoodList(_result.data);
            }

        });
    }

    const cmbNbhood_OnChange = (e) => {
        const nbhoodId = e.target.value;
        setQueryField("nbhoodId", nbhoodId);
        setQueryField("nbhoodName", e.target.selectedOptions[0].text);

    }

    const defaultQuery = { name: null, districtId: null, nbhoodId: null, showPodOnDuty: false, showMapSelect: false, showNearby: false };
    const [query, setQuery] = useState(defaultQuery);
    const setQueryField = (_field, _value) => {
        setQuery( query => {
            return { ...query,[_field]: _value}
         })
    }

    const [clusterLayer, setClusterLayer] = useState(null);
    const removeLastClusterLayer = () => {
        if (clusterLayer != null) {
            mapView.map.remove(clusterLayer);
            setClusterLayer(null);
        }
    }


    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const btnBack_OnClick = (e) => {
        removeLastClusterLayer();
        setActiveTab("form");
    }

    const [loading, setLoading] = useState(false);
    const btnSubmit_OnClick = (e) => {

        e?.preventDefault();
        const _symbol={
            type: "picture-marker",
            url: "images/icons/sidebar/eczane.png",
            width: "48px",
            height: "48px"
        };
        setLoading(true);
        if (query.showPodOnDuty) {

            LoggingBusiness.CreateClientLog("Eczaneler/Sorgu (Nöbetçi)", query.name);

            PodQueryBusiness.QueryPodOnDuty(query).then((_result) => {

                setActiveTab("query");

                if (_result.type == Constants_ServiceResultType.Success) {

                    let list = [];

                    _result.data.forEach(_item => {
                        list.push({
                            ObjectId: _item.attr.objectid,
                            Title: _item.attr.adi,
                            Phone: _item.attr.telefon,
                            Address: _item.attr.adres,
                            AddressDescription: "Adres tarifi bulunmuyor"
                        });
                    });
                    setResultList(list);


                    let promises=[];
                    _result.data?.forEach(_pod => {
                        promises.push(GisGraphicsHelper.CreatePoint({ latitude: _pod.lat, longitude: _pod.lng }));        
                    });
          
                    Promise.all(promises).then((_geometries)=>{

                        var geoJson={
                            type: "FeatureCollection",
                            features: [],
                            layerType: Constants_LayerType.GeoJSONLayer
                        };
                        _geometries.forEach((_geometry,_index) => {
                            geoJson.features.push({
                                type:"feature",
                                geometry:{
                                    type:"Point",
                                    coordinates:[_geometry.x,_geometry.y]
                                },
                                id: TextHelper.CreateGuid(),
                                properties:_result.data[_index]
                            });
                        });

                        /*
                        CommonBusiness.CreateLayer(geoJson).then(_layer=>{

                            mapView.map.add(_layer);
                        });
                        */

                        CommonBusiness.Clustering.CreateGeoJsonClusterLayer(geoJson, "Nöbetçi Eczaneler", _symbol).then(_clusterLayer=>{

                            removeLastClusterLayer();

                            setClusterLayer(_clusterLayer);
                            mapView.map.add(_clusterLayer);
                        });
                      
                        setLoading(false);
                        
                    });

                }
            }).catch(error => {
                props.windowManager.ShowMessage(Constants_MessageType.Error,error.message); 
                setLoading(false);
            });
        }
        else {

            
            LoggingBusiness.CreateClientLog("Eczaneler/Sorgu (Tüm)", query.districtName+"/"+query.nbhoodName+"/"+query.name);

            PodQueryBusiness.Query(query, false).then((_result) => {

                if (_result.type == Constants_ServiceResultType.Success) {

                    setActiveTab("query");
                    
                    CommonBusiness.Clustering.CreateClusterLayer("PharmacyQueryUrl", "eczaneler", query, _symbol).then((_clusterLayer) => {

                        removeLastClusterLayer();

                        setClusterLayer(_clusterLayer.layerObj);
                        mapView.map.add(_clusterLayer.layerObj);

                    });

                    let list = [];

                    _result.data.forEach(_item => {
                        list.push({
                            ObjectId: _item.attr.objectid,
                            Title: _item.attr.adi,
                            Phone: _item.attr.telefon,
                            Address: _item.attr.adres,
                            AddressDescription: "Adres tarifi bulunmuyor"
                        });
                    });
                    setResultList(list);
                    setLoading(false);
                }
            }).catch(error => {
                props.windowManager.ShowMessage(Constants_MessageType.Error,error.message); 
                setLoading(false);
            });
        }
    }


    const getItemDetailsById=async(_item)=>{

        return new Promise((resolve, reject)=>{

            PodQueryBusiness.Query({ObjectId: _item.ObjectId},true).then((_result) => {
                if(_result.type==Constants_ServiceResultType.Success){
                    if(_result.data!=null){
                        const _resultItem=_result.data[0];
                        resolve(_resultItem);
                    }
                    else{
                        reject(null);
                    }
                }
            });
        });

    }


    const item_OnClick=(e,_item)=>{

        LoggingBusiness.CreateClientLog("Eczaneler/Detay Göster", _item.id +"/"+_item.title);

        if (query.showPodOnDuty) {

            GisGraphicsHelper.CreatePoint({ latitude: _item.Lat, longitude: _item.Lng }).then(_point=>{
                
                const _symbol={
                    type: "picture-marker",
                    url: "images/icons/sidebar/eczane.png",
                    width: "48px",
                    height: "48px"
                };
        
                GisGraphicsHelper.CreateGraphicFromGeometry(_point, _symbol).then((_graphic)=>{
                   
                    MapManager.AddGraphics(_graphic, true);
                    GisGraphicsHelper.ZoomToGeometry(mapView, _point, 16);


                    if(window.screen.width<960){
                        props.windowManager.ToggleMinimiseWindow(props.id);
                    } 
                });
            });
        }
        else{
        
            //get details by id
            getItemDetailsById(_item).then(_itemDetails =>  {
                GisGraphicsHelper.ZoomToGeometry(mapView, _itemDetails?.geometry, 18);    
            });   
        }

    }


    const item_ShowRoute=(e, _item)=>{
        
        LoggingBusiness.CreateClientLog("Eczaneler/Yol Tarifi", _item.Id +"/"+_item.Title);
        
        if (query.showPodOnDuty) {
            //convert from lat lng
            GisGraphicsHelper.CreatePoint({ latitude: _item.Lat, longitude: _item.Lng }).then(_point=>{
                
                let url = GoogleMapsBusiness.CreateRoutesUrlFromPoint(_point);
                window.open(url, "_blank");
               
            });
        }
        else{
            //get details by id
            getItemDetailsById(_item).then(_itemDetails =>  {
                
            if(_itemDetails!=null){
                let url = GoogleMapsBusiness.CreateRoutesUrlFromPoint(_itemDetails.geometry);
                window.open(url, "_blank");
                //TODO: create log
            }
            else{
                props.windowManager.ShowMessage(Constants_MessageType.Error,"Yol tarifi alınamadı - öğe detayları bulunamadı");
            }
            
            });   
        }

    }


    return (<>
        <div className="common-query-window"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>
            <div className="common-query-window-header">
                <img className="common-query-window-header-icon" src="images/icons/sidebar/eczane.png"></img>
                <span>Eczane</span>
                <CommonQueryWindowTools
                    ref={commonToolsComponentRef}
                    windowManager={props.windowManager}
                    windowId={props.id}
                    setQueryField={setQueryField} 
                    query={query}
                    showNearbySearch={activeTab=="form"}
                    showMapSelect={activeTab=="form"} />

            </div>
            <div className={"common-query-window-body "+ (props.windowManager.IsMinimized(props.id) ? "common-query-window-body-collapsed" : "")}>
                {
                    activeTab === "form" ?
                        <>
                            <Form onSubmit={(e) => btnSubmit_OnClick(e)}>
                                <Form.Group>
                                    {<div onClick={(e) => setQueryField("showPodOnDuty", !query.showPodOnDuty)}
                                        className="form-checkbox">
                                        <span>Nöbetçi Eczane Ara</span>{
                                            query && query.showPodOnDuty ? <BsToggleOn /> : <BsToggleOff />
                                        }
                                    </div>
                                    }
                                </Form.Group>
                                {
                                    !query.mapSelect && <Form.Group>
                                        <label className="form-label">Adı</label>
                                        <input className="form-control" onChange={((e) => cmbName_OnChange(e))} value={query.name} />
                                    </Form.Group>
                                }

                                {
                                    (!query.showPodOnDuty && !query.showNearby && !query.mapSelect) && <>
                                        <Form.Group>
                                            <label className="form-label">İlçe</label>
                                            <select className="form-select form-control" onChange={((e) => cmbDistrict_OnChange(e))}
                                                value={query.districtId}>
                                                <option value="">Seçiniz..</option>
                                                {
                                                    districtList?.map(_item => {
                                                        return <option value={_item.attr.id}>{_item.attr.ad}</option>
                                                    })
                                                }
                                            </select>
                                        </Form.Group>
                                        <Form.Group>
                                            <label className="form-label">Mahalle</label>
                                            <select className="form-select" onChange={((e) => cmbNbhood_OnChange(e))}
                                                value={query.nbhoodId}>
                                                <option value="">Seçiniz..</option>
                                                {
                                                    nbhoodList?.map(_item => {
                                                        return <option value={_item.attr.id}>{_item.attr.ad}</option>
                                                    })
                                                }
                                            </select>
                                        </Form.Group></>
                                }
                                {
                                    !query.mapSelect &&
                                    <>
                                    {
                                        loading ? <ButtonLoading />
                                            : <Button type="button" className="form-button" onClick={(e) => btnSubmit_OnClick()}>
                                                <BiSearch className="form-button-icon" /><span>Sorgula</span>
                                            </Button>
                                    }
                                    </>
                                    
                                }

                            </Form>
                        </> : <div className="results-container">
                            {
                                <>
                                    <div className="results-container-toolbar">
                                        <div className="results-container-back-button" onClick={(e) => btnBack_OnClick(e)}>
                                            <HiOutlineArrowNarrowLeft className="results-container-back-button-icon" />
                                            &nbsp;Geri Dön
                                        </div>
                                        <div className="results-container-count">
                                            <strong>{resultList?.length ?? 0}</strong> adet sonuç bulundu
                                        </div>
                                    </div>
                                    {
                                        resultList?.map(_item => {
                                            return <div className="result-item-container" onClick={(e)=>item_OnClick(e,_item)}>
                                                <div className="result-item-info">
                                                    <div className="result-item-info-title">
                                                        {_item.Title}
                                                    </div>
                                                    <div className="result-item-info-address">
                                                        <FiMapPin />&nbsp;
                                                        {_item.Address}
                                                    </div>
                                                    <div className="result-item-info-address-description">
                                                        <FiMapPin />&nbsp;
                                                        {_item.AddressDescription}
                                                    </div>
                                                  
                                                </div>
                                                <CommonQueryResultItemTools 
                                                item={_item} 
                                                zoomCallback={(e)=>item_OnClick(e,_item)}
                                                showRouteCallback={(e)=>item_ShowRoute(e,_item)}/>
                                            </div>
                                        })
                                    }
                                </>
                            }
                        </div>
                }
            </div>
        </div>
    </>);
});