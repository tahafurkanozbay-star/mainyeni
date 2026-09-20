import { createFocusTrap, focusSafely, type FocusTrapController } from "./focusNavigation";

export type OverlayKind = "dialog" | "drawer" | "sheet" | "popover" | "map-panel";
export type OverlayModality = "modal" | "non-modal";
export type OverlayDismissReason = "escape" | "backdrop" | "programmatic" | "superseded";

export interface OverlayRegistration {
    id: string;
    element: HTMLElement;
    kind: OverlayKind;
    modality?: OverlayModality;
    trigger?: HTMLElement | null;
    initialFocus?: HTMLElement | (() => HTMLElement | null) | null;
    fallbackFocus?: HTMLElement | (() => HTMLElement | null) | null;
    closeOnEscape?: boolean;
    closeOnBackdrop?: boolean;
    restoreFocus?: boolean;
    lockDocumentScroll?: boolean;
    inertSiblings?: boolean;
    onRequestClose?: (reason: OverlayDismissReason) => void;
    onOpen?: () => void;
    onClose?: (reason: OverlayDismissReason) => void;
}

export interface OverlaySnapshotItem {
    id: string;
    kind: OverlayKind;
    modality: OverlayModality;
    topmost: boolean;
}

export interface OverlaySnapshot {
    size: number;
    modalCount: number;
    topmostId: string | null;
    items: readonly OverlaySnapshotItem[];
}

export interface OverlayHandle {
    readonly id: string;
    close(reason?: OverlayDismissReason): void;
    requestClose(reason?: OverlayDismissReason): void;
    bringToFront(): void;
    update(next: Partial<Omit<OverlayRegistration, "id" | "element">>): void;
    isOpen(): boolean;
}

export interface OverlayCoordinatorOptions {
    document?: Document;
    appRoot?: HTMLElement | null;
    onChange?: (snapshot: OverlaySnapshot) => void;
}

interface OverlayEntry {
    registration: OverlayRegistration;
    trap: FocusTrapController | null;
    restoreTarget: HTMLElement | null;
    sequence: number;
    open: boolean;
}

interface InertRecord {
    element: HTMLElement;
    hadInert: boolean;
    ariaHidden: string | null;
}

const normalizeId = (value: string): string => value.trim();
const modalityOf = (registration: OverlayRegistration): OverlayModality => registration.modality ?? "modal";
const isModal = (entry: OverlayEntry): boolean => modalityOf(entry.registration) === "modal";

export class OverlayCoordinator {
    private readonly document: Document;
    private readonly appRoot: HTMLElement | null;
    private readonly onChange: ((snapshot: OverlaySnapshot) => void) | undefined;
    private readonly entries = new Map<string, OverlayEntry>();
    private readonly inertRecords = new Map<HTMLElement, InertRecord>();
    private sequence = 0;
    private previousBodyOverflow: string | null = null;
    private destroyed = false;

    constructor(options: OverlayCoordinatorOptions = {}) {
        this.document = options.document ?? document;
        this.appRoot = options.appRoot ?? null;
        this.onChange = options.onChange;
    }

    open(registration: OverlayRegistration): OverlayHandle {
        this.assertActive();
        const id = normalizeId(registration.id);
        if (!id) throw new Error("Overlay id boş olamaz.");
        if (!registration.element.isConnected) throw new Error(`Overlay DOM'a bağlı olmalı: ${id}`);
        if (this.entries.has(id)) throw new Error(`Overlay id zaten açık: ${id}`);

        const normalized: OverlayRegistration = { ...registration, id };
        const activeElement = this.document.activeElement;
        const entry: OverlayEntry = {
            registration: normalized,
            trap: null,
            restoreTarget: normalized.trigger ?? (activeElement instanceof HTMLElement ? activeElement : null),
            sequence: ++this.sequence,
            open: true
        };
        this.entries.set(id, entry);
        this.prepareSemantics(entry);
        this.reconcile();
        normalized.onOpen?.();
        this.emit();

        return {
            id,
            close: (reason = "programmatic") => this.close(id, reason),
            requestClose: (reason = "programmatic") => this.requestClose(id, reason),
            bringToFront: () => this.bringToFront(id),
            update: (next) => this.update(id, next),
            isOpen: () => this.entries.get(id)?.open === true
        };
    }

    close(id: string, reason: OverlayDismissReason = "programmatic"): void {
        const entry = this.entries.get(id);
        if (!entry?.open) return;
        entry.open = false;
        const hadTrap = entry.trap !== null;
        entry.trap?.deactivate({ restoreFocus: false });
        entry.trap = null;
        this.entries.delete(id);
        entry.registration.element.removeAttribute("data-overlay-topmost");
        this.reconcile();
        const topmost = this.ordered().at(-1) ?? null;
        if (hadTrap && entry.registration.restoreFocus !== false && (!topmost || !isModal(topmost))) {
            focusSafely(entry.restoreTarget);
        }
        entry.registration.onClose?.(reason);
        this.emit();
    }

    requestClose(id: string, reason: OverlayDismissReason = "programmatic"): void {
        const entry = this.entries.get(id);
        if (!entry?.open) return;
        if (reason === "escape" && entry.registration.closeOnEscape === false) return;
        if (reason === "backdrop" && entry.registration.closeOnBackdrop === false) return;
        if (entry.registration.onRequestClose) entry.registration.onRequestClose(reason);
        else this.close(id, reason);
    }

    bringToFront(id: string): void {
        const entry = this.entries.get(id);
        if (!entry?.open) return;
        entry.sequence = ++this.sequence;
        this.reconcile();
        this.emit();
    }

    update(id: string, next: Partial<Omit<OverlayRegistration, "id" | "element">>): void {
        const entry = this.entries.get(id);
        if (!entry?.open) return;
        entry.registration = { ...entry.registration, ...next, id, element: entry.registration.element };
        this.prepareSemantics(entry);
        this.reconcile();
        this.emit();
    }

    snapshot(): OverlaySnapshot {
        const ordered = this.ordered();
        const topmost = ordered.at(-1) ?? null;
        const items = ordered.map((entry): OverlaySnapshotItem => Object.freeze({
            id: entry.registration.id,
            kind: entry.registration.kind,
            modality: modalityOf(entry.registration),
            topmost: entry === topmost
        }));
        return Object.freeze({
            size: ordered.length,
            modalCount: ordered.filter(isModal).length,
            topmostId: topmost?.registration.id ?? null,
            items: Object.freeze(items)
        });
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        const entries = this.ordered().reverse();
        for (const entry of entries) {
            entry.trap?.deactivate({ restoreFocus: false });
            entry.registration.element.removeAttribute("data-overlay-topmost");
        }
        this.entries.clear();
        this.restoreInert();
        this.restoreScroll();
    }

    private ordered(): OverlayEntry[] {
        return [...this.entries.values()].filter((entry) => entry.open).sort((a, b) => a.sequence - b.sequence);
    }

    private prepareSemantics(entry: OverlayEntry): void {
        const { element, kind } = entry.registration;
        if ((kind === "dialog" || kind === "drawer" || kind === "sheet") && !element.hasAttribute("role")) {
            element.setAttribute("role", "dialog");
        }
        if (isModal(entry)) element.setAttribute("aria-modal", "true");
        else element.removeAttribute("aria-modal");
        element.setAttribute("data-overlay-kind", kind);
    }

    private reconcile(): void {
        const ordered = this.ordered();
        const topmost = ordered.at(-1) ?? null;
        for (const entry of ordered) {
            const isTopmost = entry === topmost;
            entry.registration.element.toggleAttribute("data-overlay-topmost", isTopmost);
            if (!isTopmost && entry.trap) {
                entry.trap.deactivate({ restoreFocus: false });
                entry.trap = null;
            }
        }
        if (topmost && isModal(topmost) && !topmost.trap) topmost.trap = this.createTrap(topmost);
        this.reconcileInert(ordered);
        this.reconcileScroll(ordered);
    }

    private createTrap(entry: OverlayEntry): FocusTrapController {
        const registration = entry.registration;
        const trap = createFocusTrap({
            container: registration.element,
            initialFocus: registration.initialFocus ?? null,
            fallbackFocus: registration.fallbackFocus ?? registration.element,
            returnFocus: registration.trigger ?? null,
            escapeDeactivates: false
        });
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape" || this.ordered().at(-1) !== entry) return;
            if (registration.closeOnEscape === false) return;
            event.preventDefault();
            event.stopPropagation();
            this.requestClose(registration.id, "escape");
        };
        registration.element.addEventListener("keydown", onKeyDown);
        const originalDeactivate = trap.deactivate.bind(trap);
        trap.deactivate = (options) => {
            registration.element.removeEventListener("keydown", onKeyDown);
            originalDeactivate(options);
        };
        trap.activate();
        return trap;
    }

    private reconcileInert(ordered: OverlayEntry[]): void {
        this.restoreInert();
        const topModal = [...ordered].reverse().find((entry) => isModal(entry) && entry.registration.inertSiblings !== false);
        if (!topModal) return;
        const root = this.appRoot ?? this.document.body;
        const overlay = topModal.registration.element;
        const protectedBranch = this.directChildContaining(root, overlay);
        for (const child of Array.from(root.children)) {
            if (!(child instanceof HTMLElement) || child === protectedBranch || child.contains(overlay)) continue;
            this.inertRecords.set(child, {
                element: child,
                hadInert: child.hasAttribute("inert"),
                ariaHidden: child.getAttribute("aria-hidden")
            });
            child.setAttribute("inert", "");
            child.setAttribute("aria-hidden", "true");
        }
    }

    private directChildContaining(root: HTMLElement, target: HTMLElement): HTMLElement | null {
        let current: HTMLElement | null = target;
        while (current?.parentElement && current.parentElement !== root) current = current.parentElement;
        return current?.parentElement === root ? current : null;
    }

    private restoreInert(): void {
        for (const record of this.inertRecords.values()) {
            if (!record.hadInert) record.element.removeAttribute("inert");
            if (record.ariaHidden === null) record.element.removeAttribute("aria-hidden");
            else record.element.setAttribute("aria-hidden", record.ariaHidden);
        }
        this.inertRecords.clear();
    }

    private reconcileScroll(ordered: OverlayEntry[]): void {
        const shouldLock = ordered.some((entry) => isModal(entry) && entry.registration.lockDocumentScroll !== false);
        if (shouldLock && this.previousBodyOverflow === null) {
            this.previousBodyOverflow = this.document.body.style.overflow;
            this.document.body.style.overflow = "hidden";
        } else if (!shouldLock) this.restoreScroll();
    }

    private restoreScroll(): void {
        if (this.previousBodyOverflow === null) return;
        this.document.body.style.overflow = this.previousBodyOverflow;
        this.previousBodyOverflow = null;
    }

    private emit(): void {
        this.onChange?.(this.snapshot());
    }

    private assertActive(): void {
        if (this.destroyed) throw new Error("OverlayCoordinator destroy edildikten sonra kullanılamaz.");
    }
}

export const createOverlayCoordinator = (options: OverlayCoordinatorOptions = {}): OverlayCoordinator =>
    new OverlayCoordinator(options);
