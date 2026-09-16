import React, { useCallback, useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExperienceDialog } from "./ExperienceDialog";

function DialogHarness({ closeOnBackdrop = true }) {
    const [open, setOpen] = useState(false);
    const closeRef = useRef(null);
    const close = useCallback(() => setOpen(false), []);

    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>Aç</button>
            <ExperienceDialog
                open={open}
                onClose={close}
                labelledBy="test-dialog-title"
                describedBy="test-dialog-description"
                initialFocusRef={closeRef}
                backdropClassName="test-backdrop"
                dialogClassName="test-dialog"
                closeOnBackdrop={closeOnBackdrop}
                testId="test-dialog"
            >
                <h2 id="test-dialog-title">Test iletişim kutusu</h2>
                <p id="test-dialog-description">Erişilebilir dialog davranışı.</p>
                <button ref={closeRef} type="button" onClick={close}>Kapat</button>
                <button type="button">İkincil işlem</button>
            </ExperienceDialog>
        </>
    );
}

describe("ExperienceDialog", () => {
    afterEach(() => {
        document.body.style.overflow = "";
    });

    test("sets modal semantics, focuses the requested control and restores focus", async () => {
        render(<DialogHarness />);
        const opener = screen.getByRole("button", { name: "Aç" });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole("dialog", { name: "Test iletişim kutusu" });
        expect(dialog).toHaveAttribute("aria-modal", "true");
        expect(dialog).toHaveAttribute("aria-describedby", "test-dialog-description");
        await waitFor(() => expect(screen.getByRole("button", { name: "Kapat" })).toHaveFocus());
        expect(document.body.style.overflow).toBe("hidden");

        fireEvent.click(screen.getByRole("button", { name: "Kapat" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await waitFor(() => expect(opener).toHaveFocus());
        expect(document.body.style.overflow).toBe("");
    });

    test("traps Tab and Shift+Tab at dialog boundaries", async () => {
        render(<DialogHarness />);
        fireEvent.click(screen.getByRole("button", { name: "Aç" }));

        const closeButton = screen.getByRole("button", { name: "Kapat" });
        const secondaryButton = screen.getByRole("button", { name: "İkincil işlem" });
        await waitFor(() => expect(closeButton).toHaveFocus());

        fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
        expect(secondaryButton).toHaveFocus();

        fireEvent.keyDown(document, { key: "Tab" });
        expect(closeButton).toHaveFocus();
    });

    test("closes with Escape and reports backdrop intent only for backdrop clicks", async () => {
        render(<DialogHarness />);
        const opener = screen.getByRole("button", { name: "Aç" });
        fireEvent.click(opener);
        await screen.findByRole("dialog");

        fireEvent.keyDown(document, { key: "Escape" });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await waitFor(() => expect(opener).toHaveFocus());

        fireEvent.click(opener);
        const dialog = await screen.findByRole("dialog");
        fireEvent.mouseDown(dialog);
        expect(screen.getByRole("dialog")).toBeInTheDocument();

        const backdrop = dialog.parentElement;
        fireEvent.mouseDown(backdrop);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    test("can keep a dialog open when backdrop closing is disabled", async () => {
        render(<DialogHarness closeOnBackdrop={false} />);
        fireEvent.click(screen.getByRole("button", { name: "Aç" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.mouseDown(dialog.parentElement);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
});
