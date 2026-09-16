import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext(null);
const THEME_STORAGE_KEY = "kent-rehberi-experience-theme";
const VALID_THEMES = new Set(["light", "dark"]);

export const EXPERIENCE_TOKENS = Object.freeze({
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
    radius: { control: 8, card: 12, panel: 16, modal: 18, pill: 999 },
    control: { height: 40, touchTarget: 44 },
    z: { map: 0, overlay: 10, controls: 20, panel: 30, dialog: 100 }
});

function getSystemTheme() {
    if (typeof window === "undefined") return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const getStoredTheme = () => {
    if (typeof window === "undefined") return "light";

    try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        if (VALID_THEMES.has(stored)) return stored;
    } catch (_) {
        // Storage can be unavailable in privacy-restricted or embedded contexts.
    }

    return getSystemTheme();
};

function persistTheme(theme) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_) {
        // Theme remains functional for this session when persistence is blocked.
    }
}

function applyThemeToDocument(theme) {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.experienceTheme = theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
}

export function ExperienceThemeProvider({ children }) {
    const [theme, setThemeState] = useState(getStoredTheme);

    const setTheme = useCallback(nextTheme => {
        setThemeState(VALID_THEMES.has(nextTheme) ? nextTheme : "light");
    }, []);

    const toggleTheme = useCallback(() => {
        setThemeState(current => current === "dark" ? "light" : "dark");
    }, []);

    useEffect(() => {
        applyThemeToDocument(theme);
        persistTheme(theme);
    }, [theme]);

    useEffect(() => {
        if (typeof window === "undefined") return undefined;

        const onStorage = event => {
            if (event.key !== THEME_STORAGE_KEY || !VALID_THEMES.has(event.newValue)) return;
            setThemeState(event.newValue);
        };

        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const value = useMemo(() => ({ theme, toggleTheme, setTheme }), [theme, toggleTheme, setTheme]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useExperienceTheme() {
    const value = useContext(ThemeContext);
    if (!value) throw new Error("useExperienceTheme must be used inside ExperienceThemeProvider");
    return value;
}

export function StatusPill({ tone = "neutral", children }) {
    return <span className={`experience-status-pill experience-status-pill--${tone}`}><span aria-hidden="true" className="experience-status-pill__dot" />{children}</span>;
}

export function EmptyState({ title, description, action, icon }) {
    return <section className="experience-empty-state" aria-label={title}>
        <div className="experience-empty-state__icon" aria-hidden="true">{icon || "—"}</div>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
        {action}
    </section>;
}

export function LoadingState({ label = "Yükleniyor", rows = 3 }) {
    return <section className="experience-loading-state" aria-live="polite" aria-busy="true" aria-label={label}>
        <div className="experience-loading-state__head"><span className="experience-skeleton experience-skeleton--title" /><span className="experience-skeleton experience-skeleton--control" /></div>
        <div className="experience-loading-state__rows">{Array.from({ length: rows }).map((_, index) => <span key={index} className="experience-skeleton" />)}</div>
    </section>;
}

export function ErrorState({ title = "Bir sorun oluştu", description, onRetry }) {
    return <section className="experience-error-state" role="alert">
        <div className="experience-error-state__badge" aria-hidden="true">!</div>
        <div><h3>{title}</h3>{description && <p>{description}</p>}{onRetry && <button type="button" className="experience-btn experience-btn--secondary" onClick={onRetry}>Tekrar dene</button>}</div>
    </section>;
}

export const experienceThemeInternals = Object.freeze({
    storageKey: THEME_STORAGE_KEY,
    validThemes: VALID_THEMES,
    applyThemeToDocument,
    persistTheme
});

export default ExperienceThemeProvider;
