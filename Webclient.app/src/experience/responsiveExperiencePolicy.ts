export type ExperienceViewportClass = "compact" | "medium" | "expanded" | "wide";
export type ExperienceInputMode = "touch" | "pointer" | "hybrid";
export type ExperienceDensity = "comfortable" | "compact";
export type ExperiencePanelMode = "sheet" | "drawer" | "floating" | "docked";

export interface ExperienceViewport {
    width: number;
    height: number;
    safeAreaTop?: number;
    safeAreaRight?: number;
    safeAreaBottom?: number;
    safeAreaLeft?: number;
}

export interface ExperiencePreferences {
    coarsePointer?: boolean;
    hover?: boolean;
    reducedMotion?: boolean;
    forcedColors?: boolean;
    reducedTransparency?: boolean;
    density?: ExperienceDensity;
}

export interface ExperienceResponsivePolicy {
    viewportClass: ExperienceViewportClass;
    inputMode: ExperienceInputMode;
    density: ExperienceDensity;
    panelMode: ExperiencePanelMode;
    navigationCollapsed: boolean;
    commandLabelsVisible: boolean;
    maxFloatingPanels: number;
    touchTarget: number;
    panelGap: number;
    panelMaxWidth: number;
    panelMaxHeight: number;
    mapControlInset: Readonly<{ top: number; right: number; bottom: number; left: number }>;
    motionDurationMs: number;
    backdropBlur: number;
    tablePageSize: number;
    tableStickyColumns: number;
    searchResultLimit: number;
}

const finite = (value: number | undefined, fallback = 0): number =>
    Number.isFinite(value) ? Math.max(0, Number(value)) : fallback;

export function classifyViewport(width: number): ExperienceViewportClass {
    const safe = finite(width);
    if (safe < 640) return "compact";
    if (safe < 1024) return "medium";
    if (safe < 1440) return "expanded";
    return "wide";
}

export function classifyInput(preferences: ExperiencePreferences): ExperienceInputMode {
    if (preferences.coarsePointer && preferences.hover) return "hybrid";
    if (preferences.coarsePointer) return "touch";
    return "pointer";
}

function choosePanelMode(viewportClass: ExperienceViewportClass, input: ExperienceInputMode): ExperiencePanelMode {
    if (viewportClass === "compact") return "sheet";
    if (viewportClass === "medium") return input === "touch" ? "sheet" : "drawer";
    if (viewportClass === "wide") return "docked";
    return "floating";
}

function chooseDensity(viewportClass: ExperienceViewportClass, input: ExperienceInputMode, requested?: ExperienceDensity): ExperienceDensity {
    if (input === "touch") return "comfortable";
    if (requested) return requested;
    return viewportClass === "wide" ? "compact" : "comfortable";
}

export function createResponsiveExperiencePolicy(
    viewport: ExperienceViewport,
    preferences: ExperiencePreferences = {}
): ExperienceResponsivePolicy {
    const width = finite(viewport.width);
    const height = finite(viewport.height);
    const viewportClass = classifyViewport(width);
    const inputMode = classifyInput(preferences);
    const density = chooseDensity(viewportClass, inputMode, preferences.density);
    const panelMode = choosePanelMode(viewportClass, inputMode);
    const safeTop = finite(viewport.safeAreaTop);
    const safeRight = finite(viewport.safeAreaRight);
    const safeBottom = finite(viewport.safeAreaBottom);
    const safeLeft = finite(viewport.safeAreaLeft);
    const compact = viewportClass === "compact";
    const medium = viewportClass === "medium";
    const touch = inputMode !== "pointer";
    const forced = Boolean(preferences.forcedColors);
    const reducedTransparency = Boolean(preferences.reducedTransparency);

    const baseGap = compact ? 8 : medium ? 12 : 16;
    const maxWidth = compact ? width : medium ? Math.min(480, width - 32) : Math.min(560, Math.max(360, width * 0.38));
    const maxHeight = compact ? Math.max(240, height * 0.72) : Math.max(320, height - 64);

    return {
        viewportClass,
        inputMode,
        density,
        panelMode,
        navigationCollapsed: compact || (medium && touch),
        commandLabelsVisible: !compact && width >= 760,
        maxFloatingPanels: compact ? 1 : medium ? 2 : viewportClass === "expanded" ? 3 : 4,
        touchTarget: touch ? 48 : density === "comfortable" ? 44 : 36,
        panelGap: baseGap,
        panelMaxWidth: Math.round(maxWidth),
        panelMaxHeight: Math.round(maxHeight),
        mapControlInset: Object.freeze({
            top: safeTop + baseGap,
            right: safeRight + baseGap,
            bottom: safeBottom + baseGap,
            left: safeLeft + baseGap
        }),
        motionDurationMs: preferences.reducedMotion ? 0 : compact ? 160 : 200,
        backdropBlur: forced || reducedTransparency ? 0 : compact ? 8 : 12,
        tablePageSize: compact ? 10 : medium ? 20 : 30,
        tableStickyColumns: compact ? 0 : medium ? 1 : 2,
        searchResultLimit: compact ? 8 : medium ? 12 : 20
    };
}

export interface ResponsivePolicyCssVariables {
    "--kr-touch-target": string;
    "--kr-panel-gap": string;
    "--kr-panel-max-width": string;
    "--kr-panel-max-height": string;
    "--kr-safe-top": string;
    "--kr-safe-right": string;
    "--kr-safe-bottom": string;
    "--kr-safe-left": string;
    "--kr-motion-duration": string;
    "--kr-backdrop-blur": string;
}

export function toResponsiveCssVariables(policy: ExperienceResponsivePolicy): ResponsivePolicyCssVariables {
    return {
        "--kr-touch-target": `${policy.touchTarget}px`,
        "--kr-panel-gap": `${policy.panelGap}px`,
        "--kr-panel-max-width": `${policy.panelMaxWidth}px`,
        "--kr-panel-max-height": `${policy.panelMaxHeight}px`,
        "--kr-safe-top": `${policy.mapControlInset.top}px`,
        "--kr-safe-right": `${policy.mapControlInset.right}px`,
        "--kr-safe-bottom": `${policy.mapControlInset.bottom}px`,
        "--kr-safe-left": `${policy.mapControlInset.left}px`,
        "--kr-motion-duration": `${policy.motionDurationMs}ms`,
        "--kr-backdrop-blur": `${policy.backdropBlur}px`
    };
}

export function applyResponsivePolicy(
    element: HTMLElement,
    policy: ExperienceResponsivePolicy
): () => void {
    const previous = new Map<string, string>();
    const variables = toResponsiveCssVariables(policy);
    for (const [name, value] of Object.entries(variables)) {
        previous.set(name, element.style.getPropertyValue(name));
        element.style.setProperty(name, value);
    }
    const previousViewport = element.dataset.viewport;
    const previousInput = element.dataset.input;
    const previousDensity = element.dataset.density;
    const previousPanel = element.dataset.panelMode;
    element.dataset.viewport = policy.viewportClass;
    element.dataset.input = policy.inputMode;
    element.dataset.density = policy.density;
    element.dataset.panelMode = policy.panelMode;

    return () => {
        for (const [name, value] of previous) {
            if (value) element.style.setProperty(name, value);
            else element.style.removeProperty(name);
        }
        if (previousViewport === undefined) delete element.dataset.viewport; else element.dataset.viewport = previousViewport;
        if (previousInput === undefined) delete element.dataset.input; else element.dataset.input = previousInput;
        if (previousDensity === undefined) delete element.dataset.density; else element.dataset.density = previousDensity;
        if (previousPanel === undefined) delete element.dataset.panelMode; else element.dataset.panelMode = previousPanel;
    };
}

export interface ResponsivePolicyControllerOptions {
    target: HTMLElement;
    window?: Window;
    preferences?: () => ExperiencePreferences;
    safeArea?: () => Partial<Pick<ExperienceViewport, "safeAreaTop" | "safeAreaRight" | "safeAreaBottom" | "safeAreaLeft">>;
    onChange?: (policy: ExperienceResponsivePolicy) => void;
}

export interface ResponsivePolicyController {
    getPolicy(): ExperienceResponsivePolicy;
    refresh(): ExperienceResponsivePolicy;
    destroy(): void;
}

export function createResponsivePolicyController(options: ResponsivePolicyControllerOptions): ResponsivePolicyController {
    const runtimeWindow = options.window ?? window;
    let restore: (() => void) | undefined;
    let destroyed = false;
    let policy = createResponsiveExperiencePolicy({ width: runtimeWindow.innerWidth, height: runtimeWindow.innerHeight });

    const refresh = (): ExperienceResponsivePolicy => {
        if (destroyed) return policy;
        const safeArea = options.safeArea?.() ?? {};
        const next = createResponsiveExperiencePolicy({
            width: runtimeWindow.innerWidth,
            height: runtimeWindow.innerHeight,
            ...safeArea
        }, options.preferences?.() ?? {});
        restore?.();
        restore = applyResponsivePolicy(options.target, next);
        policy = next;
        options.onChange?.(next);
        return next;
    };

    const onResize = (): void => { refresh(); };
    runtimeWindow.addEventListener("resize", onResize, { passive: true });
    refresh();

    return {
        getPolicy: () => policy,
        refresh,
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            runtimeWindow.removeEventListener("resize", onResize);
            restore?.();
            restore = undefined;
        }
    };
}
