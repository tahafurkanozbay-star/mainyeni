import {
    DEFAULT_EXPERIENCE_PREFERENCES,
    EXPERIENCE_COMMAND_EVENT,
    EXPERIENCE_PREFERENCE_EVENT,
    classifyViewport,
    createExperienceBus,
    createPreferenceStore,
    createRuntimeSnapshot,
    formatShortcut,
    getCommandByName,
    isExperienceCommandName,
    mapModeAnnouncement,
    mapModeLabel,
    mergeExperiencePreferences,
    nextMapMode,
    normalizeCommandDetail,
    normalizeExperiencePreferences,
    normalizeSearchText,
    parseExperiencePreferences,
    readExperiencePreferences,
    resolveConnectivity,
    resolveEffectiveTheme,
    resolvePanelPlacement,
    resolveReducedMotion,
    searchExperienceCommands,
    serializeExperiencePreferences,
    writeExperiencePreferences
} from "./experienceRuntime";

class MemoryStorage {
    constructor(seed = {}) {
        this.values = new Map(Object.entries(seed));
        this.writes = [];
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        const text = String(value);
        this.values.set(key, text);
        this.writes.push([key, text]);
    }
}

describe("experienceRuntime preferences", () => {
    test("normalizes unknown input to the stable defaults", () => {
        expect(normalizeExperiencePreferences(null)).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
        expect(normalizeExperiencePreferences("not-an-object")).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
        expect(normalizeExperiencePreferences([])).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
    });

    test("keeps only supported preference values", () => {
        expect(normalizeExperiencePreferences({
            theme: "dark",
            density: "compact",
            motion: "reduced",
            panelPlacement: "left",
            lastMapMode: "3d",
            utilityCollapsed: true,
            showCoordinateReadout: false,
            highContrastMapControls: true,
            unexpected: "ignored"
        })).toEqual({
            theme: "dark",
            density: "compact",
            motion: "reduced",
            panelPlacement: "left",
            lastMapMode: "3d",
            utilityCollapsed: true,
            showCoordinateReadout: false,
            highContrastMapControls: true
        });
    });

    test("rejects invalid enum and non-boolean values independently", () => {
        const preferences = normalizeExperiencePreferences({
            theme: "sepia",
            density: "tiny",
            motion: "instant",
            panelPlacement: "top",
            lastMapMode: "4d",
            utilityCollapsed: "yes",
            showCoordinateReadout: 1,
            highContrastMapControls: null
        });

        expect(preferences).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
    });

    test("parses malformed persistence without leaking an exception", () => {
        expect(parseExperiencePreferences("{broken-json")).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
        expect(parseExperiencePreferences(null)).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
    });

    test("serializes a normalized persistence payload", () => {
        const serialized = serializeExperiencePreferences({
            ...DEFAULT_EXPERIENCE_PREFERENCES,
            theme: "dark",
            density: "compact"
        });
        expect(JSON.parse(serialized)).toEqual({
            ...DEFAULT_EXPERIENCE_PREFERENCES,
            theme: "dark",
            density: "compact"
        });
    });

    test("merges partial preference patches while retaining invariants", () => {
        const merged = mergeExperiencePreferences(DEFAULT_EXPERIENCE_PREFERENCES, {
            theme: "dark",
            showCoordinateReadout: false
        });
        expect(merged.theme).toBe("dark");
        expect(merged.showCoordinateReadout).toBe(false);
        expect(merged.density).toBe("comfortable");
    });

    test("reads and writes through a storage-like contract", () => {
        const storage = new MemoryStorage();
        const next = { ...DEFAULT_EXPERIENCE_PREFERENCES, theme: "dark" };
        expect(writeExperiencePreferences(storage, next)).toBe(true);
        expect(storage.writes).toHaveLength(1);
        expect(readExperiencePreferences(storage).theme).toBe("dark");
    });

    test("storage failures degrade to defaults instead of breaking startup", () => {
        const throwingStorage = {
            getItem() { throw new Error("read blocked"); },
            setItem() { throw new Error("write blocked"); }
        };
        expect(readExperiencePreferences(throwingStorage)).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
        expect(writeExperiencePreferences(throwingStorage, DEFAULT_EXPERIENCE_PREFERENCES)).toBe(false);
    });
});

describe("experienceRuntime preference store", () => {
    test("publishes changes to storage, event bus and subscribers", () => {
        const storage = new MemoryStorage();
        const target = new EventTarget();
        const bus = createExperienceBus(target);
        const eventListener = vi.fn();
        const subscriber = vi.fn();
        const releaseEvent = bus.on(EXPERIENCE_PREFERENCE_EVENT, eventListener);
        const store = createPreferenceStore({ storage, bus });
        const releaseSubscriber = store.subscribe(subscriber);

        const next = store.set({ theme: "dark", density: "compact" });

        expect(next.theme).toBe("dark");
        expect(next.density).toBe("compact");
        expect(storage.writes).toHaveLength(1);
        expect(eventListener).toHaveBeenCalledWith(next, expect.any(Event));
        expect(subscriber).toHaveBeenCalledWith(next);

        releaseEvent();
        releaseSubscriber();
        store.set({ theme: "light" });
        expect(eventListener).toHaveBeenCalledTimes(1);
        expect(subscriber).toHaveBeenCalledTimes(1);
    });

    test("supports replace and reset without carrying unknown properties", () => {
        const storage = new MemoryStorage();
        const store = createPreferenceStore({ storage, bus: createExperienceBus(new EventTarget()) });
        const replaced = store.replace({
            ...DEFAULT_EXPERIENCE_PREFERENCES,
            panelPlacement: "bottom",
            theme: "dark",
            ignored: "x"
        });
        expect(replaced.panelPlacement).toBe("bottom");
        expect(replaced.ignored).toBeUndefined();

        const reset = store.reset();
        expect(reset).toEqual(DEFAULT_EXPERIENCE_PREFERENCES);
    });

    test("combines persisted state with explicit initial state", () => {
        const persisted = serializeExperiencePreferences({
            ...DEFAULT_EXPERIENCE_PREFERENCES,
            theme: "dark",
            density: "compact"
        });
        const storage = new MemoryStorage({
            "kent-rehberi-experience-preferences-v2": persisted
        });
        const store = createPreferenceStore({
            storage,
            bus: createExperienceBus(new EventTarget()),
            initial: { theme: "light" }
        });
        expect(store.get().theme).toBe("light");
        expect(store.get().density).toBe("compact");
    });
});

describe("experienceRuntime command catalog", () => {
    test("normalizes Turkish search text consistently", () => {
        expect(normalizeSearchText("  ÖLÇÜM / İSTANBUL  ")).toBe("olcum istanbul");
        expect(normalizeSearchText("Çizim---Aracı")).toBe("cizim---araci");
    });

    test("finds commands by label, keyword and multi-word intent", () => {
        expect(searchExperienceCommands("ölçüm")[0].name).toBe("measure");
        expect(searchExperienceCommands("katman")[0].name).toBe("layers");
        expect(searchExperienceCommands("3b sahne").some(command => command.name === "map-mode")).toBe(true);
        expect(searchExperienceCommands("klavye panel").some(command => command.name === "focus-sidebar")).toBe(true);
    });

    test("keeps deterministic catalog ordering for an empty query", () => {
        const first = searchExperienceCommands("", undefined, 4).map(command => command.name);
        const second = searchExperienceCommands("", undefined, 4).map(command => command.name);
        expect(first).toEqual(second);
        expect(first).toHaveLength(4);
    });

    test("clamps result limits to a useful safe range", () => {
        expect(searchExperienceCommands("", undefined, 0)).toHaveLength(8);
        expect(searchExperienceCommands("", undefined, 1)).toHaveLength(1);
        expect(searchExperienceCommands("", undefined, 500).length).toBeLessThanOrEqual(50);
    });

    test("exposes stable command lookup and shortcut formatting", () => {
        expect(getCommandByName("map-mode").label).toMatch(/2B/);
        expect(getCommandByName("not-real")).toBeUndefined();
        expect(formatShortcut(["Ctrl", "K"])).toBe("Ctrl + K");
        expect(formatShortcut()).toBe("");
    });

    test("validates and normalizes command details", () => {
        expect(isExperienceCommandName("map-mode")).toBe(true);
        expect(isExperienceCommandName("destroy-city")).toBe(false);
        expect(normalizeCommandDetail({ name: "unknown" })).toBeNull();

        const detail = normalizeCommandDetail({
            name: "map-mode",
            mode: "3d",
            source: "  test  ",
            query: "Ankara",
            timestamp: "42",
            payload: { origin: "keyboard" }
        });
        expect(detail).toEqual({
            name: "map-mode",
            mode: "3d",
            source: "test",
            query: "Ankara",
            timestamp: 42,
            payload: { origin: "keyboard" }
        });
    });

    test("event bus emits normalized command events and supports unsubscribe", () => {
        const target = new EventTarget();
        const bus = createExperienceBus(target);
        const listener = vi.fn();
        const release = bus.on(EXPERIENCE_COMMAND_EVENT, listener);

        expect(bus.command({ name: "map-mode", mode: "3d", source: "test" })).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toEqual(expect.objectContaining({
            name: "map-mode",
            mode: "3d",
            source: "test"
        }));

        release();
        bus.command({ name: "map-mode", mode: "2d" });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(bus.command({ name: "unknown" })).toBe(false);
    });
});

describe("experienceRuntime environment decisions", () => {
    test.each([
        [0, "compact"],
        [719, "compact"],
        [720, "medium"],
        [1199, "medium"],
        [1200, "wide"],
        [1920, "wide"]
    ])("classifies viewport %s as %s", (width, expected) => {
        expect(classifyViewport(width)).toBe(expected);
    });

    test("normalizes invalid viewport widths to compact", () => {
        expect(classifyViewport(Number.NaN)).toBe("compact");
        expect(classifyViewport(-100)).toBe("compact");
    });

    test("derives online state only when the navigator contract is known", () => {
        expect(resolveConnectivity({ onLine: true })).toBe("online");
        expect(resolveConnectivity({ onLine: false })).toBe("offline");
        expect(resolveConnectivity({})).toBe("unknown");
        expect(resolveConnectivity(null)).toBe("unknown");
    });

    test("resolves system theme without overriding explicit choices", () => {
        expect(resolveEffectiveTheme("system", true)).toBe("dark");
        expect(resolveEffectiveTheme("system", false)).toBe("light");
        expect(resolveEffectiveTheme("dark", false)).toBe("dark");
        expect(resolveEffectiveTheme("light", true)).toBe("light");
    });

    test("resolves motion preference deterministically", () => {
        expect(resolveReducedMotion("system", true)).toBe(true);
        expect(resolveReducedMotion("system", false)).toBe(false);
        expect(resolveReducedMotion("reduced", false)).toBe(true);
        expect(resolveReducedMotion("full", true)).toBe(false);
    });

    test("uses a bottom panel on compact auto layouts", () => {
        expect(resolvePanelPlacement("auto", "compact")).toBe("bottom");
        expect(resolvePanelPlacement("auto", "medium")).toBe("right");
        expect(resolvePanelPlacement("auto", "wide")).toBe("right");
        expect(resolvePanelPlacement("left", "compact")).toBe("left");
    });

    test("builds one normalized runtime snapshot", () => {
        const snapshot = createRuntimeSnapshot({
            preferences: { theme: "dark", motion: "reduced" },
            width: 1440,
            online: false,
            systemReducedMotion: false,
            forcedColors: true,
            coarsePointer: true,
            standalone: true
        });
        expect(snapshot.viewport).toBe("wide");
        expect(snapshot.connectivity).toBe("offline");
        expect(snapshot.reducedMotion).toBe(true);
        expect(snapshot.forcedColors).toBe(true);
        expect(snapshot.coarsePointer).toBe(true);
        expect(snapshot.standalone).toBe(true);
        expect(snapshot.preferences.theme).toBe("dark");
    });

    test("provides deterministic map-mode copy", () => {
        expect(nextMapMode("2d")).toBe("3d");
        expect(nextMapMode("3d")).toBe("2d");
        expect(mapModeLabel("2d")).toBe("2B");
        expect(mapModeLabel("3d")).toBe("3B");
        expect(mapModeAnnouncement("2d")).toMatch(/2B/);
        expect(mapModeAnnouncement("3d")).toMatch(/3B/);
    });
});
