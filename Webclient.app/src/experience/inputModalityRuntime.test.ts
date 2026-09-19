import { installInputModalityRuntime } from './inputModalityRuntime';

class FakeMediaQuery {
  matches: boolean;
  private listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(matches = false) {
    this.matches = matches;
  }

  addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener);
  }

  emit(matches: boolean): void {
    this.matches = matches;
    const event = { matches } as MediaQueryListEvent;
    for (const listener of this.listeners) listener(event);
  }
}

const install = (coarse = false) => {
  const media = new FakeMediaQuery(coarse);
  const runtime = installInputModalityRuntime({
    document,
    window,
    matchMedia: () => media as unknown as MediaQueryList,
  });
  return { runtime, media };
};

describe('inputModalityRuntime', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-input-modality');
    document.documentElement.removeAttribute('data-keyboard-navigation');
    document.documentElement.removeAttribute('data-coarse-pointer');
    document.body.replaceChildren();
  });

  test('publishes an unknown initial state without pretending keyboard focus intent', () => {
    const { runtime } = install();
    expect(runtime.getSnapshot()).toEqual({
      modality: 'unknown',
      keyboardNavigation: false,
      coarsePointer: false,
      sequence: 0,
    });
    expect(document.documentElement).toHaveAttribute('data-input-modality', 'unknown');
    expect(document.documentElement).not.toHaveAttribute('data-keyboard-navigation');
    runtime.dispose();
  });

  test('enters keyboard navigation for meaningful keyboard interaction', () => {
    const { runtime } = install();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot()).toEqual(expect.objectContaining({
      modality: 'keyboard',
      keyboardNavigation: true,
      sequence: 1,
    }));
    expect(document.documentElement).toHaveAttribute('data-keyboard-navigation', 'true');
    runtime.dispose();
  });

  test('ignores modifier-only, prevented and composing keyboard events', () => {
    const { runtime } = install();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true, isComposing: true }));
    const prevented = new KeyboardEvent('keydown', { key: 'A', bubbles: true, cancelable: true });
    prevented.preventDefault();
    document.dispatchEvent(prevented);
    expect(runtime.getSnapshot().modality).toBe('unknown');
    expect(runtime.getSnapshot().sequence).toBe(0);
    runtime.dispose();
  });

  test('does not turn normal text entry into global keyboard-navigation mode', () => {
    const { runtime } = install();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(runtime.getSnapshot().modality).toBe('unknown');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot().modality).toBe('keyboard');
    runtime.dispose();
  });

  test('switches back to pointer mode after mouse interaction', () => {
    const { runtime } = install();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    if ('PointerEvent' in window) {
      const pointerEvent = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(pointerEvent, 'pointerType', { value: 'mouse' });
      document.dispatchEvent(pointerEvent);
    } else {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }

    expect(runtime.getSnapshot()).toEqual(expect.objectContaining({
      modality: 'pointer',
      keyboardNavigation: false,
    }));
    expect(document.documentElement).not.toHaveAttribute('data-keyboard-navigation');
    runtime.dispose();
  });

  test('tracks coarse-pointer media changes independently from modality', () => {
    const { runtime, media } = install(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    media.emit(true);
    expect(runtime.getSnapshot()).toEqual(expect.objectContaining({
      modality: 'keyboard',
      keyboardNavigation: true,
      coarsePointer: true,
      sequence: 2,
    }));
    expect(document.documentElement).toHaveAttribute('data-coarse-pointer', 'true');
    runtime.dispose();
  });

  test('deduplicates repeated events that do not change the effective state', () => {
    const { runtime } = install();
    const listener = vi.fn();
    runtime.subscribe(listener);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(runtime.getSnapshot().sequence).toBe(1);
    expect(listener).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  test('isolates subscriber failures from input processing', () => {
    const { runtime } = install();
    const healthy = vi.fn();
    runtime.subscribe(() => { throw new Error('observer failed'); });
    runtime.subscribe(healthy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(runtime.getSnapshot().modality).toBe('keyboard');
    expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({ modality: 'keyboard' }));
    runtime.dispose();
  });

  test('unsubscribe prevents later notifications', () => {
    const { runtime } = install();
    const listener = vi.fn();
    const release = runtime.subscribe(listener);
    release();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(listener).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  test('dispose is idempotent, removes listeners and clears document state', () => {
    const { runtime, media } = install();
    runtime.dispose();
    runtime.dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    media.emit(true);
    expect(runtime.getSnapshot().modality).toBe('unknown');
    expect(document.documentElement).not.toHaveAttribute('data-input-modality');
    expect(document.documentElement).not.toHaveAttribute('data-keyboard-navigation');
    expect(document.documentElement).not.toHaveAttribute('data-coarse-pointer');
  });
});
