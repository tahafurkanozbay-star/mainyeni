import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureManagedWindowOpener,
  createManagedWindowFocusLifecycle,
  focusManagedWindow,
  restoreManagedWindowFocus,
  scheduleManagedWindowFocus,
} from './ManagedWindowFocus';

describe('ManagedWindowFocus', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(1);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('focuses the first available interactive target', () => {
    const root = document.createElement('section');
    const disabled = document.createElement('button');
    disabled.disabled = true;
    const enabled = document.createElement('button');
    root.append(disabled, enabled);
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBe(enabled);
    expect(document.activeElement).toBe(enabled);
  });

  it('falls back to the root when no focus candidate exists', () => {
    const root = document.createElement('section');
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBe(root);
    expect(root.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(root);
  });

  it('skips candidates hidden by an ancestor', () => {
    const root = document.createElement('section');
    const hidden = document.createElement('div');
    hidden.hidden = true;
    const hiddenButton = document.createElement('button');
    hidden.append(hiddenButton);
    const enabled = document.createElement('button');
    root.append(hidden, enabled);
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBe(enabled);
  });

  it('skips inert and aria-hidden candidates', () => {
    const root = document.createElement('section');
    const inert = document.createElement('div');
    inert.setAttribute('inert', '');
    const inertButton = document.createElement('button');
    inert.append(inertButton);
    const ariaHidden = document.createElement('div');
    ariaHidden.setAttribute('aria-hidden', 'true');
    const ariaButton = document.createElement('button');
    ariaHidden.append(ariaButton);
    const enabled = document.createElement('button');
    root.append(inert, ariaHidden, enabled);
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBe(enabled);
  });

  it('skips CSS-hidden descendants even when connected and not aria-hidden', () => {
    const root = document.createElement('section');
    const displayNone = document.createElement('div');
    displayNone.style.display = 'none';
    const displayButton = document.createElement('button');
    displayNone.append(displayButton);
    const invisible = document.createElement('div');
    invisible.style.visibility = 'hidden';
    const invisibleButton = document.createElement('button');
    invisible.append(invisibleButton);
    const available = document.createElement('button');
    root.append(displayNone, invisible, available);
    document.body.append(root);

    expect(focusManagedWindow({ root })).toBe(available);
    expect(restoreManagedWindowFocus(displayButton)).toBe(false);
    expect(restoreManagedWindowFocus(invisibleButton)).toBe(false);
    expect(document.activeElement).toBe(available);
  });

  it('discovers a first focus target inside an open shadow component', () => {
    const root = document.createElement('section');
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowButton = document.createElement('button');
    const laterButton = document.createElement('button');
    shadow.append(shadowButton);
    root.append(host, laterButton);
    document.body.append(root);

    expect(focusManagedWindow({ root })).toBe(shadowButton);
    expect(shadow.activeElement).toBe(shadowButton);
    expect(document.activeElement).toBe(host);
  });

  it('preserves composed reading order when light DOM precedes a shadow host', () => {
    const root = document.createElement('section');
    const first = document.createElement('button');
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const shadowButton = document.createElement('button');
    shadow.append(shadowButton);
    root.append(first, host);
    document.body.append(root);

    expect(focusManagedWindow({ root })).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(shadow.activeElement).toBeNull();
  });

  it('skips unavailable shadow hosts without losing later focus targets', () => {
    const root = document.createElement('section');
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const unavailable = document.createElement('button');
    shadow.append(unavailable);
    host.setAttribute('aria-hidden', 'true');
    const available = document.createElement('button');
    root.append(host, available);
    document.body.append(root);

    expect(focusManagedWindow({ root })).toBe(available);
    expect(document.activeElement).toBe(available);
  });

  it('restores an opener after focus entered nested shadow controls in a window', () => {
    const opener = document.createElement('button');
    const root = document.createElement('section');
    const outerHost = document.createElement('div');
    const outer = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    const inner = innerHost.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    inner.append(target);
    outer.append(innerHost);
    root.append(outerHost);
    document.body.append(opener, root);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root });
    expect(inner.activeElement).toBe(target);
    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does not restore the opener when focus moved to a different shadow host', () => {
    const opener = document.createElement('button');
    const root = document.createElement('section');
    root.append(document.createElement('button'));
    const outsideHost = document.createElement('div');
    const outsideShadow = outsideHost.attachShadow({ mode: 'open' });
    const outsideButton = document.createElement('button');
    outsideShadow.append(outsideButton);
    document.body.append(opener, root, outsideHost);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root });
    outsideButton.focus();
    expect(lifecycle.close()).toBe(false);
    expect(outsideShadow.activeElement).toBe(outsideButton);
  });

  it('does not focus an entire CSS-hidden window', () => {
    const root = document.createElement('section');
    root.style.visibility = 'hidden';
    root.append(document.createElement('button'));
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('skips buttons disabled by their containing fieldset', () => {
    const root = document.createElement('section');
    const fieldset = document.createElement('fieldset');
    fieldset.disabled = true;
    const unavailable = document.createElement('button');
    fieldset.append(unavailable);
    const enabled = document.createElement('button');
    root.append(fieldset, enabled);
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBe(enabled);
    expect(document.activeElement).toBe(enabled);
  });

  it('does not steal focus when a delayed open loses ownership to another control', () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const opener = document.createElement('button');
    const outside = document.createElement('button');
    const root = document.createElement('section');
    const inside = document.createElement('button');
    root.append(inside);
    document.body.append(opener, outside, root);
    opener.focus();
    const cancel = scheduleManagedWindowFocus({ root });
    outside.focus();
    frames[0]?.(0);
    expect(document.activeElement).toBe(outside);
    cancel();
  });

  it.each([
    'pointerdown',
    'keydown',
    'focusin',
    'visibilitychange',
    'blur',
    'pagehide',
  ])('yields queued window focus to newer %s intent', (type) => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const opener = document.createElement('button');
    const root = document.createElement('section');
    const inside = document.createElement('button');
    root.append(inside);
    document.body.append(opener, root);
    opener.focus();

    const cancel = scheduleManagedWindowFocus({ root });
    const eventTarget = type === 'blur' || type === 'pagehide' ? window : document;
    eventTarget.dispatchEvent(type === 'keydown'
      ? new KeyboardEvent(type, { key: 'Tab', bubbles: true })
      : new Event(type, { bubbles: true }));
    frames[0]?.(0);

    expect(document.activeElement).toBe(opener);
    expect(inside).not.toHaveFocus();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    cancel();
  });

  it('still transfers focus when no newer interaction occurs', () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const opener = document.createElement('button');
    const root = document.createElement('section');
    const inside = document.createElement('button');
    root.append(inside);
    document.body.append(opener, root);
    opener.focus();

    const cancel = scheduleManagedWindowFocus({ root });
    expect(document.activeElement).toBe(opener);
    frames[0]?.(0);
    expect(document.activeElement).toBe(inside);
    cancel();
  });

  it('removes intent listeners after a successful frame', () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const opener = document.createElement('button');
    const root = document.createElement('section');
    root.append(document.createElement('button'));
    document.body.append(opener, root);
    opener.focus();
    scheduleManagedWindowFocus({ root });
    frames[0]?.(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it('invalidates an already queued frame after cancellation or close', () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const opener = document.createElement('button');
    const root = document.createElement('section');
    const inside = document.createElement('button');
    root.append(inside);
    document.body.append(opener, root);
    opener.focus();
    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root });
    inside.focus(); // The modeless restore policy requires focus within the window.
    expect(lifecycle.close()).toBe(true);
    frames[0]?.(0);
    expect(document.activeElement).toBe(opener);
  });

  it('rejects aria-disabled ancestor groups for focus and opener restoration', () => {
    const root = document.createElement('section');
    const disabledGroup = document.createElement('div');
    disabledGroup.setAttribute('aria-disabled', 'true');
    const unavailable = document.createElement('button');
    disabledGroup.append(unavailable);
    const enabled = document.createElement('button');
    root.append(disabledGroup, enabled);
    document.body.append(root);
    expect(focusManagedWindow({ root })).toBe(enabled);
    expect(restoreManagedWindowFocus(unavailable)).toBe(false);
    expect(document.activeElement).toBe(enabled);
  });

  it('fails safely for invalid feature-owned selectors', () => {
    const root = document.createElement('section');
    document.body.append(root);
    expect(focusManagedWindow({ root, initialFocusSelector: '[' })).toBe(root);
  });

  it('captures a meaningful opener but never body', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    expect(captureManagedWindowOpener(document)).toBe(opener);
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    expect(captureManagedWindowOpener(document)).toBeNull();
    document.body.removeAttribute('tabindex');
  });

  it('restores only connected and available opener elements', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    expect(restoreManagedWindowFocus(opener)).toBe(true);
    opener.remove();
    expect(restoreManagedWindowFocus(opener)).toBe(false);
  });

  it('restores focus after a non-modal cycle while focus remains inside', () => {
    const opener = document.createElement('button');
    const root = document.createElement('section');
    const child = document.createElement('button');
    root.append(child);
    document.body.append(opener, root);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root });
    expect(document.activeElement).toBe(child);
    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('does not steal focus from a deliberate outside target', () => {
    const opener = document.createElement('button');
    const outside = document.createElement('button');
    const root = document.createElement('section');
    root.append(document.createElement('button'));
    document.body.append(opener, outside, root);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root });
    outside.focus();
    expect(lifecycle.close()).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it('supports explicit always-restore policy', () => {
    const opener = document.createElement('button');
    const outside = document.createElement('button');
    const root = document.createElement('section');
    root.append(document.createElement('button'));
    document.body.append(opener, outside, root);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root, restorePolicy: 'always' });
    outside.focus();
    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('allows callers to explicitly disable opener restoration', () => {
    const root = document.createElement('section');
    root.append(document.createElement('button'));
    const opener = document.createElement('button');
    document.body.append(opener, root);
    opener.focus();

    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root, opener: null, restorePolicy: 'always' });
    expect(lifecycle.close()).toBe(false);
  });
  it('captures and restores an opener inside nested open shadow roots', () => {
    const outer = document.createElement('div');
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    outerRoot.append(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    const opener = document.createElement('button');
    innerRoot.append(opener);
    document.body.append(outer);
    opener.focus();
    expect(document.activeElement).toBe(outer);
    expect(captureManagedWindowOpener(document)).toBe(opener);
    expect(restoreManagedWindowFocus(opener)).toBe(true);
    expect(innerRoot.activeElement).toBe(opener);
  });

  it('does not steal focus after a deliberate change inside the same shadow root', () => {
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const first = document.createElement('button');
    const second = document.createElement('button');
    shadow.append(first, second);
    const root = document.createElement('section');
    const target = document.createElement('button');
    root.append(target);
    document.body.append(host, root);
    first.focus();
    const cancel = scheduleManagedWindowFocus({ root });
    second.focus();
    expect(document.activeElement).toBe(host);
    frames[0]?.(0);
    expect(shadow.activeElement).toBe(second);
    expect(target).not.toHaveFocus();
    cancel();
  });

  it('restores the opener when the managed window is inside an open shadow root', () => {
    const opener = document.createElement('button');
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const root = document.createElement('section');
    const child = document.createElement('button');
    root.append(child);
    shadow.append(root);
    document.body.append(opener, host);
    opener.focus();
    const lifecycle = createManagedWindowFocusLifecycle(document);
    lifecycle.open({ root });
    expect(shadow.activeElement).toBe(child);
    expect(lifecycle.close()).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

});
