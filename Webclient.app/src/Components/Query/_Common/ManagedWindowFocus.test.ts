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
});
