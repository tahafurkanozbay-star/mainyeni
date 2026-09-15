import React, { useEffect, useRef,useImperativeHandle, useState, useCallback } from "react";
import { DebugHelper } from "../../Toolbox/DebugHelper";
import "./Sidebar.css";
import MapManager from "../../Store/Managers/MapManager";
import { CommonBusiness } from "../../Business/CommonBusiness";
import { LayerBusiness } from "../../Business/LayerBusiness";
import { Constants_ServiceResultType } from "../../Core/Constants";
import { loadModules } from "esri-loader";




export const Sidebar= React.forwardRef((props, ref ) => {

    const [isSidebarOpenABB, setIsSidebarOpenABB] = useState(false);
    const [isSidebarOpenEGO, setIsSidebarOpenEGO] = useState(false);
    const [isSidebarOpenASKI, setIsSidebarOpenASKI] = useState(false); 
    const [isSidebarOpenISTIRAK, setIsSidebarOpenISTIRAK] = useState(false);
    const [isSidebarOpenGENEL, setIsSidebarOpenGENEL] = useState(true);
    const [mapView, setMapView] = useState(null);
    const [extentHistory, setExtentHistory] = useState([]);
    const [extentIndex, setExtentIndex] = useState(0);
    const [addExtent, setAddExtent] = useState(true);
    

    useImperativeHandle(ref, () => ({

        id: props.id, visible: true, minimized: false,
        OnShow: () => {
            DebugHelper.Log("show " + props.id);
            setQuery({ name: "" });
            setIsSidebarOpenGENEL(true); // Sidebar'ı aç
            fetchQueryResults();
            setAddExtent(false);
            let targetExtent = extentHistory[0];
            mapView.goTo(targetExtent);
            
            
        },
        OnClose: () => {
            DebugHelper.Log("closing " + props.id);  
            setQuery({ name: "" }); 
            setIsSidebarOpenGENEL(false); // Sidebar'ı aç 
            fetchQueryResults();
          
        }
    }));
    useEffect(() => {
        setQuery({ name: "" });
        const _mapView = MapManager.GetMapView();
        setMapView(_mapView);       
        if (mapView?.map) {

            fetchQueryResults(mapView);
        }
        
      

        props.windowManager.RegisterWindow(ref); 
      
        if(props)     
        setIsSidebarOpenGENEL(true);      
        setIsSidebarOpenEGO(false); // Diğer sidebar'lar kapanır
        setIsSidebarOpenASKI(false);
        setIsSidebarOpenISTIRAK(false);
        setIsSidebarOpenABB(false); // Diğer sidebar'lar kapanır  

        
       
     }, [mapView]);
     const extentChangeHandler = () => {

        if (addExtent) {

            let mapView = MapManager.GetMapView();

            let _extent = mapView.extent;

            let _exhistory = extentHistory;
            _exhistory.push(_extent);

            setExtentHistory(_exhistory);
            setExtentIndex  (_exhistory.length - 1);
        }
    }

    const [activeButton, setActiveButton] = useState('');
    const toggleSidebarABB = () => {
        setIsSidebarOpenABB(!isSidebarOpenABB);
        setIsSidebarOpenEGO(false); // Diğer sidebar'lar kapanır
        setIsSidebarOpenASKI(false);
        setIsSidebarOpenISTIRAK(false);
        setActiveButton(activeButton === 'ABB' ? '' : 'ABB');

    };
    const toggleSidebarEGO = () => {
        setIsSidebarOpenEGO(!isSidebarOpenEGO);
        setIsSidebarOpenABB(false); // Diğer sidebar'lar kapanır
        setIsSidebarOpenASKI(false);
        setIsSidebarOpenISTIRAK(false);
        setActiveButton(activeButton === 'EGO' ? '' : 'EGO');
    };
    const toggleSidebarASKI = () => {
        setIsSidebarOpenASKI(!isSidebarOpenASKI);   
        setIsSidebarOpenABB(false); // Diğer sidebar'lar kapanır
        setIsSidebarOpenEGO(false);
        setIsSidebarOpenISTIRAK(false);
        setActiveButton(activeButton === 'ASKI' ? '' : 'ASKI');
    };
    const toggleSidebarISTIRAK = () => {
        setIsSidebarOpenISTIRAK(!isSidebarOpenISTIRAK);
        setIsSidebarOpenABB(false); // Diğer sidebar'lar kapanır
        setIsSidebarOpenEGO(false);
        setIsSidebarOpenASKI(false);
        setActiveButton(activeButton === 'ISTIRAK' ? '' : 'ISTIRAK');
    };

    const [isHalkEkmekOpen, setIsHalkEkmekOpen] = useState(false);
    const halkEkmekWindowRef = useRef(null);
    const openPatiDostuWindow = () => {
        setIsSidebarOpenGENEL(false);
      props.windowManager.ShowWindow("patidostu-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
      
    };
    const openKadinlarLokaliWindow = () => {
        setIsSidebarOpenGENEL(false);
      props.windowManager.ShowWindow("kadinlarlokali-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
      
    };
    const openKadinlarDanismamaWindow = () => {
        setIsSidebarOpenGENEL(false);
      props.windowManager.ShowWindow("kadindanisma-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
      
    };
    const openTeknolojiMerkeziWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("teknolojimerkezi-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAileYasamMerkezleriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("aileyasammerkezleri-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAnfaBitkiEviWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("anfabitkievi-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openKafelerWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("anfakafeler-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openOtoparkWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("anfaotopark-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAskiAtikSuTesisleriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("askiatiksutesisleri-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAskiBarajWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("askibaraj-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAskiBolgeMudurlukleriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("askibolgemudurlukler-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAskiKartDolumOdemeWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("askikartdolumodeme-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openAskiSuMatikindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("askisumatik-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };

    const openAskiTahsilatSubeWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("askitahsilatsube-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openBaskentMarketWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("baskentmarket-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openBelkoMeyveSuyuSatisBufeleriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("belkomeyvesuyusatisbufeleri-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openBelmekBeltekWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("belmekbeltek-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openCocukEtkinlikMerkezleriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("cocuketkinlikmerkezleri-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEgoAnkarayDuraklarWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egoankarayduraklar-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEgoBaskentayDuraklarWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egobaskentrayduraklar-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEgoElektrikliBisikletİstasyonlariWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egoelektriklibisikletistasyonlari-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEgoKartDolumNoktalariiWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egokartdolumnoktalari-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };

    const openEgoSatisNoktalariiWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egokartsatisnoktalari-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEgoMetroDuraklriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egometroduraklar-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEgoOtobusDuraklriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egootobusduraklar-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };

    const openEgoTeleferikDuraklriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("egoteleferikduraklari-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEngelliBireylerWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("engellibirey-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openEngelliCocuklarWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("engellicocuk-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openGazilerMerkeziWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("gazilermerkezi-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openHalkEkmekWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("halkekmek-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openParkWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("park-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openPortasAsfaltUretimWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("portasasfalturetim-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openSegmenSuFabrikasiWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("segmensufabrikasi-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openSegmenSuSatisBayileriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("segmensusatisbayileri-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openSosyalHizmetlerWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("sosyalhizmetler-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openSporTesisleriWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("sportesisleri-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openWifiNoktalariWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("wifinoktalari-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openYasliDostuWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("yaslidostu-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
    const openKutuphanelerWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("kutuphaneler-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };

    const openKulturSanatWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("culture-query-window"); // ShowWindow fonksiyonu props üzerinden çağrılıyor
    };
  
    const [query, setQuery] = useState("");
    // Input değiştiğinde çağrılacak fonksiyon

    const setQueryField = (_field, _value) => {
        setQuery(query => {
            const newQuery = { ...query, [_field]: _value };
          
            return newQuery;
        });
    };
 
    const openGenelAramaWindow = () => {
        setIsSidebarOpenGENEL(false); 
         props.windowManager.ShowWindow("genelarama-query-window", query);
    };

    const [LayerGroups, setLayerGroups] = useState(null);
    
const getSymbolBasedOnZoom = (zoomLevel, windowLogoicon) => {
    if (zoomLevel <= 10) {
        return {
            type: "picture-marker",
            url: windowLogoicon,
            width: "25px",
            height: "30px"
        };
    } else {
        return {
            type: "picture-marker",
            url: windowLogoicon,
            width: "25px",
            height: "30px"
        };
    }
};

const layers = [
    { url: "YeniYasliDostuQueryUrl", icon: "images/icons/map/ABB/yaslidostuuygulamalar.svg" },
    { url: "YeniSosyalHizmetlerQueryUrl", icon: "images/icons/map/ABB/sosyalhizmetler.svg" },
    { url: "YeniTeknolojiMerkezleriQueryUrl", icon: "images/icons/map/ABB/teknolojimerkezleri.svg" },
    { url: "YeniPatiDostuQeryUrl", icon: "images/icons/map/ABB/patidostuuygulamalar.svg" },
    { url: "YeniBelmekBeltekQeryUrl", icon: "images/icons/map/ABB/belmek.svg" },
    { url: "YeniKadinDanismaQueryUrl", icon: "images/icons/map/ABB/kadindayanismamerkezi.svg" },
    { url: "YeniKadinlarLokaliQeryUrl", icon: "images/icons/map/ABB/kadinlarlokali.svg" },
    { url: "YeniAileYasamMerkezleriQeryUrl", icon: "images/icons/map/ABB/aileyasammerkezi.svg" },
    { url: "YeniCocukEtkinlikMerkezleriQeryUrl", icon: "images/icons/map/ABB/cocuketkinlikmerkezleri.svg" },
    { url: "YeniEngelliCocukQueryUrl", icon: "images/icons/map/ABB/engelsizkres.svg" },
    { url: "YeniEngelliBireyQeryUrl", icon: "images/icons/map/ABB/engelsizyasam.svg" },
    { url: "YeniSporTesisleriQeryUrl", icon: "images/icons/map/ABB/esportesisleri.svg" },
    { url: "YeniGazilerMerkeziQeyUrl", icon: "images/icons/map/ABB/gazimerkezleri.svg" },
    { url: "YeniKültürSanatQueryUrl", icon: "images/icons/map/ABB/kultursanat.svg" },
    { url: "YeniKutuphanelerQueryUrl", icon: "images/icons/map/ABB/kutuphane.svg" },
    { url: "YeniParklarQeryUrl", icon: "images/icons/map/ABB/parklar.svg" },
    { url: "YeniWifiNoktalariQeryUrl", icon: "images/icons/map/ABB/wifierisimnoktalari.svg" }

];

const fetchQueryResults = () => {
    if (!mapView) return; // mapView yoksa çık
    mapView.map.removeAll();
    const layerPromises = layers.map(layer => {
        const initialSymbol = getSymbolBasedOnZoom(mapView.zoom, layer.icon);
        return CommonBusiness.Clustering.CreateLayerWithoutClustering(layer.url, props.windowTitle, query, initialSymbol)
            .then((_clusterLayer) => {
                return _clusterLayer.layerObj; // Katman objesini döndür
            });
    });

  

    // Promise.all ile tüm katmanlar tamamlandığında haritaya ekleyelim
    Promise.all(layerPromises).then((layerObjects) => {
        layerObjects.forEach(layerObj => {
            mapView.map.add(layerObj);
        });
    });
};



 

return (
    <>
      {isSidebarOpenGENEL && ( 
      <div className="sidebar-container" >
        
      <div className="ns-sidebar-header">
      <div 
       className={`ns-btnABB ${activeButton === 'ABB' ? 'active' : ''}`}
        onClick={toggleSidebarABB}
      >
        <img 
          src={activeButton  ? "../images/abbbuton.svg" : "../images/abbbuton.svg"} 
          alt="ABB Logo" 
        />
      </div>
      <div 
       className={`ns-btnEGO ${activeButton === 'EGO' ? 'active' : ''}`}
        onClick={toggleSidebarEGO}
      >
        <img 
          src={activeButton  ? "../images/egobuton.svg" : "../images/egobuton.svg"} 
          alt="EGO Logo" 
        />
      </div>
      <div 
       className={`ns-btnASKI ${activeButton === 'ASKI' ? 'active' : ''}`}
        onClick={toggleSidebarASKI}
      >
        <img 
          src={activeButton  ? "../images/askibuton.svg" : "../images/askibuton.svg"} 
          alt="ASKİ Logo" 
        />
      </div>
      <div 
        className={`ns-btnISTIRAK ${activeButton === 'ISTIRAK' ? 'active' : ''}`}
        onClick={toggleSidebarISTIRAK}
      >
        <img 
          src={activeButton  ? "../images/istiraklerbuton.svg" : "../images/istiraklerbuton.svg"} 
          alt="İstirak Logo" 
        />
      </div>

   
</div>

    
        {isSidebarOpenABB && (
          <div className="ns-sidebar-container"  >     
  
             <div className="ns-card brd"  onClick={openKadinlarDanismamaWindow}>
              <img src="../images/Sidebar/ABB/kadindanismamerkezleri.png" />
              <span>Kadın Danışma Merkezleri</span>
            </div>
            <div className="ns-card kl" onClick={openKadinlarLokaliWindow}> 
                <img src="../images/Sidebar/ABB/kadinlarlokali.png" />
                <span>Kadınlar Lokali</span>
            </div>
            <div className="ns-card sarı"  onClick={openPatiDostuWindow}> 
                <img src="../images/Sidebar/ABB/patidostu.png" />
                <span>Pati Dostu Uygulamalar</span>
            </div>
            <div className="ns-card etu"  onClick={openTeknolojiMerkeziWindow}> 
                <img src="../images/Sidebar/ABB/esporteknoloji.png" />
                <span>Teknoloji Merkezleri</span>
            </div>
            <div className="ns-card mor" onClick={openSosyalHizmetlerWindow}> 
                <img src="../images/Sidebar/ABB/sosyaltesisler.png"   />
                <span>Sosyal Hizmetler</span>
            </div>
            <div className="ns-card brd" onClick={openYasliDostuWindow}> 
                <img src="../images/Sidebar/ABB/yaslıdostumekanlar.png"  />
                <span>Yaşlı Dostu Uygulamalar</span>
            </div>
            <div className="ns-card yesil"  onClick={openEngelliCocuklarWindow}> 
                <img src="../images/Sidebar/ABB/engellicocuklar.png"/>
                <span>Engelli Çocuklar</span>
            </div>
            <div className="ns-card krmz" onClick={openEngelliBireylerWindow}> 
                <img src="../images/Sidebar/ABB/engellibireyler.png"  />
                <span>Engelli Bireyler</span>
            </div>
            <div className="ns-card mor"  onClick={openKulturSanatWindow}> 
                <img src="../images/Sidebar/ABB/kulturvesanat.png"/>
                <span>Kültür ve Sanat</span>
            </div>
            <div className="ns-card sarı" onClick={openCocukEtkinlikMerkezleriWindow}> 
                <img src="../images/Sidebar/ABB/cocukmerkezleri.png"  />
                <span>Çocuk Etkinlik Merkezleri</span>
            </div>
            <div className="ns-card mor" onClick={openSporTesisleriWindow}> 
                <img src="../images/Sidebar/ABB/esportesisleri.png" />
                <span>Spor Tesisleri</span>
            </div>
            <div className="ns-card yesil" onClick={openParkWindow}> 
                <img src="../images/Sidebar/ABB/park.png"  />
                <span>Parklar</span>
            </div>
            <div className="ns-card sarı"  onClick={openAileYasamMerkezleriWindow}> 
                <img src="../images/Sidebar/ABB/aileyasamgenclikmerkezi.png"/>
                <span>Aile Yaşam Merkezleri</span>
            </div>
            <div className="ns-card k-mavi"  onClick={openWifiNoktalariWindow}> 
                <img src="../images/Sidebar/ABB/wifi.png"  />
                <span>Wİ-Fİ Noktaları</span>
            </div>
            <div className="ns-card mavi"  onClick={openGazilerMerkeziWindow}> 
                <img src="../images/Sidebar/ABB/gazimerkezleri.png"/>
                <span>Gazi Merkezleri</span>
            </div>
            <div className="ns-card mavi" onClick={openKutuphanelerWindow}> 
                <img src="../images/Sidebar/ABB/kutuphaneler.png" />
                <span>Kütüphaneler</span>
            </div>
            <div className="ns-card krmz" onClick={openBelmekBeltekWindow}> 
                <img src="../images/Sidebar/ABB/belmek.png" />
                <span>Belmek-Beltek</span>
            </div>
      
          </div>
        )}
    {isSidebarOpenEGO && (
          <div className="ns-sidebar-container">
                          <div className="ns-card yesil" onClick={openEgoSatisNoktalariiWindow} > 
                <img src="../images/Sidebar/EGO/egokartsatis.png"  />
                <span>EGO - Kart Satış Noktaları</span>
            </div>
            <div className="ns-card krmz" onClick={openEgoKartDolumNoktalariiWindow}> 
                <img src="../images/Sidebar/EGO/egokartdolum.png" />
                <span>EGO - Kart Dolum Noktaları</span>
            </div>
            <div className="ns-card mor" onClick={openEgoElektrikliBisikletİstasyonlariWindow}> 
                <img src="../images/Sidebar/EGO/elektriklibisikletistasyonlari.png" />
                <span>Elektrikli Bisiklet İstasyonları</span>
            </div>
            <div className="ns-card k-mavi" onClick={openEgoOtobusDuraklriWindow}> 
                <img src="../images/Sidebar/EGO/otobusduraklari.png"  />
                <span>Otobüs Durakları</span>
            </div>
            <div className="ns-card k-yesil" onClick={openEgoAnkarayDuraklarWindow}> 
                <img src="../images/Sidebar/EGO/ankaray.png"  />
                <span>Ankaray</span>
            </div>
            <div className="ns-card sarı" onClick={openEgoTeleferikDuraklriWindow}> 
                <img src="../images/Sidebar/EGO/teleferik.png"   />
                <span>Teleferik</span>
            </div>
            <div className="ns-card k-mavi" onClick={openEgoBaskentayDuraklarWindow}> 
                <img src="../images/Sidebar/EGO/baskentray.png"  />
                <span>Başkentray</span>
            </div>
            <div className="ns-card krmz" onClick={openEgoMetroDuraklriWindow}> 
                <img src="../images/Sidebar/EGO/metro.png"  />
                <span>Metro Hattı</span>
            </div>
          </div>
        )}
          
          {isSidebarOpenASKI && (
          <div className="ns-sidebar-container">
                <div className="ns-card k-yesil" onClick={openAskiBolgeMudurlukleriWindow}> 
                <img src="../images/Sidebar/ASKI/askibolgemudurlukleri.png"  />
                <span>Bölge Müdürlükleri</span>
            </div>
            <div className="ns-card krmz" onClick={openAskiAtikSuTesisleriWindow}> 
                <img src="../images/Sidebar/ASKI/askiatiksutesisleri.png" />
                <span>ASKİ Atık Su Tesisleri</span>
            </div>
            <div className="ns-card mavi" onClick={openAskiBarajWindow}> 
                <img src="../images/Sidebar/ASKI/askibaraj.png" />
                <span>Barajlar</span>
            </div>
            <div className="ns-card sarı" onClick={openAskiTahsilatSubeWindow}> 
                <img src="../images/Sidebar/ASKI/askitahsilatsube.png" />
                <span>Tahsilat Şubeleri</span>
            </div>
            <div className="ns-card mor" onClick={openAskiSuMatikindow}> 
                <img src="../images/Sidebar/ASKI/askisumatik.png" />
                <span>Sumatik</span>
            </div>
            <div className="ns-card k-mavi" onClick={openAskiKartDolumOdemeWindow}> 
                <img src="../images/Sidebar/ASKI/askikartdolum.png" />
                <span>ASKİ - Kart Dolum Noktaları</span>
            </div>
          </div>
        
        )}
        {isSidebarOpenISTIRAK && (
          <div className="ns-sidebar-container">
            <div className="ns-card k-mavi" onClick={openOtoparkWindow}> 
                <img src="../images/Sidebar/ISTIRAK/anfaotopark.png" />
                <span>ANFA - Otopark</span>
            </div>
            <div className="ns-card brd" onClick={openKafelerWindow}> 
                <img src="../images/Sidebar/ISTIRAK/anfakafeler.png"  />
                <span>ANFA - Kafeler</span>
            </div>
            <div className="ns-card yesil" onClick={openAnfaBitkiEviWindow}> 
                <img src="../images/Sidebar/ISTIRAK/anfabitkievi.png" />
                <span>ANFA - Bitki Evi</span>
            </div>
            <div className="ns-card sarı"  onClick={openBelkoMeyveSuyuSatisBufeleriWindow}> 
                <img src="../images/Sidebar/ISTIRAK/belkomeyvesuyusatis.png"/>
                <span>Belko Meyve Suyu Satış</span>
            </div>
            <div className="ns-card k-mavi" onClick={openPortasAsfaltUretimWindow}> 
                <img src="../images/Sidebar/ISTIRAK/portasasfalturetim.png"  />
                <span>Portaş Asfalt Üretim</span>
            </div>
            <div className="ns-card yesil" onClick={openSegmenSuSatisBayileriWindow}> 
                <img src="../images/Sidebar/ISTIRAK/segmensusatisnoktalari.png"   />
                <span>Seğmen Su Satış Noktaları</span>
            </div>
            <div className="ns-card brd" onClick={openSegmenSuFabrikasiWindow}> 
                <img src="../images/Sidebar/ISTIRAK/segmensufabrikalari.png"  />
                <span>Seğmen Su Fabrikaları</span>
            </div>
            <div className="ns-card yesil" onClick={openBaskentMarketWindow}> 
                <img src="../images/Sidebar/ISTIRAK/baskentmarket.png" />
                <span>Başkent Market</span>
            </div>
            <div className="ns-card krmz" onClick={openHalkEkmekWindow}> 
                <img src="../images/Sidebar/ISTIRAK/halkekmek.png"  />
                <span>Halk Ekmek Satış Noktaları </span>
            </div>
          </div>
        )}
      </div>
        )}
    </>
  );
});