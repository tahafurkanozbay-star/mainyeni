import { describe, expect, it, vi } from 'vitest';
import { createResponsiveDataTableRuntime } from './responsiveDataTableRuntime';

interface MutableTarget {
  clientWidth: number;
  getBoundingClientRect(): { width: number };
}

interface FakeMedia {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

const createTarget = (width = 800): MutableTarget => ({
  clientWidth: width,
  getBoundingClientRect: () => ({ width }),
});

const createWindow = () => {
  const media = new Map<string, FakeMedia>();
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const windowObject = {
    innerWidth: 1200,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const bucket = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      bucket.add(listener);
      listeners.set(type, bucket);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    }),
    matchMedia: vi.fn((query: string) => {
      if (!media.has(query)) {
        media.set(query, {
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
        });
      }
      return media.get(query) as unknown as MediaQueryList;
    }),
  };
  return { windowObject, media, listeners };
};

const createFrameHarness = () => {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    requestFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    }),
    cancelFrame: vi.fn((id: number) => callbacks.delete(id)),
    flush() {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(0);
    },
    size: () => callbacks.size,
  };
};

describe('createResponsiveDataTableRuntime', () => {
  it('publishes target width changes through one animation frame', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    let resizeCallback: ResizeObserverCallback | null = null;
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    const onEnvironment = vi.fn();
    const runtime = createResponsiveDataTableRuntime({
      target,
      onEnvironment,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver(callback) {
        resizeCallback = callback;
        return observer;
      },
    });

    expect(runtime.snapshot().containerWidth).toBe(800);
    target.clientWidth = 500;
    resizeCallback?.([], {} as ResizeObserver);
    expect(onEnvironment).not.toHaveBeenCalled();
    frame.flush();
    expect(onEnvironment).toHaveBeenCalledTimes(1);
    expect(onEnvironment.mock.calls[0]?.[0].containerWidth).toBe(500);
  });

  it('coalesces repeated resize notifications into a single frame', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    let resizeCallback: ResizeObserverCallback | null = null;
    const runtime = createResponsiveDataTableRuntime({
      target,
      onEnvironment: vi.fn(),
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver(callback) {
        resizeCallback = callback;
        return { observe: vi.fn(), disconnect: vi.fn() };
      },
    });
    resizeCallback?.([], {} as ResizeObserver);
    resizeCallback?.([], {} as ResizeObserver);
    resizeCallback?.([], {} as ResizeObserver);
    expect(frame.size()).toBe(1);
    expect(runtime.diagnostics().scheduledCount).toBe(1);
  });

  it('does not emit duplicate measurements', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    const onEnvironment = vi.fn();
    const runtime = createResponsiveDataTableRuntime({
      target,
      onEnvironment,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    runtime.refresh();
    frame.flush();
    expect(onEnvironment).not.toHaveBeenCalled();
    expect(runtime.diagnostics().duplicateCount).toBe(1);
  });

  it('falls back to bounding-box width when clientWidth is zero', () => {
    const target: MutableTarget = {
      clientWidth: 0,
      getBoundingClientRect: () => ({ width: 640 }),
    };
    const runtime = createResponsiveDataTableRuntime({
      target,
      onEnvironment: vi.fn(),
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    expect(runtime.snapshot().containerWidth).toBe(640);
    runtime.dispose();
  });

  it('falls back to viewport width while the host is not measurable', () => {
    const target: MutableTarget = {
      clientWidth: 0,
      getBoundingClientRect: () => ({ width: 0 }),
    };
    const { windowObject } = createWindow();
    windowObject.innerWidth = 912;
    const runtime = createResponsiveDataTableRuntime({
      target,
      windowObject,
      onEnvironment: vi.fn(),
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    expect(runtime.snapshot()).toMatchObject({
      containerWidth: 912,
      viewportWidth: 912,
    });
    runtime.dispose();
  });

  it('tracks coarse pointer, reduced motion and forced colors', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    const { windowObject, media } = createWindow();
    windowObject.matchMedia('(pointer: coarse)');
    windowObject.matchMedia('(prefers-reduced-motion: reduce)');
    windowObject.matchMedia('(forced-colors: active)');
    media.get('(pointer: coarse)')!.matches = true;
    media.get('(prefers-reduced-motion: reduce)')!.matches = true;
    media.get('(forced-colors: active)')!.matches = true;

    const runtime = createResponsiveDataTableRuntime({
      target,
      windowObject,
      onEnvironment: vi.fn(),
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    expect(runtime.snapshot()).toMatchObject({
      coarsePointer: true,
      reducedMotion: true,
      forcedColors: true,
    });
  });

  it('subscribes to browser resize and media change signals', () => {
    const target = createTarget(800);
    const { windowObject, media } = createWindow();
    const runtime = createResponsiveDataTableRuntime({
      target,
      windowObject,
      onEnvironment: vi.fn(),
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    expect(windowObject.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function), { passive: true });
    expect(media.get('(pointer: coarse)')?.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(media.get('(prefers-reduced-motion: reduce)')?.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(media.get('(forced-colors: active)')?.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    runtime.dispose();
  });

  it('updates viewport width after a window resize', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    const { windowObject, listeners } = createWindow();
    const onEnvironment = vi.fn();
    const runtime = createResponsiveDataTableRuntime({
      target,
      windowObject,
      onEnvironment,
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    windowObject.innerWidth = 700;
    const resize = [...(listeners.get('resize') ?? [])][0] as EventListener;
    resize(new Event('resize'));
    frame.flush();
    expect(onEnvironment.mock.calls[0]?.[0].viewportWidth).toBe(700);
    runtime.dispose();
  });

  it('disconnects observer, browser and media listeners on dispose', () => {
    const target = createTarget(800);
    const { windowObject, media } = createWindow();
    const observer = { observe: vi.fn(), disconnect: vi.fn() };
    const runtime = createResponsiveDataTableRuntime({
      target,
      windowObject,
      onEnvironment: vi.fn(),
      createResizeObserver: () => observer,
    });
    runtime.dispose();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(windowObject.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(media.get('(pointer: coarse)')?.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(runtime.diagnostics().disposed).toBe(true);
  });

  it('cancels a scheduled frame when disposed', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    const runtime = createResponsiveDataTableRuntime({
      target,
      onEnvironment: vi.fn(),
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    runtime.refresh();
    expect(frame.size()).toBe(1);
    runtime.dispose();
    expect(frame.cancelFrame).toHaveBeenCalledTimes(1);
  });

  it('ignores refresh requests after disposal', () => {
    const target = createTarget(800);
    const frame = createFrameHarness();
    const runtime = createResponsiveDataTableRuntime({
      target,
      onEnvironment: vi.fn(),
      requestFrame: frame.requestFrame,
      cancelFrame: frame.cancelFrame,
      createResizeObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    });
    runtime.dispose();
    runtime.refresh();
    expect(frame.requestFrame).not.toHaveBeenCalled();
  });
});
