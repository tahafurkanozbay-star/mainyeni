import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExperienceDialog } from "./ExperienceDialog";
import {
    createExperienceBus,
    createPreferenceStore,
    classifyViewport,
    getCommandByName,
    mapModeAnnouncement,
    resolveEffectiveTheme,
    resolvePanelPlacement
} from "../../experience/experienceRuntime";
import {
    activateSkipTarget,
    createLiveRegion,
    getMediaPreferenceSnapshot,
    installMediaPreferenceObserver,
    shouldHandleGlobalShortcut
} from "../../experience/accessibilityRuntime";
import "./experience-workspace.css";

const bus = createExperienceBus();
const preferenceStore = createPreferenceStore({ bus });

function usePreferences() {
    const [preferences, setPreferences] = useState(() => preferenceStore.get());
    useEffect(() => preferenceStore.subscribe(setPreferences), []);
    return [preferences, preferenceStore.set.bind(preferenceStore)];
}

function useViewport() {
    const [viewport, setViewport] = useState(() => classifyViewport(
        typeof window === "undefined" ? 1200 : window.innerWidth
    ));

    useEffect(() => {
        let frame = 0;
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setViewport(classifyViewport(window.innerWidth)));
        };
        window.addEventListener("resize", update, { passive: true });
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("resize", update);
        };
    }, []);

    return viewport;
}

function useConnectivity() {
    const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine !== false);
    useEffect(() => {
        const update = () => setOnline(navigator.onLine !== false);
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
            window.removeEventListener("online", update);
            window.removeEventListener("offline", update);
        };
    }, []);
    return online;
}

function useMediaPreferences() {
    const [media, setMedia] = useState(() => getMediaPreferenceSnapshot());
    useEffect(() => installMediaPreferenceObserver(setMedia), []);
    return media;
}

function useLiveAnnouncements() {
    const regionRef = useRef(null);
    useEffect(() => {
        regionRef.current = createLiveRegion(document.body, {
            id: "experience-global-live-region",
            politeness: "polite"
        });
        const release = bus.on("kentrehberi:announcement", detail => {
            if (!detail?.message) return;
            regionRef.current?.announce(detail.message, detail.politeness || "polite");
        });
        return () => {
            release();
            regionRef.current?.destroy();
            regionRef.current = null;
        };
    }, []);

    return useCallback((message, politeness = "polite") => {
        regionRef.current?.announce(message, politeness);
    }, []);
}

function ExperienceSkipLinks() {
    const focusTarget = useCallback((event, selector) => {
        event.preventDefault();
        const target = document.querySelector(selector);
        if (target instanceof HTMLElement) activateSkipTarget(target);
    }, []);

    return (
        <nav className="experience-skip-links" aria-label="Hızlı atlama bağlantıları">
            <a href="#esri-map-container" onClick={event => focusTarget(event, "#esri-map-container")}>Haritaya geç</a>
            <a href="#sidebar" onClick={event => focusTarget(event, "#sidebar")}>Araç paneline geç</a>
            <a href="#experience-workspace-controls" onClick={event => focusTarget(event, "#experience-workspace-controls")}>Görünüm kontrollerine geç</a>
        </nav>
    );
}

function StatusItem({ label, value, tone = "neutral" }) {
    return (
        <span className={`experience-workspace__status experience-workspace__status--${tone}`}>
            <span className="experience-workspace__status-label">{label}</span>
            <strong>{value}</strong>
        </span>
    );
}

function MapModeControl({ mode, pendingMode, onChange }) {
    const busy = Boolean(pendingMode);
    return (
        <div
            className="experience-map-mode"
            role="group"
            aria-label="Harita görünümü"
            aria-busy={busy ? "true" : undefined}
        >
            {[
                { value: "2d", short: "2B", label: "2 boyutlu harita" },
                { value: "3d", short: "3B", label: "3 boyutlu sahne" }
            ].map(option => {
                const selected = mode === option.value;
                const pending = pendingMode === option.value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        className={`experience-map-mode__button ${selected ? "is-active" : ""}`}
                        aria-pressed={selected}
                        aria-label={`${option.label}${selected ? ", etkin" : ""}`}
                        disabled={busy && !pending}
                        onClick={() => onChange(option.value)}
                    >
                        <span aria-hidden="true">{option.short}</span>
                        <span className="experience-map-mode__long-label">{option.label}</span>
                        {pending && <span className="experience-map-mode__pending" aria-hidden="true" />}
                    </button>
                );
            })}
        </div>
    );
}

function SettingSelect({ id, label, description, value, onChange, children }) {
    return (
        <div className="experience-setting-row">
            <div className="experience-setting-row__copy">
                <label htmlFor={id}>{label}</label>
                {description && <p id={`${id}-description`}>{description}</p>}
            </div>
            <select
                id={id}
                value={value}
                aria-describedby={description ? `${id}-description` : undefined}
                onChange={event => onChange(event.target.value)}
            >
                {children}
            </select>
        </div>
    );
}

function SettingSwitch({ id, label, description, checked, onChange }) {
    return (
        <div className="experience-setting-row">
            <div className="experience-setting-row__copy">
                <label htmlFor={id}>{label}</label>
                {description && <p id={`${id}-description`}>{description}</p>}
            </div>
            <button
                id={id}
                type="button"
                role="switch"
                aria-checked={checked}
                aria-describedby={description ? `${id}-description` : undefined}
                className={`experience-switch ${checked ? "is-on" : ""}`}
                onClick={() => onChange(!checked)}
            >
                <span className="experience-switch__track" aria-hidden="true">
                    <span className="experience-switch__thumb" />
                </span>
                <span className="experience-sr-only">{checked ? "Açık" : "Kapalı"}</span>
            </button>
        </div>
    );
}

function ExperienceSettingsDialog({ open, onClose, preferences, updatePreferences, media, viewport }) {
    const closeRef = useRef(null);
    const effectiveTheme = resolveEffectiveTheme(preferences.theme, media.prefersDark);
    const placement = resolvePanelPlacement(preferences.panelPlacement, viewport);

    return (
        <ExperienceDialog
            open={open}
            onClose={onClose}
            labelledBy="experience-settings-title"
            describedBy="experience-settings-description"
            initialFocusRef={closeRef}
            backdropClassName="experience-settings-backdrop"
            dialogClassName="experience-settings"
            testId="experience-settings"
        >
            <header className="experience-settings__header">
                <div>
                    <span className="experience-eyebrow">DENEYİM AYARLARI</span>
                    <h2 id="experience-settings-title">Çalışma alanını kişiselleştir</h2>
                    <p id="experience-settings-description">
                        Ayarlar bu tarayıcıda saklanır; harita verisini veya sorgu sonuçlarını değiştirmez.
                    </p>
                </div>
                <button ref={closeRef} type="button" className="experience-close" onClick={() => onClose("button")} aria-label="Deneyim ayarlarını kapat">×</button>
            </header>

            <div className="experience-settings__summary" role="status" aria-label="Etkin deneyim özeti">
                <span>Tema <strong>{effectiveTheme === "dark" ? "Koyu" : "Açık"}</strong></span>
                <span>Panel <strong>{placement === "bottom" ? "Alt" : placement === "left" ? "Sol" : "Sağ"}</strong></span>
                <span>Hareket <strong>{preferences.motion === "reduced" || (preferences.motion === "system" && media.reducedMotion) ? "Azaltılmış" : "Standart"}</strong></span>
            </div>

            <div className="experience-settings__body">
                <fieldset className="experience-settings__group">
                    <legend>Görünüm</legend>
                    <SettingSelect
                        id="experience-theme-setting"
                        label="Tema"
                        description="Sistem temasını izleyebilir veya sabit bir tema seçebilirsiniz."
                        value={preferences.theme}
                        onChange={theme => updatePreferences({ theme })}
                    >
                        <option value="system">Sistem</option>
                        <option value="light">Açık</option>
                        <option value="dark">Koyu</option>
                    </SettingSelect>
                    <SettingSelect
                        id="experience-density-setting"
                        label="Arayüz yoğunluğu"
                        description="Kompakt mod, masaüstünde daha fazla harita alanı bırakır."
                        value={preferences.density}
                        onChange={density => updatePreferences({ density })}
                    >
                        <option value="comfortable">Rahat</option>
                        <option value="compact">Kompakt</option>
                    </SettingSelect>
                    <SettingSelect
                        id="experience-panel-setting"
                        label="Panel yerleşimi"
                        description="Otomatik seçim küçük ekranlarda alt panel kullanır."
                        value={preferences.panelPlacement}
                        onChange={panelPlacement => updatePreferences({ panelPlacement })}
                    >
                        <option value="auto">Otomatik</option>
                        <option value="left">Sol</option>
                        <option value="right">Sağ</option>
                        <option value="bottom">Alt</option>
                    </SettingSelect>
                </fieldset>

                <fieldset className="experience-settings__group">
                    <legend>Erişilebilirlik</legend>
                    <SettingSelect
                        id="experience-motion-setting"
                        label="Hareket tercihi"
                        description="Azaltılmış hareket, geçiş ve animasyonları minimuma indirir."
                        value={preferences.motion}
                        onChange={motion => updatePreferences({ motion })}
                    >
                        <option value="system">Sistem tercihi</option>
                        <option value="reduced">Azaltılmış</option>
                        <option value="full">Standart</option>
                    </SettingSelect>
                    <SettingSwitch
                        id="experience-high-contrast-setting"
                        label="Harita kontrollerinde yüksek kontrast"
                        description="Kontrol yüzeylerinin sınır ve odak vurgusunu güçlendirir."
                        checked={preferences.highContrastMapControls}
                        onChange={highContrastMapControls => updatePreferences({ highContrastMapControls })}
                    />
                    <SettingSwitch
                        id="experience-coordinate-setting"
                        label="Koordinat durumunu göster"
                        description="Desteklenen görünümde koordinat durum bilgisini açık tutar."
                        checked={preferences.showCoordinateReadout}
                        onChange={showCoordinateReadout => updatePreferences({ showCoordinateReadout })}
                    />
                </fieldset>
            </div>

            <footer className="experience-settings__footer">
                <button
                    type="button"
                    className="experience-btn experience-btn--secondary"
                    onClick={() => preferenceStore.reset()}
                >
                    Varsayılanlara dön
                </button>
                <button type="button" className="experience-btn experience-btn--primary" onClick={() => onClose("done")}>Tamam</button>
            </footer>
        </ExperienceDialog>
    );
}

export function ExperienceWorkspace() {
    const [preferences, updatePreferences] = usePreferences();
    const viewport = useViewport();
    const online = useConnectivity();
    const media = useMediaPreferences();
    const announce = useLiveAnnouncements();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [mapMode, setMapMode] = useState(preferences.lastMapMode || "2d");
    const [pendingMode, setPendingMode] = useState(null);
    const pendingTimerRef = useRef(0);

    const effectiveTheme = resolveEffectiveTheme(preferences.theme, media.prefersDark);
    const panelPlacement = resolvePanelPlacement(preferences.panelPlacement, viewport);
    const reduceMotion = preferences.motion === "reduced" || (preferences.motion === "system" && media.reducedMotion);

    useEffect(() => {
        const root = document.documentElement;
        root.dataset.experienceTheme = effectiveTheme;
        root.dataset.experienceDensity = preferences.density;
        root.dataset.experiencePanel = panelPlacement;
        root.dataset.experienceMotion = reduceMotion ? "reduced" : "full";
        root.dataset.experienceContrast = preferences.highContrastMapControls ? "high" : "normal";
        root.style.colorScheme = effectiveTheme;
    }, [effectiveTheme, panelPlacement, preferences.density, preferences.highContrastMapControls, reduceMotion]);

    useEffect(() => {
        const release = bus.on("kentrehberi:map-mode-changed", detail => {
            if (detail?.mode !== "2d" && detail?.mode !== "3d") return;
            window.clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = 0;
            setMapMode(detail.mode);
            setPendingMode(null);
            updatePreferences({ lastMapMode: detail.mode });
            announce(mapModeAnnouncement(detail.mode));
        });
        return () => {
            release();
            window.clearTimeout(pendingTimerRef.current);
        };
    }, [announce, updatePreferences]);

    useEffect(() => {
        const onKeyDown = event => {
            if (!shouldHandleGlobalShortcut(event)) return;
            if (event.altKey && event.key.toLowerCase() === "m") {
                event.preventDefault();
                const target = document.querySelector("#esri-map-container");
                if (target instanceof HTMLElement) activateSkipTarget(target);
            }
            if (event.altKey && event.key.toLowerCase() === "s") {
                event.preventDefault();
                const target = document.querySelector("#sidebar");
                if (target instanceof HTMLElement) activateSkipTarget(target);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const requestMapMode = useCallback(nextMode => {
        if (nextMode === mapMode || pendingMode) return;
        setPendingMode(nextMode);
        bus.command({ name: "map-mode", mode: nextMode, source: "experience-workspace" });
        announce(`${nextMode === "3d" ? "3B sahne" : "2B harita"} hazırlanıyor.`);
        window.clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = window.setTimeout(() => {
            setPendingMode(null);
            announce("Görünüm değişikliği tamamlanamadı. Mevcut harita görünümü korunuyor.", "assertive");
        }, 12000);
    }, [announce, mapMode, pendingMode]);

    const searchCommand = useMemo(() => getCommandByName("command-palette"), []);

    return (
        <>
            <ExperienceSkipLinks />
            <aside
                id="experience-workspace-controls"
                className="experience-workspace"
                aria-label="Harita çalışma alanı durumu ve görünüm kontrolleri"
                tabIndex={-1}
                data-viewport={viewport}
            >
                <div className="experience-workspace__status-group" aria-label="Çalışma alanı durumu">
                    <StatusItem
                        label="Bağlantı"
                        value={online ? "Çevrimiçi" : "Çevrimdışı"}
                        tone={online ? "success" : "warning"}
                    />
                    <StatusItem label="Görünüm" value={mapMode === "3d" ? "3B sahne" : "2B harita"} tone="accent" />
                    {media.forcedColors && <StatusItem label="Erişilebilirlik" value="Yüksek kontrast" tone="accent" />}
                </div>

                <div className="experience-workspace__actions">
                    <MapModeControl mode={mapMode} pendingMode={pendingMode} onChange={requestMapMode} />
                    <button
                        type="button"
                        className="experience-workspace__action"
                        onClick={() => bus.command({ name: "command-palette", source: "experience-workspace" })}
                        aria-label={`Komut merkezini aç${searchCommand?.shortcut ? `, ${searchCommand.shortcut.join(" artı ")}` : ""}`}
                    >
                        <span aria-hidden="true">Komutlar</span>
                        <kbd>Ctrl K</kbd>
                    </button>
                    <button
                        type="button"
                        className="experience-workspace__action"
                        onClick={() => setSettingsOpen(true)}
                    >
                        Deneyim ayarları
                    </button>
                </div>
            </aside>

            <ExperienceSettingsDialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                preferences={preferences}
                updatePreferences={updatePreferences}
                media={media}
                viewport={viewport}
            />
        </>
    );
}

export default ExperienceWorkspace;
