import React, { useEffect, useState } from "react";
import { AppConfig } from "../../Core/AppConfig";
import { Constants_ConfigKeys } from "../../Core/Constants";
import { LocalStorageHelper } from "../../Toolbox/LocalStorageHelper";
import { CompanyLogo } from "./CompanyLogo";
import "./NavigationBar.css";

export function NavigationBar(props) {
    const [query, setQuery] = useState("");

    useEffect(() => {
        const storedTheme = LocalStorageHelper.Get(Constants_ConfigKeys.THEME_CHOICE);
        if (storedTheme == null) return;
        document.documentElement.dataset.experienceTheme = storedTheme ? "light" : "dark";
    }, []);

    const openSearch = () => {
        props.windowManager.ShowWindow("genelarama-query-window", { name: query.trim() });
    };

    const onSearchKeyDown = event => {
        if (event.key === "Enter") {
            event.preventDefault();
            openSearch();
        }
        if (event.key === "Escape") {
            setQuery("");
            event.currentTarget.blur();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name: "command-palette" } }));
        }
    };

    return (
        <header className="mainbar-container" role="banner" aria-label="Kent Rehberi üst gezinme">
            <div className="row h-100">
                <div className="col-12 h-100">
                    <div className="mainbar">
                        <div className="mainbar-logo">
                            <a href="https://www.ankara.bel.tr/" target="_blank" rel="noopener noreferrer" aria-label="Ankara Büyükşehir Belediyesi ana sayfası">
                                <img src="images/abblogo.svg" alt="Ankara Büyükşehir Belediyesi" title={`v${AppConfig.App.Version}`} />
                            </a>
                        </div>
                        <a href="https://kentrehberi.ankara.bel.tr" target="_blank" rel="noopener noreferrer" aria-label="Kent Rehberi ana sayfası">
                            <span className="mainbar-text">KENT REHBERİ</span>
                        </a>
                        <form className="ns-input" role="search" onSubmit={event => { event.preventDefault(); openSearch(); }}>
                            <label className="experience-sr-only" htmlFor="kentrehberi-global-search">Kent Rehberi genel arama</label>
                            <div className="ns-input-group">
                                <input id="kentrehberi-global-search" type="search" placeholder="Adres, yer veya katman ara…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onSearchKeyDown} autoComplete="off" />
                                <button type="submit" className="kr-search-submit" aria-label="Aramayı başlat" title="Ara"><span aria-hidden="true">⌕</span></button>
                            </div>
                            <span className="kr-search-hint" aria-hidden="true"><kbd>Ctrl</kbd><span>+</span><kbd>K</kbd></span>
                        </form>
                        <div className="mainbar-right" aria-label="Üst menü">
                            <button type="button" className="kr-header-shortcut" onClick={() => window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name: "command-palette" } }))} aria-label="Komut merkezini aç" title="Komut merkezi (Ctrl K)">⌘K</button>
                            <CompanyLogo />
                        </div>
                    </div>
                </div>
            </div>
        </header>
    );
}

export default NavigationBar;
