export type ContrastPreference = "no-preference" | "more" | "less" | "custom";
export type MotionPreference = "no-preference" | "reduce";
export type PointerAccuracy = "fine" | "coarse" | "none";

export interface AccessibilityPreferencesSnapshot {
    reducedMotion: boolean;
    forcedColors: boolean;
    contrast: ContrastPreference;
    darkScheme: boolean;
    pointer: PointerAccuracy;
    hoverCapable: boolean;
    revision: number;
}

export interface AccessibilityPreferencesRuntimeOptions {
    window?: Window;
    document?: Document;
    reflectToDocument?: boolean;
    applyColorScheme?: boolean;
}

export type AccessibilityPreferencesListener = (
    snapshot: Readonly<AccessibilityPreferencesSnapshot>,
    previous: Readonly<AccessibilityPreferencesSnapshot>,
) => void;

interface QueryBinding {
    query: string;
    media: MediaQueryList;
    listener: (event: MediaQueryListEvent) => void;
}

const QUERIES = {
    reducedMotion: "(prefers-reduced-motion: reduce)",
    forcedColors: "(forced-colors: active)",
    contrastMore: "(prefers-contrast: more)",
    contrastLess: "(prefers-contrast: less)",
    contrastCustom: "(prefers-contrast: custom)",
    darkScheme: "(prefers-color-scheme: dark)",
    pointerFine: "(pointer: fine)",
    pointerCoarse: "(pointer: coarse)",
    hover: "(hover: hover)",
} as const;

type QueryKey = keyof typeof QUERIES;

const snapshotEqual = (left: AccessibilityPreferencesSnapshot, right: AccessibilityPreferencesSnapshot): boolean =>
    left.reducedMotion === right.reducedMotion
    && left.forcedColors === right.forcedColors
    && left.contrast === right.contrast
    && left.darkScheme === right.darkScheme
    && left.pointer === right.pointer
    && left.hoverCapable === right.hoverCapable;

const cloneSnapshot = (snapshot: AccessibilityPreferencesSnapshot): AccessibilityPreferencesSnapshot => ({ ...snapshot });

function resolveContrast(matches: (key: QueryKey) => boolean): ContrastPreference {
    if (matches("contrastCustom")) return "custom";
    if (matches("contrastMore")) return "more";
    if (matches("contrastLess")) return "less";
    return "no-preference";
}

function resolvePointer(matches: (key: QueryKey) => boolean): PointerAccuracy {
    if (matches("pointerCoarse")) return "coarse";
    if (matches("pointerFine")) return "fine";
    return "none";
}

function safeDatasetWrite(element: HTMLElement, key: string, value: string): void {
    if (element.dataset[key] === value) return;
    element.dataset[key] = value;
}

function safeDatasetDelete(element: HTMLElement, key: string): void {
    if (key in element.dataset) delete element.dataset[key];
}

export class AccessibilityPreferencesRuntime {
    private readonly runtimeWindow: Window;
    private readonly runtimeDocument: Document | undefined;
    private readonly reflectToDocument: boolean;
    private readonly applyColorScheme: boolean;
    private readonly bindings = new Map<QueryKey, QueryBinding>();
    private readonly listeners = new Set<AccessibilityPreferencesListener>();
    private current: AccessibilityPreferencesSnapshot;
    private disposed = false;
    private dispatching = false;
    private pendingRefresh = false;

    constructor(options: AccessibilityPreferencesRuntimeOptions = {}) {
        const runtimeWindow = options.window ?? globalThis.window;
        if (!runtimeWindow || typeof runtimeWindow.matchMedia !== "function") {
            throw new Error("AccessibilityPreferencesRuntime matchMedia destekleyen bir Window gerektirir.");
        }
        this.runtimeWindow = runtimeWindow;
        this.runtimeDocument = options.document ?? runtimeWindow.document;
        this.reflectToDocument = options.reflectToDocument ?? true;
        this.applyColorScheme = options.applyColorScheme ?? false;

        (Object.keys(QUERIES) as QueryKey[]).forEach(key => {
            const query = QUERIES[key];
            const media = this.runtimeWindow.matchMedia(query);
            const listener = (): void => this.requestRefresh();
            if (typeof media.addEventListener === "function") media.addEventListener("change", listener);
            else media.addListener?.(listener);
            this.bindings.set(key, { query, media, listener });
        });

        this.current = this.readSnapshot(0);
        this.reflect(this.current);
    }

    get snapshot(): Readonly<AccessibilityPreferencesSnapshot> {
        return cloneSnapshot(this.current);
    }

    get isDisposed(): boolean {
        return this.disposed;
    }

    subscribe(listener: AccessibilityPreferencesListener, emitCurrent = false): () => void {
        this.assertActive();
        this.listeners.add(listener);
        if (emitCurrent) {
            const current = cloneSnapshot(this.current);
            listener(current, current);
        }
        return () => { this.listeners.delete(listener); };
    }

    refresh(): Readonly<AccessibilityPreferencesSnapshot> {
        this.assertActive();
        this.refreshNow();
        return this.snapshot;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.bindings.forEach(({ media, listener }) => {
            if (typeof media.removeEventListener === "function") media.removeEventListener("change", listener);
            else media.removeListener?.(listener);
        });
        this.bindings.clear();
        this.listeners.clear();
        this.pendingRefresh = false;
        this.clearReflection();
    }

    private assertActive(): void {
        if (this.disposed) throw new Error("AccessibilityPreferencesRuntime dispose edildikten sonra kullanılamaz.");
    }

    private matches(key: QueryKey): boolean {
        return this.bindings.get(key)?.media.matches ?? false;
    }

    private readSnapshot(revision: number): AccessibilityPreferencesSnapshot {
        const matches = (key: QueryKey): boolean => this.matches(key);
        return {
            reducedMotion: matches("reducedMotion"),
            forcedColors: matches("forcedColors"),
            contrast: resolveContrast(matches),
            darkScheme: matches("darkScheme"),
            pointer: resolvePointer(matches),
            hoverCapable: matches("hover"),
            revision,
        };
    }

    private requestRefresh(): void {
        if (this.disposed) return;
        if (this.dispatching) {
            this.pendingRefresh = true;
            return;
        }
        this.refreshNow();
    }

    private refreshNow(): void {
        const next = this.readSnapshot(this.current.revision + 1);
        if (snapshotEqual(next, this.current)) return;
        const previous = this.current;
        this.current = next;
        this.reflect(next);
        this.dispatch(previous);
    }

    private dispatch(previous: AccessibilityPreferencesSnapshot): void {
        this.dispatching = true;
        try {
            const current = cloneSnapshot(this.current);
            for (const listener of Array.from(this.listeners)) {
                try {
                    listener(current, cloneSnapshot(previous));
                } catch {
                    // Observer failures must never break preference propagation.
                }
            }
        } finally {
            this.dispatching = false;
        }
        if (this.pendingRefresh) {
            this.pendingRefresh = false;
            this.refreshNow();
        }
    }

    private reflect(snapshot: AccessibilityPreferencesSnapshot): void {
        if (!this.reflectToDocument) return;
        const root = this.runtimeDocument?.documentElement;
        if (!root) return;
        safeDatasetWrite(root, "reducedMotion", snapshot.reducedMotion ? "reduce" : "no-preference");
        safeDatasetWrite(root, "forcedColors", snapshot.forcedColors ? "active" : "none");
        safeDatasetWrite(root, "contrast", snapshot.contrast);
        safeDatasetWrite(root, "pointer", snapshot.pointer);
        safeDatasetWrite(root, "hover", snapshot.hoverCapable ? "hover" : "none");
        if (this.applyColorScheme) safeDatasetWrite(root, "colorScheme", snapshot.darkScheme ? "dark" : "light");
    }

    private clearReflection(): void {
        if (!this.reflectToDocument) return;
        const root = this.runtimeDocument?.documentElement;
        if (!root) return;
        for (const key of ["reducedMotion", "forcedColors", "contrast", "pointer", "hover"] as const) safeDatasetDelete(root, key);
        if (this.applyColorScheme) safeDatasetDelete(root, "colorScheme");
    }
}

export function createAccessibilityPreferencesRuntime(options: AccessibilityPreferencesRuntimeOptions = {}): AccessibilityPreferencesRuntime {
    return new AccessibilityPreferencesRuntime(options);
}
