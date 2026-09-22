import { describe, expect, it, vi } from 'vitest';
import { createPageVisibilityRuntime, type PageVisibilityDocumentLike } from './pageVisibilityRuntime';

describe('pageVisibilityRuntime', () => {
  it('publishes visibility changes and detaches the browser listener when idle', () => {
    let visibilityState = 'visible';
    const listeners = new Set<() => void>();
    const documentRef: PageVisibilityDocumentLike = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: vi.fn((_type, listener) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((_type, listener) => {
        listeners.delete(listener);
      }),
    };

    const runtime = createPageVisibilityRuntime(documentRef);
    const observer = vi.fn();
    const unsubscribe = runtime.subscribe(observer);

    expect(runtime.isVisible()).toBe(true);
    expect(documentRef.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    visibilityState = 'hidden';
    listeners.forEach((listener) => listener());
    expect(runtime.isVisible()).toBe(false);
    expect(observer).toHaveBeenLastCalledWith(false);

    visibilityState = 'visible';
    listeners.forEach((listener) => listener());
    expect(observer).toHaveBeenLastCalledWith(true);

    expect(unsubscribe()).toBe(true);
    expect(documentRef.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('fails open as visible when there is no document runtime', () => {
    const runtime = createPageVisibilityRuntime(null);
    expect(runtime.isVisible()).toBe(true);
    const unsubscribe = runtime.subscribe(() => undefined);
    expect(unsubscribe()).toBe(true);
  });
});
