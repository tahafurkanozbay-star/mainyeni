import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./ExperienceDesignSystem";
import { normalizeCommandQuery } from "./experience-quality-utils";

const COMMANDS = Object.freeze([
    { id: "search", label: "Genel arama", group: "Arama", shortcut: "Ctrl K", icon: "⌕", target: "genelarama-query-window" },
    { id: "layers", label: "Katman yönetimini aç", group: "Harita", shortcut: "L", icon: "▱", event: "layers" },
    { id: "legend", label: "Lejandı aç", group: "Harita", shortcut: "G", icon: "≡", event: "legend" },
    { id: "basemap", label: "Altlık haritayı değiştir", group: "Harita", icon: "◇", target: "basemap-widget" },
    { id: "identify", label: "Haritada bilgi al", group: "Analiz", icon: "i", target: "global-identify-widget" },
    { id: "measure", label: "Ölçüm aracını aç", group: "Analiz", icon: "↔", target: "measurement-widget" },
    { id: "sketch", label: "Çizim aracını aç", group: "Analiz", icon: "✎", target: "sketch-widget" },
    { id: "bookmark", label: "Yer imlerini aç", group: "Harita", icon: "☆", target: "bookmark-widget" },
    { id: "help", label: "Klavye kısayollarını göster", group: "Yardım", shortcut: "?", icon: "?", event: "help" }
]);

const dispatchExperienceCommand = name => {
    window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name } }));
};

export function ExperienceCommandCenter({ windowManager }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef(null);
    const dialogRef = useRef(null);

    const filtered = useMemo(() => {
        const needle = normalizeCommandQuery(query);
        if (!needle) return COMMANDS;
        return COMMANDS.filter(command => normalizeCommandQuery(`${command.label} ${command.group} ${command.id}`).includes(needle));
    }, [query]);

    const activeCommand = filtered[activeIndex];

    const close = useCallback(() => setOpen(false), []);

    const execute = useCallback(command => {
        if (!command) return;
        close();

        if (command.target && windowManager?.ShowWindow) {
            windowManager.ShowWindow(command.target);
        }
        if (command.event) dispatchExperienceCommand(command.event);

        window.dispatchEvent(new CustomEvent("kentrehberi:command-executed", {
            detail: { name: command.id }
        }));
    }, [close, windowManager]);

    useEffect(() => {
        const handler = event => {
            if (event?.detail?.name === "command-palette") setOpen(true);
        };
        window.addEventListener("kentrehberi:command", handler);
        return () => window.removeEventListener("kentrehberi:command", handler);
    }, []);

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setActiveIndex(0);
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [open]);

    useEffect(() => {
        if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
    }, [activeIndex, filtered.length]);

    useEffect(() => {
        if (!open) return undefined;

        const onKeyDown = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                close();
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(index => filtered.length ? (index + 1) % filtered.length : 0);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(index => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
            } else if (event.key === "Enter" && document.activeElement === inputRef.current && activeCommand) {
                event.preventDefault();
                execute(activeCommand);
            } else if (event.key === "Tab" && dialogRef.current) {
                const focusable = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, activeCommand, close, execute, filtered.length]);

    if (!open) return null;

    return (
        <div className="kr-command-backdrop" role="presentation" onMouseDown={close}>
            <section
                ref={dialogRef}
                className="kr-command"
                role="dialog"
                aria-modal="true"
                aria-labelledby="kr-command-title"
                aria-describedby="kr-command-description"
                onMouseDown={event => event.stopPropagation()}
            >
                <header className="kr-command__head">
                    <div>
                        <span className="experience-eyebrow">KENT REHBERİ</span>
                        <h2 id="kr-command-title">Komut merkezi</h2>
                        <span id="kr-command-description" className="experience-sr-only">Harita, arama ve yardımcı araçlara hızlı erişim.</span>
                    </div>
                    <button type="button" className="experience-close" onClick={close} aria-label="Komut merkezini kapat">×</button>
                </header>
                <div className="kr-command__search">
                    <span aria-hidden="true">⌕</span>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={event => {
                            setQuery(event.target.value);
                            setActiveIndex(0);
                        }}
                        aria-label="Komut veya işlem ara"
                        aria-controls="kr-command-results"
                        aria-activedescendant={activeCommand ? `kr-command-item-${activeCommand.id}` : undefined}
                        placeholder="Komut veya işlem ara…"
                        autoComplete="off"
                    />
                    <kbd>Ctrl K</kbd>
                </div>
                <div id="kr-command-results" className="kr-command__body" role="listbox" aria-label="Komut sonuçları">
                    {filtered.length ? filtered.map((command, index) => (
                        <button
                            key={command.id}
                            id={`kr-command-item-${command.id}`}
                            type="button"
                            className={`kr-command__item ${index === activeIndex ? "is-active" : ""}`}
                            onMouseEnter={() => setActiveIndex(index)}
                            onFocus={() => setActiveIndex(index)}
                            onClick={() => execute(command)}
                            role="option"
                            aria-selected={index === activeIndex}
                        >
                            <span className="kr-command__icon" aria-hidden="true">{command.icon}</span>
                            <span className="kr-command__copy"><strong>{command.label}</strong><small>{command.group}</small></span>
                            {command.shortcut ? <kbd>{command.shortcut}</kbd> : <span aria-hidden="true">↵</span>}
                        </button>
                    )) : <EmptyState title="Komut bulunamadı" description="Arama ifadenizi değiştirip tekrar deneyin." />}
                </div>
                <footer className="kr-command__foot" aria-live="polite">{filtered.length} işlem</footer>
            </section>
        </div>
    );
}

export default ExperienceCommandCenter;
