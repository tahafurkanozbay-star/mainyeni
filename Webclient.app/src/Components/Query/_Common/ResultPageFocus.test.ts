import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleOwnedResultFocus } from './ResultPageFocus';

const setup = () => {
  const callbacks: FrameRequestCallback[] = [];
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  const trigger = document.createElement('button');
  const target = document.createElement('button');
  const outside = document.createElement('button');
  document.body.append(trigger, target, outside);
  return { callbacks, request, cancel, trigger, target, outside };
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('owned result paging focus', () => {
  it('moves focus to the new result for keyboard-owned activation', () => {
    const fixture = setup();
    fixture.trigger.focus();
    const focusSpy = vi.spyOn(fixture.target, 'focus');
    const cancel = scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.target);
    // The browser should scroll the focused card into view for keyboard users.
    expect(focusSpy).toHaveBeenCalledWith();
    cancel();
  });

  it('transfers keyboard-owned focus through nested open shadow roots', () => {
    const fixture = setup();
    const outer = document.createElement('div');
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    outerRoot.append(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    const shadowTrigger = document.createElement('button');
    innerRoot.append(shadowTrigger);
    document.body.append(outer);
    shadowTrigger.focus();
    expect(document.activeElement).toBe(outer);
    expect(outerRoot.activeElement).toBe(inner);
    expect(innerRoot.activeElement).toBe(shadowTrigger);

    scheduleOwnedResultFocus({
      trigger: shadowTrigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    expect(fixture.callbacks).toHaveLength(1);
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.target);
  });

  it('preserves deliberate focus changes within the same shadow root', () => {
    const fixture = setup();
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const shadowTrigger = document.createElement('button');
    const sibling = document.createElement('button');
    root.append(shadowTrigger, sibling);
    document.body.append(host);
    shadowTrigger.focus();

    scheduleOwnedResultFocus({
      trigger: shadowTrigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    sibling.focus();
    fixture.callbacks[0]?.(0);
    expect(root.activeElement).toBe(sibling);
    expect(document.activeElement).toBe(host);
  });

  it('does not guess focus ownership inside a closed shadow root', () => {
    const fixture = setup();
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const shadowTrigger = document.createElement('button');
    root.append(shadowTrigger);
    document.body.append(host);
    shadowTrigger.focus();

    scheduleOwnedResultFocus({
      trigger: shadowTrigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    expect(fixture.callbacks).toHaveLength(0);
    expect(document.activeElement).toBe(host);
  });

  it('does not schedule focus for a pointer activation', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 1,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    expect(fixture.callbacks).toHaveLength(0);
    expect(document.activeElement).toBe(fixture.trigger);
  });

  it('does not schedule when the paging control does not own focus', () => {
    const fixture = setup();
    fixture.outside.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    expect(fixture.callbacks).toHaveLength(0);
    expect(document.activeElement).toBe(fixture.outside);
  });

  it('respects deliberate focus movement before the animation frame', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.outside.focus();
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.outside);
  });

  it('allows body fallback when a focused paging control is removed', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.trigger.remove();
    expect(document.activeElement).toBe(document.body);
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.target);
  });

  it('does not move focus when the request is obsolete', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => false,
    });
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.trigger);
  });

  it('invalidates callbacks even if cancellation races a queued frame', () => {
    const fixture = setup();
    fixture.trigger.focus();
    const cancel = scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    cancel();
    expect(fixture.cancel).toHaveBeenCalledWith(1);
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.trigger);
  });

  it('does not hand off keyboard focus into a CSS-hidden result card', () => {
    const fixture = setup();
    fixture.trigger.focus();
    fixture.target.style.display = 'none';
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.trigger);
  });

  it('ignores disconnected and disabled result actions', () => {
    const fixture = setup();
    fixture.trigger.focus();
    fixture.target.disabled = true;
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.trigger);
  });
  it('does not steal focus after a pointer gesture on a non-focusable map', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.trigger.remove();
    // Map canvas interactions need not focus another element.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(document.body);
    expect(fixture.cancel).toHaveBeenCalledWith(1);
  });


  it('cancels when Tab follows a removed paging button before the frame', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.trigger.remove();
    expect(document.activeElement).toBe(document.body);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(document.body);
    expect(fixture.cancel).toHaveBeenCalledWith(1);
  });

  it.each(['blur', 'pagehide'])('cancels on window %s without reclaiming focus', (type) => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    window.dispatchEvent(new Event(type));
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.trigger);
    expect(fixture.cancel).toHaveBeenCalledWith(1);
  });

  it('releases focus ownership immediately when another control receives focus', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    fixture.outside.focus();
    expect(fixture.cancel).toHaveBeenCalledWith(1);
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.outside);
  });

  it('invalidates a queued focus handoff when the tab visibility changes', () => {
    const fixture = setup();
    fixture.trigger.focus();
    scheduleOwnedResultFocus({
      trigger: fixture.trigger, detail: 0,
      resolveTarget: () => fixture.target, isCurrent: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.callbacks[0]?.(0);
    expect(document.activeElement).toBe(fixture.trigger);
    expect(fixture.cancel).toHaveBeenCalledWith(1);
  });

});
