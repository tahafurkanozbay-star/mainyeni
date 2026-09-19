import {
    applyResponsivePolicy,
    classifyInput,
    classifyViewport,
    createResponsiveExperiencePolicy,
    createResponsivePolicyController,
    toResponsiveCssVariables
} from "./responsiveExperiencePolicy";

describe("responsiveExperiencePolicy", () => {
    test.each([
        [0, "compact"], [639, "compact"], [640, "medium"], [1023, "medium"],
        [1024, "expanded"], [1439, "expanded"], [1440, "wide"], [1920, "wide"]
    ])("classifies width %s as %s", (width, expected) => {
        expect(classifyViewport(width as number)).toBe(expected);
    });

    test("sanitizes invalid width", () => {
        expect(classifyViewport(Number.NaN)).toBe("compact");
    });

    test("classifies touch input", () => {
        expect(classifyInput({ coarsePointer: true, hover: false })).toBe("touch");
    });

    test("classifies hybrid input", () => {
        expect(classifyInput({ coarsePointer: true, hover: true })).toBe("hybrid");
    });

    test("classifies pointer input by default", () => {
        expect(classifyInput({})).toBe("pointer");
    });

    test("compact viewport uses sheet and collapsed navigation", () => {
        const policy = createResponsiveExperiencePolicy({ width: 390, height: 844 });
        expect(policy.viewportClass).toBe("compact");
        expect(policy.panelMode).toBe("sheet");
        expect(policy.navigationCollapsed).toBe(true);
        expect(policy.maxFloatingPanels).toBe(1);
        expect(policy.tablePageSize).toBe(10);
        expect(policy.tableStickyColumns).toBe(0);
    });

    test("wide viewport uses docked panels", () => {
        const policy = createResponsiveExperiencePolicy({ width: 1920, height: 1080 });
        expect(policy.panelMode).toBe("docked");
        expect(policy.maxFloatingPanels).toBe(4);
        expect(policy.navigationCollapsed).toBe(false);
        expect(policy.tableStickyColumns).toBe(2);
    });

    test("touch input forces comfortable density", () => {
        const policy = createResponsiveExperiencePolicy({ width: 1200, height: 800 }, { coarsePointer: true, density: "compact" });
        expect(policy.density).toBe("comfortable");
        expect(policy.touchTarget).toBe(48);
    });

    test("wide pointer viewport defaults to compact density", () => {
        const policy = createResponsiveExperiencePolicy({ width: 1600, height: 900 });
        expect(policy.density).toBe("compact");
        expect(policy.touchTarget).toBe(36);
    });

    test("explicit comfortable density is preserved for pointer input", () => {
        const policy = createResponsiveExperiencePolicy({ width: 1600, height: 900 }, { density: "comfortable" });
        expect(policy.density).toBe("comfortable");
        expect(policy.touchTarget).toBe(44);
    });

    test("reduced motion removes transition duration", () => {
        expect(createResponsiveExperiencePolicy({ width: 1200, height: 800 }, { reducedMotion: true }).motionDurationMs).toBe(0);
    });

    test("forced colors removes backdrop blur", () => {
        expect(createResponsiveExperiencePolicy({ width: 1200, height: 800 }, { forcedColors: true }).backdropBlur).toBe(0);
    });

    test("reduced transparency removes backdrop blur", () => {
        expect(createResponsiveExperiencePolicy({ width: 1200, height: 800 }, { reducedTransparency: true }).backdropBlur).toBe(0);
    });

    test("safe area contributes to map control insets", () => {
        const policy = createResponsiveExperiencePolicy({
            width: 390, height: 844, safeAreaTop: 47, safeAreaRight: 2, safeAreaBottom: 34, safeAreaLeft: 3
        });
        expect(policy.mapControlInset).toEqual({ top: 55, right: 10, bottom: 42, left: 11 });
    });

    test("invalid safe-area values are sanitized", () => {
        const policy = createResponsiveExperiencePolicy({ width: 390, height: 844, safeAreaTop: -10, safeAreaBottom: Number.NaN });
        expect(policy.mapControlInset.top).toBe(8);
        expect(policy.mapControlInset.bottom).toBe(8);
    });

    test("medium touch viewport uses sheet", () => {
        const policy = createResponsiveExperiencePolicy({ width: 800, height: 900 }, { coarsePointer: true });
        expect(policy.panelMode).toBe("sheet");
        expect(policy.navigationCollapsed).toBe(true);
    });

    test("medium pointer viewport uses drawer", () => {
        const policy = createResponsiveExperiencePolicy({ width: 800, height: 900 });
        expect(policy.panelMode).toBe("drawer");
        expect(policy.navigationCollapsed).toBe(false);
    });

    test("expanded viewport uses floating panels", () => {
        expect(createResponsiveExperiencePolicy({ width: 1200, height: 900 }).panelMode).toBe("floating");
    });

    test("command labels remain hidden on narrow medium screens", () => {
        expect(createResponsiveExperiencePolicy({ width: 700, height: 900 }).commandLabelsVisible).toBe(false);
        expect(createResponsiveExperiencePolicy({ width: 800, height: 900 }).commandLabelsVisible).toBe(true);
    });

    test("css variables reflect policy", () => {
        const policy = createResponsiveExperiencePolicy({ width: 390, height: 844 }, { reducedMotion: true });
        const vars = toResponsiveCssVariables(policy);
        expect(vars["--kr-touch-target"]).toMatch(/px$/);
        expect(vars["--kr-motion-duration"]).toBe("0ms");
        expect(vars["--kr-panel-max-width"]).toBe("390px");
    });

    test("apply writes and restores variables and data attributes", () => {
        const element = document.createElement("main");
        element.style.setProperty("--kr-panel-gap", "99px");
        element.dataset.viewport = "legacy";
        const policy = createResponsiveExperiencePolicy({ width: 390, height: 844 });
        const restore = applyResponsivePolicy(element, policy);
        expect(element.dataset.viewport).toBe("compact");
        expect(element.dataset.panelMode).toBe("sheet");
        expect(element.style.getPropertyValue("--kr-panel-gap")).toBe("8px");
        restore();
        expect(element.dataset.viewport).toBe("legacy");
        expect(element.dataset.panelMode).toBeUndefined();
        expect(element.style.getPropertyValue("--kr-panel-gap")).toBe("99px");
    });

    test("controller applies initial policy and can refresh", () => {
        const target = document.createElement("main");
        const listeners = new Map<string, EventListener>();
        const fakeWindow = {
            innerWidth: 390,
            innerHeight: 844,
            addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
            removeEventListener: (name: string) => listeners.delete(name)
        } as unknown as Window;
        const changes: string[] = [];
        const controller = createResponsivePolicyController({
            target,
            window: fakeWindow,
            onChange: policy => changes.push(policy.viewportClass)
        });
        expect(controller.getPolicy().viewportClass).toBe("compact");
        expect(target.dataset.viewport).toBe("compact");
        (fakeWindow as unknown as { innerWidth: number }).innerWidth = 1500;
        controller.refresh();
        expect(controller.getPolicy().viewportClass).toBe("wide");
        expect(changes).toEqual(["compact", "wide"]);
        controller.destroy();
        expect(target.dataset.viewport).toBeUndefined();
        expect(listeners.has("resize")).toBe(false);
    });

    test("controller resize listener recomputes policy", () => {
        const target = document.createElement("main");
        let resize: EventListener | undefined;
        const fakeWindow = {
            innerWidth: 800,
            innerHeight: 800,
            addEventListener: (_name: string, listener: EventListener) => { resize = listener; },
            removeEventListener: () => undefined
        } as unknown as Window;
        const controller = createResponsivePolicyController({ target, window: fakeWindow });
        expect(controller.getPolicy().viewportClass).toBe("medium");
        (fakeWindow as unknown as { innerWidth: number }).innerWidth = 1200;
        resize?.(new Event("resize"));
        expect(controller.getPolicy().viewportClass).toBe("expanded");
        controller.destroy();
    });

    test("controller reads preferences on each refresh", () => {
        const target = document.createElement("main");
        let reduced = false;
        const fakeWindow = {
            innerWidth: 1200, innerHeight: 800,
            addEventListener: () => undefined, removeEventListener: () => undefined
        } as unknown as Window;
        const controller = createResponsivePolicyController({
            target, window: fakeWindow, preferences: () => ({ reducedMotion: reduced })
        });
        expect(controller.getPolicy().motionDurationMs).toBe(200);
        reduced = true;
        controller.refresh();
        expect(controller.getPolicy().motionDurationMs).toBe(0);
        controller.destroy();
    });

    test("controller reads safe area on each refresh", () => {
        const target = document.createElement("main");
        let top = 10;
        const fakeWindow = {
            innerWidth: 390, innerHeight: 844,
            addEventListener: () => undefined, removeEventListener: () => undefined
        } as unknown as Window;
        const controller = createResponsivePolicyController({ target, window: fakeWindow, safeArea: () => ({ safeAreaTop: top }) });
        expect(controller.getPolicy().mapControlInset.top).toBe(18);
        top = 20;
        controller.refresh();
        expect(controller.getPolicy().mapControlInset.top).toBe(28);
        controller.destroy();
    });

    test("destroy is idempotent", () => {
        const target = document.createElement("main");
        const fakeWindow = {
            innerWidth: 390, innerHeight: 844,
            addEventListener: () => undefined, removeEventListener: () => undefined
        } as unknown as Window;
        const controller = createResponsivePolicyController({ target, window: fakeWindow });
        expect(() => { controller.destroy(); controller.destroy(); }).not.toThrow();
    });
});
