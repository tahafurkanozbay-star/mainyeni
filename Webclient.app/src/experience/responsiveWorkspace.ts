export type WorkspaceViewport = 'compact' | 'medium' | 'wide';
export type WorkspacePanel = 'none' | 'layers' | 'legend' | 'search' | 'details' | 'tools';
export type WorkspacePlacement = 'overlay' | 'bottom-sheet' | 'side';
export type WorkspaceInputMode = 'touch' | 'pointer' | 'mixed';

export interface WorkspaceInsets {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
}

export interface WorkspaceMetrics {
    readonly width: number;
    readonly height: number;
    readonly visualWidth?: number;
    readonly visualHeight?: number;
    readonly keyboardInset?: number;
    readonly safeArea?: Partial<WorkspaceInsets>;
    readonly coarsePointer?: boolean;
    readonly hover?: boolean;
    readonly reducedMotion?: boolean;
}

export interface WorkspacePolicy {
    readonly viewport: WorkspaceViewport;
    readonly inputMode: WorkspaceInputMode;
    readonly placement: WorkspacePlacement;
    readonly panelWidth: number;
    readonly panelMaxHeight: number;
    readonly mapMinWidth: number;
    readonly touchTarget: number;
    readonly toolbarColumns: number;
    readonly keyboardInset: number;
    readonly safeArea: WorkspaceInsets;
    readonly reducedMotion: boolean;
    readonly transitionMs: number;
}

export interface WorkspaceState {
    readonly activePanel: WorkspacePanel;
    readonly panelPinned: boolean;
    readonly utilityExpanded: boolean;
    readonly mapMode: '2d' | '3d';
}

export interface WorkspaceSnapshot {
    readonly policy: WorkspacePolicy;
    readonly state: WorkspaceState;
}

export interface WorkspaceRuntimeOptions {
    readonly initialMetrics: WorkspaceMetrics;
    readonly initialState?: Partial<WorkspaceState>;
    readonly onChange?: (snapshot: WorkspaceSnapshot) => void;
    readonly onError?: (error: unknown) => void;
}

export interface WorkspaceRuntime {
    getSnapshot(): WorkspaceSnapshot;
    setMetrics(metrics: WorkspaceMetrics): WorkspaceSnapshot;
    setPanel(panel: WorkspacePanel): WorkspaceSnapshot;
    setPinned(pinned: boolean): WorkspaceSnapshot;
    setUtilityExpanded(expanded: boolean): WorkspaceSnapshot;
    setMapMode(mode: '2d' | '3d'): WorkspaceSnapshot;
    closeTransientPanel(): WorkspaceSnapshot;
    subscribe(listener: (snapshot: WorkspaceSnapshot) => void): () => void;
    dispose(): void;
}

const DEFAULT_STATE: WorkspaceState = Object.freeze({
    activePanel: 'none',
    panelPinned: false,
    utilityExpanded: false,
    mapMode: '2d'
});

const ZERO_INSETS: WorkspaceInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

function finiteNonNegative(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function classifyWorkspaceViewport(width: number): WorkspaceViewport {
    const normalized = finiteNonNegative(width);
    if (normalized < 720) return 'compact';
    if (normalized < 1200) return 'medium';
    return 'wide';
}

export function resolveWorkspaceInputMode(coarsePointer = false, hover = true): WorkspaceInputMode {
    if (coarsePointer && !hover) return 'touch';
    if (!coarsePointer && hover) return 'pointer';
    return 'mixed';
}

export function normalizeWorkspaceInsets(value?: Partial<WorkspaceInsets>): WorkspaceInsets {
    if (!value) return ZERO_INSETS;
    return Object.freeze({
        top: finiteNonNegative(value.top),
        right: finiteNonNegative(value.right),
        bottom: finiteNonNegative(value.bottom),
        left: finiteNonNegative(value.left)
    });
}

export function resolveKeyboardInset(metrics: WorkspaceMetrics): number {
    const explicit = finiteNonNegative(metrics.keyboardInset);
    if (explicit > 0) return explicit;
    const layoutHeight = finiteNonNegative(metrics.height);
    const visualHeight = finiteNonNegative(metrics.visualHeight, layoutHeight);
    if (layoutHeight <= 0 || visualHeight <= 0 || visualHeight >= layoutHeight) return 0;
    const inferred = layoutHeight - visualHeight;
    return inferred >= 80 ? Math.round(inferred) : 0;
}

export function createWorkspacePolicy(metrics: WorkspaceMetrics): WorkspacePolicy {
    const width = finiteNonNegative(metrics.visualWidth, finiteNonNegative(metrics.width));
    const height = finiteNonNegative(metrics.visualHeight, finiteNonNegative(metrics.height));
    const viewport = classifyWorkspaceViewport(width);
    const inputMode = resolveWorkspaceInputMode(metrics.coarsePointer, metrics.hover);
    const safeArea = normalizeWorkspaceInsets(metrics.safeArea);
    const keyboardInset = resolveKeyboardInset(metrics);
    const reducedMotion = metrics.reducedMotion === true;
    const usableHeight = Math.max(0, height - safeArea.top - safeArea.bottom - keyboardInset);

    if (viewport === 'compact') {
        return Object.freeze({
            viewport,
            inputMode,
            placement: 'bottom-sheet',
            panelWidth: Math.max(0, Math.round(width - safeArea.left - safeArea.right)),
            panelMaxHeight: Math.round(usableHeight * 0.72),
            mapMinWidth: 0,
            touchTarget: inputMode === 'pointer' ? 40 : 44,
            toolbarColumns: width >= 480 ? 5 : 4,
            keyboardInset,
            safeArea,
            reducedMotion,
            transitionMs: reducedMotion ? 0 : 180
        });
    }

    if (viewport === 'medium') {
        const availableWidth = Math.max(0, width - safeArea.left - safeArea.right);
        return Object.freeze({
            viewport,
            inputMode,
            placement: 'overlay',
            panelWidth: clamp(Math.round(availableWidth * 0.42), 320, 420),
            panelMaxHeight: usableHeight,
            mapMinWidth: 360,
            touchTarget: inputMode === 'pointer' ? 40 : 44,
            toolbarColumns: 6,
            keyboardInset,
            safeArea,
            reducedMotion,
            transitionMs: reducedMotion ? 0 : 160
        });
    }

    const availableWidth = Math.max(0, width - safeArea.left - safeArea.right);
    return Object.freeze({
        viewport,
        inputMode,
        placement: 'side',
        panelWidth: clamp(Math.round(availableWidth * 0.28), 360, 480),
        panelMaxHeight: usableHeight,
        mapMinWidth: 640,
        touchTarget: inputMode === 'pointer' ? 36 : 44,
        toolbarColumns: 8,
        keyboardInset,
        safeArea,
        reducedMotion,
        transitionMs: reducedMotion ? 0 : 140
    });
}

export function normalizeWorkspaceState(
    value: Partial<WorkspaceState> | undefined,
    policy: WorkspacePolicy
): WorkspaceState {
    const activePanel: WorkspacePanel = ['none', 'layers', 'legend', 'search', 'details', 'tools'].includes(value?.activePanel ?? '')
        ? value!.activePanel as WorkspacePanel
        : DEFAULT_STATE.activePanel;
    const mapMode = value?.mapMode === '3d' ? '3d' : '2d';
    const requestedPinned = value?.panelPinned === true;
    return Object.freeze({
        activePanel,
        panelPinned: requestedPinned && policy.placement === 'side' && activePanel !== 'none',
        utilityExpanded: value?.utilityExpanded === true,
        mapMode
    });
}

export function reconcileWorkspaceState(state: WorkspaceState, policy: WorkspacePolicy): WorkspaceState {
    if (policy.placement === 'side') return state;
    if (!state.panelPinned) return state;
    return Object.freeze({ ...state, panelPinned: false });
}

function sameInsets(left: WorkspaceInsets, right: WorkspaceInsets): boolean {
    return left.top === right.top && left.right === right.right && left.bottom === right.bottom && left.left === right.left;
}

export function workspacePolicyEquals(left: WorkspacePolicy, right: WorkspacePolicy): boolean {
    return left.viewport === right.viewport &&
        left.inputMode === right.inputMode &&
        left.placement === right.placement &&
        left.panelWidth === right.panelWidth &&
        left.panelMaxHeight === right.panelMaxHeight &&
        left.mapMinWidth === right.mapMinWidth &&
        left.touchTarget === right.touchTarget &&
        left.toolbarColumns === right.toolbarColumns &&
        left.keyboardInset === right.keyboardInset &&
        left.reducedMotion === right.reducedMotion &&
        left.transitionMs === right.transitionMs &&
        sameInsets(left.safeArea, right.safeArea);
}

export function workspaceStateEquals(left: WorkspaceState, right: WorkspaceState): boolean {
    return left.activePanel === right.activePanel &&
        left.panelPinned === right.panelPinned &&
        left.utilityExpanded === right.utilityExpanded &&
        left.mapMode === right.mapMode;
}

export function createResponsiveWorkspaceRuntime(options: WorkspaceRuntimeOptions): WorkspaceRuntime {
    let disposed = false;
    let policy = createWorkspacePolicy(options.initialMetrics);
    let state = normalizeWorkspaceState(options.initialState, policy);
    let snapshot: WorkspaceSnapshot = Object.freeze({ policy, state });
    const listeners = new Set<(value: WorkspaceSnapshot) => void>();

    const reportError = (error: unknown): void => {
        try {
            options.onError?.(error);
        } catch {
            // Error observers must never destabilize the workspace runtime.
        }
    };

    const notify = (): void => {
        if (disposed) return;
        const current = [...listeners];
        for (const listener of current) {
            try {
                listener(snapshot);
            } catch (error) {
                reportError(error);
            }
        }
        try {
            options.onChange?.(snapshot);
        } catch (error) {
            reportError(error);
        }
    };

    const commit = (nextPolicy: WorkspacePolicy, nextState: WorkspaceState): WorkspaceSnapshot => {
        if (disposed) return snapshot;
        if (workspacePolicyEquals(policy, nextPolicy) && workspaceStateEquals(state, nextState)) return snapshot;
        policy = nextPolicy;
        state = nextState;
        snapshot = Object.freeze({ policy, state });
        notify();
        return snapshot;
    };

    const setState = (patch: Partial<WorkspaceState>): WorkspaceSnapshot => {
        const next = normalizeWorkspaceState({ ...state, ...patch }, policy);
        return commit(policy, next);
    };

    return {
        getSnapshot: () => snapshot,
        setMetrics(metrics) {
            if (disposed) return snapshot;
            const nextPolicy = createWorkspacePolicy(metrics);
            const nextState = reconcileWorkspaceState(state, nextPolicy);
            return commit(nextPolicy, nextState);
        },
        setPanel(panel) {
            if (disposed) return snapshot;
            return setState({ activePanel: panel, panelPinned: panel === 'none' ? false : state.panelPinned });
        },
        setPinned(pinned) {
            if (disposed) return snapshot;
            return setState({ panelPinned: pinned });
        },
        setUtilityExpanded(expanded) {
            if (disposed) return snapshot;
            return setState({ utilityExpanded: expanded });
        },
        setMapMode(mode) {
            if (disposed) return snapshot;
            return setState({ mapMode: mode });
        },
        closeTransientPanel() {
            if (disposed || state.panelPinned || state.activePanel === 'none') return snapshot;
            return setState({ activePanel: 'none' });
        },
        subscribe(listener) {
            if (disposed) return () => undefined;
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            listeners.clear();
        }
    };
}
