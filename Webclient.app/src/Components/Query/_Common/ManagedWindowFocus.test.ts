import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureManagedWindowOpener, focusManagedWindow, restoreManagedWindowFocus, scheduleManagedWindowFocus } from './ManagedWindowFocus';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ManagedWindowFocus', () => {
  it('focuses the first enabled interactive control', () => {
    document.body.innerHTML = '<section id="root"><button disabled>Disabled</button><input id="search"><button>Action</button></section>';
    const root = document.querySelector<HTMLElement>('#root');
    const target = focusManagedWindow({ root });
    expect(target?.id).toBe('search');
    expect(document.activeElement).toBe(target);
  });

  it('falls back to the window root when no interactive control exists', () => {
    document.body.innerHTML = '<section id="root"><p>Empty state</p></section>';
    const root = document.querySelector<HTMLElement>('#root');
    const target = focusManagedWindow({ root });
    expect(target).toBe(root);
    expect(root?.getAttribute('tabindex')).toBe('-1');
  });

  it('captures and restores a connected opener', () => {
    document.body.innerHTML = '<button id="opener">Open</button><section id="root"><button>Close</button></section>';
    const opener = document.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    expect(captureManagedWindowOpener()).toBe(opener);
    expect(restoreManagedWindowFocus(opener)).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does not restore focus to a detached opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
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
