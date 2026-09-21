export type InteractionModality = "keyboard" | "pointer" | "touch" | "programmatic";

export interface InteractionModalitySnapshot {
    modality: InteractionModality;
    keyboardIntent: boolean;
    focusVisible: boolean;
    revision: number;
}

export interface InteractionModalityOptions {
    document?: Document;
    reflectToDocument?: boolean;
    onError?: (error: unknown) => void;
}

export type InteractionModalityListener = (
    snapshot: Readonly<InteractionModalitySnapshot>,
    previous: Readonly<InteractionModalitySnapshot>,
) => void;

const NAVIGATION_KEYS = new Set([
    "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
    "Enter", " ", "Escape",
]);

const clone = (value: InteractionModalitySnapshot): InteractionModalitySnapshot => ({ ...value });

export class InteractionModalityRuntime {
    private readonly document: Document;
    private readonly reflectToDocument: boolean;
    private readonly onError: ((error: unknown) => void) | undefined;
    private readonly listeners = new Set<InteractionModalityListener>();
    private current: InteractionModalitySnapshot = {
        modality: "programmatic",
        keyboardIntent: false,
        focusVisible: false,
        revision: 0,
    };
    private disposed = false;

    constructor(options: InteractionModalityOptions = {}) {
        const document = options.document ?? globalThis.document;
        if (!document) throw new Error("InteractionModalityRuntime bir Document gerektirir.");
        this.document = document;
        this.reflectToDocument = options.reflectToDocument ?? true;
        this.onError = options.onError;
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("pointerdown", this.onPointerDown, true);
        document.addEventListener("focusin", this.onFocusIn, true);
        document.addEventListener("focusout", this.onFocusOut, true);
        this.reflect();
    }

    get snapshot(): Readonly<InteractionModalitySnapshot> {
        return clone(this.current);
    }

    subscribe(listener: InteractionModalityListener, emitCurrent = false): () => void {
        this.assertActive();
        this.listeners.add(listener);
        if (emitCurrent) listener(this.snapshot, this.snapshot);
        return () => this.listeners.delete(listener);
    }

    markProgrammatic(): void {
        this.assertActive();
        this.commit("programmatic", false, this.hasFocus());
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.document.removeEventListener("keydown", this.onKeyDown, true);
        this.document.removeEventListener("pointerdown", this.onPointerDown, true);
        this.document.removeEventListener("focusin", this.onFocusIn, true);
        this.document.removeEventListener("focusout", this.onFocusOut, true);
        this.listeners.clear();
        if (this.reflectToDocument) {
            const root = this.document.documentElement;
            delete root.dataset.interactionModality;
            delete root.dataset.keyboardIntent;
        }
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (!NAVIGATION_KEYS.has(event.key) && event.key.length !== 1) return;
        this.commit("keyboard", true, this.hasFocus());
    };

    private readonly onPointerDown = (event: PointerEvent): void => {
        const modality: InteractionModality = event.pointerType === "touch" ? "touch" : "pointer";
        this.commit(modality, false, false);
    };

    private readonly onFocusIn = (): void => {
        this.commit(this.current.modality, this.current.keyboardIntent, this.current.keyboardIntent);
    };

    private readonly onFocusOut = (): void => {
        queueMicrotask(() => {
            if (this.disposed) return;
            if (!this.hasFocus()) this.commit(this.current.modality, this.current.keyboardIntent, false);
        });
    };

    private hasFocus(): boolean {
        const active = this.document.activeElement;
        return active instanceof HTMLElement && active !== this.document.body;
    }

    private commit(modality: InteractionModality, keyboardIntent: boolean, focusVisible: boolean): void {
        if (
            modality === this.current.modality &&
            keyboardIntent === this.current.keyboardIntent &&
            focusVisible === this.current.focusVisible
        ) return;
        const previous = clone(this.current);
        this.current = {
            modality,
            keyboardIntent,
            focusVisible,
            revision: this.current.revision + 1,
        };
        this.reflect();
        const next = clone(this.current);
        for (const listener of this.listeners) {
            try {
                listener(next, clone(previous));
            } catch (error) {
                this.report(error);
            }
        }
    }

    private reflect(): void {
        if (!this.reflectToDocument) return;
        const root = this.document.documentElement;
        root.dataset.interactionModality = this.current.modality;
        root.dataset.keyboardIntent = this.current.keyboardIntent ? "true" : "false";
    }

    private report(error: unknown): void {
        if (this.onError) {
            try {
                this.onError(error);
                return;
            } catch (reportingError) {
                queueMicrotask(() => { throw reportingError; });
                return;
            }
        }
        queueMicrotask(() => { throw error; });
    }

    private assertActive(): void {
        if (this.disposed) throw new Error("InteractionModalityRuntime dispose edildikten sonra kullanılamaz.");
    }
}

export const createInteractionModalityRuntime = (
    options: InteractionModalityOptions = {},
): InteractionModalityRuntime => new InteractionModalityRuntime(options);
