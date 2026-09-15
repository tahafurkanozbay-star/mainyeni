import React, { useEffect, useImperativeHandle, useState } from "react";
import { Button, Form } from "react-bootstrap";
import { NumberingQueryBusiness } from "../../../Business/NumberingQueryBusiness";
import { Constants_MessageType, Constants_ServiceResultType } from "../../../Core/Constants";
import MapManager from "../../../Store/Managers/MapManager";
import { FiMapPin, FiPhone } from "react-icons/fi";
import { HiOutlineArrowNarrowLeft } from "react-icons/hi";
import { CommonQueryResultItemTools } from "../_Common/CommonQueryResultItemTools";
import { CommonBusiness } from "../../../Business/CommonBusiness";
import { DebugHelper } from "../../../Toolbox/DebugHelper";
import { GisGraphicsHelper } from "../../../Toolbox/GisGraphicsHelper";
import { ButtonLoading } from "../../Common/Loading";
import { LoggingBusiness } from "../../../Business/LoggingBusiness";
import { LayerBusiness } from "../../../Business/LayerBusiness";
import { useRef } from "react";
import { GenelAramaQeryBusiness } from "../../../Business/GenelAramaQeryBusiness";

export const GenelAramaQeryWindow = React.forwardRef((props, ref) => {

    const windowTitle = "ARAMA SONUÇLARI";
    const windowLogo = "images/search.svg";   
     const [query, setQuery] = useState({ name: "" });
    const defaultQuery = props.windowManager.GetQueryParams(props.id);
    
    useImperativeHandle(ref, () => ({

        id: props.id, visible: false, minimized: false,
        OnShow: () => {
            DebugHelper.Log("show " + props.id);
            //setQuery(props.query); // Eğer props.query boşsa, default değeri kullan

            // Sorgu sonucunu getiriyoruz
            fetchQueryResults(query.name)
        
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
    const [loading, setLoading]=useState(false);


    useEffect(() => {

        props.windowManager.RegisterWindow(ref);        
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);      
        fetchQueryResults(mapView)
        

    }, [mapView]);


 
  
   
    const setQueryField = (_field, _value) => {
        setQuery( query => {
            return { ...query,[_field]: _value}
         })
    }

    const [clusterLayer, setClusterLayer] = useState(null);
    const removeLastClusterLayer = () => {
        if (clusterLayer != null) {
            mapView.map.remove(clusterLayer.layerObj);
            setClusterLayer(null);
        }
    }


    const [resultList, setResultList] = useState(null);
    const [activeTab, setActiveTab] = useState("form");
    const btnBack_OnClick = (e) => {
        removeLastClusterLayer();
        props.windowManager.ShowWindow("sidebar"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
       
    }
    
    const fetchQueryResults = async  () => {
        setLoading(true);
        const query = props.windowManager.GetQueryParams(props.id)      
    
        // searchQuery'yi query nesnesine ekliyoruz
     
    
        // Arama log kaydını oluşturuyoruz
        LoggingBusiness.CreateClientLog("Genel Arama/Sorgu", query);
    
        // Arama sorgusunu gerçekleştiriyoruz
        GenelAramaQeryBusiness.Query(query, false).then((_result) => {
            if (_result.type == Constants_ServiceResultType.Success) {
                let list = [];
    
                // Gelen sonuçları işleyip listeye ekliyoruz
                _result.data.forEach((_item) => {
                    list.push({
                        ObjectId: _item.attr.objectid,
                        Title: _item.attr.adi,
                        Phone: _item.attr.telefon,
                        Address: _item.attr.adres
                    });
                });
    
                // Sonuçları state'e kaydediyoruz
                setResultList(list);
                setLoading(false);
            }
        }).catch((error) => {
            // Hata durumunda mesaj gösteriyoruz
            props.windowManager.ShowMessage(Constants_MessageType.Error, error.message);
            setLoading(false);
        });
    }
    


    const getItemDetailsById=async(_item)=>{

        return new Promise((resolve, reject)=>{
            GenelAramaQeryBusiness.Query({ObjectId: _item.ObjectId},true).then((_result) => {
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

    const item_OnClick = (e, _item) => {

        LoggingBusiness.CreateClientLog("Parklar/Detay Göster", _item.Id+"/"+_item.Address);

        getItemDetailsById(_item).then(_itemDetails =>  {

            GisGraphicsHelper.ZoomToGeometry(mapView, _itemDetails?.geometry, 18);
            
            if(window.screen.width<960){
                props.windowManager.ToggleMinimiseWindow(props.id);
            } 
        });   
    }

    const item_ShowRoute=(e, _item)=>{
        
        getItemDetailsById(_item).then(_itemDetails =>  {

            if(_itemDetails!=null){
                const lat=_itemDetails.geometry.latitude;
            const lng=_itemDetails.geometry.longitude;
            let url = "https://www.google.com.tr/maps?saddr=My+Location&daddr=" + lat + "," + lng;
            window.open(url, "_blank");
            //TODO: create log
            }
            else{
                props.windowManager.ShowMessage(Constants_MessageType.Error,"Yol tarifi alınamadı - öğe detayları bulunamadı");
            }
            
        
        });   
    }

    return (<>
        <div className="sidebar-container"
            style={{ visibility: props.windowManager.IsVisible(props.id) ? 'visible' : 'hidden' }}>     

<div className="common-query-window-header">
                <img className="common-query-window-header-icon" src={windowLogo}></img>
                <span>{windowTitle}</span>      

            </div>
           
                  <div className="results-container">
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
                                            return <div className="result-item-container" onClick={(e) => item_OnClick(e, _item)}>
                                                <div className="result-item-info">
                                                    <div className="result-item-info-title">
                                                        {_item.Title}
                                                    </div>
                                                    <div className="result-item-info-address">
                                                        <FiMapPin />&nbsp;
                                                        {_item.Address}
                                                    </div>
                                           
                                                    <div className="result-item-info-phone">
                                                        <FiPhone />&nbsp;
                                                        {_item.Phone}
                                                    </div>
                                                </div>
                                                <CommonQueryResultItemTools 
                                                    item={_item}
                                                    zoomCallback={(e)=>item_OnClick(e,_item)}
                                                    showRouteCallback={(e)=>item_ShowRoute(e,_item)}
                                                     />
                                            </div>
                                        })
                                    }
                                </>
                       
                }
            </div>
        </div>
    </>);
});