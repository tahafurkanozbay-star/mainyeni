import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./ExperienceDesignSystem";
import { ExperienceDialog } from "./ExperienceDialog";
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
    }, [open]);

    useEffect(() => {
        if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
    }, [activeIndex, filtered.length]);

    const moveActive = useCallback(direction => {
        setActiveIndex(index => {
            if (!filtered.length) return 0;
            if (direction === "first") return 0;
            if (direction === "last") return filtered.length - 1;
            if (direction === "next") return (index + 1) % filtered.length;
            if (direction === "previous") return (index - 1 + filtered.length) % filtered.length;
            return index;
        });
    }, [filtered.length]);

    const handleInputKeyDown = event => {
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                moveActive("next");
                break;
            case "ArrowUp":
                event.preventDefault();
                moveActive("previous");
                break;
            case "Home":
                event.preventDefault();
                moveActive("first");
                break;
            case "End":
                event.preventDefault();
                moveActive("last");
                break;
            case "Enter":
                if (activeCommand) {
                    event.preventDefault();
                    execute(activeCommand);
                }
                break;
            default:
                break;
        }
    };

    return (
        <ExperienceDialog
            open={open}
            onClose={close}
            labelledBy="kr-command-title"
            describedBy="kr-command-description"
            initialFocusRef={inputRef}
            backdropClassName="kr-command-backdrop"
            dialogClassName="kr-command"
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
                    onKeyDown={handleInputKeyDown}
                    role="combobox"
                    aria-label="Komut veya işlem ara"
                    aria-expanded="true"
                    aria-haspopup="listbox"
                    aria-autocomplete="list"
                    aria-controls="kr-command-results"
                    aria-activedescendant={activeCommand ? `kr-command-item-${activeCommand.id}` : undefined}
                    aria-describedby="kr-command-hint"
                    placeholder="Komut veya işlem ara…"
                    autoComplete="off"
                    spellCheck="false"
                />
                <kbd aria-hidden="true">Ctrl K</kbd>
            </div>
            <span id="kr-command-hint" className="experience-sr-only">Sonuçlarda gezinmek için yukarı ve aşağı ok tuşlarını, çalıştırmak için Enter tuşunu kullanın.</span>
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
                        tabIndex={-1}
                    >
                        <span className="kr-command__icon" aria-hidden="true">{command.icon}</span>
                        <span className="kr-command__copy"><strong>{command.label}</strong><small>{command.group}</small></span>
                        {command.shortcut ? <kbd aria-hidden="true">{command.shortcut}</kbd> : <span aria-hidden="true">↵</span>}
                    </button>
                )) : <EmptyState title="Komut bulunamadı" description="Arama ifadenizi değiştirip tekrar deneyin." />}
            </div>
            <footer className="kr-command__foot" aria-live="polite" aria-atomic="true">{filtered.length} işlem</footer>
        </ExperienceDialog>
    );
}

export const experienceCommandCenterInternals = Object.freeze({ COMMANDS });

export default ExperienceCommandCenter;
