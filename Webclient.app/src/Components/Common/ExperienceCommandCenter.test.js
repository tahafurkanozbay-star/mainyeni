import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExperienceCommandCenter } from "./ExperienceCommandCenter";

function openCommandCenter() {
    act(() => {
        window.dispatchEvent(new CustomEvent("kentrehberi:command", {
            detail: { name: "command-palette" }
        }));
    });
}

describe("ExperienceCommandCenter", () => {
    test("exposes an ARIA combobox/listbox contract and initial active option", async () => {
        render(<ExperienceCommandCenter />);
        openCommandCenter();

        expect(screen.getByRole("dialog", { name: "Komut merkezi" })).toBeInTheDocument();
        const input = screen.getByRole("combobox", { name: "Komut veya işlem ara" });
        expect(input).toHaveAttribute("aria-expanded", "true");
        expect(input).toHaveAttribute("aria-haspopup", "listbox");
        expect(input).toHaveAttribute("aria-autocomplete", "list");
        expect(input).toHaveAttribute("aria-controls", "kr-command-results");
        expect(input).toHaveAttribute("aria-activedescendant", "kr-command-item-search");
        expect(screen.getByRole("listbox", { name: "Komut sonuçları" })).toBeInTheDocument();
        expect(screen.getAllByRole("option").length).toBeGreaterThan(4);
        await waitFor(() => expect(input).toHaveFocus());
    });

    test("supports Arrow, Home and End navigation without moving DOM focus", async () => {
        render(<ExperienceCommandCenter />);
        openCommandCenter();
        const input = screen.getByRole("combobox");
        await waitFor(() => expect(input).toHaveFocus());

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(input).toHaveAttribute("aria-activedescendant", "kr-command-item-layers");
        expect(input).toHaveFocus();

        fireEvent.keyDown(input, { key: "End" });
        expect(input).toHaveAttribute("aria-activedescendant", "kr-command-item-help");

        fireEvent.keyDown(input, { key: "Home" });
        expect(input).toHaveAttribute("aria-activedescendant", "kr-command-item-search");

        fireEvent.keyDown(input, { key: "ArrowUp" });
        expect(input).toHaveAttribute("aria-activedescendant", "kr-command-item-help");
    });

    test("filters normalized Turkish command text and executes the active result", async () => {
        const windowManager = { ShowWindow: jest.fn() };
        render(<ExperienceCommandCenter windowManager={windowManager} />);
        openCommandCenter();
        const input = screen.getByRole("combobox");
        await waitFor(() => expect(input).toHaveFocus());

        fireEvent.change(input, { target: { value: "ölçüm" } });
        expect(screen.getAllByRole("option")).toHaveLength(1);
        expect(input).toHaveAttribute("aria-activedescendant", "kr-command-item-measure");
        expect(screen.getByText("1 işlem")).toBeInTheDocument();

        fireEvent.keyDown(input, { key: "Enter" });
        expect(windowManager.ShowWindow).toHaveBeenCalledWith("measurement-widget");
        expect(screen.queryByRole("dialog", { name: "Komut merkezi" })).not.toBeInTheDocument();
    });

    test("announces an empty result set without a stale active descendant", async () => {
        render(<ExperienceCommandCenter />);
        openCommandCenter();
        const input = screen.getByRole("combobox");
        await waitFor(() => expect(input).toHaveFocus());

        fireEvent.change(input, { target: { value: "bulunmayacak-bir-komut" } });
        expect(screen.getByText("Komut bulunamadı")).toBeInTheDocument();
        expect(screen.getByText("0 işlem")).toBeInTheDocument();
        expect(input).not.toHaveAttribute("aria-activedescendant");
    });

    test("dispatches event-backed commands and closes the palette", async () => {
        const handler = jest.fn();
        window.addEventListener("kentrehberi:command", handler);
        render(<ExperienceCommandCenter />);
        openCommandCenter();
        const input = screen.getByRole("combobox");
        await waitFor(() => expect(input).toHaveFocus());

        fireEvent.change(input, { target: { value: "katman" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(handler.mock.calls.some(call => call[0]?.detail?.name === "layers")).toBe(true);
        expect(screen.queryByRole("dialog", { name: "Komut merkezi" })).not.toBeInTheDocument();
        window.removeEventListener("kentrehberi:command", handler);
    });
});
