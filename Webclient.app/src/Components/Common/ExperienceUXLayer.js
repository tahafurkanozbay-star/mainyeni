import React, { useEffect, useMemo, useState } from "react";
import "./experience-ui.css";

const STORAGE_KEY = "kent-rehberi-experience-theme";

const getInitialTheme = () => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === "light" || stored === "dark") return stored;
        return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (_) {
        return "light";
    }
};

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
    try {
        window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name, ...detail } }));
    } catch (_) {
        // Optional command bridge; application remains functional if unavailable.
    }
};

export function ExperienceUXLayer() {
    const [theme, setTheme] = useState(getInitialTheme);
    const [helpOpen, setHelpOpen] = useState(false);
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        document.documentElement.dataset.experienceTheme = theme;
        try {
            window.localStorage.setItem(STORAGE_KEY, theme);
        } catch (_) {
            // Storage can be unavailable in restricted browser contexts.
        }
    }, [theme]);

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key === "Escape") setHelpOpen(false);
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                dispatchCommand("command-palette");
            }
            if (event.key === "?") setHelpOpen(true);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const themeLabel = useMemo(() => theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç", [theme]);

    return (
        <>
            <aside className={`experience-utility ${collapsed ? "is-collapsed" : ""}`} aria-label="Kent Rehberi yardımcı araçları">
                <div className="experience-utility__brand" aria-hidden={collapsed}>
                    <span className="experience-utility__status" aria-hidden="true" />
                    {!collapsed && <span>Çalışma alanı</span>}
                </div>
                <div className="experience-utility__actions">
                    <button className="experience-utility__button" type="button" onClick={() => dispatchCommand("search")} aria-label="Aramayı aç" title="Arama">
                        <ActionIcon type="search" />{!collapsed && <span>Arama</span>}
                    </button>
                    <button className="experience-utility__button" type="button" onClick={() => dispatchCommand("layers")} aria-label="Katmanlar panelini aç" title="Katmanlar">
                        <ActionIcon type="layers" />{!collapsed && <span>Katmanlar</span>}
                    </button>
                    <button className="experience-utility__button" type="button" onClick={() => dispatchCommand("legend")} aria-label="Lejandı aç" title="Lejand">
                        <ActionIcon type="legend" />{!collapsed && <span>Lejand</span>}
                    </button>
                    <button className="experience-utility__button" type="button" onClick={() => setHelpOpen(true)} aria-label="Klavye kısayollarını aç" title="Kısayollar">
                        <ActionIcon type="keyboard" />{!collapsed && <span>Kısayollar</span>}
                    </button>
                    <button className="experience-utility__button" type="button" onClick={() => setTheme(value => value === "dark" ? "light" : "dark")} aria-label={themeLabel} title={themeLabel}>
                        <ActionIcon type={theme === "dark" ? "sun" : "moon"} />{!collapsed && <span>{theme === "dark" ? "Açık tema" : "Koyu tema"}</span>}
                    </button>
                </div>
                <button className="experience-utility__collapse" type="button" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed} aria-label={collapsed ? "Yardımcı araçları genişlet" : "Yardımcı araçları daralt"} title={collapsed ? "Genişlet" : "Daralt"}>
                    <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
                </button>
            </aside>

            {helpOpen && (
                <div className="experience-help-backdrop" role="presentation" onMouseDown={() => setHelpOpen(false)}>
                    <section className="experience-help" role="dialog" aria-modal="true" aria-labelledby="experience-help-title" onMouseDown={(event) => event.stopPropagation()}>
                        <header className="experience-help__header">
                            <div>
                                <span className="experience-eyebrow">KENT REHBERİ</span>
                                <h2 id="experience-help-title">Hızlı kullanım</h2>
                                <p>Harita üzerinde daha hızlı çalışmak için temel kısayollar.</p>
                            </div>
                            <button className="experience-close" type="button" onClick={() => setHelpOpen(false)} aria-label="Kısayollar penceresini kapat">×</button>
                        </header>
                        <div className="experience-help__grid">
                            <div className="experience-shortcut"><span>Arama</span><kbd>Ctrl</kbd><b>+</b><kbd>K</kbd></div>
                            <div className="experience-shortcut"><span>Yardım</span><kbd>?</kbd></div>
                            <div className="experience-shortcut"><span>Pencereyi kapat</span><kbd>Esc</kbd></div>
                            <div className="experience-shortcut"><span>Katmanlar</span><button type="button" onClick={() => { setHelpOpen(false); dispatchCommand("layers"); }}>Aç</button></div>
                            <div className="experience-shortcut"><span>Lejand</span><button type="button" onClick={() => { setHelpOpen(false); dispatchCommand("legend"); }}>Aç</button></div>
                            <div className="experience-shortcut"><span>Tema</span><button type="button" onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}>{theme === "dark" ? "Açık" : "Koyu"}</button></div>
                        </div>
                        <footer className="experience-help__footer">
                            <ActionIcon type="info" size={16} />
                            <span>Harita araçları ve sorgu pencereleri mevcut işlevlerini korur; bu yüzey hızlı erişim ve erişilebilirlik için eklenmiştir.</span>
                        </footer>
                    </section>
                </div>
            )}
        </>
    );
}

export default ExperienceUXLayer;
