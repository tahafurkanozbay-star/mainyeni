import React, { useEffect, useMemo, useRef, useState } from "react";
import "./experience-ui.css";
import { useExperienceTheme } from "./ExperienceDesignSystem";
import { LayerListWidget } from "../Widget/LayerList/LayerListWidget";

const ActionIcon = ({ type, size = 18 }) => {
    const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
    switch (type) {
        case "sun": return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></svg>;
        case "moon": return <svg {...common}><path d="M20.5 15.6A8.5 8.5 0 0 1 8.4 3.5 8.5 8.5 0 1 0 20.5 15.6Z" /></svg>;
        case "keyboard": return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h1M11 9h1M15 9h1M7 13h5M15 13h2" /></svg>;
        case "search": return <svg {...common}><circle cx="10.8" cy="10.8" r="6.6" /><path d="m16 16 4.2 4.2" /></svg>;
        case "layers": return <svg {...common}><path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" /><path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" /></svg>;
        case "legend": return <svg {...common}><path d="M4 5h16M4 12h10M4 19h7" /><circle cx="18" cy="12" r="2" /><circle cx="15" cy="19" r="2" /></svg>;
        case "info": return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 10v6M12 7h.01" /></svg>;
        default: return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
    }
};

const dispatchCommand = (name, detail = {}) => {
    try { window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name, ...detail } })); } catch (_) { /* optional enhancement */ }
};

export function ExperienceUXLayer({ windowManager }) {
    const { theme, toggleTheme } = useExperienceTheme();
    const [helpOpen, setHelpOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const closeButtonRef = useRef(null);
    const layerListRef = useRef(null);

    useEffect(() => {
        document.documentElement.dataset.experienceTheme = theme;
        try { window.localStorage.setItem("kent-rehberi-experience-theme", theme); } catch (_) { /* storage unavailable */ }
    }, [theme]);

    useEffect(() => {
        const onCommand = event => {
            const name = event?.detail?.name;
            if (name === "help") setHelpOpen(true);
            if ((name === "layers" || name === "legend") && layerListRef.current?.OnShow) layerListRef.current.OnShow(name === "legend" ? "legend" : "layers");
            if (name === "search" && windowManager?.ShowWindow) windowManager.ShowWindow("genelarama-query-window");
        };
        window.addEventListener("kentrehberi:command", onCommand);
        return () => window.removeEventListener("kentrehberi:command", onCommand);
    }, [windowManager]);

    useEffect(() => {
        const onKeyDown = event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); dispatchCommand("command-palette"); }
            if (event.key === "?" && !event.altKey && !event.ctrlKey && !event.metaKey) {
                const tag = event.target?.tagName;
                if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) { event.preventDefault(); setHelpOpen(true); }
            }
            if (event.key === "Escape") setHelpOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    useEffect(() => { if (helpOpen) requestAnimationFrame(() => closeButtonRef.current?.focus()); }, [helpOpen]);
    const themeLabel = useMemo(() => theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç", [theme]);

    return (
        <>
            <aside className={`experience-utility ${collapsed ? "is-collapsed" : ""}`} aria-label="Kent Rehberi yardımcı araçları">
                <div className="experience-utility__brand"><span className="experience-utility__status" aria-hidden="true" />{!collapsed && <span>Çalışma alanı</span>}</div>
                <nav className="experience-utility__actions" aria-label="Hızlı araçlar">
                    <button className="experience-utility__button" type="button" onClick={() => dispatchCommand("search")} aria-label="Genel aramayı aç" title="Genel arama"><ActionIcon type="search" />{!collapsed && <span>Arama</span>}</button>
                    <button className="experience-utility__button" type="button" onClick={() => dispatchCommand("layers")} aria-label="Katman yönetimini aç" title="Katmanlar"><ActionIcon type="layers" />{!collapsed && <span>Katmanlar</span>}</button>
                    <button className="experience-utility__button" type="button" onClick={() => dispatchCommand("legend")} aria-label="Lejandı aç" title="Lejand"><ActionIcon type="legend" />{!collapsed && <span>Lejand</span>}</button>
                    <button className="experience-utility__button" type="button" onClick={() => setHelpOpen(true)} aria-label="Kısayolları ve yardım bilgisini aç" title="Kısayollar"><ActionIcon type="keyboard" />{!collapsed && <span>Kısayollar</span>}</button>
                    <button className="experience-utility__button" type="button" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}><ActionIcon type={theme === "dark" ? "sun" : "moon"} />{!collapsed && <span>{theme === "dark" ? "Açık tema" : "Koyu tema"}</span>}</button>
                </nav>
                <button className="experience-utility__collapse" type="button" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed} aria-label={collapsed ? "Yardımcı araçları genişlet" : "Yardımcı araçları daralt"} title={collapsed ? "Genişlet" : "Daralt"}><span aria-hidden="true">{collapsed ? "›" : "‹"}</span></button>
            </aside>
            <LayerListWidget id="layerlist-widget" windowManager={windowManager} ref={layerListRef} />
            {helpOpen && (
                <div className="experience-help-backdrop" role="presentation" onMouseDown={() => setHelpOpen(false)}>
                    <section className="experience-help" role="dialog" aria-modal="true" aria-labelledby="experience-help-title" aria-describedby="experience-help-description" onMouseDown={event => event.stopPropagation()}>
                        <header className="experience-help__header"><div><span className="experience-eyebrow">KENT REHBERİ</span><h2 id="experience-help-title">Hızlı kullanım</h2><p id="experience-help-description">Harita ve veri araçlarına klavye ile hızlı erişin.</p></div><button ref={closeButtonRef} className="experience-close" type="button" onClick={() => setHelpOpen(false)} aria-label="Yardım penceresini kapat">×</button></header>
                        <div className="experience-help__grid">
                            <div className="experience-shortcut"><span>Komut merkezi</span><kbd>Ctrl</kbd><b>+</b><kbd>K</kbd></div>
                            <div className="experience-shortcut"><span>Yardım</span><kbd>?</kbd></div>
                            <div className="experience-shortcut"><span>Pencereyi kapat</span><kbd>Esc</kbd></div>
                            <button className="experience-shortcut experience-shortcut--action" type="button" onClick={() => { setHelpOpen(false); dispatchCommand("layers"); }}><span>Katmanlar</span><strong>Aç</strong></button>
                            <button className="experience-shortcut experience-shortcut--action" type="button" onClick={() => { setHelpOpen(false); dispatchCommand("legend"); }}><span>Lejand</span><strong>Aç</strong></button>
                            <button className="experience-shortcut experience-shortcut--action" type="button" onClick={toggleTheme}><span>Tema</span><strong>{theme === "dark" ? "Açık" : "Koyu"}</strong></button>
                        </div>
                        <footer className="experience-help__footer"><ActionIcon type="info" size={16} /><span>Mevcut GIS sorgu, katman ve popup işlevleri korunur; bu yüzey yalnızca keşif, erişilebilirlik ve hızlı erişim sağlar.</span></footer>
                    </section>
                </div>
            )}
        </>
    );
}

export default ExperienceUXLayer;
