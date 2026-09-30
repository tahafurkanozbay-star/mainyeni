import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMapWorkspaceDialogSession, getMapDialogFocusableElements } from './mapWorkspaceDialogRuntime';

const mountDialog = () => {
  document.body.innerHTML = `
    <main id="workspace"><button id="launcher">Open</button></main>
    <div id="backdrop"><div id="dialog" tabindex="-1">
      <button id="first">First</button>
      <a id="middle" href="#target">Middle</a>
      <button id="last">Last</button>
    </div></div>`;
  const launcher = document.querySelector<HTMLElement>('#launcher')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  const first = document.querySelector<HTMLElement>('#first')!;
  const middle = document.querySelector<HTMLElement>('#middle')!;
  const last = document.querySelector<HTMLElement>('#last')!;
  launcher.focus();
  return { launcher, dialog, first, middle, last, workspace: document.querySelector<HTMLElement>('#workspace')! };
};

const key = (value: string, shiftKey = false) => new KeyboardEvent('keydown', { key: value, shiftKey, cancelable: true });

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('getMapDialogFocusableElements', () => {
  it('returns interactive elements in DOM order', () => {
    const { dialog, first, middle, last } = mountDialog();
    expect(getMapDialogFocusableElements(dialog)).toEqual([first, middle, last]);
  });

  it('excludes hidden and aria-hidden elements', () => {
    const { dialog, middle, last } = mountDialog();
    middle.setAttribute('hidden', '');
    last.setAttribute('aria-hidden', 'true');
    expect(getMapDialogFocusableElements(dialog).map((element) => element.id)).toEqual(['first']);
  });

  it('excludes descendants of inert containers', () => {
    const { dialog, middle } = mountDialog();
    const wrapper = document.createElement('div');
    wrapper.setAttribute('inert', '');
    middle.parentElement?.insertBefore(wrapper, middle);
    wrapper.appendChild(middle);
    expect(getMapDialogFocusableElements(dialog).map((element) => element.id)).toEqual(['first', 'last']);
  });
});

describe('createMapWorkspaceDialogSession', () => {
  it('moves initial focus to the first interactive control', () => {
    const { dialog, first } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    session.focusInitial();
    expect(document.activeElement).toBe(first);
    session.dispose();
  });

  it('falls back to the dialog when there are no interactive controls', () => {
    const { dialog } = mountDialog();
    dialog.querySelectorAll('button,a').forEach((element) => element.remove());
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    session.focusInitial();
    expect(document.activeElement).toBe(dialog);
    session.dispose();
  });

  it('locks document scrolling for the lifetime of the session', () => {
    const { dialog } = mountDialog();
    document.body.style.overflow = 'clip';
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    expect(document.body.style.overflow).toBe('hidden');
    session.dispose();
    expect(document.body.style.overflow).toBe('clip');
  });

  it('makes workspace siblings inert while the modal is active', () => {
    const { dialog, workspace } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    expect(workspace.hasAttribute('inert')).toBe(true);
    session.dispose();
    expect(workspace.hasAttribute('inert')).toBe(false);
  });

  it('restores focus to the opener on disposal', () => {
    const { dialog, launcher, first } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    session.focusInitial();
    expect(document.activeElement).toBe(first);
    session.dispose();
    expect(document.activeElement).toBe(launcher);
  });

  it('does not restore focus to a detached opener', () => {
    const { dialog, launcher, first } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    session.focusInitial();
    launcher.remove();
    session.dispose();
    expect(document.activeElement).not.toBe(launcher);
    expect(first.isConnected).toBe(true);
  });

  it('closes and consumes Escape', () => {
    const { dialog } = mountDialog();
    const onClose = vi.fn();
    const session = createMapWorkspaceDialogSession(dialog, onClose);
    const event = key('Escape');
    expect(session.handleKeyDown(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('does not consume unrelated keys', () => {
    const { dialog } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    const event = key('ArrowDown');
    expect(session.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    session.dispose();
  });

  it('wraps Tab from the last control to the first', () => {
    const { dialog, first, last } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    last.focus();
    const event = key('Tab');
    expect(session.handleKeyDown(event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    session.dispose();
  });

  it('wraps Shift+Tab from the first control to the last', () => {
    const { dialog, first, last } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    first.focus();
    const event = key('Tab', true);
    expect(session.handleKeyDown(event)).toBe(true);
    expect(document.activeElement).toBe(last);
    session.dispose();
  });

  it('recovers Tab focus that escaped outside the dialog', () => {
    const { dialog, first, launcher } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    launcher.focus();
    expect(session.handleKeyDown(key('Tab'))).toBe(true);
    expect(document.activeElement).toBe(first);
    session.dispose();
  });

  it('recovers reverse Tab focus to the last control', () => {
    const { dialog, last, launcher } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    launcher.focus();
    expect(session.handleKeyDown(key('Tab', true))).toBe(true);
    expect(document.activeElement).toBe(last);
    session.dispose();
  });

  it('allows Tab to proceed between interior controls', () => {
    const { dialog, middle } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    middle.focus();
    const event = key('Tab');
    expect(session.handleKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    session.dispose();
  });

  it('redirects Tab to the dialog when no focusable controls remain', () => {
    const { dialog } = mountDialog();
    dialog.querySelectorAll('button,a').forEach((element) => element.remove());
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    const event = key('Tab');
    expect(session.handleKeyDown(event)).toBe(true);
    expect(document.activeElement).toBe(dialog);
    session.dispose();
  });

  it('is idempotent when disposed more than once', () => {
    const { dialog, launcher } = mountDialog();
    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    session.focusInitial();
    session.dispose();
    session.dispose();
    expect(document.activeElement).toBe(launcher);
  });

  it('ignores keyboard events after disposal', () => {
    const { dialog } = mountDialog();
    const onClose = vi.fn();
    const session = createMapWorkspaceDialogSession(dialog, onClose);
    session.dispose();
    expect(session.handleKeyDown(key('Escape'))).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
