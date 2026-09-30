import { describe, expect, it, vi } from 'vitest';
import { createMapWorkspaceViewportRuntime } from './mapWorkspaceViewportRuntime';

const createTarget = () => {
  const listeners = new Map<string, EventListenerOrEventListenerObject>();
  return {
    addEventListener: vi.fn((name: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(name, listener);
    }),
    removeEventListener: vi.fn((name: string) => {
      listeners.delete(name);
    }),
    dispatch(name: string) {
      const listener = listeners.get(name);
      if (typeof listener === 'function') listener(new Event(name));
      else listener?.handleEvent(new Event(name));
    },
  };
};

describe('createMapWorkspaceViewportRuntime', () => {
  it('applies initial padding once by default', () => {
    const view = { padding: null as unknown, destroyed: false };
    const createPadding = vi.fn((width: number) => ({ left: width > 600 ? 240 : 0 }));
    const target = createTarget();
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({ sidebar: true }),
      createPadding,
      getViewportWidth: () => 1280,
      target,
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
    });
    expect(createPadding).toHaveBeenCalledWith(1280, { sidebar: true });
    expect(view.padding).toEqual({ left: 240 });
    expect(runtime.diagnostics()).toMatchObject({ appliedCount: 1, scheduledCount: 0, disposed: false });
  });

  it('can opt out of initial write', () => {
    const view = { padding: null as unknown, destroyed: false };
    const createPadding = vi.fn(() => ({ left: 0 }));
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({}),
      createPadding,
      target: createTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      applyInitial: false,
    });
    expect(createPadding).not.toHaveBeenCalled();
    expect(runtime.diagnostics().appliedCount).toBe(0);
  });

  it('coalesces multiple resize events into one scheduled frame', () => {
    const target = createTarget();
    const view = { padding: null as unknown, destroyed: false };
    let frameCallback: FrameRequestCallback | null = null;
    const scheduleFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 7;
    });
    const createPadding = vi.fn(() => ({ left: 10 }));
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({}),
      createPadding,
      target,
      scheduleFrame,
      cancelFrame: vi.fn(),
      applyInitial: false,
    });
    target.dispatch('resize');
    target.dispatch('resize');
    target.dispatch('resize');
    expect(scheduleFrame).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({ scheduledCount: 1, coalescedCount: 2, appliedCount: 0 });
    frameCallback?.(0);
    expect(createPadding).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics().appliedCount).toBe(1);
  });

  it('allows a later resize to schedule a new frame after the first frame applies', () => {
    const target = createTarget();
    const view = { padding: null as unknown, destroyed: false };
    const callbacks: FrameRequestCallback[] = [];
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({}),
      createPadding: (width) => ({ width }),
      getViewportWidth: () => 900,
      target,
      scheduleFrame(callback) {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancelFrame: vi.fn(),
      applyInitial: false,
    });
    target.dispatch('resize');
    callbacks[0]?.(0);
    target.dispatch('resize');
    callbacks[1]?.(16);
    expect(runtime.diagnostics()).toMatchObject({ scheduledCount: 2, appliedCount: 2 });
    expect(view.padding).toEqual({ width: 900 });
  });

  it('flushes a pending frame synchronously and cancels scheduled ownership', () => {
    const target = createTarget();
    const view = { padding: null as unknown, destroyed: false };
    const cancelFrame = vi.fn();
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({}),
      createPadding: () => ({ top: 1 }),
      target,
      scheduleFrame: vi.fn(() => 42),
      cancelFrame,
      applyInitial: false,
    });
    runtime.requestUpdate();
    runtime.flush();
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(view.padding).toEqual({ top: 1 });
    expect(runtime.diagnostics().appliedCount).toBe(1);
  });

  it('does not write when no view is available', () => {
    const createPadding = vi.fn(() => ({ left: 0 }));
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => null,
      getConfiguration: () => ({}),
      createPadding,
      target: createTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
    });
    expect(createPadding).not.toHaveBeenCalled();
    expect(runtime.diagnostics().appliedCount).toBe(0);
  });

  it('does not write into a destroyed view', () => {
    const createPadding = vi.fn(() => ({ left: 0 }));
    const view = { padding: null as unknown, destroyed: true };
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => view,
      getConfiguration: () => ({}),
      createPadding,
      target: createTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
    });
    expect(createPadding).not.toHaveBeenCalled();
    expect(runtime.diagnostics().appliedCount).toBe(0);
  });

  it('isolates padding calculation failures and records diagnostics', () => {
    const reporter = vi.fn();
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => ({ destroyed: false }),
      getConfiguration: () => ({}),
      createPadding() { throw new TypeError('private padding detail'); },
      target: createTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      onError: reporter,
    });
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({ errorCount: 1, appliedCount: 0 });
    expect(JSON.stringify(runtime.diagnostics())).not.toContain('private padding detail');
  });

  it('contains reporter failures without breaking runtime diagnostics', () => {
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => ({ destroyed: false }),
      getConfiguration: () => ({}),
      createPadding() { throw new Error('padding failed'); },
      target: createTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      onError() { throw new Error('reporter failed'); },
    });
    expect(runtime.diagnostics().errorCount).toBe(2);
  });

  it('disposes resize listener and cancels a pending frame', () => {
    const target = createTarget();
    const cancelFrame = vi.fn();
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => ({ destroyed: false }),
      getConfiguration: () => ({}),
      createPadding: () => ({}),
      target,
      scheduleFrame: vi.fn(() => 9),
      cancelFrame,
      applyInitial: false,
    });
    runtime.requestUpdate();
    runtime.dispose();
    expect(target.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(cancelFrame).toHaveBeenCalledWith(9);
    expect(runtime.diagnostics().disposed).toBe(true);
  });

  it('is inert after disposal', () => {
    const target = createTarget();
    const createPadding = vi.fn(() => ({}));
    const scheduleFrame = vi.fn(() => 1);
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => ({ destroyed: false }),
      getConfiguration: () => ({}),
      createPadding,
      target,
      scheduleFrame,
      cancelFrame: vi.fn(),
      applyInitial: false,
    });
    runtime.dispose();
    runtime.requestUpdate();
    runtime.flush();
    target.dispatch('resize');
    expect(scheduleFrame).not.toHaveBeenCalled();
    expect(createPadding).not.toHaveBeenCalled();
  });

  it('returns frozen diagnostics snapshots', () => {
    const runtime = createMapWorkspaceViewportRuntime({
      getView: () => null,
      getConfiguration: () => ({}),
      createPadding: () => ({}),
      target: createTarget(),
      scheduleFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      applyInitial: false,
    });
    expect(Object.isFrozen(runtime.diagnostics())).toBe(true);
  });
});
