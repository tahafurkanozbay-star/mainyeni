import { describe, expect, it, vi } from 'vitest';
import { MapWorkspaceAccessibilityModel } from './mapWorkspaceAccessibility';
import { createMapWorkspaceRecoveryFocusController } from './mapWorkspaceRecoveryFocus';

const readySnapshot = () => {
  const model = new MapWorkspaceAccessibilityModel();
  model.beginAttempt();
  model.markReady();
  return model.getSnapshot();
};

const errorModel = (maxAttempts = 3) => {
  const model = new MapWorkspaceAccessibilityModel({ maxAttempts });
  model.beginAttempt();
  model.markError('failed');
  return model;
};

describe('createMapWorkspaceRecoveryFocusController', () => {
  it('starts inert with frozen diagnostics', () => {
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => null });
    expect(controller.diagnostics()).toEqual({
      requestCount: 0,
      restoreCount: 0,
      coalescedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      lastErrorKind: null,
      pending: false,
      disposed: false,
    });
    expect(Object.isFrozen(controller.diagnostics())).toBe(true);
  });

  it('does not focus without an explicit recovery request', () => {
    const focus = vi.fn();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    expect(controller.sync(readySnapshot())).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('arms one-shot restoration after a retry request', () => {
    const focus = vi.fn();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    expect(controller.requestRestore()).toBe(true);
    expect(controller.diagnostics()).toMatchObject({ requestCount: 1, pending: true });
    expect(controller.sync(readySnapshot())).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(controller.diagnostics()).toMatchObject({ restoreCount: 1, pending: false });
  });

  it('does not steal focus during booting', () => {
    const focus = vi.fn();
    const model = new MapWorkspaceAccessibilityModel();
    model.beginAttempt();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.requestRestore();
    expect(controller.sync(model.getSnapshot())).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(controller.diagnostics().pending).toBe(true);
  });

  it('does not steal focus while the workspace remains in error', () => {
    const focus = vi.fn();
    const model = errorModel();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.sync(model.getSnapshot());
    controller.requestRestore();
    expect(controller.sync(model.getSnapshot())).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(controller.diagnostics().pending).toBe(true);
  });

  it('restores after a later retry reaches ready', () => {
    const focus = vi.fn();
    const model = errorModel();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.sync(model.getSnapshot());
    controller.requestRestore();
    model.beginAttempt();
    expect(controller.sync(model.getSnapshot())).toBe(false);
    model.markReady();
    expect(controller.sync(model.getSnapshot())).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('restores when retry succeeds in degraded-but-interactive state', () => {
    const focus = vi.fn();
    const model = errorModel();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.sync(model.getSnapshot());
    controller.requestRestore();
    model.beginAttempt();
    model.markReady();
    model.markResourceFailed('kent-rehberi-data', 'temporary');
    expect(model.getSnapshot().phase).toBe('degraded');
    expect(controller.sync(model.getSnapshot())).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not repeat restoration on later updates after a successful one-shot', () => {
    const focus = vi.fn();
    const model = new MapWorkspaceAccessibilityModel();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.requestRestore();
    model.beginAttempt();
    model.markReady();
    controller.sync(model.getSnapshot());
    model.markUpdating(true);
    controller.sync(model.getSnapshot());
    model.markUpdating(false);
    controller.sync(model.getSnapshot());
    expect(focus).toHaveBeenCalledTimes(1);
    expect(controller.diagnostics()).toMatchObject({ restoreCount: 1, pending: false });
  });

  it('coalesces repeated requests while one restore is pending', () => {
    const focus = vi.fn();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.requestRestore();
    controller.requestRestore();
    controller.requestRestore();
    expect(controller.diagnostics()).toMatchObject({
      requestCount: 3,
      coalescedCount: 2,
      pending: true,
    });
    controller.sync(readySnapshot());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('clears pending state when target is unavailable at restore time', () => {
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => null });
    controller.requestRestore();
    expect(controller.sync(readySnapshot())).toBe(false);
    expect(controller.diagnostics()).toMatchObject({
      skippedCount: 1,
      pending: false,
      restoreCount: 0,
    });
  });

  it('contains focus errors and records bounded failure kind', () => {
    const reporter = vi.fn();
    const controller = createMapWorkspaceRecoveryFocusController({
      getTarget: () => ({
        focus() { throw new TypeError('private focus detail'); },
      }),
      onError: reporter,
    });
    controller.requestRestore();
    expect(() => controller.sync(readySnapshot())).not.toThrow();
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(controller.diagnostics()).toMatchObject({
      errorCount: 1,
      lastErrorKind: 'TypeError',
      pending: false,
    });
    expect(JSON.stringify(controller.diagnostics())).not.toContain('private focus detail');
  });

  it('contains reporter failures and records the reporter failure kind', () => {
    const controller = createMapWorkspaceRecoveryFocusController({
      getTarget: () => ({
        focus() { throw new Error('focus failure'); },
      }),
      onError() { throw new RangeError('reporter failure'); },
    });
    controller.requestRestore();
    controller.sync(readySnapshot());
    expect(controller.diagnostics()).toMatchObject({
      errorCount: 2,
      lastErrorKind: 'RangeError',
      pending: false,
    });
  });

  it('expires a pending request after a bounded number of revisions', () => {
    const focus = vi.fn();
    const model = new MapWorkspaceAccessibilityModel();
    const controller = createMapWorkspaceRecoveryFocusController({
      getTarget: () => ({ focus }),
      maxPendingRevisions: 2,
    });
    controller.sync(model.getSnapshot());
    controller.requestRestore();
    model.beginAttempt();
    controller.sync(model.getSnapshot());
    model.markError('first');
    controller.sync(model.getSnapshot());
    model.beginAttempt();
    expect(controller.sync(model.getSnapshot())).toBe(false);
    expect(controller.diagnostics()).toMatchObject({
      skippedCount: 1,
      pending: false,
    });
    expect(focus).not.toHaveBeenCalled();
  });

  it('clamps too-small pending revision budgets to a safe minimum', () => {
    const focus = vi.fn();
    const model = new MapWorkspaceAccessibilityModel();
    const controller = createMapWorkspaceRecoveryFocusController({
      getTarget: () => ({ focus }),
      maxPendingRevisions: 0,
    });
    controller.sync(model.getSnapshot());
    controller.requestRestore();
    model.beginAttempt();
    controller.sync(model.getSnapshot());
    model.markReady();
    expect(controller.sync(model.getSnapshot())).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('can cancel a pending restoration explicitly', () => {
    const focus = vi.fn();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.requestRestore();
    controller.cancel();
    expect(controller.diagnostics().pending).toBe(false);
    controller.sync(readySnapshot());
    expect(focus).not.toHaveBeenCalled();
  });

  it('cancel is idempotent when no restoration is pending', () => {
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => null });
    expect(() => {
      controller.cancel();
      controller.cancel();
    }).not.toThrow();
    expect(controller.diagnostics().pending).toBe(false);
  });

  it('dispose clears pending focus ownership and makes the controller inert', () => {
    const focus = vi.fn();
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => ({ focus }) });
    controller.requestRestore();
    controller.dispose();
    expect(controller.diagnostics()).toMatchObject({ pending: false, disposed: true });
    expect(controller.requestRestore()).toBe(false);
    expect(controller.sync(readySnapshot())).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('dispose is idempotent', () => {
    const controller = createMapWorkspaceRecoveryFocusController({ getTarget: () => null });
    controller.dispose();
    expect(() => controller.dispose()).not.toThrow();
    expect(controller.diagnostics().disposed).toBe(true);
  });
});
