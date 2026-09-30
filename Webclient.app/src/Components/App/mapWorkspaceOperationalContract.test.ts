import { describe, expect, it, vi } from 'vitest';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import { createMapWorkspaceHealthPresentation } from './mapWorkspaceHealthPresentation';
import { createMapWorkspaceRecoveryFocusController } from './mapWorkspaceRecoveryFocus';
import { waitForMapWorkspaceViewReady } from './mapWorkspaceViewReadiness';
import { createMapWorkspaceViewportRuntime } from './mapWorkspaceViewportRuntime';

const createViewportTarget = () => {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  return {
    addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
      listeners.set(name, listener);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
    resize() {
      const listener = listeners.get('resize');
      if (typeof listener === 'function') listener(new Event('resize'));
      else listener?.handleEvent(new Event('resize'));
    },
  };
};

describe('map workspace operational contract', () => {
  it('keeps boot state non-interactive until readiness resolves', async () => {
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    const readiness = waitForMapWorkspaceViewReady({ when: () => readyPromise });

    expect(model.getSnapshot()).toMatchObject({ phase: 'booting', isInteractive: false });
    expect(createMapWorkspaceHealthPresentation(model.getSnapshot()).visible).toBe(true);

    resolveReady();
    const outcome = await readiness;
    expect(outcome).toMatchObject({ status: 'ready', ready: true, failureKind: null });
    model.markReady();
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', isInteractive: true });
    expect(createMapWorkspaceHealthPresentation(model.getSnapshot()).visible).toBe(false);
  });

  it('maps readiness timeout into bounded fatal recovery without raw runtime details', async () => {
    let timeoutCallback: (() => void) | undefined;
    const readiness = waitForMapWorkspaceViewReady(
      { when: () => new Promise(() => undefined) },
      {
        timeoutMs: 1_000,
        scheduleTimeout(callback) {
          timeoutCallback = callback;
          return 1 as ReturnType<typeof setTimeout>;
        },
        clearScheduledTimeout() {},
      },
    );
    timeoutCallback?.();
    const outcome = await readiness;
    expect(outcome).toMatchObject({
      status: 'timeout',
      ready: false,
      code: 'MAP_VIEW_TIMEOUT',
      failureKind: 'TimeoutError',
    });

    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError('Harita görünümü beklenen sürede hazır duruma geçemedi.');
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    expect(presentation).toMatchObject({ tone: 'danger', role: 'alert' });
    expect(presentation.actions.some((action) => action.id === 'retry-workspace')).toBe(true);
  });

  it('treats optional data failure as degradation after view readiness', async () => {
    const readiness = await waitForMapWorkspaceViewReady({ when: async () => undefined });
    expect(readiness.ready).toBe(true);

    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    model.markResourceLoading('kent-rehberi-data');
    model.markResourceFailed('kent-rehberi-data', new Error('data unavailable'));

    expect(model.getSnapshot()).toMatchObject({
      phase: 'degraded',
      health: 'degraded',
      isInteractive: true,
      issueCount: 1,
    });
    expect(createMapWorkspaceHealthPresentation(model.getSnapshot())).toMatchObject({
      visible: true,
      tone: 'warning',
      role: 'status',
    });
  });

  it('restores map focus after a fatal retry succeeds', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const focus = vi.fn();
    const focusController = createMapWorkspaceRecoveryFocusController({
      getTarget: () => ({ focus }),
    });

    model.beginAttempt();
    model.markError('failed');
    focusController.sync(model.getSnapshot());
    focusController.requestRestore();
    model.beginAttempt();
    expect(focusController.sync(model.getSnapshot())).toBe(false);
    model.markReady();
    expect(focusController.sync(model.getSnapshot())).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does not restore focus after a short non-fatal map update', () => {
    const model = new MapWorkspaceAccessibilityModel();
    const focus = vi.fn();
    const focusController = createMapWorkspaceRecoveryFocusController({
      getTarget: () => ({ focus }),
    });
    model.beginAttempt();
    model.markReady();
    model.markUpdating(true);
    focusController.sync(model.getSnapshot());
    model.markUpdating(false);
    focusController.sync(model.getSnapshot());
    expect(focus).not.toHaveBeenCalled();
  });

  it('coalesces viewport churn while workspace remains interactive', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();

    const target = createViewportTarget();
    const view = { destroyed: false, padding: null as unknown };
    let frame: FrameRequestCallback | null = null;
    const viewport = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({ compact: false }),
      createPadding: (width) => ({ left: width >= 960 ? 280 : 0 }),
      getViewportWidth: () => 1280,
      target,
      scheduleFrame(callback) {
        frame = callback;
        return 1;
      },
      cancelFrame: vi.fn(),
      applyInitial: false,
    });

    target.resize();
    target.resize();
    target.resize();
    expect(view.padding).toBeNull();
    expect(viewport.diagnostics()).toMatchObject({ scheduledCount: 1, coalescedCount: 2 });
    frame?.(0);
    expect(view.padding).toEqual({ left: 280 });
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', isInteractive: true });
  });

  it('keeps viewport failure isolated from workspace health state', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    const reporter = vi.fn();
    const viewport = createMapWorkspaceViewportRuntime({
      getView: () => ({ destroyed: false }),
      getConfiguration: () => ({}),
      createPadding() { throw new TypeError('private padding detail'); },
      target: createViewportTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      onError: reporter,
    });
    expect(viewport.diagnostics()).toMatchObject({ errorCount: 1, lastErrorKind: 'TypeError' });
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', health: 'healthy' });
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('keeps raw readiness rejection detail out of health presentation', async () => {
    const readiness = await waitForMapWorkspaceViewReady({
      when: async () => { throw new TypeError('token=secret-value'); },
    });
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markError('Harita görünümü güvenli biçimde başlatılamadı.');
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());

    expect(readiness.failureKind).toBe('TypeError');
    expect(JSON.stringify(readiness)).not.toContain('secret-value');
    expect(JSON.stringify(presentation)).not.toContain('secret-value');
  });

  it('keeps recovery bounded across three failed attempts', () => {
    const model = new MapWorkspaceAccessibilityModel({ maxAttempts: 3 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(model.beginAttempt()).toBe(true);
      model.markError(`failure-${attempt}`);
    }
    const snapshot = model.getSnapshot();
    const presentation = createMapWorkspaceHealthPresentation(snapshot);
    expect(snapshot).toMatchObject({ attempt: 3, canRetry: false, retryExhausted: true });
    expect(presentation.actions.some((action) => action.id === 'retry-workspace')).toBe(false);
    expect(presentation.actions.some((action) => action.id === 'reload-page')).toBe(true);
    expect(model.beginAttempt()).toBe(false);
  });

  it('cleans up viewport ownership and recovery focus ownership independently', () => {
    const target = createViewportTarget();
    const cancelFrame = vi.fn();
    const viewport = createMapWorkspaceViewportRuntime({
      getView: () => ({ destroyed: false }),
      getConfiguration: () => ({}),
      createPadding: () => ({}),
      target,
      scheduleFrame: vi.fn(() => 9),
      cancelFrame,
      applyInitial: false,
    });
    const focusController = createMapWorkspaceRecoveryFocusController({ getTarget: () => null });
    viewport.requestUpdate();
    focusController.requestRestore();

    viewport.dispose();
    focusController.dispose();
    expect(cancelFrame).toHaveBeenCalledWith(9);
    expect(viewport.diagnostics().disposed).toBe(true);
    expect(focusController.diagnostics()).toMatchObject({ disposed: true, pending: false });
  });

  it('preserves immutable public snapshots across the composed operational layers', () => {
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    model.markReady();
    const presentation = createMapWorkspaceHealthPresentation(model.getSnapshot());
    const focusController = createMapWorkspaceRecoveryFocusController({ getTarget: () => null });
    const viewport = createMapWorkspaceViewportRuntime({
      getView: () => null,
      getConfiguration: () => ({}),
      createPadding: () => ({}),
      target: createViewportTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      applyInitial: false,
    });

    expect(Object.isFrozen(model.getSnapshot())).toBe(true);
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(focusController.diagnostics())).toBe(true);
    expect(Object.isFrozen(viewport.diagnostics())).toBe(true);
  });
});
