import React, { useEffect, useReducer, useRef, useState } from "react";
import { loadModules } from "esri-loader";
import Store from "../../Store/Store";
import { MapReducer_ActionTypes } from "../../Store/Reducers/MapReducer";
import { NavigationBar } from "./NavigationBar";
import { Sidebar } from "./Sidebar";

import { CompanyLogo } from "./CompanyLogo";
import { LayerListWidget } from "../Widget/LayerList/LayerListWidget";
import { BasemapWidget } from "../Widget/Basemap/BasemapWidget";
import MapManager from "../../Store/Managers/MapManager";
import { ToolbarWidget } from "../Widget/Toolbar/ToolbarWidget";
import { CityBlockParcelQueryWindow } from "../Query/CityBlockParcelQuery/CityBlockParcelQueryWindow";
import { ReportQueryWindow} from "../Query/ReportQuery/ReportQueryWindow";
import { RouteQueryWindow } from "../Query/RouteQuery/RouteQueryWindow";
import { TransitRouteQueryWindow } from "../Query/TransitRouteQuery/TransitRouteQueryWindow";
import { TaxiQueryWindow } from "../Query/TaxiQuery/TaxiQueryWindow";
import { PodQueryWindow } from "../Query/PodQuery/PodQueryWindow";
import { PatiDostuQueryWindow } from "../Query/PatiDostuQuery/PatiDostuQueryWindow";
import { HalkEkmekQueryWindow } from "../Query/HalkEkmekQuery/HalkEkmekQueryWindow";
import { BaskentMarketQueryWindow } from "../Query/BaskentMarketQuery/BaskentMarketQueryWindow";
import { KadinlarLokaliQueryWindow } from "../Query/KadinlarLokaliQuery/KadinlarLokaliQueryWindow";
import { KadinDanismaQueryWindow } from "../Query/KadinDanismaQuery/KadinDanismaQueryWindow";
import { TeknolojiMerkezleriQueryWindow } from "../Query/TeknolojiMerkezleriQuery/TeknolojiMerkezleriQueryWindow";
import { AileYasamMerkezleriQeryWindow } from "../Query/AileYasamMerkezleriQery/AileYasamMerkezleriQeryWindow";
import { AnfaBitkiEviQeryWindow } from "../Query/AnfaBitkiEviQery/AnfaBitkiEviQeryWindow";
import { AnfaKafelerQeryWindow } from "../Query/AnfaKafelerQery/AnfaKafelerQeryWindow";
import { AnfaOtoparkQueryWindow } from "../Query/AnfaOtoparkQuery/AnfaOtoparkQueryWindow";
import { AskiAtıkSuTesisleriQeryWindow } from "../Query/AskiAtıkSuTesisleriQery/AskiAtıkSuTesisleriQeryWindow";
import { AskiBarajQeryWindow } from "../Query/AskiBarajQery/AskiBarajQeryWindow";
import { AskiBolgeMudurlukleriQeryWindow } from "../Query/AskiBolgeMudurlukleriQery/AskiBolgeMudurlukleriQeryWindow";
import { AskiKartDolumOdemeQueryWindow } from "../Query/AskiKartDolumOdemeQuery/AskiKartDolumOdemeQueryWindow";
import { AskiTahsilatSubeQueryWindow } from "../Query/AskiTahsilatSubeQuery/AskiTahsilatSubeQueryWindow";
import { AskiSumatikQeryWindow } from "../Query/AskiSumatikQery/AskiSumatikQeryWindow";
import { BelkoMeyveSuyuSatisBufeleriQueryWindow } from "../Query/BelkoMeyveSuyuSatisBufeleriQuery/BelkoMeyveSuyuSatisBufeleriQueryWindow";
import { BelmekBeltekQeryWindow } from "../Query/BelmekBeltekQery/BelmekBeltekQeryWindow";
import { CocukEtkinlikMerkezleriQeryWindow } from "../Query/CocukEtkinlikMerkezleriQery/CocukEtkinlikMerkezleriQeryWindow";
import { EventQueryWindow } from "../Query/EventQuery/EventQueryWindow";
import { EgoAnkarayDuraklariQueryWindow } from "../Query/EgoAnkarayDuraklariQuery/EgoAnkarayDuraklariQueryWindow";
import { EgoBaskentrayDuraklariQueryWindow } from "../Query/EgoBaskentrayDuraklariQuery/EgoBaskentrayDuraklariQueryWindow";
import { EgoElektrikliBisikletIstasyonlariQueryWindow } from "../Query/EgoElektrikliBisikletİstasyonlariQuery/EgoElektrikliBisikletIstasyonlariQueryWindow";
import { EgoKartDolumNoktalariQeryWindow } from "../Query/EgoKartDolumNoktalariQery/EgoKartDolumNoktalariQeryWindow";
import { EgoKartSatisNoktalariQueryWindow } from "../Query/EgoKartSatisNoktalariQuery/EgoKartSatisNoktalariQueryWindow";
import { EgoOtobusDuraklariQueryWindow } from "../Query/EgoOtobusDuraklariQuery/EgoOtobusDuraklariQueryWindow";
import { EgoMetroDuraklariQueryWindow } from "../Query/EgoMetroDuraklariQuery/EgoMetroDuraklariQueryWindow";
import { EgoTeleferikDuraklariQueryWindow } from "../Query/EgoTeleferikDuraklariQuery/EgoTeleferikDuraklariQueryWindow";
import { EngelliBireyQeryWindow } from "../Query/EngelliBireyQery/EngelliBireyQeryWindow";
import { EngelliCocukQueryWindow } from "../Query/EngelliCocukQuery/EngelliCocukQueryWindow";
import { GazilerMerkeziQueryWindow } from "../Query/GazilerMerkeziQurey/GazilerMerkeziQueryWindow";
import { ParklarQueryWindow } from "../Query/ParklarQuery/ParklarQueryWindow";
import { PortasAsfaltUretimQueryWindow } from "../Query/PortasAsfaltUretimQuery/PortasAsfaltUretimQueryWindow";
import { SegmenSuFabrikalarıQueryWindow } from "../Query/SegmenSuFabrikalarıQuery/SegmenSuFabrikalarıQueryWindow";
import { SegmenSuSatisBayileriQueryWindow } from "../Query/SegmenSuSatisBayileriQuery/SegmenSuSatisBayileriQueryWindow";
import { SosyalHizmetlerQueryWindow } from "../Query/SosyalHizmetlerQuery/SosyalHizmetlerQueryWindow";
import { SporTesisleriQueryWindow } from "../Query/SporTesisleriQuery/SporTesisleriQueryWindow";
import { WifiNoktalariQueryWindow } from "../Query/WifiNoktalariQuery/WifiNoktalariQueryWindow";
import { KutuphanelerQueryWindow } from "../Query/KutuphanelerQuery/KutuphanelerQueryWindow";
import { YasliDostuQueryWindow } from "../Query/YasliDostuQuery/YasliDostuQueryWindow";
import { NumberingQueryWindow } from "../Query/NumberingQuery/NumberingQueryWindow";
import "./MapComponent.css";
import { FastAccessQueryWindow } from "../Query/FastAccessQuery/FastAccessQueryWindow";
import { MeasurementWidget } from "../Widget/Measurement/MeasurementWidget";
import { SketchWidget } from "../Widget/Sketch/SketchWidget";
import { GlobalIdentifyWidget } from "../Widget/GlobalIdentify/GlobalIdentifyWidget";
import { StreetViewWidget } from "../Widget/StreetView/StreetViewWidget";
import { BookmarkWidget } from "../Widget/Bookmark/BookmarkWidget";
import { AssemblyAreaQueryWindow } from "../Query/AAQuery/AAQueryWindow";
import { FeedbackWidget } from "../Widget/Feedback/FeedbackWidget";
import { GoogleMapsBusiness } from "../../Business/GoogleMapsBusiness";
import { DisclaimerWidget } from "../Widget/Disclaimer/DisclaimerWidget";
import { ContextMenuWidget } from "../Widget/ContextMenu/ContextMenuWidget";
import { VicinityQueryWindow } from "../Query/VicinityQuery/VicinityQueryWindow";
import { CultureQueryWindow } from "../Query/CultureQuery/CultureQueryWindow";
import { EgoQueryWindow } from "../Query/EgoQuery/EgoQueryWindow";
import { GenelAramaQeryWindow } from "../Query/GenelAramaQuery/GenelAramaQeryWindow";


export const MapComponent = (props) => {
   
    const mapDiv = useRef(null);
    const [mapView, setMapView] = useState(null);
  //  const [showLayerListWidget, setShowLayerListWidget] = useState(false);
     const sidebarRef = useRef();
 
    //Widgets
    const basemapWidgetRef = useRef();
    const bookmarkWidgetRef = useRef();
    const contextMenuWidgetRef= useRef();
    const feedbackWidgetRef= useRef();
    const globalIdentifyWidgetRef=useRef();
    const layerListWidgetRef = useRef();
    const measurementWidgetRef = useRef();
    const sketchWidgetRef = useRef();

    //Queries
    const assemblyareaQueryRef=useRef();
    const baskentmarketQueryRef=useRef();
    const cityblockParcelRef = useRef();
    const cultureQueryRef=useRef();
    const egoQueryRef = useRef();
    const eventQueryRef = useRef();
    const familyQueryRef = useRef();
    const greenAreaQueryRef = useRef();
    const halkekmekQueryRef= useRef();
    const patidostuQueryRef = useRef();
    const kadinlarlokaliQueryRef = useRef();
    const kadindanismaQueryRef = useRef();
    const teknolojimerkezleriQueryRef = useRef();
    const aileyasammerkezleriQueryRef = useRef();
    const anfabitkieviQueryRef = useRef();
    const anfakafalarQueryRef = useRef();
    const anfaotoparkQueryRef = useRef();
    const askiatiksutesisleriQueryRef = useRef();
    const askibarajQueryRef = useRef();
    const askibolgemudurluklerQueryRef = useRef();
    const askikartdolumodemeQueryRef = useRef();
    const askisumatikQueryRef = useRef();
    const askitahsilatsubeQeryRef = useRef();
    const belmekbeltekQeryRef = useRef();
    const belkomeyvesuyusatisbufeleriQeryRef = useRef();
    const cocuketkinlikmerkezleriQueryRef = useRef();
    const egoankarayduraklarQueryRef = useRef();
    const egobaskentrayduraklarQueryRef = useRef();
    const egokartdolumnoktalariQueryRef = useRef();
    const egokartsatisnoktalariQueryRef = useRef();
    const egoelektriklibisikletistasyonlariQueryRef = useRef();
    const egometroduraklarQueryRef = useRef();
    const egootobusduraklariQueryRef = useRef();
    const egooteleferikduraklariQueryRef = useRef();
    const engelliBireyQueryRef = useRef();
    const engelliCocukQueryRef = useRef();
    const gazilermerkeziQueryRef = useRef();
    const parkQueryRef = useRef();
    const portasasfalturetimQueryRef = useRef();
    const segmensufabrikasiQueryRef = useRef();
    const segmensusatisbayileriQueryRef = useRef();
    const sosyalhizmetlerQueryRef = useRef();
    const sportesisleriQueryRef = useRef();
    const wifinoktalariQueryRef = useRef();
    const kutuphanelerQueryRef = useRef();
    const yaslidostuQueryRef = useRef();
    const kindergartenQueryRef = useRef();
    const numberingQueryRef = useRef();
    const podQueryRef = useRef();
    const reportQueryRef = useRef();
    const routeQueryRef = useRef();
    const sanctuaryQueryRef = useRef();
    const schoolQueryRef = useRef();
    const streetViewWidget= useRef();
    const taxiQueryRef = useRef();
    const touristicQueryRef = useRef();
    const transitQueryRef = useRef();
    const vicinityQueryRef = useRef();
    const vivariumQueryRef = useRef();
    const genelaramaQueryRef = useRef();
   
  
    useEffect(() => {

        const mapConfig = MapManager.GetMapConfiguration();

        return loadModules(["esri/Map", "esri/views/MapView", "esri/config", "esri/core/urlUtils", "esri/core/watchUtils", "esri/layers/MapImageLayer",
        "dojo/domReady!"])
            .then(([Map, MapView, esriConfig, urlUtils, watchUtils,MapImageLayer]) => {

        
             
                const map = new Map({
                    basemap:  "osm",
                });

                const view = new MapView({
                    container: "esri-map-container",
                    ui: {
                        components: []
                    },
                    map,
                    zoom: 11,
                    center: [mapConfig.Centerx ?? 34, mapConfig.Centery ?? 39],
                    padding: {
                        top: 0,
                        bottom: window.innerWidth <= 576 ? 200 : 0,
                        left: window.innerWidth <= 576 ? 0 : 400,  // Adjust this value as needed
                        right: 0  // Adjust this value as needed
                    },
                    constraints: {
                        maxZoom: 221,
                        minZoom: 1,
                        rotationEnabled: false
                    }
                });
                watchUtils.whenTrue(view, "updating", () => {
                    props.windowManager.SetMapUpdating(true);
                });

                watchUtils.whenFalse(view, "updating", () => {
                    props.windowManager.SetMapUpdating(false);
                });
                

       

                view.popup.on("trigger-action", function(event){
                    // If the zoom-out action is clicked, fire the zoomOut() function
                    if(event.action.id === "show-on-google"){
                      
                        const feature = view.popup.selectedFeature;
                        const url=GoogleMapsBusiness.CreateRoutesUrlFromPoint(feature.geometry);
                        window.open(url,"_blank");
                    }

                    if(event.action.id === "show-on-streetview"){
                      
                        const feature = view.popup.selectedFeature;
                        const url=GoogleMapsBusiness.CreateStreetViewUrlFromPoint(feature.geometry);
                        window.open(url,"_blank");
                    }


                    if(event.action.id === "show-details"){
                      
                        const feature = view.popup.selectedFeature;
                        const url=GoogleMapsBusiness.CreateStreetViewUrlFromPoint(feature.geometry);
                        window.open(url,"_blank");
                    }

                });
                  

                view.on("click", function (event) {
                    if (event.button == "2" || MapManager.GetMobileRightClick()) { //<- right button
                        MapManager.SetMapClickEvent(event);
                        props.windowManager.ShowWindow("context-menu-widget");
                    }
                    else{
                        props.windowManager.HideWindow("context-menu-widget");
                    }
                });

                Store.dispatch({
                    type: MapReducer_ActionTypes.SetMapView,
                    payload: view
                });

                setMapView(view);

            });

    }, []);

    return (<>
        <div className="esri-map" id="esri-map-container" ref={mapDiv}>
            {
                mapView && <>
                   <NavigationBar id="mainbar" windowManager={props.windowManager} />
                    <Sidebar id="sidebar" windowManager={props.windowManager} ref={sidebarRef}   /> 
                               
                    <ToolbarWidget id="toolbar-widget" windowManager={props.windowManager} />
                    {
                        /*<CompanyLogo/> */
                       
                    }

            
                    <BasemapWidget id="basemap-widget" windowManager={props.windowManager} ref={basemapWidgetRef} />
                    <BookmarkWidget id="bookmark-widget" windowManager={props.windowManager} ref={bookmarkWidgetRef} />
                    <ContextMenuWidget id="context-menu-widget" windowManager={props.windowManager} ref={contextMenuWidgetRef} />
                    <FeedbackWidget id="feedback-widget" windowManager={props.windowManager} ref={feedbackWidgetRef} />
                    <GlobalIdentifyWidget id="global-identify-widget" windowManager={props.windowManager} ref={globalIdentifyWidgetRef}/>                   
                     <MeasurementWidget id="measurement-widget" windowManager={props.windowManager} ref={measurementWidgetRef} />
                    <SketchWidget id="sketch-widget" windowManager={props.windowManager} ref={sketchWidgetRef} />
                    <StreetViewWidget id="streetview-widget" windowManager={props.windowManager} ref={streetViewWidget} />                    
                    <AssemblyAreaQueryWindow id="assemblyarea-query-window" windowManager={props.windowManager} ref={assemblyareaQueryRef} />
                    <BaskentMarketQueryWindow id="baskentmarket-query-window" windowManager={props.windowManager} ref={baskentmarketQueryRef} />
                    <CityBlockParcelQueryWindow id="cityblockparcel-query-window" windowManager={props.windowManager} ref={cityblockParcelRef} />
                    <CultureQueryWindow id="culture-query-window" windowManager={props.windowManager} ref={cultureQueryRef} />
                    <EgoQueryWindow id="ego-query-window" windowManager={props.windowManager} ref={egoQueryRef} />
                    <EventQueryWindow id="event-query-window" windowManager={props.windowManager} ref={eventQueryRef} />
                    <HalkEkmekQueryWindow id="halkekmek-query-window" windowManager={props.windowManager} ref={halkekmekQueryRef} />
                    <PatiDostuQueryWindow id="patidostu-query-window" windowManager={props.windowManager} ref={patidostuQueryRef} />
                    <TeknolojiMerkezleriQueryWindow id="teknolojimerkezi-query-window" windowManager={props.windowManager} ref={teknolojimerkezleriQueryRef} />
                    <AileYasamMerkezleriQeryWindow id="aileyasammerkezleri-query-window" windowManager={props.windowManager} ref={aileyasammerkezleriQueryRef} />
                    <AnfaBitkiEviQeryWindow id="anfabitkievi-query-window" windowManager={props.windowManager} ref={anfabitkieviQueryRef} />
                    <AnfaKafelerQeryWindow id="anfakafeler-query-window" windowManager={props.windowManager} ref={anfakafalarQueryRef} />
                    <AnfaOtoparkQueryWindow id="anfaotopark-query-window" windowManager={props.windowManager} ref={anfaotoparkQueryRef} />
                    <AskiAtıkSuTesisleriQeryWindow id="askiatiksutesisleri-query-window" windowManager={props.windowManager} ref={askiatiksutesisleriQueryRef} />
                    <AskiBarajQeryWindow id="askibaraj-query-window" windowManager={props.windowManager} ref={askibarajQueryRef} />
                    <AskiBolgeMudurlukleriQeryWindow id="askibolgemudurlukler-query-window" windowManager={props.windowManager} ref={askibolgemudurluklerQueryRef} />
                    <AskiKartDolumOdemeQueryWindow id="askikartdolumodeme-query-window" windowManager={props.windowManager} ref={askikartdolumodemeQueryRef} />
                    <AskiSumatikQeryWindow id="askisumatik-query-window" windowManager={props.windowManager} ref={askisumatikQueryRef} />
                    <AskiTahsilatSubeQueryWindow id="askitahsilatsube-query-window" windowManager={props.windowManager} ref={askitahsilatsubeQeryRef} />
                    <BelkoMeyveSuyuSatisBufeleriQueryWindow id="belkomeyvesuyusatisbufeleri-query-window" windowManager={props.windowManager} ref={belkomeyvesuyusatisbufeleriQeryRef} />
                    <BelmekBeltekQeryWindow id="belmekbeltek-query-window" windowManager={props.windowManager} ref={belmekbeltekQeryRef} />
                    <CocukEtkinlikMerkezleriQeryWindow id="cocuketkinlikmerkezleri-query-window" windowManager={props.windowManager} ref={cocuketkinlikmerkezleriQueryRef} />
                    <EgoAnkarayDuraklariQueryWindow id="egoankarayduraklar-query-window" windowManager={props.windowManager} ref={egoankarayduraklarQueryRef} />
                    <EgoBaskentrayDuraklariQueryWindow id="egobaskentrayduraklar-query-window" windowManager={props.windowManager} ref={egobaskentrayduraklarQueryRef} />
                    <EgoElektrikliBisikletIstasyonlariQueryWindow id="egoelektriklibisikletistasyonlari-query-window" windowManager={props.windowManager} ref={egoelektriklibisikletistasyonlariQueryRef} />
                    <EgoKartDolumNoktalariQeryWindow id="egokartdolumnoktalari-query-window" windowManager={props.windowManager} ref={egokartdolumnoktalariQueryRef} />
                    <EgoKartSatisNoktalariQueryWindow id="egokartsatisnoktalari-query-window" windowManager={props.windowManager} ref={egokartsatisnoktalariQueryRef} />
                    <EgoMetroDuraklariQueryWindow id="egometroduraklar-query-window" windowManager={props.windowManager} ref={egometroduraklarQueryRef} />
                    <EgoOtobusDuraklariQueryWindow id="egootobusduraklar-query-window" windowManager={props.windowManager} ref={egootobusduraklariQueryRef} />
                    <EgoTeleferikDuraklariQueryWindow id="egoteleferikduraklari-query-window" windowManager={props.windowManager} ref={egooteleferikduraklariQueryRef} />
                    <EngelliBireyQeryWindow id="engellibirey-query-window" windowManager={props.windowManager} ref={engelliBireyQueryRef} />
                    <EngelliCocukQueryWindow id="engellicocuk-query-window" windowManager={props.windowManager} ref={engelliCocukQueryRef} />
                    <GazilerMerkeziQueryWindow id="gazilermerkezi-query-window" windowManager={props.windowManager} ref={gazilermerkeziQueryRef} />
                    <ParklarQueryWindow id="park-query-window" windowManager={props.windowManager} ref={parkQueryRef} />
                    <PortasAsfaltUretimQueryWindow id="portasasfalturetim-query-window" windowManager={props.windowManager} ref={portasasfalturetimQueryRef} />
                    <SegmenSuFabrikalarıQueryWindow id="segmensufabrikasi-query-window" windowManager={props.windowManager} ref={segmensufabrikasiQueryRef} />
                    <SegmenSuSatisBayileriQueryWindow id="segmensusatisbayileri-query-window" windowManager={props.windowManager} ref={segmensusatisbayileriQueryRef} />
                     <SosyalHizmetlerQueryWindow id="sosyalhizmetler-query-window" windowManager={props.windowManager} ref={sosyalhizmetlerQueryRef} />
                     <SporTesisleriQueryWindow id="sportesisleri-query-window" windowManager={props.windowManager} ref={sportesisleriQueryRef} />
                     <WifiNoktalariQueryWindow id="wifinoktalari-query-window" windowManager={props.windowManager} ref={wifinoktalariQueryRef} />
                     <YasliDostuQueryWindow id="yaslidostu-query-window" windowManager={props.windowManager} ref={yaslidostuQueryRef} />
                     <KutuphanelerQueryWindow id="kutuphaneler-query-window" windowManager={props.windowManager} ref={kutuphanelerQueryRef} />
                    <KadinlarLokaliQueryWindow id="kadinlarlokali-query-window" windowManager={props.windowManager} ref={kadinlarlokaliQueryRef} />
                    <KadinDanismaQueryWindow id="kadindanisma-query-window" windowManager={props.windowManager} ref={kadindanismaQueryRef} />
                    <GenelAramaQeryWindow id="genelarama-query-window" windowManager={props.windowManager} ref={genelaramaQueryRef}  />
                    <NumberingQueryWindow id="numbering-query-window" windowManager={props.windowManager} ref={numberingQueryRef} />
                    <PodQueryWindow id="pod-query-window" windowManager={props.windowManager} ref={podQueryRef} />
                    <ReportQueryWindow id="report-query-window" windowManager={props.windowManager} ref={reportQueryRef} />
                    <RouteQueryWindow id="route-query-window" windowManager={props.windowManager} ref={routeQueryRef} />
                    <TaxiQueryWindow id="taxi-query-window" windowManager={props.windowManager} ref={taxiQueryRef} />
                  
                    <VicinityQueryWindow id="vicinity-query-window" windowManager={props.windowManager} ref={vicinityQueryRef} />
                    

                   


                </>
            }
        </div>

    </>
    );

}