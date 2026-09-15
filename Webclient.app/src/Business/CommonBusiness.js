import axios from "axios";
import { loadModules } from "esri-loader";
import { ArrayHelper } from "../Toolbox/ArrayHelper";
import { Constants_LayerType, Constants_ServiceResultType } from "../Core/Constants";
import { AppConfig } from "../Core/AppConfig";
import { MapManager } from "../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../Toolbox/GisGraphicsHelper";
import { TextHelper } from "../Toolbox/TextHelper";
import { IsNull } from "../Toolbox/ObjectHelper";
import { GisQueryHelper } from "../Toolbox/GisQueryHelper";
import Store from "../Store/Store";
import { CommonReducer_ActionTypes } from "../Store/Reducers/CommonReducer";


export const CommonBusiness = {

    _Cache: {

    },

    ShowUserLocationOnMap: (_mapView, _point) => {

        if (CommonBusiness._Cache.locationGraphic) {
            GisGraphicsHelper.RemoveGraphics(_mapView, CommonBusiness._Cache.locationGraphic);
        }

        GisGraphicsHelper.CreateCustomGraphicFromGeometry(_point, {

            type: "picture-marker",
            url: "images/location_ripple.gif",
            width: "64px",
            height: "64px"

        }).then((_locationGraphic) => {

            GisGraphicsHelper.AddGraphics(_mapView, _locationGraphic);
            CommonBusiness._Cache.locationGraphic = _locationGraphic;

            GisGraphicsHelper.ZoomToGeometry(_mapView, _point, 15);

        });

    },


    /*Proxy kullanım durumuna göre url oluşturur */
    GenerateUrl: (_queryService) => {
        return _queryService?.eg ?? _queryService?.Eg;
    },

   
    AddProxyRule: (_url, _source) => {

        return loadModules(["esri/config", "esri/core/urlUtils"])
            .then(([esriConfig, urlUtils]) => {

                let proxyUrl = AppConfig.Api.BaseUrl + "/Gis/Proxy";

                esriConfig.request.proxyUrl = proxyUrl;
                esriConfig.request.forceProxy = true;

                urlUtils.addProxyRule({
                    urlPrefix: _url,
                    proxyUrl: proxyUrl
                });

            });
    },

    //yapı düzeninde çalışıyor
    GetDomainValues: async (_queryServiceTitle, _field) => {

        return new Promise((resolve) => {

            loadModules(["esri/layers/FeatureLayer"]).then(([FeatureLayer]) => {

                let configServices = MapManager.GetConfiguration().ConfigurationServices;
                let queryService = ArrayHelper.Find(configServices, "Title", _queryServiceTitle);

                if (queryService == null) {
                    resolve(null);
                }

                let url = CommonBusiness.GenerateUrl(queryService);
                let layer = new FeatureLayer(url);

                layer.load().then(function (p) {


                    let fields = ArrayHelper.Filter(layer.fields, "name", _field);
                    if (fields == null || fields?.length == 0) {
                        resolve(null);
                        return;
                    }

                    let field = fields[0];
                    if (field?.domain == null) {
                        resolve(null);
                        return;
                    }

                    resolve(field?.domain?.codedValues);
                });
            });
        });
    },


    //altkullanım da çalışıyor
    GetCodedValueDomains: async (_queryServiceTitle, _field) => {

        return new Promise((resolve) => {

            loadModules(["esri/layers/FeatureLayer"]).then(([FeatureLayer]) => {

                let configServices = MapManager.GetConfiguration().ConfigurationServices;
                let queryService = ArrayHelper.Find(configServices, "Title", _queryServiceTitle);

                if (queryService == null) {
                    resolve(null);
                }

                let codedValues = [];

                let url = CommonBusiness.GenerateUrl(queryService);
                let layer = new FeatureLayer(url);

                layer.load().then(function (p) {

                    layer.types?.forEach(layer_type => {

                        if (layer_type.domains[_field].codedValues != null) {
                            layer_type.domains[_field].codedValues?.forEach(codedValue => {

                                codedValues.push({
                                    code: codedValue.code,
                                    name: codedValue.name
                                });

                            });
                        }

                    });
                    resolve(codedValues);
                });
            });
        });
    },

    GetUniqueValueRenderers: async (_queryServiceTitle) => {
        return new Promise((resolve, reject) => {

            let configServices = MapManager.GetConfiguration().ConfigurationServices;
            let queryServiceList = ArrayHelper.Find(configServices, "Title", _queryServiceTitle);

            if (queryServiceList.length == 0) {
                reject(null);
            }

            loadModules(["esri/layers/FeatureLayer"]).then(([FeatureLayer]) => {


                let queryService = queryServiceList[0];
                let url = CommonBusiness.GenerateUrl(queryService);
                let layer = new FeatureLayer(url);

                layer.load().then(function () {
                    resolve(layer.sourceJSON.drawingInfo.renderer.uniqueValueInfos);

                 
                  
                });
            });


        });

    },
    GetUniqueValueAdd: async (_queryServiceTitle) => {
        return new Promise((resolve, reject) => {

            let configServices = MapManager.GetConfiguration().ConfigurationServices;
            let queryServiceList = ArrayHelper.Find(configServices, "Title", _queryServiceTitle);

            if (queryServiceList.length === 0) {
                reject(null);
            }

            // FeatureLayer modülünü esri-loader ile yükleyin
            loadModules(["esri/layers/FeatureLayer"]).then(([FeatureLayer]) => {

                let queryService = queryServiceList[0];
                let url = CommonBusiness.GenerateUrl(queryService); // Correct the queryService variable usage
                let layer = new FeatureLayer({ url });

                // Layer yüklendikten sonra işlemleri gerçekleştir
                layer.load().then(function () {
                    // UniqueValueRenderers bilgilerini resolve et
                    resolve(layer.sourceJSON.drawingInfo.renderer.uniqueValueInfos);

                    // MapView'i al ve layer'ı ekle
                    const _mapView = MapManager.GetMapView(); // MapView'i alın
                    _mapView.map.removeAll(); // Tüm layer'ları temizleyin
                    _mapView.map.add(layer); // Yeni layer'ı MapView'e ekleyin
                }).catch(err => {
                    reject(err); // Hata durumunda reject çalıştırın
                });
            }).catch(err => {
                reject(err); // Hata durumunda reject çalıştırın
            });
        });

    },

    GetDomainTypes: async (_queryServiceTitle) => {

        return new Promise((resolve, reject) => {


            let configServices = MapManager.GetConfiguration().ConfigurationServices;
            let queryService = ArrayHelper.Find(configServices, "Title", _queryServiceTitle);

            if (queryService == null) {
                reject(null);
            }

            loadModules(["esri/layers/FeatureLayer"]).then(([FeatureLayer]) => {

                let url = CommonBusiness.GenerateUrl(queryService);
                let layer = new FeatureLayer(url);

                layer.load().then(function () {
                    resolve(layer.types);
                });
            });


        });

    },


    CreateLayer: async (layerItem) => {

        return new Promise((resolve, reject) => {

            CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(layerItem), "CommonBusiness.CreateLayer");

            return loadModules(["esri/layers/FeatureLayer", "esri/layers/WMSLayer",
                "esri/layers/MapImageLayer", "esri/layers/BaseDynamicLayer", "esri/layers/GeoJSONLayer"])
                .then(([FeatureLayer, WMSLayer, MapImageLayer, BaseDynamicLayer, GeoJSONLayer]) => {


                    try {

                        let layer = null;

                        if (layerItem.layerType === Constants_LayerType.MapImageLayer) { //MapImageLayer
                            layer = new MapImageLayer({
                                id: layerItem.id,
                                url: CommonBusiness.GenerateUrl(layerItem),
                                title: layerItem.title,
                                visible: layerItem.visible,
                                opacity: layerItem.opacity / 100
                            });
                        }

                        if (layerItem.layerType === Constants_LayerType.MapLayer) { //MapImageLayer
                            layer = new MapImageLayer({
                                id: layerItem.id,
                                url: CommonBusiness.GenerateUrl(layerItem),
                                title: layerItem.title,
                                visible: layerItem.visible,
                                opacity: layerItem.opacity / 100,
                                sublayers: [
                                    {
                                        id: 3, // id
                                        visible: false
                                    }
                                ]
                            });
                        }


                        if (layerItem.layerType === Constants_LayerType.FeatureLayer) { //FeatureLayer
                            layer = new FeatureLayer({
                                id: layerItem.id,
                                url: CommonBusiness.GenerateUrl(layerItem),
                                title: layerItem.title,
                                visible: layerItem.visible,
                                opacity: layerItem.opacity / 100,
                                renderer: layerItem.renderer ?? null,
                                featureReduction: layerItem.featureReduction ?? null,
                                popupTemplate: layerItem.popupTemplate ?? null

                            });
                        }

                        if (layerItem.layerType === Constants_LayerType.WMSLayer) { //WMSLayer
                            layer = new WMSLayer({
                                id: layerItem.id,
                                url: CommonBusiness.GenerateUrl(layerItem),
                                title: layerItem.title,
                                visible: layerItem.visible,
                                opacity: layerItem.opacity / 100
                            });
                        }


                        if (layerItem.layerType === Constants_LayerType.GeoJSONLayer) { //WMSLayer

                            const blob = new Blob([JSON.stringify(layerItem)], {
                                type: "application/json"
                            });
                            const geojsonurl = URL.createObjectURL(blob);

                            layer = new GeoJSONLayer({
                                renderer: layerItem.renderer ?? null,
                                featureReduction: layerItem.featureReduction ?? null,
                                url: geojsonurl,
                                popupTemplate: layerItem.popupTemplate ?? null
                            });
                        }

                        /*
                        layer.when(function (err) {

                        });
                        */

                        resolve(layer);

                    } catch (error) {
                        console.log(error);
                        resolve(null);
                    }


                });

        });
    },


    Clustering: {

        ChangePopup:(_showBigPopup)=>{
        
            if(_showBigPopup){
                var head = document.head;
                var link = document.createElement("link");
                
                link.type = "text/css";
                link.rel = "stylesheet";
                link.href =  process.env.PUBLIC_URL+"/BigPopupOverride.css";
                
                head.appendChild(link);
                Store.dispatch({
                    type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
                    payload: link
                });
            
            }
            else{
                //remove big pop up link
                var head = document.head;
                var link=Store.getState().Common.BigPopupLinkRef;
                if(link!=null){

                    head.removeChild(link);
                    Store.dispatch({
                        type: CommonReducer_ActionTypes.SetBigPopupLinkRef,
                        payload: null
                    });
                }
               
            }
        
        },

        CreateConfig: (_popupTemplate) => {

            return {
                type: "cluster",
                clusterRadius: "120px",

                clusterMinSize: "32px",
                clusterMaxSize: "84px",
                labelingInfo: [{
                    deconflictionStrategy: "none",
                    labelExpressionInfo: {
                        expression: "Text($feature.cluster_count, '#')"
                    },
                    symbol: {
                        type: "text",
                        color: "#444",
                        font: {
                            weight: "bold",
                            family: "Noto Sans",
                            size: "16px"
                        }
                    },
                    labelPlacement: "center-center",
                }],

                symbol: {
                    type: "simple-marker",
                    style: "circle",
                    size: 12,
                    color: "#EEE",
                    outline: {
                        color: "rgba(8,143,188,1)",
                        width: 4
                    }
                }

            };
        },


        GetPopupInfo:async(feature)=>{

                if (feature) {

                    CommonBusiness.Clustering.ChangePopup(false);
                    const div=document.createElement("div");

                    var graphic, attributes, html = "";
                    graphic = feature.graphic;
                    attributes = graphic.attributes;


                    html += "<div class='map-popup'>";
                    html += "<div class='popup-section'>";
                    html += " <span class='popup-title'>";
                    html += attributes["adi"] ?? attributes["title"];
                    html += "</span>";
                    html += "</div>";


                    html += "<div class='popup-section'>";
                    if (!IsNull(attributes['mahalleadi']) ||!IsNull(attributes['districtName'])) {
                        html += "<div class='popup-nbhood'>";
                        html +=  attributes['mahalleadi'] ?? attributes['districtName'] ?? "(Mahalle bilgisi yok)";
                        html += "</div>";
                    }

                    if (!IsNull(attributes['adres']) || !IsNull(attributes['address'])) {
                        html += "<div class='popup-address'>";
                        html +=  attributes['adres'] ?? attributes['address'] ?? "(Mahalle bilgisi yok)";
                        html += "</div>";
                    }

                    if (!IsNull(attributes['telefon']) ||!IsNull(attributes['phone'])) {
                        html += "<div class='popup-phone'>";
                        html +=  attributes['telefon'] ?? attributes['phone'] ?? "(Mahalle bilgisi yok)";
                        html += "</div>";
                    }
                    html += "</div>";
                    

                    if (!IsNull(attributes['websitesi'])) {
                        html += "<div class='popup-section'>";
                        html += "<div class='popup-header'>Web sitesi</div>";
                        html += "<div class='popup-website'><a href='" + attributes['websitesi']+"' target='_blank'>Buraya tıklayarak websitesine ulaşabilirsiniz</a></div>";
                        html += "</div>";
           
                    }
                    
                    html += "</div>";


                    div.innerHTML=html;
                    
                    return div;
                }
        

        },


        GetInfoWithAttachments:async(feature, _attachmentQueryUrl, _queryServiceTitle)=>{

            if (feature) {

                CommonBusiness.Clustering.ChangePopup(true);

                const div=document.createElement("div");

                var graphic, attributes, html = "";
                graphic = feature.graphic;
                attributes = graphic.attributes;


                html += "<div class='map-popup'>";
                html += ""
                 
                    + "<span class='popup-title'>" + attributes["adi"] + "</span>"

                html += "<div class='popup-sections'>";

                html += "<div class='popup-section'>";
                //html += "<div class='popup-title'>" + attributes['ADI'] + "</div>";
                
                const _attachmentList=await  CommonBusiness.Attachments.QueryAttachments(_attachmentQueryUrl,attributes.globalid)
      
                if(_attachmentList.data?.length>0){

                    html+="  <div class='slider'>";

                    html+="     <div class='slides'>";
                    _attachmentList.data.forEach((_attachment,_index) => {
                      
                        const imageurl=CommonBusiness.Attachments.GetAttachmentUrl(_queryServiceTitle,attributes.objectid,_attachment.attr.attachmentid);
                        html+="<div id='slide-"+_index+"'>"
                        +"<img class='attachments-image' src='"+imageurl+"'/>"
                        +"</div>";
                    });

                    html+="     </div>";  

                    /*
                    _attachmentList.data.forEach((_attachment,_index) => {
                        html+="<a class='slider-link' href='#slide-"+_index+"'></a>";
                    });
                    */

                    html+=" </div>";                   
                }
                html += "</div>";
                
                html += "<div class='popup-section'>";
                if (!IsNull(attributes['aciklama'])) {
                    html += "<div class='popup-header'>Hakkında</div>";
                    html += "<div class='popup-description'>" + (attributes['aciklama'] ?? "-") + "</div>";
                }

                html += "</div>";

                html += "<div class='popup-section'>";
                html += "   <div class='popup-header'>Adres ve Ulaşım</div>";
                if (!IsNull(attributes['mahalle_adi'])) {
                    html += "   <div class='popup-nbhood'>" + (attributes['mahalle_adi'] ?? "(Mahalle bilgisi yok)") + "</div>";
                }

                if (!IsNull(attributes['adres'])) {
                    html += "   <div class='popup-address'>" + (attributes['adres'] ?? "(Adres bilgisi yok)") + "</div>";
                }

                if (!IsNull(attributes['telefon'])) {
                    html += "   <div class='popup-phone'>" + (attributes['telefon'] ?? "(Telefon bilgisi yok)") + "</div>";
                }
   
                html += "   </div>";
                html += "</div>";


                
                if (!IsNull(attributes['websitesi'])) {
                    html += "<div class='popup-section'>";
                    html += "<div class='popup-header'>Web sitesi</div>";
                    html += "<div class='popup-website'><a href='" + attributes['websitesi']+"' target='_blank'>Buraya tıklayarak websitesine ulaşabilirsiniz</a></div>";
                    html += "</div>";
                    html += "</div>";
                }

                html += "</div>";

                div.innerHTML=html;
                
                           
                /*
                window.showAttachmentLarge=(_title,_url)=>{
                    const imageDiv=document.createElement("div");
                    const imageHtml="<div id='large-attachment-image-window' class='attachments-image-large-bg'>"
                    +"<div  class='attachments-image-large-container'>"
                    +"<div  class='attachments-image-large-container-header'>"
                    +"<div  class='attachments-image-large-container-title'>"+_title+"</div>"
                    +"  <div class='attachments-image-large-close-btn' onclick='window.removeAttachmentLarge()'>x</div>"
                    +"</div>"
                    +"<img class='attachments-image-large' src='"+_url+"'/></div></div>";

                    imageDiv.innerHTML=imageHtml;
                    document.body.append(imageDiv);
                };

                window.removeAttachmentLarge=()=>{
                    document.getElementById('large-attachment-image-window').remove();
                }
                */

                setTimeout(() => {
                    
                    const mapView=MapManager.GetMapView();
                 
                    var centerPoint=[
                        (graphic.geometry.longitude),
                        (graphic.geometry.latitude + 0.005),
                    ];
       
                    mapView.goTo({
                        center: centerPoint,
                        zoom:16
                    });
                    mapView.popup.location=graphic.geometry;
                    
                }, 100);
                
              
                return div;
            }
        },

        CreateGeoJsonClusterLayer: async (_geojson, _layerTitle, _symbol) => {
            return new Promise((resolve, reject) => {
                const view = MapManager.GetMapView();
        
                _geojson.featureReduction = CommonBusiness.Clustering.CreateConfig();
        
                // Function to get symbol based on zoom level
                const getSymbolBasedOnZoom = (zoomLevel) => {
                    if (zoomLevel > 10) {
                        return {
                            type: "picture-marker",
                            url: "images/icons/map/yasli.png",
                            width: "48px",
                            height: "48px"
                        };
                    } else {
                        return {
                            type: "picture-marker",
                            url: "images/icons/map/yasli.png",
                            width: "40px",
                            height: "40px"
                        };
                    }
                };
        
                // Function to update renderer based on zoom level
                const updateRenderer = (zoomLevel) => {
                    _geojson.renderer = {
                        type: "simple",
                        symbol: getSymbolBasedOnZoom(zoomLevel)
                    };
                    // Renderer'ı güncelle
                    if (_geojson.layer) {
                        _geojson.layer.renderer = _geojson.renderer;
                    }
                };
        
                // Initial setup
                updateRenderer(view.zoom);
        
                // Add event listener to update symbol when zoom level changes
                view.watch("zoom", (newZoomLevel) => {
                    updateRenderer(newZoomLevel);
                });
        
                _geojson.popupTemplate = {
                    outFields: ['*'],
                    title: "",
                    content: (_feature) => CommonBusiness.Clustering.GetPopupInfo(_feature),
                    actions: [
                        {
                            title: "Cad./Sok.Görünümü",
                            id: "show-on-streetview",
                            image: "images/icons/map/streetView.png"
                        }
                    ]
                };
        
                CommonBusiness.CreateLayer(_geojson).then((_layer) => {
                    // Layer'ı kaydet
                    _geojson.layer = _layer; // Layer referansını sakla
                    resolve(_layer);
                }).catch(reject);
            });
        },
        CreateLayerWithoutClustering: async (_queryServiceTitle, _layerTitle, _query, _symbol, _showAttachments, _attachmentQueryUrl) => {

            return new Promise((resolve, reject) => {
        
                let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", _queryServiceTitle);
                if (queryService == null) {
                    reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + _queryServiceTitle + ")" });
                    return;
                }
        
                CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(queryService), "CommonBusiness.CreateLayerWithoutClustering");
                
                if (_showAttachments) {
                    CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(_attachmentQueryUrl), "CommonBusiness.CreateLayerWithoutClustering");
                }
          
        
                const _layerProperties = {
                    id: TextHelper.CreateGuid(),
                    layerType: Constants_LayerType.FeatureLayer,
                    title: _layerTitle,
                    url: CommonBusiness.GenerateUrl(queryService),
                    visible: true,
                    opacity: 100,
        
                    // Kümeleme (featureReduction) olmadan sembol ayarları
                    renderer: {
                        type: "simple",
                        symbol: _symbol ?? {
                            type: "simple-marker",
                            style: "circle",
                            size: 12,
                            color: "#EEE",
                            outline: {
                                color: "#30598b",
                                width: 4
                            }
                        }
                    },
        
                    popupTemplate: {
                        outFields: ['*'],
                        title: "",
                        content: (_feature) => !_showAttachments 
                            ? CommonBusiness.Clustering.GetPopupInfo(_feature) 
                            : CommonBusiness.Clustering.GetInfoWithAttachments(_feature, _attachmentQueryUrl, _queryServiceTitle),
                        actions: [
                            {
                                title: "Yol Tarifi Al (Google)",
                                id: "show-on-google",
                                image: "images/icons/map/pictureMarker.png"
                            },
                            {
                                title: "Cadde/Sokak Görünümü (Google)",
                                id: "show-on-streetview",
                                image: "images/icons/map/streetView.png"
                            }
                        ]
                    }
                };
        
                // Layer ekleme işlemi
                loadModules(["esri/layers/FeatureLayer"]).then(([FeatureLayer]) => {
                    let layer = new FeatureLayer(_layerProperties);
                    resolve({
                        layerObj: layer
                    });
                }).catch(err => {
                    reject(err);
                });
            });
        },
        


        CreateClusterLayer: async (_queryServiceTitle, _layerTitle, _query, _symbol, _showAttachments, _attachmentQueryUrl) => {

            return new Promise((resolve, reject) => {

                let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", _queryServiceTitle);
                if (queryService == null) {
                    reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + _queryServiceTitle + ")" })
                };

                CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(queryService), "CommonBusiness.CreateClusterLayer");
                
                if(_showAttachments){
                    CommonBusiness.AddProxyRule(CommonBusiness.GenerateUrl(_attachmentQueryUrl), "CommonBusiness.CreateClusterLayer");
                }

                const _layerProperties = {

                    id: TextHelper.CreateGuid(),
                    layerType: Constants_LayerType.FeatureLayer,
                    title: _layerTitle,
                    url: CommonBusiness.GenerateUrl(queryService),
                    eg: CommonBusiness.GenerateUrl(queryService),
                    visible: true,
                    opacity: 100,
                    featureReduction: CommonBusiness.Clustering.CreateConfig(),

                    renderer: {
                        type: "simple",
                        symbol: _symbol ?? {
                            type: "simple-marker",
                            style: "circle",
                            size: 12,
                            color: "#EEE",
                            outline: {
                                color: "#30598b",
                                width: 4
                            }
                        }
                    },

                    popupTemplate: {
                        outFields: ['*'],
                        title: "",
                        content: (_feature) => !_showAttachments ? CommonBusiness.Clustering.GetPopupInfo(_feature) : CommonBusiness.Clustering.GetInfoWithAttachments(_feature, _attachmentQueryUrl, _queryServiceTitle),
                        actions: [
                            {
                                title: "Yol Tarifi Al (Google)",
                                id: "show-on-google",
                                image:
                                    "images/icons/map/pictureMarker.png"
                            },
                            {
                                title: "Cadde/Sokak Görünümü (Google)",
                                id: "show-on-streetview",
                                image:
                                    "images/icons/map/streetView.png"
                            }
                        ]
                    }
                };


                CommonBusiness.CreateLayer(_layerProperties).then((_layer) => {

                    _layer.definitionExpression = "1=1";

                    let options = {};
                    options.where = "1=1";

                    if (_query != null) {

                        if (!IsNull(_query.name)) {
                            _layer.definitionExpression += " AND UPPER(adi) LIKE '%" + TextHelper.RemoveTurkishChars(TextHelper.TurkishToUpper(_query.name)) + "%'";
                        }


                        if (_query.showNearby) {

                            options.geometry = _query.userLocation;
                            options.distance = _query.bufferDistance * 100;
                            options.units = 'meters';
                            options.spatialRelationship = 'intersects';

                        }
                        else {
                            if (!IsNull(_query.districtId)) {
                                _layer.definitionExpression += " AND ilceid = '" + _query.districtId + "'";
                            }

                            if (!IsNull(_query.nbhoodId)) {
                                _layer.definitionExpression += " AND mahalleid = '" + _query.nbhoodId + "'";
                            }
                        }
                    }


                    _layer.queryObjectIds(options).then((_queryResults) => {
                     
                        if (!IsNull(_queryResults)) {
                            _layer.definitionExpression += " AND objectid IN (" + _queryResults.join(",") + ")"
                        }

                        let _layerInfo = {
                            id: _layerProperties.id,
                            title: _layerProperties.title,
                            layerObj: _layer
                        };


                        resolve(_layerInfo);
                    });

                });

              


            });


        }
    },


    Attachments: {

        QueryAttachments: async (_queryServiceTitle, _id) => {


            return new Promise((resolve, reject) => {

                let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", _queryServiceTitle);

                if (queryService == null) {
                    reject({ type: Constants_ServiceResultType.Error, message: "Servis bulunamadı (" + _queryServiceTitle + ")" })
                };

                let options = {
                    url: CommonBusiness.GenerateUrl(queryService),
                    returnGeometry: false,
                    outFields: ["*"]
                };

                let where = "rel_globalid='" + _id+"'";
                options.where = where;

                GisQueryHelper.ExecuteQuery(options).then(results => {
                    resolve(results);
                });

            });
        },

        GetAttachmentUrl: (_queryServiceTitle, _id, _attachmentId) => {


            let queryService = ArrayHelper.Find(MapManager.GetConfigurationServices(), "title", _queryServiceTitle);

            if (queryService == null) {
                return "#";
            };


            var baseUrl = queryService.url;

            let url = baseUrl + "/" + _id + "/attachments/" + _attachmentId;

            return url;
        }


    }

}