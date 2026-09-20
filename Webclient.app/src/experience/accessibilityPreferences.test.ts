import { AccessibilityPreferencesRuntime, createAccessibilityPreferencesRuntime } from "./accessibilityPreferences";

type Listener = (event: MediaQueryListEvent) => void;

class MockMediaQueryList implements MediaQueryList {
    readonly media: string;
    onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;
    private listeners = new Set<Listener>();
    private legacyListeners = new Set<(this: MediaQueryList, ev: MediaQueryListEvent) => unknown>();
    matches = false;

    constructor(media: string) { this.media = media; }

    addEventListener(_type: "change", listener: EventListenerOrEventListenerObject | null): void {
        if (typeof listener === "function") this.listeners.add(listener as Listener);
    }
    removeEventListener(_type: "change", listener: EventListenerOrEventListenerObject | null): void {
        if (typeof listener === "function") this.listeners.delete(listener as Listener);
    }
    addListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void {
        if (callback) this.legacyListeners.add(callback);
    }
    removeListener(callback: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null): void {
        if (callback) this.legacyListeners.delete(callback);
    }
    dispatchEvent(): boolean { return true; }

    setMatches(matches: boolean): void {
        if (this.matches === matches) return;
        this.matches = matches;
        const event = { matches, media: this.media } as MediaQueryListEvent;
        this.listeners.forEach(listener => listener(event));
        this.legacyListeners.forEach(listener => listener.call(this, event));
        this.onchange?.call(this, event);
    }

    get listenerCount(): number { return this.listeners.size + this.legacyListeners.size; }
}

const makeWindow = () => {
    const queries = new Map<string, MockMediaQueryList>();
    const matchMedia = (query: string): MediaQueryList => {
        let media = queries.get(query);
        if (!media) { media = new MockMediaQueryList(query); queries.set(query, media); }
        return media;
    };
    return { window: { matchMedia, document } as unknown as Window, queries };
};

const query = (queries: Map<string, MockMediaQueryList>, value: string): MockMediaQueryList => {
    const result = queries.get(value);
    if (!result) throw new Error(`Missing query ${value}`);
    return result;
};

afterEach(() => {
    for (const key of ["reducedMotion", "forcedColors", "contrast", "pointer", "hover", "colorScheme"]) delete document.documentElement.dataset[key];
});

describe("AccessibilityPreferencesRuntime", () => {
    test("reads a deterministic initial preference snapshot", () => {
        const { window } = makeWindow();
        const runtime = new AccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        expect(runtime.snapshot).toEqual({ reducedMotion: false, forcedColors: false, contrast: "no-preference", darkScheme: false, pointer: "none", hoverCapable: false, revision: 0 });
        runtime.dispose();
    });

    test("tracks reduced motion and forced colors changes", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        query(queries, "(prefers-reduced-motion: reduce)").setMatches(true);
        query(queries, "(forced-colors: active)").setMatches(true);
        expect(runtime.snapshot.reducedMotion).toBe(true);
        expect(runtime.snapshot.forcedColors).toBe(true);
        expect(runtime.snapshot.revision).toBe(2);
        runtime.dispose();
    });

    test("resolves contrast preference with deterministic precedence", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        query(queries, "(prefers-contrast: less)").setMatches(true);
        expect(runtime.snapshot.contrast).toBe("less");
        query(queries, "(prefers-contrast: more)").setMatches(true);
        expect(runtime.snapshot.contrast).toBe("more");
        query(queries, "(prefers-contrast: custom)").setMatches(true);
        expect(runtime.snapshot.contrast).toBe("custom");
        runtime.dispose();
    });

    test("prefers coarse pointer when multiple pointer queries match", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        query(queries, "(pointer: fine)").setMatches(true);
        expect(runtime.snapshot.pointer).toBe("fine");
        query(queries, "(pointer: coarse)").setMatches(true);
        expect(runtime.snapshot.pointer).toBe("coarse");
        runtime.dispose();
    });

    test("tracks hover and color scheme without coupling them", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        query(queries, "(hover: hover)").setMatches(true);
        expect(runtime.snapshot.hoverCapable).toBe(true);
        expect(runtime.snapshot.darkScheme).toBe(false);
        query(queries, "(prefers-color-scheme: dark)").setMatches(true);
        expect(runtime.snapshot.darkScheme).toBe(true);
        runtime.dispose();
    });

    test("notifies subscribers with previous and current snapshots", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        const calls: Array<[boolean, boolean]> = [];
        runtime.subscribe((current, previous) => calls.push([previous.reducedMotion, current.reducedMotion]));
        query(queries, "(prefers-reduced-motion: reduce)").setMatches(true);
        expect(calls).toEqual([[false, true]]);
        runtime.dispose();
    });

    test("supports immediate subscription snapshots", () => {
        const { window } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        const revisions: number[] = [];
        runtime.subscribe(current => revisions.push(current.revision), true);
        expect(revisions).toEqual([0]);
        runtime.dispose();
    });

    test("unsubscribe prevents future notifications", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        let count = 0;
        const unsubscribe = runtime.subscribe(() => { count += 1; });
        unsubscribe();
        query(queries, "(forced-colors: active)").setMatches(true);
        expect(count).toBe(0);
        runtime.dispose();
    });

    test("isolates observer failures", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        let healthyCalls = 0;
        runtime.subscribe(() => { throw new Error("observer failure"); });
        runtime.subscribe(() => { healthyCalls += 1; });
        expect(() => query(queries, "(hover: hover)").setMatches(true)).not.toThrow();
        expect(healthyCalls).toBe(1);
        expect(runtime.snapshot.hoverCapable).toBe(true);
        runtime.dispose();
    });

    test("returns defensive snapshot copies", () => {
        const { window } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        const snapshot = runtime.snapshot as { reducedMotion: boolean };
        snapshot.reducedMotion = true;
        expect(runtime.snapshot.reducedMotion).toBe(false);
        runtime.dispose();
    });

    test("does not increment revision for a no-op explicit refresh", () => {
        const { window } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        runtime.refresh();
        expect(runtime.snapshot.revision).toBe(0);
        runtime.dispose();
    });

    test("reflects accessibility preferences onto the document root", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, document, reflectToDocument: true, applyColorScheme: true });
        expect(document.documentElement.dataset.reducedMotion).toBe("no-preference");
        expect(document.documentElement.dataset.pointer).toBe("none");
        query(queries, "(prefers-reduced-motion: reduce)").setMatches(true);
        query(queries, "(forced-colors: active)").setMatches(true);
        query(queries, "(pointer: coarse)").setMatches(true);
        query(queries, "(prefers-color-scheme: dark)").setMatches(true);
        expect(document.documentElement.dataset.reducedMotion).toBe("reduce");
        expect(document.documentElement.dataset.forcedColors).toBe("active");
        expect(document.documentElement.dataset.pointer).toBe("coarse");
        expect(document.documentElement.dataset.colorScheme).toBe("dark");
        runtime.dispose();
    });

    test("can avoid document reflection entirely", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, document, reflectToDocument: false });
        query(queries, "(prefers-reduced-motion: reduce)").setMatches(true);
        expect(document.documentElement.dataset.reducedMotion).toBeUndefined();
        runtime.dispose();
    });

    test("clears only its reflection keys on dispose", () => {
        document.documentElement.dataset.application = "kent-rehberi";
        const { window } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, document, reflectToDocument: true });
        runtime.dispose();
        expect(document.documentElement.dataset.reducedMotion).toBeUndefined();
        expect(document.documentElement.dataset.application).toBe("kent-rehberi");
        delete document.documentElement.dataset.application;
    });

    test("removes media listeners during deterministic teardown", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        expect(Array.from(queries.values()).every(media => media.listenerCount === 1)).toBe(true);
        runtime.dispose();
        expect(Array.from(queries.values()).every(media => media.listenerCount === 0)).toBe(true);
        expect(runtime.isDisposed).toBe(true);
    });

    test("dispose is idempotent", () => {
        const { window } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        expect(() => { runtime.dispose(); runtime.dispose(); }).not.toThrow();
    });

    test("rejects active operations after dispose", () => {
        const { window } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        runtime.dispose();
        expect(() => runtime.refresh()).toThrow(/dispose/);
        expect(() => runtime.subscribe(() => undefined)).toThrow(/dispose/);
    });

    test("rejects windows without matchMedia", () => {
        expect(() => createAccessibilityPreferencesRuntime({ window: { document } as Window })).toThrow(/matchMedia/);
    });

    test("coalesces preference changes triggered from a subscriber", () => {
        const { window, queries } = makeWindow();
        const runtime = createAccessibilityPreferencesRuntime({ window, reflectToDocument: false });
        const revisions: number[] = [];
        runtime.subscribe(current => {
            revisions.push(current.revision);
            if (current.reducedMotion && !current.forcedColors) query(queries, "(forced-colors: active)").setMatches(true);
        });
        query(queries, "(prefers-reduced-motion: reduce)").setMatches(true);
        expect(runtime.snapshot).toMatchObject({ reducedMotion: true, forcedColors: true });
        expect(revisions).toEqual([1, 2]);
        runtime.dispose();
    });
});
