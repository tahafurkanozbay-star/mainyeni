import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureManagedWindowOpener, focusManagedWindow, restoreManagedWindowFocus, scheduleManagedWindowFocus } from './ManagedWindowFocus';

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
