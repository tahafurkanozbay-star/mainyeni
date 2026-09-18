import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureManagedWindowOpener, createManagedWindowFocusLifecycle, focusManagedWindow, restoreManagedWindowFocus, scheduleManagedWindowFocus } from './ManagedWindowFocus';

const append = <K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | boolean> = {}) => {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === 'boolean') {
      if (value) element.setAttribute(name, '');
    } else {
      element.setAttribute(name, value);
    }
  }
  document.body.append(element);
  return element;
};

const installAnimationFrameHarness = () => {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    callbacks.delete(id);
  });
  return {
    pending: () => callbacks.size,
    flush: () => {
      const scheduled = [...callbacks.entries()];
      callbacks.clear();
      scheduled.forEach(([, callback]) => callback(performance.now()));
    }
  };
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('ManagedWindowFocus', () => {
  it('focuses the first enabled interactive control', () => {
    const root = append('section', { id: 'root' });
    const disabled = document.createElement('button');
    disabled.disabled = true;
    disabled.textContent = 'Disabled';
    const search = document.createElement('input');
    search.id = 'search';
    const action = document.createElement('button');
    action.textContent = 'Action';
    root.append(disabled, search, action);

    const target = focusManagedWindow({ root });
    expect(target?.id).toBe('search');
    expect(document.activeElement).toBe(target);
  });

  it('skips aria-disabled and inert candidates', () => {
    const root = append('section', { id: 'root' });
    const ariaDisabled = document.createElement('button');
    ariaDisabled.setAttribute('aria-disabled', 'true');
    const inertGroup = document.createElement('div');
    inertGroup.setAttribute('inert', '');
    const inertButton = document.createElement('button');
    inertGroup.append(inertButton);
    const available = document.createElement('button');
    available.id = 'available';
    root.append(ariaDisabled, inertGroup, available);

    expect(focusManagedWindow({ root })).toBe(available);
    expect(document.activeElement).toBe(available);
  });

  it('does not focus a hidden or inert window root', () => {
    const hiddenRoot = append('section', { hidden: true });
    hiddenRoot.append(document.createElement('button'));
    expect(focusManagedWindow({ root: hiddenRoot })).toBeNull();

    hiddenRoot.removeAttribute('hidden');
    hiddenRoot.setAttribute('inert', '');
    expect(focusManagedWindow({ root: hiddenRoot })).toBeNull();
  });

  it('fails safely for an invalid feature-owned focus selector', () => {
    const root = append('section');
    root.append(document.createElement('button'));
    expect(() => focusManagedWindow({ root, initialFocusSelector: '[broken' })).not.toThrow();
    expect(document.activeElement).toBe(root);
  });

  it('falls back to the window root when no interactive control exists', () => {
    const root = append('section', { id: 'root' });
    const emptyState = document.createElement('p');
    emptyState.textContent = 'Empty state';
    root.append(emptyState);

    const target = focusManagedWindow({ root });
    expect(target).toBe(root);
    expect(root.getAttribute('tabindex')).toBe('-1');
  });

  it('captures and restores a connected opener', () => {
    const opener = append('button', { id: 'opener' });
    opener.textContent = 'Open';
    const root = append('section', { id: 'root' });
    const close = document.createElement('button');
    close.textContent = 'Close';
    root.append(close);

    opener.focus();
    expect(captureManagedWindowOpener()).toBe(opener);
    expect(restoreManagedWindowFocus(opener)).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does not capture an aria-disabled active element as an opener', () => {
    const opener = append('button');
    opener.focus();
    opener.setAttribute('aria-disabled', 'true');
    expect(captureManagedWindowOpener()).toBeNull();
  });

  it('does not restore focus to a detached opener', () => {
    const opener = append('button');
    opener.remove();
    expect(restoreManagedWindowFocus(opener)).toBe(false);
  });

  it('cancels scheduled focus before the animation frame executes', () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(17);
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const cancel = scheduleManagedWindowFocus({ root: document.body });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    cancel();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);
  });
});

describe('managed window focus lifecycle', () => {
  it('captures the opener and moves focus after the window is mounted', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button', { id: 'opener' });
    const root = append('section', { id: 'window' });
    const search = document.createElement('input');
    search.id = 'search';
    root.append(search);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root });
    expect(lifecycle.isOpen()).toBe(true);
    expect(frames.pending()).toBe(1);
    expect(document.activeElement).toBe(opener);

    frames.flush();
    expect(document.activeElement).toBe(search);
    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(lifecycle.isOpen()).toBe(false);
  });

  it('preserves the original opener across repeated open notifications', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button', { id: 'opener' });
    const root = append('section', { id: 'window' });
    const first = document.createElement('button');
    first.id = 'first';
    root.append(first);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root });
    frames.flush();
    expect(document.activeElement).toBe(first);

    lifecycle.open({ root });
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does not steal focus back when a non-modal user moved outside the window', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button', { id: 'opener' });
    const root = append('section', { id: 'window' });
    const inside = document.createElement('button');
    root.append(inside);
    const outside = append('button', { id: 'outside' });
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root });
    frames.flush();
    expect(document.activeElement).toBe(inside);
    outside.focus();

    expect(lifecycle.close()).toBe(false);
    expect(document.activeElement).toBe(outside);
    expect(lifecycle.isOpen()).toBe(false);
  });

  it('supports explicit always-restore ownership when a caller needs it', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button', { id: 'opener' });
    const root = append('section');
    root.append(document.createElement('button'));
    const outside = append('button');
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root, restorePolicy: 'always' });
    frames.flush();
    outside.focus();

    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('cancels stale scheduled focus when the window closes before the frame', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button');
    const root = append('section');
    const action = document.createElement('button');
    root.append(action);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root });
    expect(frames.pending()).toBe(1);
    // Focus never entered this non-modal window, so close must cancel pending
    // work without stealing focus from the already-correct opener.
    expect(lifecycle.close()).toBe(false);
    expect(frames.pending()).toBe(0);
    frames.flush();
    expect(document.activeElement).toBe(opener);
  });

  it('fails closed when the captured opener is detached', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button');
    const root = append('section');
    root.append(document.createElement('button'));
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root });
    frames.flush();
    opener.remove();
    expect(lifecycle.close()).toBe(false);
    expect(lifecycle.isOpen()).toBe(false);
  });

  it('dispose cancels pending work without restoring focus', () => {
    const frames = installAnimationFrameHarness();
    const opener = append('button');
    const root = append('section');
    root.append(document.createElement('button'));
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle();
    lifecycle.open({ root });
    expect(frames.pending()).toBe(1);
    lifecycle.dispose();
    expect(frames.pending()).toBe(0);
    expect(lifecycle.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
