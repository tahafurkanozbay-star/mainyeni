import React, { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'iframe',
    'object',
    'embed',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
].join(",");

let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";

function lockBodyScroll() {
    if (typeof document === "undefined") return () => {};

    if (bodyLockCount === 0) {
        bodyOverflowBeforeLock = document.body.style.overflow;
        document.body.style.overflow = "hidden";
    }
    bodyLockCount += 1;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        bodyLockCount = Math.max(0, bodyLockCount - 1);
        if (bodyLockCount === 0) {
            document.body.style.overflow = bodyOverflowBeforeLock;
            bodyOverflowBeforeLock = "";
        }
    };
}

function getFocusableElements(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(element => {
        if (element.hasAttribute("disabled") || element.getAttribute("aria-hidden") === "true") return false;
        return element.getAttribute("tabindex") !== "-1";
    });
}

function focusFirstAvailable(container, initialFocusRef) {
    const preferred = initialFocusRef?.current;
    if (preferred && typeof preferred.focus === "function") {
        preferred.focus();
        return;
    }

    const [first] = getFocusableElements(container);
    if (first) {
        first.focus();
        return;
    }

    if (container && typeof container.focus === "function") container.focus();
}

/**
 * Shared modal-dialog primitive for Experience surfaces.
 *
 * Keeps focus inside the active dialog, closes on Escape, restores focus to the
 * element that launched the dialog, and prevents the map behind the dialog from
 * scrolling while the dialog is open. The visual shell remains owned by each
 * feature so GIS-specific layouts are not coupled to a generic modal package.
 */
export function ExperienceDialog({
    open,
    onClose,
    labelledBy,
    describedBy,
    initialFocusRef,
    backdropClassName,
    dialogClassName,
    children,
    closeOnBackdrop = true,
    restoreFocus = true,
    role = "dialog",
    testId
}) {
    const dialogRef = useRef(null);
    const returnFocusRef = useRef(null);

    useEffect(() => {
        if (!open || typeof document === "undefined") return undefined;

        returnFocusRef.current = document.activeElement;
        const releaseScrollLock = lockBodyScroll();
        let frame = null;
        if (typeof requestAnimationFrame === "function") {
            frame = requestAnimationFrame(() => focusFirstAvailable(dialogRef.current, initialFocusRef));
        } else {
            focusFirstAvailable(dialogRef.current, initialFocusRef);
        }

        const onKeyDown = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose?.("escape");
                return;
            }

            if (event.key !== "Tab") return;
            const focusable = getFocusableElements(dialogRef.current);
            if (!focusable.length) {
                event.preventDefault();
                dialogRef.current?.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;

            if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown, true);

        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
            releaseScrollLock();

            if (restoreFocus) {
                const target = returnFocusRef.current;
                if (target && document.contains(target) && typeof target.focus === "function") {
                    target.focus();
                }
            }
        };
    }, [open, onClose, initialFocusRef, restoreFocus]);

    if (!open) return null;

    const handleBackdropMouseDown = event => {
        if (!closeOnBackdrop || event.target !== event.currentTarget) return;
        onClose?.("backdrop");
    };

    return (
        <div
            className={backdropClassName}
            role="presentation"
            onMouseDown={handleBackdropMouseDown}
            data-experience-dialog-backdrop="true"
        >
            <section
                ref={dialogRef}
                className={dialogClassName}
                role={role}
                aria-modal="true"
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
                tabIndex={-1}
                data-experience-dialog="true"
                data-testid={testId}
            >
                {children}
            </section>
        </div>
    );
}

export const experienceDialogInternals = Object.freeze({
    FOCUSABLE_SELECTOR,
    getFocusableElements
});

export default ExperienceDialog;
