import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExperienceWorkspace } from "./ExperienceWorkspace";

const mediaStates = new Map();

const installMatchMedia = () => {
    window.matchMedia = jest.fn(query => ({
        matches: Boolean(mediaStates.get(query)),
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn()
    }));
};

const setOnline = value => {
    Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value
    });
};

describe("ExperienceWorkspace", () => {
    beforeEach(() => {
        localStorage.clear();
        mediaStates.clear();
        installMatchMedia();
        setOnline(true);
        document.documentElement.removeAttribute("data-experience-theme");
        document.documentElement.removeAttribute("data-experience-density");
        document.documentElement.removeAttribute("data-experience-panel");
        document.documentElement.removeAttribute("data-experience-motion");
        document.documentElement.removeAttribute("data-experience-contrast");

        const map = document.createElement("div");
        map.id = "esri-map-container";
        const sidebar = document.createElement("div");
        sidebar.id = "sidebar";
        document.body.append(map, sidebar);
    });

    afterEach(() => {
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    test("renders semantic status and 2B/3B controls", () => {
        render(<ExperienceWorkspace />);
        expect(screen.getByLabelText("Harita çalışma alanı durumu ve görünüm kontrolleri")).toBeInTheDocument();
        expect(screen.getByLabelText("Çalışma alanı durumu")).toHaveTextContent("Çevrimiçi");
        expect(screen.getByRole("button", { name: /2 boyutlu harita, etkin/i })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: /3 boyutlu sahne/i })).toHaveAttribute("aria-pressed", "false");
    });

    test("dispatches a map-mode command instead of mutating GIS state directly", () => {
        const listener = jest.fn();
        window.addEventListener("kentrehberi:command", listener);
        render(<ExperienceWorkspace />);

        fireEvent.click(screen.getByRole("button", { name: /3 boyutlu sahne/i }));

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].detail).toEqual(expect.objectContaining({
            name: "map-mode",
            mode: "3d",
            source: "experience-workspace"
        }));
        expect(screen.getByLabelText("Harita görünümü")).toHaveAttribute("aria-busy", "true");
        window.removeEventListener("kentrehberi:command", listener);
    });

    test("accepts runtime confirmation and updates the active map mode", async () => {
        render(<ExperienceWorkspace />);
        fireEvent.click(screen.getByRole("button", { name: /3 boyutlu sahne/i }));

        window.dispatchEvent(new CustomEvent("kentrehberi:map-mode-changed", {
            detail: { mode: "3d", source: "test-runtime" }
        }));

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /3 boyutlu sahne, etkin/i })).toHaveAttribute("aria-pressed", "true");
        });
        expect(screen.getByLabelText("Harita görünümü")).not.toHaveAttribute("aria-busy");
    });

    test("opens an accessible settings dialog and persists theme changes", async () => {
        render(<ExperienceWorkspace />);
        fireEvent.click(screen.getByRole("button", { name: "Deneyim ayarları" }));

        const dialog = screen.getByRole("dialog", { name: "Çalışma alanını kişiselleştir" });
        expect(dialog).toHaveAttribute("aria-modal", "true");

        fireEvent.change(screen.getByLabelText("Tema"), { target: { value: "dark" } });
        await waitFor(() => expect(document.documentElement.dataset.experienceTheme).toBe("dark"));

        const persisted = JSON.parse(localStorage.getItem("kent-rehberi-experience-preferences-v2"));
        expect(persisted.theme).toBe("dark");
    });

    test("persists accessibility switches through the shared preference store", async () => {
        render(<ExperienceWorkspace />);
        fireEvent.click(screen.getByRole("button", { name: "Deneyim ayarları" }));

        const contrast = screen.getByRole("switch", { name: "Harita kontrollerinde yüksek kontrast" });
        expect(contrast).toHaveAttribute("aria-checked", "false");
        fireEvent.click(contrast);

        await waitFor(() => expect(contrast).toHaveAttribute("aria-checked", "true"));
        expect(document.documentElement.dataset.experienceContrast).toBe("high");
    });

    test("reset restores defaults without closing the dialog", async () => {
        localStorage.setItem("kent-rehberi-experience-preferences-v2", JSON.stringify({
            theme: "dark",
            density: "compact",
            motion: "reduced",
            panelPlacement: "left",
            lastMapMode: "2d",
            utilityCollapsed: false,
            showCoordinateReadout: false,
            highContrastMapControls: true
        }));
        render(<ExperienceWorkspace />);
        fireEvent.click(screen.getByRole("button", { name: "Deneyim ayarları" }));
        expect(screen.getByLabelText("Tema")).toHaveValue("dark");

        fireEvent.click(screen.getByRole("button", { name: "Varsayılanlara dön" }));

        await waitFor(() => expect(screen.getByLabelText("Tema")).toHaveValue("system"));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    test("reacts to browser offline and online events", async () => {
        render(<ExperienceWorkspace />);
        expect(screen.getByLabelText("Çalışma alanı durumu")).toHaveTextContent("Çevrimiçi");

        setOnline(false);
        fireEvent(window, new Event("offline"));
        await waitFor(() => expect(screen.getByLabelText("Çalışma alanı durumu")).toHaveTextContent("Çevrimdışı"));

        setOnline(true);
        fireEvent(window, new Event("online"));
        await waitFor(() => expect(screen.getByLabelText("Çalışma alanı durumu")).toHaveTextContent("Çevrimiçi"));
    });

    test("skip links move focus to the requested application region", () => {
        render(<ExperienceWorkspace />);
        const map = document.querySelector("#esri-map-container");
        fireEvent.click(screen.getByRole("link", { name: "Haritaya geç" }));
        expect(map).toHaveAttribute("tabindex", "-1");
        expect(document.activeElement).toBe(map);
    });

    test("Alt+M and Alt+S support keyboard-only region navigation", () => {
        render(<ExperienceWorkspace />);
        const map = document.querySelector("#esri-map-container");
        const sidebar = document.querySelector("#sidebar");

        fireEvent.keyDown(window, { key: "m", altKey: true });
        expect(document.activeElement).toBe(map);

        fireEvent.keyDown(window, { key: "s", altKey: true });
        expect(document.activeElement).toBe(sidebar);
    });

    test("forced-colors state is surfaced as a user-visible status", () => {
        mediaStates.set("(forced-colors: active)", true);
        render(<ExperienceWorkspace />);
        expect(screen.getByLabelText("Çalışma alanı durumu")).toHaveTextContent("Yüksek kontrast");
    });
});
