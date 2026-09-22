import { describe, expect, test, vi } from 'vitest';
import {
    classifyWorkspaceViewport,
    createResponsiveWorkspaceRuntime,
    createWorkspacePolicy,
    normalizeWorkspaceInsets,
    normalizeWorkspaceState,
    reconcileWorkspaceState,
    resolveKeyboardInset,
    resolveWorkspaceInputMode,
    workspacePolicyEquals,
    workspaceStateEquals,
    type WorkspaceMetrics
} from './responsiveWorkspace';

const metrics = (overrides: Partial<WorkspaceMetrics> = {}): WorkspaceMetrics => ({
    width: 1440,
    height: 900,
    visualWidth: 1440,
    visualHeight: 900,
    hover: true,
    coarsePointer: false,
    ...overrides
});

describe('responsive workspace viewport policy', () => {
    test.each([
        [-1, 'compact'],
        [0, 'compact'],
        [360, 'compact'],
        [719, 'compact'],
        [720, 'medium'],
        [1199, 'medium'],
        [1200, 'wide'],
        [1920, 'wide'],
        [Number.NaN, 'compact']
    ])('classifies width %s as %s', (width, expected) => {
        expect(classifyWorkspaceViewport(width)).toBe(expected);
    });

    test.each([
        [true, false, 'touch'],
        [false, true, 'pointer'],
        [true, true, 'mixed'],
        [false, false, 'mixed']
    ])('maps coarse=%s hover=%s to %s', (coarse, hover, expected) => {
        expect(resolveWorkspaceInputMode(coarse, hover)).toBe(expected);
    });

    test('normalizes unsafe safe-area values', () => {
        expect(normalizeWorkspaceInsets({ top: 12, right: -5, bottom: Number.NaN, left: 8 })).toEqual({
            top: 12,
            right: 0,
            bottom: 0,
            left: 8
        });
    });

    test('returns stable zero insets when omitted', () => {
        expect(normalizeWorkspaceInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    test('uses compact bottom sheet with touch-safe targets', () => {
        const policy = createWorkspacePolicy(metrics({
            width: 390,
            visualWidth: 390,
            height: 844,
            visualHeight: 844,
            coarsePointer: true,
            hover: false,
            safeArea: { top: 47, bottom: 34 }
        }));
        expect(policy.viewport).toBe('compact');
        expect(policy.placement).toBe('bottom-sheet');
        expect(policy.touchTarget).toBe(44);
        expect(policy.toolbarColumns).toBe(4);
        expect(policy.panelWidth).toBe(390);
        expect(policy.panelMaxHeight).toBeLessThan(844);
        expect(policy.safeArea.bottom).toBe(34);
    });

    test('grows compact toolbar to five columns on larger phones', () => {
        expect(createWorkspacePolicy(metrics({ width: 600, visualWidth: 600 })).toolbarColumns).toBe(5);
    });

    test('uses bounded overlay panel on medium screens', () => {
        const policy = createWorkspacePolicy(metrics({ width: 900, visualWidth: 900 }));
        expect(policy.viewport).toBe('medium');
        expect(policy.placement).toBe('overlay');
        expect(policy.panelWidth).toBeGreaterThanOrEqual(320);
        expect(policy.panelWidth).toBeLessThanOrEqual(420);
        expect(policy.mapMinWidth).toBe(360);
    });

    test('uses a bounded side panel on wide screens', () => {
        const policy = createWorkspacePolicy(metrics({ width: 1800, visualWidth: 1800 }));
        expect(policy.viewport).toBe('wide');
        expect(policy.placement).toBe('side');
        expect(policy.panelWidth).toBe(480);
        expect(policy.mapMinWidth).toBe(640);
        expect(policy.toolbarColumns).toBe(8);
    });

    test('keeps pointer targets compact without dropping below usable size', () => {
        expect(createWorkspacePolicy(metrics()).touchTarget).toBe(36);
        expect(createWorkspacePolicy(metrics({ width: 900, visualWidth: 900 })).touchTarget).toBe(40);
    });

    test('preserves 44px target for touch-capable wide workspaces', () => {
        const policy = createWorkspacePolicy(metrics({ coarsePointer: true, hover: false }));
        expect(policy.inputMode).toBe('touch');
        expect(policy.touchTarget).toBe(44);
    });

    test('disables transitions for reduced-motion users', () => {
        const policy = createWorkspacePolicy(metrics({ reducedMotion: true }));
        expect(policy.reducedMotion).toBe(true);
        expect(policy.transitionMs).toBe(0);
    });

    test('uses short transitions when motion is allowed', () => {
        expect(createWorkspacePolicy(metrics({ width: 390, visualWidth: 390 })).transitionMs).toBe(180);
        expect(createWorkspacePolicy(metrics({ width: 900, visualWidth: 900 })).transitionMs).toBe(160);
        expect(createWorkspacePolicy(metrics()).transitionMs).toBe(140);
    });
});

describe('responsive workspace virtual keyboard handling', () => {
    test('honors an explicit keyboard inset', () => {
        expect(resolveKeyboardInset(metrics({ keyboardInset: 280 }))).toBe(280);
    });

    test('infers keyboard occlusion from the visual viewport', () => {
        expect(resolveKeyboardInset(metrics({ height: 844, visualHeight: 520 }))).toBe(324);
    });

    test('ignores tiny visual viewport deltas caused by browser chrome', () => {
        expect(resolveKeyboardInset(metrics({ height: 844, visualHeight: 790 }))).toBe(0);
    });

    test('ignores invalid visual viewport values', () => {
        expect(resolveKeyboardInset(metrics({ height: 844, visualHeight: Number.NaN }))).toBe(0);
    });

    test('subtracts keyboard occlusion from panel maximum height', () => {
        const withoutKeyboard = createWorkspacePolicy(metrics({ width: 390, visualWidth: 390, height: 844, visualHeight: 844 }));
        const withKeyboard = createWorkspacePolicy(metrics({ width: 390, visualWidth: 390, height: 844, visualHeight: 520, keyboardInset: 324 }));
        expect(withKeyboard.keyboardInset).toBe(324);
        expect(withKeyboard.panelMaxHeight).toBeLessThan(withoutKeyboard.panelMaxHeight);
    });
});

describe('responsive workspace state normalization', () => {
    const widePolicy = createWorkspacePolicy(metrics());
    const compactPolicy = createWorkspacePolicy(metrics({ width: 390, visualWidth: 390 }));

    test('uses stable defaults for unknown state', () => {
        expect(normalizeWorkspaceState(undefined, widePolicy)).toEqual({
            activePanel: 'none',
            panelPinned: false,
            utilityExpanded: false,
            mapMode: '2d'
        });
    });

    test('accepts known panel and map-mode values', () => {
        expect(normalizeWorkspaceState({ activePanel: 'layers', mapMode: '3d' }, widePolicy)).toEqual({
            activePanel: 'layers',
            panelPinned: false,
            utilityExpanded: false,
            mapMode: '3d'
        });
    });

    test('rejects unknown panel values', () => {
        expect(normalizeWorkspaceState({ activePanel: 'invalid' as never }, widePolicy).activePanel).toBe('none');
    });

    test('permits pinning only for a visible side panel', () => {
        expect(normalizeWorkspaceState({ activePanel: 'layers', panelPinned: true }, widePolicy).panelPinned).toBe(true);
        expect(normalizeWorkspaceState({ activePanel: 'none', panelPinned: true }, widePolicy).panelPinned).toBe(false);
        expect(normalizeWorkspaceState({ activePanel: 'layers', panelPinned: true }, compactPolicy).panelPinned).toBe(false);
    });

    test('unpins a panel when layout leaves side placement', () => {
        const state = normalizeWorkspaceState({ activePanel: 'layers', panelPinned: true }, widePolicy);
        expect(reconcileWorkspaceState(state, compactPolicy).panelPinned).toBe(false);
    });

    test('keeps a valid pinned state on side placement', () => {
        const state = normalizeWorkspaceState({ activePanel: 'layers', panelPinned: true }, widePolicy);
        expect(reconcileWorkspaceState(state, widePolicy)).toBe(state);
    });

    test('compares policy values structurally', () => {
        expect(workspacePolicyEquals(createWorkspacePolicy(metrics()), createWorkspacePolicy(metrics()))).toBe(true);
        expect(workspacePolicyEquals(createWorkspacePolicy(metrics()), compactPolicy)).toBe(false);
    });

    test('compares workspace state values structurally', () => {
        const left = normalizeWorkspaceState({ activePanel: 'legend' }, widePolicy);
        const right = normalizeWorkspaceState({ activePanel: 'legend' }, widePolicy);
        const other = normalizeWorkspaceState({ activePanel: 'layers' }, widePolicy);
        expect(workspaceStateEquals(left, right)).toBe(true);
        expect(workspaceStateEquals(left, other)).toBe(false);
    });
});

describe('responsive workspace runtime', () => {
    test('publishes panel changes to subscribers and the host observer', () => {
        const onChange = vi.fn();
        const subscriber = vi.fn();
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics(), onChange });
        const unsubscribe = runtime.subscribe(subscriber);
        const next = runtime.setPanel('layers');
        expect(next.state.activePanel).toBe('layers');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(subscriber).toHaveBeenCalledTimes(1);
        unsubscribe();
        runtime.setPanel('legend');
        expect(subscriber).toHaveBeenCalledTimes(1);
    });

    test('does not publish structurally identical state', () => {
        const onChange = vi.fn();
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics(), onChange });
        const first = runtime.getSnapshot();
        const second = runtime.setMapMode('2d');
        expect(second).toBe(first);
        expect(onChange).not.toHaveBeenCalled();
    });

    test('pins a visible panel on a wide workspace', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('layers');
        expect(runtime.setPinned(true).state.panelPinned).toBe(true);
    });

    test('automatically unpins when resizing to compact', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('layers');
        runtime.setPinned(true);
        const snapshot = runtime.setMetrics(metrics({ width: 390, visualWidth: 390 }));
        expect(snapshot.policy.placement).toBe('bottom-sheet');
        expect(snapshot.state.panelPinned).toBe(false);
    });

    test('cannot pin an overlay panel', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics({ width: 900, visualWidth: 900 }) });
        runtime.setPanel('layers');
        expect(runtime.setPinned(true).state.panelPinned).toBe(false);
    });

    test('closing a transient panel preserves pinned panels', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('layers');
        runtime.setPinned(true);
        expect(runtime.closeTransientPanel().state.activePanel).toBe('layers');
    });

    test('closing a transient panel hides an unpinned panel', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('search');
        expect(runtime.closeTransientPanel().state.activePanel).toBe('none');
    });

    test('switching to none also clears pinned state', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('layers');
        runtime.setPinned(true);
        expect(runtime.setPanel('none').state).toEqual(expect.objectContaining({ activePanel: 'none', panelPinned: false }));
    });

    test('tracks utility expansion independently from panel state', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('legend');
        const snapshot = runtime.setUtilityExpanded(true);
        expect(snapshot.state.utilityExpanded).toBe(true);
        expect(snapshot.state.activePanel).toBe('legend');
    });

    test('tracks 2d and 3d map mode without resetting workspace state', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.setPanel('details');
        const snapshot = runtime.setMapMode('3d');
        expect(snapshot.state.mapMode).toBe('3d');
        expect(snapshot.state.activePanel).toBe('details');
    });

    test('isolates subscriber failures and reports them', () => {
        const onError = vi.fn();
        const healthy = vi.fn();
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics(), onError });
        runtime.subscribe(() => { throw new Error('observer failed'); });
        runtime.subscribe(healthy);
        runtime.setPanel('tools');
        expect(onError).toHaveBeenCalledTimes(1);
        expect(healthy).toHaveBeenCalledTimes(1);
    });

    test('isolates host onChange failures', () => {
        const onError = vi.fn();
        const runtime = createResponsiveWorkspaceRuntime({
            initialMetrics: metrics(),
            onChange: () => { throw new Error('host failed'); },
            onError
        });
        expect(() => runtime.setPanel('search')).not.toThrow();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    test('isolates errors thrown by the error observer itself', () => {
        const runtime = createResponsiveWorkspaceRuntime({
            initialMetrics: metrics(),
            onChange: () => { throw new Error('host failed'); },
            onError: () => { throw new Error('error observer failed'); }
        });
        expect(() => runtime.setPanel('search')).not.toThrow();
    });

    test('dispose is idempotent and stops future notifications', () => {
        const onChange = vi.fn();
        const subscriber = vi.fn();
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics(), onChange });
        runtime.subscribe(subscriber);
        runtime.dispose();
        runtime.dispose();
        const before = runtime.getSnapshot();
        const after = runtime.setPanel('layers');
        expect(after).toBe(before);
        expect(onChange).not.toHaveBeenCalled();
        expect(subscriber).not.toHaveBeenCalled();
    });

    test('subscribe after disposal returns a harmless release function', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        runtime.dispose();
        const release = runtime.subscribe(() => undefined);
        expect(() => release()).not.toThrow();
    });

    test('returns immutable policy and state snapshots', () => {
        const runtime = createResponsiveWorkspaceRuntime({ initialMetrics: metrics() });
        const snapshot = runtime.getSnapshot();
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.policy)).toBe(true);
        expect(Object.isFrozen(snapshot.state)).toBe(true);
        expect(Object.isFrozen(snapshot.policy.safeArea)).toBe(true);
    });

    test('resizing across breakpoints preserves semantic workspace state', () => {
        const runtime = createResponsiveWorkspaceRuntime({
            initialMetrics: metrics({ width: 390, visualWidth: 390 }),
            initialState: { activePanel: 'search', mapMode: '3d', utilityExpanded: true }
        });
        const snapshot = runtime.setMetrics(metrics({ width: 1600, visualWidth: 1600 }));
        expect(snapshot.policy.viewport).toBe('wide');
        expect(snapshot.state.activePanel).toBe('search');
        expect(snapshot.state.mapMode).toBe('3d');
        expect(snapshot.state.utilityExpanded).toBe(true);
    });
});
