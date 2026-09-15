import React, { useEffect, useState } from "react";
import Store from "../../Store/Store";
import { DatetimeHelper } from "../../Toolbox/DatetimeHelper";
import { AppConfig } from "../../Core/AppConfig";
import { LocalStorageHelper } from "../../Toolbox/LocalStorageHelper";
import { Constants_ConfigKeys, Constants_MessageType, Constants_UserMesssages } from "../../Core/Constants";
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
    const [query, setQuery] = useState({ name: "" });

    useEffect(() => {
        const isLight = LocalStorageHelper.Get(Constants_ConfigKeys.THEME_CHOICE) ?? false;
        switchTheme(isLight);
    }, []);

    const switchTheme = (_isLight) => {
        setThemeIsLight(_isLight);
        LocalStorageHelper.Set(Constants_ConfigKeys.THEME_CHOICE, _isLight);
        const head = document.head;
        if (_isLight) {
            const link = document.createElement("link");
            link.type = "text/css";
            link.rel = "stylesheet";
            link.href = "styles.light.css";
            head.appendChild(link);
            setCssLink(link);
        } else if (cssLink) {
            head.removeChild(cssLink);
            setCssLink(null);
        }
    };

    const printMap = () => {
        const mapView = Store.getState().Map.View;
        mapView.takeScreenshot({ width: 1920, height: 1080 }).then(function (screenshot) {
            const html = printHtml(screenshot.dataUrl);
            const pwa = window.open("about:blank", "_new");
            if (!pwa) return;
            pwa.document.open();
            pwa.document.write(html);
            pwa.document.close();
        });
    };

    const printHtml = (imageSrc) => "<html><head><script>function step1(){setTimeout('step2()', 10);}function step2(){window.print();window.close()}\n</script></head><body onload='step1()'><div style='border:1px solid gray;'><div style='font-size:24px;font-family:Arial,\"SegoeUI\";padding:5px;'>" + AppConfig.App.Title1 + " | " + AppConfig.App.Title2 + " (" + DatetimeHelper.GetFormatted(new Date()) + ")</div><div style='border:1px solid gray;padding:0;margin:0;'><img style='width:100%' src='" + imageSrc + "' /></div></div></body></html>";

    const refreshPage = () => window.location.reload();
    const [activeblockstyle, setActiveblockstyle] = useState(null);
    const setActiveWindow = (_windowid) => {
        props.windowManager.ShowWindow(_windowid);
        if (_windowid === "cityblockparcel-query-window") setActiveblockstyle({ display: "block", left: "210px" });
        else if (_windowid === "numbering-query-window") setActiveblockstyle({ display: "block", left: "75px" });
        else setActiveblockstyle(null);
    };

    const getUserLocation = () => {
        const mapConfig = MapManager.GetMapConfiguration();
        let location = { x: mapConfig.Centerx ?? 32.80409955978453, y: mapConfig.Centery ?? 39.94494728389463 };
        if (!navigator.geolocation) {
            props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
            createLocation(location);
            return;
        }
        props.windowManager.ShowMessage(Constants_MessageType.Success, Constants_UserMesssages.LOCATION_ALLOWED);
        navigator.geolocation.getCurrentPosition((_location) => {
            location = { x: _location.coords.longitude, y: _location.coords.latitude };
            createLocation(location);
        }, () => {
            props.windowManager.ShowMessage(Constants_MessageType.Error, Constants_UserMesssages.LOCATION_REJECTED);
            createLocation(location);
        });
    };

    const createLocation = (_location) => {
        GisGraphicsHelper.CreatePoint(_location).then((_point) => {
            const mapView = MapManager.GetMapView();
            GisGraphicsHelper.CreateGraphicFromGeometry(_point, null).then((_graphic) => {
                MapManager.AddGraphics(_graphic, true);
                GisGraphicsHelper.ZoomToGeometry(mapView, _point, 15);
            });
        });
    };

    const openReportWindow = () => {
        LoggingBusiness.CreateClientLog("Rapor Sorgu", "");
        window.open("https://cbs.ankara.bel.tr/portal/apps/dashboards/ec8cb7663d5942d49625a7660bd0570c", "_blank");
    };

    const [isSidebarOpenGENEL, setIsSidebarOpenGENEL] = useState(true);
    const openGenelAramaWindow = () => {
        setIsSidebarOpenGENEL(false);
        props.windowManager.ShowWindow("genelarama-query-window", query);
    };

    return (
        <header className="mainbar-container" role="banner" aria-label="Kent Rehberi üst gezinme">
            <div className="row h-100">
                <div className="col-12 h-100">
                    <div className="mainbar">
                        <div className="mainbar-logo">
                            <a href="https://www.ankara.bel.tr/" target="_blank" rel="noopener noreferrer" aria-label="Ankara Büyükşehir Belediyesi ana sayfası">
                                <img src="images/abblogo.svg" alt="Ankara Büyükşehir Belediyesi Logosu" title={`v${AppConfig.App.Version}`} />
                            </a>
                        </div>
                        <a href="https://kentrehberi.ankara.bel.tr" target="_blank" rel="noopener noreferrer" aria-label="Kent Rehberi ana sayfası">
                            <span className="mainbar-text">KENT REHBERİ</span>
                        </a>
                        <form className="ns-input" role="search" aria-label="Kent Rehberi genel arama" onSubmit={(e) => { e.preventDefault(); openGenelAramaWindow(); }}>
                            <label className="experience-sr-only" htmlFor="kentrehberi-global-search">Adres, yer veya katman ara</label>
                            <div className="ns-input-group">
                                <input id="kentrehberi-global-search" type="search" placeholder="Adres, yer veya katman ara…" value={query.name || ""} onChange={(e) => setQuery({ name: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") { setQuery({ name: "" }); e.currentTarget.blur(); } }} autoComplete="off" />
                                <button type="submit" className="kr-search-submit" aria-label="Aramayı başlat" title="Ara"><span aria-hidden="true">⌕</span></button>
                            </div>
                            <span className="kr-search-hint" aria-hidden="true"><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></span>
                        </form>
                        <div className="mainbar-right" aria-label="Üst menü"><CompanyLogo /></div>
                    </div>
                </div>
            </div>
            <div className="experience-sr-only" aria-live="polite">{themeIsLight ? "Açık tema" : "Kurumsal tema"} etkin.</div>
        </header>
    );
}

export default NavigationBar;
