import React, { createContext, useContext, useMemo, useState } from "react";

const ThemeContext = createContext(null);

export const EXPERIENCE_TOKENS = Object.freeze({
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
    radius: { control: 8, card: 12, panel: 16, modal: 18, pill: 999 },
    z: { map: 0, overlay: 10, controls: 20, panel: 30, dialog: 100 }
});

export function ExperienceThemeProvider({ children }) {
    const [theme, setTheme] = useState(() => {
        try {
            const stored = window.localStorage.getItem("kent-rehberi-experience-theme");
            if (stored === "light" || stored === "dark") return stored;
        } catch (_) { /* storage unavailable */ }
        return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    });

    const value = useMemo(() => ({
        theme,
        toggleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark"),
        setTheme
    }), [theme]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useExperienceTheme() {
    const value = useContext(ThemeContext);
    if (!value) throw new Error("useExperienceTheme must be used inside ExperienceThemeProvider");
    return value;
}

export function StatusPill({ tone = "neutral", children }) {
    return <span className={`experience-status-pyl experience-status-pyl--${tone}`}><span aria-hidden="true" className="experience-status-pyl__dot" />{children}</span>;
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

export default ExperienceThemeProvider;
