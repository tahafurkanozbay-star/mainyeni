import React, { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./ExperienceDesignSystem";
import { normalizeCommandQuery } from "./experience-quality-utils";

const COMMANDS = [
    { id: "search", label: "Genel arama", group: "Arama", shortcut: "Ctrl K", icon: "⌕" },
    { id: "layers", label: "Katman yönetimini aç", group: "Harita", shortcut: "L", icon: "▱" },
    { id: "legend", label: "Lejandı aç", group: "Harita", shortcut: "G", icon: "≡" },
    { id: "help", label: "Klavye kısayollarını göster", group: "Yardım", shortcut: "?", icon: "?" }
];

export function ExperienceCommandCenter({ windowManager }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef(null);

    const filtered = useMemo(() => {
        const needle = normalizeCommandQuery(query);
        if (!needle) return COMMANDS;
        return COMMANDS.filter(command => normalizeCommandQuery(`${command.label} ${command.group} ${command.id}`).includes(needle));
    }, [query]);

    const activeCommand = filtered[activeIndex];

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

    const execute = command => {
        setOpen(false);
        if (command.id === "help") {
            window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name: "help" } }));
            return;
        }
        const ids = { search: "genelarama-query-window", layers: "layerlist-widget", legend: "layerlist-widget" };
        const target = ids[command.id];
        if (target && windowManager?.ShowWindow) windowManager.ShowWindow(target);
        window.dispatchEvent(new CustomEvent("kentrehberi:command-executed", { detail: { name: command.id } }));
    };

    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(index => filtered.length ? (index + 1) % filtered.length : 0);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(index => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
            } else if (event.key === "Enter" && activeCommand) {
                event.preventDefault();
                execute(activeCommand);
            } else if (event.key === "Tab") {
                event.preventDefault();
                inputRef.current?.focus();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, activeCommand, filtered]);

    if (!open) return null;

    return <div className="kr-command-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
        <section className="kr-command" role="dialog" aria-modal="true" aria-labelledby="kr-command-title" aria-describedby="kr-command-description" onMouseDown={event => event.stopPropagation()}>
            <header className="kr-command__head">
                <div><span className="experience-eyebrow">KENT REHBERİ</span><h2 id="kr-command-title">Komut merkezi</h2><span id="kr-command-description" className="experience-sr-only">Harita, arama ve yardımcı araçlara hızlı erişim.</span></div>
                <kbd>Esc</kbd>
            </header>
            <div className="kr-command__search">
                <span aria-hidden="true">⌕</span>
                <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} aria-label="Komut veya işlem ara" aria-controls="kr-command-results" aria-activedescendant={activeCommand ? `kr-command-item-${activeCommand.id}` : undefined} placeholder="Komut veya işlem ara…" autoComplete="off" />
                <kbd>Ctrl K</kbd>
            </div>
            <div id="kr-command-results" className="kr-command__body" role="listbox" aria-label="Komut sonuçları">
                {filtered.length ? filtered.map((command, index) => <button key={command.id} id={`kr-command-item-${command.id}`} type="button" className={`kr-command__item ${index === activeIndex ? "is-active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => execute(command)} role="option" aria-selected={index === activeIndex}>
                    <span className="kr-command__icon" aria-hidden="true">{command.icon}</span>
                    <span className="kr-command__copy"><strong>{command.label}</strong><small>{command.group}</small></span>
                    <kbd>{command.shortcut}</kbd>
                </button>) : <EmptyState title="Komut bulunamadı" description="Arama ifadenizi değiştirip tekrar deneyin." />}
            </div>
            <footer className="kr-command__foot" aria-live="polite">{filtered.length} işlem</footer>
        </section>
    </div>;
}

export default ExperienceCommandCenter;
