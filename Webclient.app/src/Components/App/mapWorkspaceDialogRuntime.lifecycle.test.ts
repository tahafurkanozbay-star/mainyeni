import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMapWorkspaceDialogSession } from './mapWorkspaceDialogRuntime';

const mount = () => {
  document.body.innerHTML = `
    <main id="workspace"><button id="launcher">Open</button></main>
    <div id="backdrop"><div id="dialog" tabindex="-1"><button>Close</button></div></div>`;
  const workspace = document.querySelector<HTMLElement>('#workspace')!;
  const launcher = document.querySelector<HTMLElement>('#launcher')!;
  const dialog = document.querySelector<HTMLElement>('#dialog')!;
  launcher.focus();
  return { workspace, launcher, dialog };
};

afterEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('map workspace dialog isolation leases', () => {
  it('preserves inert state that existed before the dialog session', () => {
    const { workspace, dialog } = mount();
    workspace.setAttribute('inert', '');

    const session = createMapWorkspaceDialogSession(dialog, vi.fn());
    expect(workspace.hasAttribute('inert')).toBe(true);

    session.dispose();
    expect(workspace.hasAttribute('inert')).toBe(true);
  });

  it('keeps shared background isolation until the final overlapping session releases it', () => {
    const { workspace, dialog } = mount();
    const first = createMapWorkspaceDialogSession(dialog, vi.fn());
    const second = createMapWorkspaceDialogSession(dialog, vi.fn());

    expect(workspace.hasAttribute('inert')).toBe(true);
    first.dispose();
    expect(workspace.hasAttribute('inert')).toBe(true);

    second.dispose();
    expect(workspace.hasAttribute('inert')).toBe(false);
  });

  it('keeps scrolling locked until the final overlapping session releases it', () => {
    const { dialog } = mount();
    document.body.style.overflow = 'clip';
    const first = createMapWorkspaceDialogSession(dialog, vi.fn());
    const second = createMapWorkspaceDialogSession(dialog, vi.fn());

    expect(document.body.style.overflow).toBe('hidden');
    first.dispose();
    expect(document.body.style.overflow).toBe('hidden');

    second.dispose();
    expect(document.body.style.overflow).toBe('clip');
  });

  it('does not let repeated disposal release another session lease', () => {
    const { workspace, dialog } = mount();
    const first = createMapWorkspaceDialogSession(dialog, vi.fn());
    const second = createMapWorkspaceDialogSession(dialog, vi.fn());

    first.dispose();
    first.dispose();
    expect(workspace.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');

    second.dispose();
    expect(workspace.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });
});
