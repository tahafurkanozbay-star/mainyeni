import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExperienceThemeProvider, experienceThemeInternals, useExperienceTheme } from "./ExperienceDesignSystem";

function ThemeHarness() {
    const { theme, toggleTheme, setTheme } = useExperienceTheme();
    return (
        <div>
            <output aria-label="tema">{theme}</output>
            <button type="button" onClick={toggleTheme}>Değiştir</button>
            <button type="button" onClick={() => setTheme("dark")}>Koyu</button>
            <button type="button" onClick={() => setTheme("unsupported")}>Geçersiz</button>
        </div>
    );
}

describe("ExperienceThemeProvider", () => {
    const storageKey = experienceThemeInternals.storageKey;

    beforeEach(() => {
        window.localStorage.clear();
        delete document.documentElement.dataset.experienceTheme;
        delete document.documentElement.dataset.theme;
        document.documentElement.style.colorScheme = "";
    });

    test("hydrates a stored theme and applies document color-scheme metadata", async () => {
        window.localStorage.setItem(storageKey, "dark");
        render(<ExperienceThemeProvider><ThemeHarness /></ExperienceThemeProvider>);

        expect(screen.getByLabelText("tema")).toHaveTextContent("dark");
        await waitFor(() => {
            expect(document.documentElement.dataset.experienceTheme).toBe("dark");
            expect(document.documentElement.dataset.theme).toBe("dark");
            expect(document.documentElement.style.colorScheme).toBe("dark");
        });
    });

    test("toggle persists a valid theme and invalid setter input falls back safely", async () => {
        window.localStorage.setItem(storageKey, "light");
        render(<ExperienceThemeProvider><ThemeHarness /></ExperienceThemeProvider>);

        fireEvent.click(screen.getByRole("button", { name: "Değiştir" }));
        expect(screen.getByLabelText("tema")).toHaveTextContent("dark");
        await waitFor(() => expect(window.localStorage.getItem(storageKey)).toBe("dark"));

        fireEvent.click(screen.getByRole("button", { name: "Geçersiz" }));
        expect(screen.getByLabelText("tema")).toHaveTextContent("light");
        await waitFor(() => expect(window.localStorage.getItem(storageKey)).toBe("light"));
    });

    test("synchronizes theme changes from another browser tab", async () => {
        window.localStorage.setItem(storageKey, "light");
        render(<ExperienceThemeProvider><ThemeHarness /></ExperienceThemeProvider>);

        act(() => {
            window.dispatchEvent(new StorageEvent("storage", {
                key: storageKey,
                newValue: "dark",
                oldValue: "light",
                storageArea: window.localStorage
            }));
        });

        expect(screen.getByLabelText("tema")).toHaveTextContent("dark");
        await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    });

    test("ignores unrelated or unsupported storage values", () => {
        window.localStorage.setItem(storageKey, "light");
        render(<ExperienceThemeProvider><ThemeHarness /></ExperienceThemeProvider>);

        act(() => {
            window.dispatchEvent(new StorageEvent("storage", { key: "other-key", newValue: "dark" }));
            window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "sepia" }));
        });

        expect(screen.getByLabelText("tema")).toHaveTextContent("light");
    });
});
