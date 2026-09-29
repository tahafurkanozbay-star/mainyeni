import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNavigationSearchShortcutController,
  isNavigationSearchShortcut,
  type NavigationSearchFocusable,
  type NavigationShortcutTarget,
} from './navigationSearchShortcutController';

describe('isNavigationSearchShortcut', () => {
  it.each([
    [{ key: 'k', ctrlKey: true }, true],
    [{ key: 'K', ctrlKey: true }, true],
    [{ key: 'k', metaKey: true }, true],
    [{ key: 'K', metaKey: true }, true],
    [{ key: 'k' }, false],
    [{ key: 'k', altKey: true, ctrlKey: true }, false],
    [{ key: 'k', shiftKey: true, ctrlKey: true }, false],
    [{ key: 'k', ctrlKey: true, isComposing: true }, false],
    [{ key: 'p', ctrlKey: true }, false],
  ] as const)('classifies %o as %s', (event, expected) => {
    expect(isNavigationSearchShortcut(event)).toBe(expected);
  });
});

describe('createNavigationSearchShortcutController', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('focuses and selects the search input for Ctrl+K', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const focus = vi.spyOn(input, 'focus');
    const select = vi.spyOn(input, 'select');
    const preventDefault = vi.fn();
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => input });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, preventDefault, target: document.body })).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('supports Meta+K', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const focus = vi.spyOn(input, 'focus');
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => input });
    expect(controller.handleKeyDown({ key: 'K', metaKey: true, preventDefault: vi.fn(), target: document.body })).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not react to plain K', () => {
    const focus = vi.fn();
    const controller = createNavigationSearchShortcutController({
      target: window,
      getSearchInput: () => ({ focus }),
    });
    expect(controller.handleKeyDown({ key: 'k', preventDefault: vi.fn() })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not react to Alt+Ctrl+K', () => {
    const focus = vi.fn();
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => ({ focus }) });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, altKey: true, preventDefault: vi.fn() })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not react during IME composition', () => {
    const focus = vi.fn();
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => ({ focus }) });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, isComposing: true, preventDefault: vi.fn() })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it('returns false without preventing default when input is unavailable', () => {
    const preventDefault = vi.fn();
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => null });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, preventDefault })).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not select when shortcut originates from another editable control', () => {
    const source = document.createElement('textarea');
    const target = document.createElement('input');
    document.body.append(source, target);
    const select = vi.spyOn(target, 'select');
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => target });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, preventDefault: vi.fn(), target: source })).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it('does not select when shortcut originates inside a contenteditable surface', () => {
    const source = document.createElement('span');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.append(source);
    const target = document.createElement('input');
    document.body.append(editable, target);
    const select = vi.spyOn(target, 'select');
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => target });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, preventDefault: vi.fn(), target: source })).toBe(true);
    expect(select).not.toHaveBeenCalled();
  });

  it('records focus failures without retaining raw messages', () => {
    const input: NavigationSearchFocusable = {
      focus: () => { throw new TypeError('sensitive focus detail'); },
    };
    const preventDefault = vi.fn();
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => input });
    expect(controller.handleKeyDown({ key: 'k', ctrlKey: true, preventDefault })).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.getDiagnostics()).toEqual({ focusFailureCount: 1, lastFailureKind: 'TypeError' });
    expect(JSON.stringify(controller.getDiagnostics())).not.toContain('sensitive focus detail');
  });

  it('freezes diagnostics', () => {
    const controller = createNavigationSearchShortcutController({ target: window, getSearchInput: () => null });
    expect(Object.isFrozen(controller.getDiagnostics())).toBe(true);
  });

  it('attaches exactly one native keydown listener across repeated starts', () => {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    const target: NavigationShortcutTarget = {
      addEventListener: vi.fn((_type, listener) => { listeners.add(listener); }),
      removeEventListener: vi.fn((_type, listener) => { listeners.delete(listener); }),
    };
    const controller = createNavigationSearchShortcutController({ target, getSearchInput: () => null });
    controller.start();
    controller.start();
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
  });

  it('removes the same native listener on stop', () => {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    const target: NavigationShortcutTarget = {
      addEventListener: (_type, listener) => { listeners.add(listener); },
      removeEventListener: vi.fn((_type, listener) => { listeners.delete(listener); }),
    };
    const controller = createNavigationSearchShortcutController({ target, getSearchInput: () => null });
    controller.start();
    expect(listeners.size).toBe(1);
    controller.stop();
    expect(listeners.size).toBe(0);
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('makes stop idempotent', () => {
    const target: NavigationShortcutTarget = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const controller = createNavigationSearchShortcutController({ target, getSearchInput: () => null });
    controller.start();
    controller.stop();
    controller.stop();
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('routes native target events through the handler', () => {
    let listener: ((event: KeyboardEvent) => void) | null = null;
    const target: NavigationShortcutTarget = {
      addEventListener: (_type, next) => { listener = next; },
      removeEventListener: () => undefined,
    };
    const input = document.createElement('input');
    document.body.append(input);
    const focus = vi.spyOn(input, 'focus');
    const controller = createNavigationSearchShortcutController({ target, getSearchInput: () => input });
    controller.start();
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    listener?.(event);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('requires a target and input resolver', () => {
    expect(() => createNavigationSearchShortcutController({
      target: null as unknown as NavigationShortcutTarget,
      getSearchInput: () => null,
    })).toThrow(TypeError);
  });
});
