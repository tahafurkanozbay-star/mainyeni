import React, { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./ExperienceDesignSystem";

const COMMANDS = [
    { id: "search", label: "Genel arama", group: "Arama", shortcut: "Ctrl K", icon: "⌕" },
    { id: "layers", label: "Katman yönetimini aç", group: "Harita", shortcut: "L", icon: "▱" },
    { id: "legend", label: "Lejandı aç", group: "Harita", shortcut: "G", icon: "≡" },
    { id: "home", label: "Harita başlangıcına dön", group: "Harita", shortcut: "H", icon: "⌂" },
    { id: "help", label: "Klavye kısayollarını göster", group: "Yardım", shortcut: "?", icon: "?" }
];

const normalize = (value) => String(value || "").toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function ExperienceCommandCenter({ windowManager }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef(null);

    const filtered = useMemo(() => {
        const needle = normalize(query);
        if (!needle) return COMMANDS;
        return COMMANDS.filter(command => normalize(`${command.label} ${command.group} ${command.id}`).includes(needle));
    }, [query]);

    useEffect(() => {
        const handler = (event) => {
            const name = event?.detail?.name;
            if (name === "command-palette") setOpen(true);
            if (name === "help") setOpen(false);
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

    const execute = (command) => {
        setOpen(false);
        if (command.id === "help") {
            window.dispatchEvent(new CustomEvent("kentrehberi:command", { detail: { name: "help" } }));
            return;
        }
        if (command.id === "home") {
            const mapView = window.__KENT_REHBERI_MAP_VIEW__;
            if (mapView?.goTo) mapView.goTo({ center: mapView.center, zoom: 11 });
            return;
        }
        const ids = {
            search: "genelarama-query-window",
            layers: "layerlist-widget",
            legend: "layerlist-widget"
        };
        const target = ids[command.id];
        if (target && windowManager?.ShowWindow) windowManager.ShowWindow(target);
        window.dispatchEvent(new CustomEvent("kentrehberi:command-executed", { detail: { name: command.id } }));
    };

    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex(index => filtered.length ? (index + 1) % filtered.length : 0);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex(index => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
            } else if (event.key === "Enter" && filtered[activeIndex]) {
                event.preventDefault();
                execute(filtered[activeIndex]);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, activeIndex, filtered]);

    if (!open) return null;

    return <div className="kr-command-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
        <section className="kr-command" role="dialog" aria-modal="true" aria-labelledby="kr-command-title" onMouseDown={event => event.stopPropagation()}>
            <header className="kr-command__head">
                <div>
                    <span className="experience-eyebrow">KENT REHBERİ</span>
                    <h2 id="kr-command-title">Komut merkezi</h2>
                </div>
                <kbd>Esc</kbd>
            </header>
            <div className="kr-command__search">
                <span aria-hidden="true">⌕</span>
                <input ref={inputRef} value={query} onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} aria-label="Komut veya işlem ara" placeholder="Komut veya işlem ara…" autoComplete="off" />
                <kbd>Ctrl K</kbd>
            </div>
            <div className="kr-command__body">
                {filtered.length ? filtered.map((command, index) => <button key={command.id} type="button" className={`kr-command__item ${index === activeIndex ? "is-active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => execute(command)} role="option" aria-selected={index === activeIndex}>
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
