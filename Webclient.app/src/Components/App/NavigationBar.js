import React, { useEffect, useState } from "react";
import Store from "../../Store/Store";
import { DatetimeHelper } from "../../Toolbox/DatetimeHelper";
import { AppConfig } from "../../Core/AppConfig";
import { LocalStorageHelper } from "../../Toolbox/LocalStorageHelper";
import { Constants_ConfigKeys, Constants_MessageType, Constants_UserMesssages } from "../../Core/Constants";
import { BiAbacus, BiEnvelope, BiTargetLock } from "react-icons/bi";
import { Button } from "react-bootstrap";
import { MessageBar } from "../Common/MessageBar";
import "./NavigationBar.css";
import { CircleLoading } from "../Common/Loading";
import { FulltextSearchQuery } from "../Query/FulltextSearchQuery/FulltextSearchQuery";
import { LoggingBusiness } from "../../Business/LoggingBusiness";
import MapManager from "../../Store/Managers/MapManager";
import { GisGraphicsHelper } from "../../Toolbox/GisGraphicsHelper";
import { CompanyLogo } from "./CompanyLogo";

export function NavigationBar(props) {

    const [themeIsLight, setThemeIsLight] = useState(false);
    const [cssLink, setCssLink] = useState(null);

    useEffect(() => {

        const isLight = LocalStorageHelper.Get(Constants_ConfigKeys.THEME_CHOICE) ?? false;
        switchTheme(isLight);

    }, []);

    const switchTheme = (_isLight) => {

        setThemeIsLight(_isLight);
        LocalStorageHelper.Set(Constants_ConfigKeys.THEME_CHOICE, _isLight);

        let head = document.head;

        if (_isLight) {

            let link = document.createElement("link");

            link.type = "text/css";
            link.rel = "stylesheet";
            link.href = "styles.light.css";

            head.appendChild(link);

            setCssLink(link);

        }
        else {
            if (cssLink) {
                head.removeChild(cssLink);
                setCssLink(null);
            }
        }
    }


    const printMap = () => {

        let mapView = Store.getState().Map.View;

        mapView.takeScreenshot({
            width: 1920,
            height: 1080
        }).then(function (screenshot) {

            let html = printHtml(screenshot.dataUrl);
            let Pagelink = "about:blank";
            let pwa = window.open(Pagelink, "_new");
            pwa.document.open();
            pwa.document.write(html);
            pwa.document.close();

        });

    }

    const printHtml = (imageSrc) => {


        return "<html><head><script>function step1(){setTimeout('step2()', 10);}" +
            "function step2(){window.print();window.close()}\n" +
            "</script></head><body onload='step1()'>\n" +
            "<div style='border:1px solid gray;'>" +
            "<div style='font-size:24px;font-family:Arial,\"SegoeUI\";padding:5px;'>" + AppConfig.App.Title1 + " | " + AppConfig.App.Title2 + " (" + DatetimeHelper.GetFormatted(new Date()) + ")</div>" +
            "<div style='border:1px solid gray;padding:0;margin:0;'>" +
            "<img style='width:100%' src='" + imageSrc + "' />" +
            "</div>" +
            "</div>" +
            +"</body></html>";
    }


    const refreshPage = (e) => {
        window.location.reload();
    }

    const [activeblockstyle, setActiveblockstyle] = useState(null);
    const setActiveWindow = (_windowid) => {

        props.windowManager.ShowWindow(_windowid);

        if (_windowid == "cityblockparcel-query-window") {
            setActiveblockstyle({
                display: 'block',
                left: '210px'
            });
        }
        else if (_windowid == "numbering-query-window") {
            setActiveblockstyle({
                display: 'block',
                left: '75px'
            });
        }
        else {
            setActiveblockstyle(null);
        }
    }


    const getUserLocation=()=>{
        
        const mapConfig = MapManager.GetMapConfiguration();
        //let location = { x: mapConfig.Centerx, y: mapConfig.Centery }; //TODO: Geçici olarak gölbaşı merkeze ayarlandı değiştirilecek
        let location = { x: 32.80409955978453, y: 39.94494728389463 };

        if (!navigator.geolocation) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
            createLocation(location);
        }
        else{
            props.windowManager.ShowMessage(Constants_MessageType.Success, Constants_UserMesssages.LOCATION_ALLOWED);

            navigator.geolocation.getCurrentPosition((_location) => {

                location = {
                    x: _location.coords.longitude,
                    y: _location.coords.latitude,
                };

                createLocation(location);
                

            }, (error) => {

                props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
                createLocation(location);
            });
        }
    }

    const createLocation = (_location) => {

        GisGraphicsHelper.CreatePoint(_location).then((_point) => {

            const mapView = MapManager.GetMapView();
            GisGraphicsHelper.CreateGraphicFromGeometry(_point, null).then((_graphic) => {
                MapManager.AddGraphics(_graphic, true);
                GisGraphicsHelper.ZoomToGeometry(mapView, _point, 15);
            });
        });
    }



    const openReportWindow = (e) => {

        LoggingBusiness.CreateClientLog("Rapor Sorgu", "");
        const url = "https://cbs.ankara.bel.tr/portal/apps/dashboards/ec8cb7663d5942d49625a7660bd0570c";
        window.open(url, "_blank");

    }
    const [isSidebarOpenGENEL, setIsSidebarOpenGENEL] = useState(true);
    const [query, setQuery] = useState("");
    const openGenelAramaWindow = () => {
        setIsSidebarOpenGENEL(false); 
         props.windowManager.ShowWindow("genelarama-query-window", query);
    };


    return (
        <>
            <div className="mainbar-container">
                <div className="row">

                    <div className="col-12 .mainbar-apptitle">

                        <div className="mainbar">


                        <div className="mainbar-logo">
                                <a href="https://www.ankara.bel.tr/" target="_blank" rel="noopener noreferrer">
                               <img src="images/abblogo.svg" alt="Ankara Büyükşehir Belediyesi Logosu" title={"v" + AppConfig.App.Version} />
                                </a>
                                </div>
                                <a href="https://kentrehberi.ankara.bel.tr" target="_blank" rel="noopener noreferrer">
                                <span className="mainbar-text">KENT REHBERİ</span>
                                </a>
                                <div className="ns-input">
                           <label className="ns-input-group" style={{ marginRight: "10px" }}>
                             <input
                                type="text"
                                placeholder="Ara..."
                                value={query.name}
                                onChange={(e) => setQuery({ name: e.target.value })}
                                onKeyPress={(e) => {
                                       if (e.key === 'Enter') {
                                          openGenelAramaWindow(); // Enter tuşuna basıldığında arama yap
                                          }
                               }}  />
                            <img
                              src="../images/search.svg"
                              alt="search"
                              onClick={openGenelAramaWindow}
                               />
                            </label>
</div>
                        
                            <div className="mainbar-right">
                                <CompanyLogo/> 
                            </div>
                        </div>

                    </div>
                </div>

            </div>

        </>
    );
}